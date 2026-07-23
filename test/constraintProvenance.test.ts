import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ConstraintPayloadError,
  readConstraintPayload
} from "../src/adapters/loom/readConstraintPayload.ts";
import { buildSeamProvenance } from "../src/core/constraint/buildSeamProvenance.ts";
import type { ConstraintPayload } from "../src/core/constraint/constraintTypes.ts";

// 実 cycling_knickers の outseam payload（Loomit v0 契約・機械変換済み fixture）。
function loadSample(): ConstraintPayload {
  const path = join(process.cwd(), "test/fixtures/constraint-payload-outseam.json");
  return readConstraintPayload(JSON.parse(readFileSync(path, "utf8")));
}

// v0 の最小 payload を組む helper（bare payload。adapter は封筒無しも受ける）。
function v0(
  params: Record<string, unknown>,
  parts: unknown,
  connectors: unknown
): Record<string, unknown> {
  return { schema: "loomit.constraint-payload.v0", params, parts, connectors };
}

test("readConstraintPayload: v0 の params(declared) / parts / connectors(join鍵) を読む", () => {
  const payload = loadSample();
  assert.equal(payload.schema, "loomit.constraint-payload.v0");
  assert.deepEqual(Object.keys(payload.params).sort(), [
    "#fly_length",
    "#leg_fly_length",
    "#pocket_opening",
    "#pocket_opening_from_waist"
  ]);
  // v0: 依存は parts、connectors は join 鍵のみ。
  const front = payload.parts.find((part) => part.partId === "front");
  const back = payload.parts.find((part) => part.partId === "back");
  assert.equal(front?.dependsOn.length, 16);
  assert.equal(back?.dependsOn.length, 15);
  assert.deepEqual(payload.connectors, [
    { partId: "front", connectorId: "outseam" },
    { partId: "back", connectorId: "outseam" }
  ]);
});

test("readConstraintPayload: 未知 schema 版は explicit error（未知版を弾く）", () => {
  assert.throws(
    () =>
      readConstraintPayload({
        schema: "loomit.constraint-payload.v9",
        params: {},
        parts: [],
        connectors: []
      }),
    (error: unknown) => error instanceof ConstraintPayloadError
  );
});

test("readConstraintPayload: params の declared union（true=value/note, false=usedBy のみ）", () => {
  const payload = readConstraintPayload(
    v0(
      {
        "#knob": {
          declared: true,
          value: "0",
          usedBy: ["front", "back"],
          note: "回してよいツマミ"
        },
        "#ref": { declared: false, usedBy: ["front"] }
      },
      [],
      []
    )
  );
  const knob = payload.params["#knob"]!;
  assert.equal(knob.declared, true);
  if (knob.declared) {
    assert.equal(knob.value, "0");
    assert.equal(knob.note, "回してよいツマミ"); // author-intent を落とさない
  }
  assert.equal(payload.params["#ref"]!.declared, false);
});

test("readConstraintPayload: refs が params に解決しないと inv3 error（parts 経由）", () => {
  // 守る仕様: 未定義増分を参照する出現は confidently-wrong を避けて explicit error。
  const broken = v0(
    {},
    [
      {
        partId: "front",
        piece: "front",
        dependsOn: [
          { pointId: "1", type: "cutSpline", linearity: "none", expr: "#ghost", refs: ["#ghost"] }
        ]
      }
    ],
    [{ partId: "front", connectorId: "outseam" }]
  );
  assert.throws(
    () => readConstraintPayload(broken),
    (error: unknown) => error instanceof ConstraintPayloadError
  );
});

test("readConstraintPayload: 壊れた field 型は explicit error（field を信頼しない）", () => {
  assert.throws(
    () => readConstraintPayload(v0({}, "nope", [])),
    (error: unknown) => error instanceof ConstraintPayloadError
  );
});

