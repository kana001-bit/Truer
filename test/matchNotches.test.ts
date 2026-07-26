import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readConstraintPayload } from "../src/adapters/loom/readConstraintPayload.ts";
import { matchSeamEdgeNotches } from "../src/core/constraint/matchNotches.ts";
import type { MeasuredNotch } from "../src/core/constraint/matchNotches.ts";
import type { ConstraintNotch, NotchType } from "../src/core/constraint/constraintTypes.ts";

// piece の .val notch（applicable の錨）。matcher は order/notchType だけ見るので splineId/lengthCandidates はダミーで足りる。
function valNotch(order: number, notchType?: NotchType, splineId = `s${order}`): ConstraintNotch {
  return {
    order,
    anchorPointId: `p${order}`,
    splineId,
    lengthCandidates: [],
    ...(notchType !== undefined ? { notchType } : {})
  };
}

// 測定辺 notch。既定は interior（onCorner/ambiguous とも false）。
function measured(
  edgePosition: number,
  notchType?: NotchType,
  flags: { onCorner?: boolean; ambiguous?: boolean } = {}
): MeasuredNotch {
  return {
    edgePosition,
    onCorner: flags.onCorner ?? false,
    ambiguous: flags.ambiguous ?? false,
    ...(notchType !== undefined ? { notchType } : {})
  };
}

test("matchSeamEdgeNotches: 種別が全部違えば run を forward で一意同定する（順序が主キー）", () => {
  // 守る仕様: 測定辺 [t,castle] が piece run [t,castle] に一意一致 → matched（forward・orders [1,2]）。
  const val = [
    valNotch(0, "v"),
    valNotch(1, "t"),
    valNotch(2, "castle"),
    valNotch(3, "u"),
    valNotch(4, "check")
  ];
  const result = matchSeamEdgeNotches([measured(0.2, "t"), measured(0.5, "castle")], val);

  assert.equal(result.status, "matched");
  if (result.status !== "matched") return;
  assert.equal(result.direction, "forward");
  assert.deepEqual(
    result.valNotches.map((notch) => notch.order),
    [1, 2]
  );
});

test("matchSeamEdgeNotches: 向きが逆でも両方向試して reversed で同定する（CW/CCW 反転）", () => {
  // 守る仕様: 測定辺 [castle,t] が piece run [t,castle] の逆順に一致 → matched（reversed）。返す valNotches は輪郭 order のまま。
  const val = [valNotch(0, "v"), valNotch(1, "t"), valNotch(2, "castle"), valNotch(3, "u")];
  const result = matchSeamEdgeNotches([measured(0.3, "castle"), measured(0.6, "t")], val);

  assert.equal(result.status, "matched");
  if (result.status !== "matched") return;
  assert.equal(result.direction, "reversed");
  assert.deepEqual(
    result.valNotches.map((notch) => notch.order),
    [1, 2]
  );
});

test("matchSeamEdgeNotches: 輪郭は閉ループ。先頭/末尾をまたぐ wrap-around run も同定する（P2-1 回帰）", () => {
  // 守る仕様: order の末尾→先頭をまたぐ連続 run（3→4→0）を候補にする。線形走査だと取りこぼしていた。
  const val = [
    valNotch(0, "v"),
    valNotch(1, "t"),
    valNotch(2, "v"),
    valNotch(3, "castle"),
    valNotch(4, "u")
  ];
  const result = matchSeamEdgeNotches(
    [measured(0.2, "castle"), measured(0.5, "u"), measured(0.8, "v")],
    val
  );

  assert.equal(result.status, "matched");
  if (result.status !== "matched") return;
  assert.equal(result.direction, "forward");
  // arc 順（run の輪郭順）で返す: 3→4→0。
  assert.deepEqual(
    result.valNotches.map((notch) => notch.order),
    [3, 4, 0]
  );
});

test("matchSeamEdgeNotches: run は一意でも向きが一意でなければ either を返す（過剰確定しない・P2-2 回帰）", () => {
  // 守る仕様: 2 個の閉ループでは [v,t] が forward（v から）でも reversed（t から逆）でも成立し向きは決められない。
  // run（集合）は一意なので matched だが direction は either（silent に forward と確定しない）。
  const val = [valNotch(0, "v"), valNotch(1, "t")];
  const result = matchSeamEdgeNotches([measured(0.3, "v"), measured(0.6, "t")], val);

  assert.equal(result.status, "matched");
  if (result.status !== "matched") return;
  assert.equal(result.direction, "either");
  assert.deepEqual(
    result.valNotches.map((notch) => notch.order),
    [0, 1]
  );
});

