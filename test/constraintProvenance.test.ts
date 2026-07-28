import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  ConstraintPayloadError,
  readConstraintPayload,
  readConstraintRequest
} from "../src/adapters/loom/readConstraintPayload.ts";
import type { ConstraintRequest } from "../src/adapters/loom/readConstraintPayload.ts";
import { buildSeamProvenance } from "../src/core/constraint/buildSeamProvenance.ts";
import type { ConstraintPayload } from "../src/core/constraint/constraintTypes.ts";

// 実 cycling_knickers の outseam payload（Loomit v0 契約・機械変換済み fixture）。notches を持たない旧 v0 なので
// 「notches 無しでも読める」後方互換の回帰も兼ねる（Loomit は今は常に notches を載せる）。
function loadSample(): ConstraintPayload {
  const path = join(process.cwd(), "test/fixtures/constraint-payload-outseam.json");
  return readConstraintPayload(JSON.parse(readFileSync(path, "utf8")));
}

// `loom truer request` の**実出力**（封筒 `{status,diagnostics,payload}` ＋ `parts[].notches[]` 入り）。
// **手編集しない。** 上流の emitter が形を変えたらこの fixture を再生成して差分を見る（drift-guard）。再生成:
//   node <Loomit>/packages/cli/dist/main.js truer request <project> --format json \
//     > test/fixtures/constraint-payload-cycling-knickers.notches.json
//   npm run format   # prettier が短い配列を 1 行に畳む。CI は format:check 独立ゲートなので必須（値は不変）
// 生成元 project は cycling_knickers（waistband の waist が合わない版・front / back / waistband の 3 parts）。
// **封筒の `status` / `diagnostics` は project の readiness 状態で変わる**（契約ではない）ので、下のテストは値を
// pin しない。再生成したら payload 側（params / parts / notches）の差分だけ見ればよい。
// この fixture は adapter（strict）・matcher・applicable の実データ回帰で共有する（`matchNotches.test.ts` /
// `buildSeamApplicable.test.ts` も同じファイルを読む。test ファイル同士は import しない＝test の二重登録を避ける）。
const REAL_NOTCHES_FIXTURE = "test/fixtures/constraint-payload-cycling-knickers.notches.json";