test("readConstraintPayload: occurrence の discriminated union を検証する（排他）", () => {
  // 守る仕様: 出現は pointId+type か splineId+handle の排他。曖昧な形は boundary で explicit error。
  const wrap = (occurrence: Record<string, unknown>) =>
    v0(
      {},
      [{ partId: "front", piece: "front", dependsOn: [occurrence] }],
      [{ partId: "front", connectorId: "seam" }]
    );
  const base = { linearity: "linear", expr: "5", refs: [] };
  const bad: Record<string, unknown>[] = [
    { ...base }, // pointId も splineId も無い
    { ...base, pointId: "1", splineId: "2", type: "endLine" }, // 両方
    { ...base, pointId: "1" }, // pointId だが type 欠け
    { ...base, pointId: "1", type: "endLine", handle: "length1" }, // point なのに handle
    { ...base, splineId: "2" }, // splineId だが handle 欠け
    { ...base, splineId: "2", handle: "length1", type: "endLine" } // spline なのに type
  ];
  for (const occurrence of bad) {
    assert.throws(
      () => readConstraintPayload(wrap(occurrence)),
      (error: unknown) => error instanceof ConstraintPayloadError,
      JSON.stringify(occurrence)
    );
  }
  assert.doesNotThrow(() =>
    readConstraintPayload(wrap({ ...base, pointId: "1", type: "endLine" }))
  );
  assert.doesNotThrow(() =>
    readConstraintPayload(wrap({ ...base, splineId: "2", handle: "length1" }))
  );
});

test("buildSeamProvenance: linearity:none を落とし linear を先に並べる（parts 起点）", () => {
  const payload = loadSample();
  const provenance = buildSeamProvenance(payload, { partId: "front", connectorId: "outseam" });
  // front の dependsOn 16、cutSpline(none) 4 を落として 12 候補。
  assert.equal(provenance.droppedNoneCount, 4);
  assert.equal(provenance.candidates.length, 12);
  const linearities = provenance.candidates.map((candidate) => candidate.occurrence.linearity);
  assert.ok(linearities.lastIndexOf("linear") < linearities.indexOf("nonlinear"));
  assert.ok(linearities.every((value) => value !== "none"));
});

test("buildSeamProvenance: outseam の長さ候補は増分参照ゼロ → coupling は全部 part-local（[C8]・危険側）", () => {
  const payload = loadSample();
  const provenance = buildSeamProvenance(payload, { partId: "front", connectorId: "outseam" });
  assert.ok(provenance.candidates.every((candidate) => candidate.occurrence.refs.length === 0));
  assert.ok(provenance.candidates.every((candidate) => candidate.coupling === "part-local"));
});

test("buildSeamProvenance: 増分参照ありは coupling=increment + usedByHint（弱いヒント・安全断定しない）", () => {
  const payload = readConstraintPayload(
    v0(
      { "#p": { declared: true, value: "5", usedBy: ["front", "back"] } },
      [
        {
          partId: "front",
          piece: "front",
          dependsOn: [
            { pointId: "1", type: "endLine", linearity: "linear", expr: "#p", refs: ["#p"] }
          ]
        }
      ],
      [{ partId: "front", connectorId: "seam" }]
    )
  );
  const provenance = buildSeamProvenance(payload, { partId: "front", connectorId: "seam" });
  assert.equal(provenance.candidates.length, 1);
  assert.equal(provenance.candidates[0]!.coupling, "increment");
  assert.deepEqual(provenance.candidates[0]!.usedByHint, ["back", "front"]);
});

test("buildSeamProvenance: connector が payload に無ければ空 + note", () => {
  const payload = loadSample();
  const provenance = buildSeamProvenance(payload, { partId: "sleeve", connectorId: "outseam" });
  assert.equal(provenance.candidates.length, 0);
  assert.match(provenance.note ?? "", /connector が無い/);
});

test("buildSeamProvenance: connector はあるが part が無ければ note", () => {
  const payload = readConstraintPayload(v0({}, [], [{ partId: "x", connectorId: "seam" }]));
  const provenance = buildSeamProvenance(payload, { partId: "x", connectorId: "seam" });
  assert.match(provenance.note ?? "", /part "x" が無い/);
});