test("matchSeamEdgeNotches: 実 cycling outseam（V2+T2）は matched。回文的種別列なので向きは either", () => {
  // 守る仕様: v,t,v,t は piece 全周と一致（run 一意）だが前後対称なので向きは一意でない → matched・either・4 個。
  const val = [valNotch(0, "v"), valNotch(1, "t"), valNotch(2, "v"), valNotch(3, "t")];
  const result = matchSeamEdgeNotches(
    [measured(0.06, "v"), measured(0.25, "t"), measured(0.5, "v"), measured(0.69, "t")],
    val
  );

  assert.equal(result.status, "matched");
  if (result.status !== "matched") return;
  assert.equal(result.direction, "either");
  assert.deepEqual(
    result.valNotches.map((notch) => notch.order),
    [0, 1, 2, 3]
  );
});

test("matchSeamEdgeNotches: 種別が弱く複数 run に一致するときは ambiguous（順序を種別で上書きしない）", () => {
  // 守る仕様: 全部 v で長さ 2 の run が複数（wrap 含む）→ 一意化できず ambiguous（applicable を出さず provenance-only）。
  const val = [valNotch(0, "v"), valNotch(1, "v"), valNotch(2, "v"), valNotch(3, "v")];
  const result = matchSeamEdgeNotches([measured(0.3, "v"), measured(0.6, "v")], val);

  assert.equal(result.status, "ambiguous");
});

test("matchSeamEdgeNotches: 一致する run が無ければ no-match", () => {
  // 守る仕様: 測定辺 [v,t] は全部 v の piece に一致 run が無い → no-match（前向き/逆向きとも不一致）。
  const val = [valNotch(0, "v"), valNotch(1, "v"), valNotch(2, "v")];
  const result = matchSeamEdgeNotches([measured(0.3, "v"), measured(0.6, "t")], val);

  assert.equal(result.status, "no-match");
});

test("matchSeamEdgeNotches: onCorner/ambiguous は署名から除く。全部除かれたら no-notches", () => {
  // 守る仕様: 角共有(onCorner)と辺内曖昧(ambiguous)は per-edge 署名にならないので除外。残り 0 個なら no-notches。
  const val = [valNotch(0, "v"), valNotch(1, "t")];
  const result = matchSeamEdgeNotches(
    [measured(0.0, "v", { onCorner: true }), measured(0.5, "t", { ambiguous: true })],
    val
  );

  assert.equal(result.status, "no-notches");
});

test("matchSeamEdgeNotches: onCorner/ambiguous を除いた interior だけで、種別欠落は wildcard として一意同定する", () => {
  // 守る仕様: 角(v@0.0)と曖昧(@0.9)を除いた interior [v@0.2, undefined@0.4, u@0.6]（種別欠落は wildcard）が piece run
  // [v,castle,u] に一意一致 → matched（forward・orders [1,2,3]）。種別は弱い tie-breaker。
  const val = [
    valNotch(0, "t"),
    valNotch(1, "v"),
    valNotch(2, "castle"),
    valNotch(3, "u"),
    valNotch(4, "t")
  ];
  const result = matchSeamEdgeNotches(
    [
      measured(0.0, "v", { onCorner: true }),
      measured(0.2, "v"),
      measured(0.4),
      measured(0.6, "u"),
      measured(0.9, "t", { ambiguous: true })
    ],
    val
  );

  assert.equal(result.status, "matched");
  if (result.status !== "matched") return;
  assert.equal(result.direction, "forward");
  assert.deepEqual(
    result.valNotches.map((notch) => notch.order),
    [1, 2, 3]
  );
});

test("matchSeamEdgeNotches: 測定辺 notch が undefined/空、または piece notch が少ないと安全に諦める", () => {
  // 守る仕様: 入力欠落・piece notch 不足でも投げず、no-notches / no-match を返す（degrade して provenance-only）。
  assert.equal(matchSeamEdgeNotches(undefined, [valNotch(0, "v")]).status, "no-notches");
  assert.equal(matchSeamEdgeNotches([], [valNotch(0, "v")]).status, "no-notches");
  assert.equal(
    matchSeamEdgeNotches([measured(0.3, "v"), measured(0.6, "t")], [valNotch(0, "v")]).status,
    "no-match"
  );
});

