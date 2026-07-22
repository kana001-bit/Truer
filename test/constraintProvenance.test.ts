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

// 実 cycling_knickers の outseam payload（Loomit handoff のサンプル・機械検証済み）。
function loadSample(): ConstraintPayload {
  const path = join(process.cwd(), "test/fixtures/constraint-payload-outseam.json");
  return readConstraintPayload(JSON.parse(readFileSync(path, "utf8")));
}

test("readConstraintPayload: 封筒 { payload, diagnostics } を受け params/connectors を読む", () => {
  const payload = loadSample();
  assert.deepEqual(Object.keys(payload.params).sort(), [
    "#fly_length",
    "#leg_fly_length",
    "#pocket_opening",
    "#pocket_opening_from_waist"
  ]);
  assert.equal(payload.connectors.length, 2);
  const front = payload.connectors.find((connector) => connector.partId === "front");
  const back = payload.connectors.find((connector) => connector.partId === "back");
  assert.equal(front?.dependsOn.length, 16);
  assert.equal(back?.dependsOn.length, 15);
});

test("readConstraintPayload: refs が params に解決しないと inv3 error（推測で流さない）", () => {
  // 守る仕様: 未定義増分を参照する出現は confidently-wrong を避けて explicit error。
  const broken = {
    payload: {
      params: {},
      connectors: [
        {
          partId: "front",
          connectorId: "outseam",
          dependsOn: [
            { pointId: "1", type: "cutSpline", linearity: "none", expr: "#ghost", refs: ["#ghost"] }
          ]
        }
      ]
    }
  };
  assert.throws(
    () => readConstraintPayload(broken),
    (error: unknown) => error instanceof ConstraintPayloadError
  );
});

test("readConstraintPayload: 壊れた field 型は explicit error（field を信頼しない）", () => {
  assert.throws(
    () => readConstraintPayload({ payload: { params: {}, connectors: "nope" } }),
    (error: unknown) => error instanceof ConstraintPayloadError
  );
});

test("readConstraintPayload: params の note（author-intent）を保持する（P2）", () => {
  // 守る仕様: .val 増分の description を permitted 層の種として素通しする（落とさない）。
  const payload = readConstraintPayload({
    payload: {
      params: {
        "#ease": {
          kind: "increment",
          value: "0",
          usedBy: ["front", "back"],
          note: "make it baggier"
        }
      },
      connectors: []
    }
  });
  assert.equal(payload.params["#ease"]!.note, "make it baggier");
});

test("readConstraintPayload: occurrence の discriminated union を検証する（P3）", () => {
  // 守る仕様: 出現は pointId+type か splineId+handle の排他。曖昧な形は boundary で explicit error。
  const wrap = (occurrence: Record<string, unknown>) => ({
    payload: {
      params: {},
      connectors: [{ partId: "front", connectorId: "seam", dependsOn: [occurrence] }]
    }
  });
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
  // 正しい 2 形は通る。
  assert.doesNotThrow(() =>
    readConstraintPayload(wrap({ ...base, pointId: "1", type: "endLine" }))
  );
  assert.doesNotThrow(() =>
    readConstraintPayload(wrap({ ...base, splineId: "2", handle: "length1" }))
  );
});

test("buildSeamProvenance: linearity:none を落とし linear を先に並べる", () => {
  const payload = loadSample();
  const provenance = buildSeamProvenance(payload, { partId: "front", connectorId: "outseam" });
  // front.outseam は 16 occ。cutSpline(none) 4 を落として 12 候補。
  assert.equal(provenance.droppedNoneCount, 4);
  assert.equal(provenance.candidates.length, 12);
  // 並びは linear が先、nonlinear が後（none は無い）。
  const linearities = provenance.candidates.map((candidate) => candidate.occurrence.linearity);
  const lastLinear = linearities.lastIndexOf("linear");
  const firstNonlinear = linearities.indexOf("nonlinear");
  assert.ok(lastLinear < firstNonlinear, `並び: ${linearities.join(",")}`);
  assert.ok(linearities.every((value) => value !== "none"));
});

test("buildSeamProvenance: outseam の長さ候補は増分参照ゼロ → coupling は全部 part-local（[C8]・危険側）", () => {
  // 実データの所見: 増分は cutSpline(none) にしか無く、長さ候補は inline 値 / measurement。安全側で危険候補扱い。
  const payload = loadSample();
  const provenance = buildSeamProvenance(payload, { partId: "front", connectorId: "outseam" });
  assert.ok(provenance.candidates.every((candidate) => candidate.occurrence.refs.length === 0));
  assert.ok(provenance.candidates.every((candidate) => candidate.coupling === "part-local"));
});

test("buildSeamProvenance: 両側 usedBy を覆う増分は both-sides（coupling recipe）", () => {
  const payload: ConstraintPayload = {
    params: { "#p": { kind: "increment", value: "5", usedBy: ["front", "back"] } },
    connectors: [
      {
        partId: "front",
        connectorId: "seam",
        dependsOn: [
          { pointId: "1", type: "endLine", linearity: "linear", expr: "#p", refs: ["#p"] }
        ]
      },
      { partId: "back", connectorId: "seam", dependsOn: [] }
    ]
  };
  const provenance = buildSeamProvenance(payload, { partId: "front", connectorId: "seam" });
  assert.equal(provenance.candidates.length, 1);
  assert.equal(provenance.candidates[0]!.coupling, "both-sides");
});

test("buildSeamProvenance: 片側だけ usedBy の増分は one-side（危険）", () => {
  const payload: ConstraintPayload = {
    params: { "#p": { kind: "increment", value: "5", usedBy: ["front"] } },
    connectors: [
      {
        partId: "front",
        connectorId: "seam",
        dependsOn: [
          { pointId: "1", type: "endLine", linearity: "linear", expr: "#p", refs: ["#p"] }
        ]
      },
      { partId: "back", connectorId: "seam", dependsOn: [] }
    ]
  };
  const provenance = buildSeamProvenance(payload, { partId: "front", connectorId: "seam" });
  assert.equal(provenance.candidates[0]!.coupling, "one-side");
});

test("buildSeamProvenance: 対象 connector が payload に無ければ空 + note", () => {
  const payload = loadSample();
  const provenance = buildSeamProvenance(payload, { partId: "sleeve", connectorId: "outseam" });
  assert.equal(provenance.candidates.length, 0);
  assert.equal(provenance.droppedNoneCount, 0);
  assert.match(provenance.note ?? "", /connector が無い/);
});

test("buildSeamProvenance: 同入力で同出力（決定的, T10）", () => {
  const payload = loadSample();
  const target = { partId: "back", connectorId: "outseam" };
  const first = buildSeamProvenance(payload, target);
  const second = buildSeamProvenance(payload, target);
  assert.deepEqual(first, second);
});