test("buildSeamProvenance: 同入力で同出力（決定的, T10）", () => {
  const payload = loadSample();
  const target = { partId: "back", connectorId: "outseam" };
  assert.deepEqual(buildSeamProvenance(payload, target), buildSeamProvenance(payload, target));
});

test("readConstraintPayload: schema-invalid な余剰フィールドは拒否（additionalProperties:false）", () => {
  // 守る仕様: adapter を JSON Schema と同じ strict にして片側の drift を実行時前に落とす。
  const cases: unknown[] = [
    // declared:false に stray value（schema では usedBy のみ）
    v0({ "#r": { declared: false, usedBy: ["front"], value: "stray" } }, [], []),
    // connector に余剰フィールド
    v0({}, [], [{ partId: "front", connectorId: "outseam", extra: 1 }]),
    // part に余剰フィールド
    v0({}, [{ partId: "front", piece: "front", dependsOn: [], extra: 1 }], []),
    // occurrence に余剰フィールド
    v0(
      {},
      [
        {
          partId: "front",
          piece: "front",
          dependsOn: [
            { pointId: "1", type: "endLine", linearity: "linear", expr: "5", refs: [], extra: 1 }
          ]
        }
      ],
      [{ partId: "front", connectorId: "seam" }]
    ),
    // payload 本体に余剰フィールド
    { schema: "loomit.constraint-payload.v0", params: {}, parts: [], connectors: [], extra: 1 }
  ];
  for (const bad of cases) {
    assert.throws(
      () => readConstraintPayload(bad),
      (error: unknown) => error instanceof ConstraintPayloadError,
      JSON.stringify(bad)
    );
  }
});

test("buildSeamProvenance: declared:false のみ参照する候補は increment にしない（part-local）", () => {
  // 守る仕様 (declared 尊重): 動かせるツマミ = declared:true。未宣言参照だけの式は turn できないので part-local。
  const payload = readConstraintPayload(
    v0(
      { "#undeclared": { declared: false, usedBy: ["front"] } },
      [
        {
          partId: "front",
          piece: "front",
          dependsOn: [
            {
              pointId: "1",
              type: "endLine",
              linearity: "linear",
              expr: "#undeclared",
              refs: ["#undeclared"]
            }
          ]
        }
      ],
      [{ partId: "front", connectorId: "seam" }]
    )
  );
  const provenance = buildSeamProvenance(payload, { partId: "front", connectorId: "seam" });
  assert.equal(provenance.candidates[0]!.coupling, "part-local");
  assert.equal(provenance.candidates[0]!.usedByHint, undefined);
});

test("buildSeamProvenance: pieceWide=true・多 seam piece の別 connector は同じ候補（[C6] の既知限界を明示）", () => {
  // 守る仕様: v0 の dependsOn は piece 単位なので connectorId で絞れない。同 part の別 connector は同じ候補になる。
  //           これを黙らせず pieceWide=true で consumer に明示する（misattribution を silent にしない）。
  const payload = readConstraintPayload(
    v0(
      { "#p": { declared: true, value: "5", usedBy: ["front"] } },
      [
        {
          partId: "front",
          piece: "front",
          dependsOn: [
            { pointId: "1", type: "endLine", linearity: "linear", expr: "#p", refs: ["#p"] }
          ]
        }
      ],
      [
        { partId: "front", connectorId: "outseam" },
        { partId: "front", connectorId: "inseam" }
      ]
    )
  );
  const outseam = buildSeamProvenance(payload, { partId: "front", connectorId: "outseam" });
  const inseam = buildSeamProvenance(payload, { partId: "front", connectorId: "inseam" });
  assert.equal(outseam.pieceWide, true);
  assert.match(outseam.note ?? "", /piece/);
  assert.deepEqual(outseam.candidates, inseam.candidates);
});