function loadRealRequest(): ConstraintRequest {
  const path = join(process.cwd(), REAL_NOTCHES_FIXTURE);
  return readConstraintRequest(JSON.parse(readFileSync(path, "utf8")));
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

test("readConstraintPayload: connectors[].pathRef を additive に受ける（[C10] 案A・v0 据置）", () => {
  // 守る仕様: `pathRef` は connector の「幾何ソース上の住所」（`part.loom` の `path_ref` 由来。DXF なら BLOCK 名、
  //   SVG なら path id）で、**Seamlint 診断の blockName と突き合わせてよい唯一の値**（`parts[].piece` は `.val` の
  //   detail 名で住所の権威ではない・Loomit 回答 2026-07-28）。上流が emit を始めた瞬間に payload 全体を reject
  //   しないよう、**Truer 側が先に受け入れ側を用意する**（notches のときと同じ strict lockstep の罠を避ける）。
  const payload = readConstraintPayload(
    v0({}, [], [{ partId: "back", connectorId: "outseam", pathRef: "BACK" }])
  );
  assert.deepEqual(payload.connectors, [
    { partId: "back", connectorId: "outseam", pathRef: "BACK" }
  ]);

  // 値は BLOCK 名に限らない（SVG 経路の path id）。adapter は文字列として素通しするだけで解釈しない。
  const svg = readConstraintPayload(
    v0({}, [], [{ partId: "front", connectorId: "armhole", pathRef: "armhole" }])
  );
  assert.equal(svg.connectors[0]!.pathRef, "armhole");
});

test("readConstraintPayload: pathRef は optional。無ければ落として piece へ暗黙 fallback しない", () => {
  // 守る仕様（鳴ってはいけない面）: `path_ref` は part.loom でも optional で、identity だけの connector が実在しうる。
  //   旧 payload にも無い。**無いことは異常ではない**ので error にせず、`pathRef` を持たない形で読む。ここで
  //   `piece` を代入して埋めると「住所の権威は pathRef だけ」という契約が崩れ、[C10] と同じ silent な誤 join に戻る。
  const payload = readConstraintPayload(v0({}, [], [{ partId: "back", connectorId: "outseam" }]));
  assert.deepEqual(payload.connectors, [{ partId: "back", connectorId: "outseam" }]);
  assert.equal("pathRef" in payload.connectors[0]!, false);

  // 旧 v0 fixture（pathRef 無し）も従来どおり読める＝後方互換。
  assert.equal(
    loadSample().connectors.every((connector) => connector.pathRef === undefined),
    true
  );
});

test("readConstraintPayload: pathRef が文字列でなければ explicit error（型を推測で通さない）", () => {
  // 守る仕様: 外部入力なので型を信頼しない。数値や null を silent に受けると住所の join が静かに壊れる。
  for (const bad of [1, null, {}, ["BACK"]]) {
    assert.throws(
      () =>
        readConstraintPayload(
          v0({}, [], [{ partId: "back", connectorId: "outseam", pathRef: bad }])
        ),
      ConstraintPayloadError
    );
  }
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

test("readConstraintPayload: parts[].notches[] を parse する（[C6]・applicable 用グループ）", () => {
  // 守る仕様: Loomit の additive な notch 単位グループを内部形へ読む。lengthCandidates は occurrence 同形。
  const payload = readConstraintPayload(
    v0(
      {},
      [
        {
          partId: "front",
          piece: "front",
          dependsOn: [],
          notches: [
            {
              order: 0,
              rawPassmarkLine: "vMark",
              notchType: "v",
              anchorPointId: "146",
              splineId: "31",
              lengthCandidates: [
                {
                  pointId: "15",
                  type: "alongLine",
                  linearity: "linear",
                  expr: "waist_circ/4+5",
                  refs: []
                },
                {
                  pointId: "2",
                  type: "endLine",
                  linearity: "linear",
                  expr: "rise_length_side_sitting",
                  refs: []
                },
                { splineId: "31", handle: "length2", linearity: "nonlinear", expr: "15", refs: [] }
              ]
            }
          ]
        }
      ],
      [{ partId: "front", connectorId: "outseam" }]
    )
  );
  const notch = payload.parts[0]!.notches[0]!;
  assert.equal(notch.order, 0);
  assert.equal(notch.notchType, "v");
  assert.equal(notch.rawPassmarkLine, "vMark");
  assert.equal(notch.anchorPointId, "146");
  assert.equal(notch.splineId, "31");
  assert.equal(notch.lengthCandidates.length, 3);
  assert.equal(notch.lengthCandidates[0]!.pointId, "15");
  assert.equal(notch.lengthCandidates[2]!.handle, "length2");
});

test("readConstraintPayload: notches 省略（旧 payload）は [] に正規化（後方互換）", () => {
  // 守る仕様: notches を持たない旧 v0 payload も壊れず、下流が常に配列を回せるよう [] にする。
  const payload = readConstraintPayload(
    v0({}, [{ partId: "front", piece: "front", dependsOn: [] }], [])
  );
  assert.deepEqual(payload.parts[0]!.notches, []);
});

test("readConstraintPayload: notches 無しの実 fixture は各 part notches=[]（後方互換の回帰）", () => {
  // 守る仕様: 現行の実 fixture（notches 無し）が strict 化した adapter を素通りし、notches=[] になる。
  const payload = loadSample();
  assert.ok(
    payload.parts.every((part) => Array.isArray(part.notches) && part.notches.length === 0)
  );
});

test("readConstraintPayload: notch の strict 検証（未知キー / 不正 notchType / order / anchor / 未解決 ref）", () => {
  // 守る仕様: notch も strict（additionalProperties:false 同等）＋必須 field ＋ lengthCandidates の refs も inv3 に載せる。
  const wrap = (notch: Record<string, unknown>) =>
    v0({}, [{ partId: "front", piece: "front", dependsOn: [], notches: [notch] }], []);
  const base = { order: 0, anchorPointId: "146", lengthCandidates: [] as unknown[] };
  const bad: unknown[] = [
    wrap({ ...base, extra: 1 }), // 未知キー
    wrap({ ...base, notchType: "bogus" }), // enum 外
    wrap({ order: "0", anchorPointId: "146", lengthCandidates: [] }), // order 非整数
    wrap({ order: 0, lengthCandidates: [] }), // anchorPointId 欠け
    wrap({ order: 0, anchorPointId: "146" }), // lengthCandidates 欠け
    // lengthCandidate の未定義 ref → inv3（notches 経由でも confidently-wrong を弾く）
    v0(
      {},
      [
        {
          partId: "front",
          piece: "front",
          dependsOn: [],
          notches: [
            {
              order: 0,
              anchorPointId: "1",
              lengthCandidates: [
                {
                  pointId: "9",
                  type: "endLine",
                  linearity: "linear",
                  expr: "#ghost",
                  refs: ["#ghost"]
                }
              ]
            }
          ]
        }
      ],
      []
    )
  ];
  for (const payload of bad) {
    assert.throws(
      () => readConstraintPayload(payload),
      (error: unknown) => error instanceof ConstraintPayloadError,
      JSON.stringify(payload)
    );
  }
});

test("readConstraintPayload: notch.order は safe-integer で検証（unsafe な整数を弾く・matching 安定キー）", () => {
  // 守る仕様 (P2): order は matching の安定キー。schema と同じ safe-integer 範囲（±2^53-1）に揃える。2^53 以上は
  //           JSON.parse で丸められ別 order と衝突しうるので、Number.isInteger では通っても弾く。境界は受ける。
  const withOrder = (order: number) =>
    v0(
      {},
      [
        {
          partId: "front",
          piece: "front",
          dependsOn: [],
          notches: [{ order, anchorPointId: "1", lengthCandidates: [] }]
        }
      ],
      []
    );
  assert.doesNotThrow(() => readConstraintPayload(withOrder(Number.MAX_SAFE_INTEGER)));
  assert.doesNotThrow(() => readConstraintPayload(withOrder(Number.MIN_SAFE_INTEGER)));
  // 2^53（Number.isInteger は true だが unsafe）は reject。
  assert.throws(
    () => readConstraintPayload(withOrder(9007199254740992)),
    (error: unknown) => error instanceof ConstraintPayloadError
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

test("readConstraintRequest: 封筒 {status, diagnostics, payload} の status/diagnostics を拾い payload を返す（[C7]）", () => {
  // 守る仕様: envelope が payload 構築時の問題を報告するとき、consumer が surface できるよう status/diagnostics を渡す。
  //           payload 本体は readConstraintPayload と同じ検証で読む。
  const request = readConstraintRequest({
    status: "warning",
    diagnostics: [
      {
        severity: "warning",
        code: "PART_SOURCE_VAL_PIECE_NOT_FOUND",
        message: 'files.piece "sleeve" が .val に無い'
      }
    ],
    payload: v0({ "#p": { declared: true, value: "5", usedBy: ["front"] } }, [], [])
  });
  assert.equal(request.status, "warning");
  assert.equal(request.payload.schema, "loomit.constraint-payload.v0");
  assert.equal(request.diagnostics.length, 1);
  assert.equal(request.diagnostics[0]!.severity, "warning");
  assert.equal(request.diagnostics[0]!.code, "PART_SOURCE_VAL_PIECE_NOT_FOUND");
  assert.match(request.diagnostics[0]!.message, /sleeve/);
});

test("readConstraintRequest: bare 形（status 無し / payload 直）は status undefined・diagnostics 空", () => {
  // 守る仕様: 旧 assemble sample `{payload, diagnostics:[]}` や payload 直（封筒無し）は「問題なし」相当。
  //           status 欠落を ok と誤断定せず undefined にし、CLI 側が「undefined は警告しない」で扱う。
  const enveloped = readConstraintRequest({ payload: v0({}, [], []), diagnostics: [] });
  assert.equal(enveloped.status, undefined);
  assert.equal(enveloped.diagnostics.length, 0);
  const bare = readConstraintRequest(v0({}, [], []));
  assert.equal(bare.status, undefined);
  assert.equal(bare.diagnostics.length, 0);
});

test("readConstraintRequest: diagnostics は表示用に defensive 正規化（message 欠落は code / JSON に fallback）", () => {
  // 守る仕様: diagnostics は人向けの注意書きなので strict にせず、message を必ず非空にして落とさない。
  //           未知 status は undefined 扱い（advisory を throw で壊さない）。
  const request = readConstraintRequest({
    status: "bogus",
    diagnostics: [{ code: "ONLY_CODE" }, { severity: "error", message: "" }, "just a string"],
    payload: v0({}, [], [])
  });
  assert.equal(request.status, undefined); // 未知 status は undefined
  assert.equal(request.diagnostics[0]!.message, "ONLY_CODE"); // message 欠落 → code
  assert.ok(request.diagnostics[1]!.message.length > 0); // 空 message → JSON fallback（非空）
  assert.equal(request.diagnostics[2]!.message, "just a string"); // 非 object → String()
});

test("readConstraintRequest: 実 `loom truer request` 出力（notches 入り）が strict を素通りする", () => {
  // 守る仕様: adapter は strict（未知フィールドを error）なので、上流 Loomit が emit する形と 1 つでも食い違うと
  //   real payload を全部 reject し provenance-only ごと壊れる。実出力 fixture を読めること自体が drift-guard。
  //   ここが落ちたら「Loomit が field を足した / 名前を変えた」ので、fixture 再生成 → adapter と schema copy を同期する。
  const request = loadRealRequest();

  // 封筒（status / diagnostics）は**ここでは検証しない**。あれは契約ではなく project の readiness 状態で、上流が
  // チェックを増やすと同じ project でも値が変わる（実際に 2026-07-27 の Loomit 再ビルドで `PART_FILE_COPY_STALE` が
  // 付き `ok` → `warning` になった）。値を pin すると **fixture を再生成しただけでテストが落ちる**。封筒を読んで
  // surface する挙動は上の [C7] テスト 3 本が synthetic で固定済みなので、実 fixture 側は payload の固定に専念する。
  assert.equal(request.payload.schema, "loomit.constraint-payload.v0");
  assert.deepEqual(
    request.payload.parts.map((part) => part.partId),
    ["front", "back", "waistband"]
  );
  // connectors は join 鍵のみ（dependsOn を持たない）。実データは outseam ＋ waist の 2 種。
  assert.deepEqual(
    request.payload.connectors.map((connector) => `${connector.partId}/${connector.connectorId}`),
    ["front/outseam", "front/waist", "back/outseam", "back/waist", "waistband/waist"]
  );
});

test("readConstraintRequest: 実出力の notches が必須 field 込みで読める（notchType は生値写像つき）", () => {
  // 守る仕様: matcher の入力になる notch 単位グループを実データで固定する。order/anchorPointId/lengthCandidates は
  //   必須、`rawPassmarkLine` は `.val` の生値 verbatim、`notchType` は layer 由来の弱い tie-breaker（Loomit の
  //   総写像で実質全 notch に付く）。inv3（refs が params に解決する）も読めた時点で通っている。
  const payload = loadRealRequest().payload;
  const back = payload.parts.find((part) => part.partId === "back");
  assert.ok(back);

  assert.deepEqual(
    back.notches.map((notch) => notch.order),
    [0, 1, 2, 3]
  );
  assert.deepEqual(
    back.notches.map((notch) => notch.notchType),
    ["v", "t", "v", "t"]
  );
  assert.deepEqual(
    back.notches.map((notch) => notch.rawPassmarkLine),
    ["vMark", "tMark", "vMark", "tMark"]
  );
  for (const notch of back.notches) {
    assert.ok(notch.anchorPointId.length > 0);
    assert.ok(notch.lengthCandidates.length > 0);
  }
  // notch の錨 spline は 84 が 3 個・86 が 1 個。「同じ辺の notch は同じ spline に乗りがち」という実データの形
  // （applicable を広げるときの discriminator 候補・現 matcher は未使用）。
  assert.deepEqual(
    back.notches.map((notch) => notch.splineId),
    ["84", "84", "84", "86"]
  );

  // waistband は notch を持たない直辺 piece。**空でも常に emit** される契約なので [] になる（field 欠落ではない）。
  const waistband = payload.parts.find((part) => part.partId === "waistband");
  assert.ok(waistband);
  assert.deepEqual(waistband.notches, []);
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