// --- 実 `.val` notch（上の synthetic を置換せず併設）---
// **実なのは Loomit `.val` 側だけ。** piece の notch は実 `loom truer request` 出力だが、測定辺側（`MeasuredNotch`）は
// 上の `measured()` で合成する（`edgePosition` は等間隔の作り値・`notchType` は val notch から複写）。Seamlint 由来の
// 実 `SeamEdgeNotch`（実 edgePosition / onCorner / ambiguous）を通す 3 者 e2e は task-spec「次にやること (b)」の領分で、
// **ここではまだ検証していない**。fixture は手編集しない・再生成手順は `constraintProvenance.test.ts` の
// loadRealRequest コメント参照（test ファイル同士は import しない＝test の二重登録を避ける）。
const REAL_NOTCHES_FIXTURE = "test/fixtures/constraint-payload-cycling-knickers.notches.json";

function loadRealNotches(partId: string): ConstraintNotch[] {
  const path = join(process.cwd(), REAL_NOTCHES_FIXTURE);
  const payload = readConstraintPayload(JSON.parse(readFileSync(path, "utf8")));
  const part = payload.parts.find((candidate) => candidate.partId === partId);
  assert.ok(part, `fixture に part "${partId}" が無い`);
  return part.notches;
}

test("matchSeamEdgeNotches: 実 .val notch では部分署名が ambiguous になる（種別列が交互で弱いため諦める）", () => {
  // 守る仕様: 実 cycling_knickers の piece notch は種別列が [v,t,v,t]。長さ 1〜3 の測定署名はこの列の複数箇所に
  //   一致してしまうので（例 [v,t,v] は run {0,1,2} と {2,3,0} の両方）、**一意化できず ambiguous** を返す。
  //   ここで無理に 1 つ選ぶと誤った param を confidently-wrong に出すので、諦めるのが正しい（T8）。
  //   実 .val notch で「種別は弱い tie-breaker」が効かない側に振れることの回帰。
  //   署名は **prefix に限らない**（測定辺は輪郭の一部なので途中から始まる部分列もありうる）ので、[t,…] 始まりも含める。
  const val = loadRealNotches("back");
  assert.deepEqual(
    val.map((notch) => notch.notchType),
    ["v", "t", "v", "t"]
  );

  const signatures: NotchType[][] = [
    ["v"],
    ["t"],
    ["v", "t"],
    ["t", "v"],
    ["v", "t", "v"],
    ["t", "v", "t"]
  ];
  for (const signature of signatures) {
    const measuredNotches = signature.map((notchType, index) =>
      measured((index + 1) / (signature.length + 1), notchType)
    );
    assert.equal(
      matchSeamEdgeNotches(measuredNotches, val).status,
      "ambiguous",
      `署名 [${signature.join(",")}] は実 .val notch で一意化できないはず`
    );
  }
});

test("matchSeamEdgeNotches: 実 .val notch で全周（4 個）署名なら matched・向きは either（回転を畳む）", () => {
  // 守る仕様: k===n（piece の全 notch を測定辺が覆う）は、どの開始位置の回転も同じ notch 集合を指すので 1 件に畳まれ
  //   matched になる。ただし [v,t,v,t] は逆順の回転とも両立するため **direction は either**（向きを過剰確定しない）。
  //   valNotches は輪郭 order 昇順で返る（下流が位置対応を仮定しないための固定）。
  const val = loadRealNotches("front");
  const fullSignature: NotchType[] = ["v", "t", "v", "t"];
  const measuredNotches = fullSignature.map((notchType, index) =>
    measured((index + 1) / (fullSignature.length + 1), notchType)
  );

  const result = matchSeamEdgeNotches(measuredNotches, val);

  assert.equal(result.status, "matched");
  if (result.status !== "matched") return;
  assert.equal(result.direction, "either");
  assert.deepEqual(
    result.valNotches.map((notch) => notch.order),
    [0, 1, 2, 3]
  );
});

test("matchSeamEdgeNotches: 実 .val の直辺 piece（waistband）は piece notch が空で no-match", () => {
  // 守る仕様: waistband は notch を持たない（`notches: []`）。合意どおり **notch 錨の無い直辺は v1 対象外**で、
  //   matcher は投げずに no-match へ degrade する（provenance-only に留まる）。
  const val = loadRealNotches("waistband");
  assert.deepEqual(val, []);
  assert.equal(matchSeamEdgeNotches([measured(0.5, "v")], val).status, "no-match");
});
