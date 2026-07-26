import test from "node:test";
import assert from "node:assert/strict";

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
  const val = [valNotch(0, "v"), valNotch(1, "t"), valNotch(2, "castle"), valNotch(3, "u"), valNotch(4, "check")];
  const result = matchSeamEdgeNotches([measured(0.2, "t"), measured(0.5, "castle")], val);

  assert.equal(result.status, "matched");
  if (result.status !== "matched") return;
  assert.equal(result.direction, "forward");
  assert.deepEqual(result.valNotches.map((notch) => notch.order), [1, 2]);
});

test("matchSeamEdgeNotches: 向きが逆でも両方向試して reversed で同定する（CW/CCW 反転）", () => {
  // 守る仕様: 測定辺 [castle,t] が piece run [t,castle] の逆順に一致 → matched（reversed）。返す valNotches は輪郭 order のまま。
  const val = [valNotch(0, "v"), valNotch(1, "t"), valNotch(2, "castle"), valNotch(3, "u")];
  const result = matchSeamEdgeNotches([measured(0.3, "castle"), measured(0.6, "t")], val);

  assert.equal(result.status, "matched");
  if (result.status !== "matched") return;
  assert.equal(result.direction, "reversed");
  assert.deepEqual(result.valNotches.map((notch) => notch.order), [1, 2]);
});

test("matchSeamEdgeNotches: 輪郭は閉ループ。先頭/末尾をまたぐ wrap-around run も同定する（P2-1 回帰）", () => {
  // 守る仕様: order の末尾→先頭をまたぐ連続 run（3→4→0）を候補にする。線形走査だと取りこぼしていた。
  const val = [valNotch(0, "v"), valNotch(1, "t"), valNotch(2, "v"), valNotch(3, "castle"), valNotch(4, "u")];
  const result = matchSeamEdgeNotches(
    [measured(0.2, "castle"), measured(0.5, "u"), measured(0.8, "v")],
    val
  );

  assert.equal(result.status, "matched");
  if (result.status !== "matched") return;
  assert.equal(result.direction, "forward");
  // arc 順（run の輪郭順）で返す: 3→4→0。
  assert.deepEqual(result.valNotches.map((notch) => notch.order), [3, 4, 0]);
});

test("matchSeamEdgeNotches: run は一意でも向きが一意でなければ either を返す（過剰確定しない・P2-2 回帰）", () => {
  // 守る仕様: 2 個の閉ループでは [v,t] が forward（v から）でも reversed（t から逆）でも成立し向きは決められない。
  // run（集合）は一意なので matched だが direction は either（silent に forward と確定しない）。
  const val = [valNotch(0, "v"), valNotch(1, "t")];
  const result = matchSeamEdgeNotches([measured(0.3, "v"), measured(0.6, "t")], val);

  assert.equal(result.status, "matched");
  if (result.status !== "matched") return;
  assert.equal(result.direction, "either");
  assert.deepEqual(result.valNotches.map((notch) => notch.order), [0, 1]);
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
  assert.deepEqual(result.valNotches.map((notch) => notch.order), [0, 1, 2, 3]);
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
  const val = [valNotch(0, "t"), valNotch(1, "v"), valNotch(2, "castle"), valNotch(3, "u"), valNotch(4, "t")];
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
  assert.deepEqual(result.valNotches.map((notch) => notch.order), [1, 2, 3]);
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
