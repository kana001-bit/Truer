import assert from "node:assert/strict";
import test from "node:test";

import { solveCornerSlide } from "../src/core/fixes/cornerSlide.ts";

// conform 辺: (0,0)→(0,100) の直辺。end 角 C=(0,100)、その隣接頂点 V=(0,0)。
const EDGE = [
  { x: 0, y: 0 },
  { x: 0, y: 100 }
];
// C を共有する水平の直線隣辺 C(0,100)→N(50,100)。
const PERPENDICULAR_NEIGHBOR = [
  { x: 0, y: 100 },
  { x: 50, y: 100 }
];

test("corner-slide extends the edge along a straight neighbor (circle ∩ line, toward the neighbor on a tie)", () => {
  // 守る仕様 (T10): 目標 = 現在長 + Δ を円（中心 V）∩ 直線（C, 隣辺方向）で解く。垂直隣辺は
  //           2 根が対称（±t）になるが、隣辺の向き側（t>0 = N へ向かう）を決定的に選ぶ。
  const result = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: PERPENDICULAR_NEIGHBOR,
    deltaMm: 5
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  const expectedSlide = Math.sqrt(105 * 105 - 100 * 100); // = √1025
  assert.ok(Math.abs(result.slideDistanceMm - expectedSlide) < 1e-9);
  // 解の検算: 滑らせた角と V の距離が目標長 105 になっている。
  const v = EDGE[0]!;
  assert.ok(Math.abs(Math.hypot(result.newCorner.x - v.x, result.newCorner.y - v.y) - 105) < 1e-9);
  // 対称根の tie-break は隣辺の向き（N 側 = +x）。
  assert.ok(result.newCorner.x > 0);
  assert.equal(result.newCorner.y, 100);
  // 連動 warning の材料: 隣辺長は 50 → 50 − √1025。
  assert.ok(Math.abs(result.neighborLengthBeforeMm - 50) < 1e-9);
  assert.ok(Math.abs(result.neighborLengthAfterMm - (50 - expectedSlide)) < 1e-9);
});

test("corner-slide shrinks the edge along a collinear continuation neighbor", () => {
  // 守る仕様: 縮める向き（Δ<0）も同じ式で解ける。辺の延長方向の隣辺なら角を 5mm 引き戻す解になる。
  const result = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: [
      { x: 0, y: 100 },
      { x: 0, y: 150 }
    ],
    deltaMm: -5
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(Math.abs(result.slideDistanceMm - 5) < 1e-9);
  assert.ok(Math.abs(result.newCorner.x) < 1e-9);
  assert.ok(Math.abs(result.newCorner.y - 95) < 1e-9);
  assert.ok(Math.abs(result.neighborLengthBeforeMm - 50) < 1e-9);
  assert.ok(Math.abs(result.neighborLengthAfterMm - 55) < 1e-9);
});

test("corner-slide picks the minimal-|t| root on a slanted neighbor (minimal change)", () => {
  // 守る仕様 (T6 の精神/T10): 2 根が非対称なら移動が小さい方を決定的に選ぶ。
  const result = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: [
      { x: 0, y: 100 },
      { x: 100, y: 200 }
    ],
    deltaMm: 5
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  // b = d·(C−V) = 100/√2、|t| = √(b²+1025) − b（小さい方の根）。
  const b = 100 / Math.SQRT2;
  const expected = Math.sqrt(b * b + 1025) - b;
  assert.ok(Math.abs(result.slideDistanceMm - expected) < 1e-9);
  const v = EDGE[0]!;
  assert.ok(Math.abs(Math.hypot(result.newCorner.x - v.x, result.newCorner.y - v.y) - 105) < 1e-9);
});

test("corner-slide solves the start corner symmetrically", () => {
  // 守る仕様: corner:"start" は points[0] の角を、points[1] を V として同じ式で解く。
  const result = solveCornerSlide({
    edgePoints: EDGE,
    corner: "start",
    neighborPoints: [
      { x: 0, y: 0 },
      { x: -50, y: 0 }
    ],
    deltaMm: 5
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.ok(Math.abs(result.slideDistanceMm - Math.sqrt(1025)) < 1e-9);
  // 隣辺の向き（N = −x 側）へ滑る。
  assert.ok(result.newCorner.x < 0);
});

test("corner-slide refuses a curved neighbor (no unique tangent)", () => {
  // 守る仕様: 隣辺が**幾何的に**直線でなければ solve しない（設計で確定。preview-only のまま）。
  //           点数ではなく弦からのズレで判定する（中間頂点があるだけの直線辺は下の test で解ける）。
  const result = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: [
      { x: 0, y: 100 },
      { x: 25, y: 110 }, // 弦から 10mm 外れる = 曲線
      { x: 50, y: 100 }
    ],
    deltaMm: 5
  });
  assert.deepEqual(result, { ok: false, reason: "curved-neighbor" });
});

test("corner-slide solves a straight neighbor that carries intermediate vertices", () => {
  // 守る仕様（[S7]）: 実データの直線辺は collinear な中間頂点を持つのが普通（ノッチ位置が polyline 頂点として
  //           記録される）。点数で切ると実データではほとんど解けないので、幾何的に直線なら端点へ畳んで解く。
  //           **畳んでも解は変わらない**ことを、同じ幾何の 2 点版と厳密比較して固定する。
  const withVertices = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: [
      { x: 0, y: 100 },
      { x: 40, y: 100 }, // 弦上（ノッチ相当）。スライド量 √1025≈32mm より遠いので通り越さない。
      { x: 50, y: 100 }
    ],
    deltaMm: 5
  });
  const twoPoint = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: PERPENDICULAR_NEIGHBOR,
    deltaMm: 5
  });
  assert.ok(withVertices.ok);
  assert.deepEqual(withVertices, twoPoint);
});

test("corner-slide reports the neighbor length as a polyline, not the chord", () => {
  // 守る仕様: 隣辺長は連動 warning として人が読む（定規で測れる値）。中間頂点がわずかに弦から外れていると
  //           折れ線長は弦より長いので、折れ線で測る。2 点隣辺では両者が一致するので従来の値は変わらない。
  //           あわせて、角が隣辺の**末尾**にある向きでも同じ解になること（向きの正規化）を固定する。
  const forward = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: [
      { x: 0, y: 100 },
      { x: 40, y: 100.3 }, // 弦から 0.3mm（直線判定の許容内）
      { x: 50, y: 100 }
    ],
    deltaMm: 5
  });
  assert.ok(forward.ok);
  if (!forward.ok) return;
  const chordLen = 50;
  const polylineLen = Math.hypot(40, 0.3) + Math.hypot(10, 0.3);
  assert.ok(Math.abs(forward.neighborLengthBeforeMm - polylineLen) < 1e-9);
  assert.ok(forward.neighborLengthBeforeMm > chordLen);

  // 同じ隣辺を逆順（角が末尾）で渡しても同一の解。
  const reversed = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: [
      { x: 50, y: 100 },
      { x: 40, y: 100.3 },
      { x: 0, y: 100 }
    ],
    deltaMm: 5
  });
  assert.deepEqual(reversed, forward);
});

test("corner-slide refuses a neighbor whose vertices backtrack along the chord", () => {
  // 守る仕様 (T6/T8): `isStraightEdge` は中間頂点と**無限直線**の距離しか見ないので、C→(20,100)→N(10,100) の
  //   ような**行って戻る** polyline も「直線」と判定される。向きが定まらないものを滑らせると、折り返したままの
  //   輪郭を**裁断用 SVG として刷ってしまう**（人はそれを 1:1 で布に当てる）。射影の単調増加まで確認して拒否する。
  const backtracking = [
    { x: 0, y: 100 },
    { x: 20, y: 100 }, // N より先へ行って…
    { x: 10, y: 100 } // …戻る（弦上なので isStraightEdge は true）
  ];
  // Δ を小さく取ると解 t≈8.9mm は隣辺長 10mm の内側に収まる = 単調性を見ないと ok になってしまう Δ。
  const result = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: backtracking,
    deltaMm: 0.4
  });
  assert.deepEqual(result, { ok: false, reason: "backtracking-neighbor" });

  // 同じ点を単調な順に並べれば（C→(10,100)→N(20,100)）解ける = 拒んでいるのは折り返しであって点数ではない。
  const monotonic = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: [
      { x: 0, y: 100 },
      { x: 10, y: 100 },
      { x: 20, y: 100 }
    ],
    deltaMm: 0.4
  });
  assert.ok(monotonic.ok);

  // 重複頂点（射影が進まない）も、どちらが生きているか決められないので同じく拒否する。
  const duplicated = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: [
      { x: 0, y: 100 },
      { x: 10, y: 100 },
      { x: 10, y: 100 },
      { x: 20, y: 100 }
    ],
    deltaMm: 0.4
  });
  assert.deepEqual(duplicated, { ok: false, reason: "backtracking-neighbor" });
});

test("corner-slide refuses to slide past an intermediate vertex of the neighbor", () => {
  // 守る仕様（T6）: 差し替えるのは共有角 1 点だけで、中間頂点は動かさない（実データではノッチ位置）。
  //           滑らせる先がその頂点に届くと、通り越した輪郭は折り返す — 頂点を黙って捨てたり動かしたりせず
  //           解かない。理由も "no-solution"（幾何的に届かない）と混ぜない。
  const slanted = [
    { x: 0, y: 100 },
    { x: 100, y: 200 }
  ];
  // 同じ幾何で、中間頂点だけを足したもの。頂点は C から 3mm の位置（解は約 6.9mm 先）。
  const blocked = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: [slanted[0]!, { x: 3 / Math.SQRT2, y: 100 + 3 / Math.SQRT2 }, slanted[1]!],
    deltaMm: 5
  });
  assert.deepEqual(blocked, { ok: false, reason: "slide-past-neighbor-vertex" });

  // 中間頂点が無ければ同じ Δ・同じ直線で解ける = 阻んでいるのは頂点であって幾何ではない。
  const unblocked = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: slanted,
    deltaMm: 5
  });
  assert.ok(unblocked.ok);
});

test("corner-slide falls back to the other root when a vertex blocks the minimal one", () => {
  // 守る仕様: 中間頂点があると正方向だけに限界ができる（負方向 = 隣辺を延ばす向きは頂点を通り越さない）。
  //           限界が非対称になるので**両方の根を検査**する。片方が頂点に阻まれても、もう片方が隣辺の範囲に
  //           収まっているなら裁てる解は実在する — それを no-solution にすると裁てるものを取りこぼす。
  //           （2 点隣辺は限界が ±neighborLen で対称なので、この分岐は従来の結果を変えない。）
  const result = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: [
      { x: 0, y: 100 },
      { x: 20, y: 100 }, // 正方向の解 +√1025≈32mm はこの頂点を通り越す
      { x: 50, y: 100 }
    ],
    deltaMm: 5
  });
  assert.ok(result.ok);
  if (!result.ok) return;
  const expectedSlide = Math.sqrt(105 * 105 - 100 * 100);
  assert.ok(Math.abs(result.slideDistanceMm - expectedSlide) < 1e-9);
  assert.ok(result.newCorner.x < 0, "頂点を通り越さない負方向（隣辺を延ばす側）の根を選ぶ");
  // 解であることの検算: 補正後も conform 辺長は目標 105mm。
  const v = EDGE[0]!;
  assert.ok(Math.abs(Math.hypot(result.newCorner.x - v.x, result.newCorner.y - v.y) - 105) < 1e-9);
});

test("corner-slide refuses a neighbor that does not share the corner", () => {
  // 守る仕様 (T8): 隣辺がその角を端点に持たない＝ループ順前提が崩れている。推測して解かない。
  const result = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: [
      { x: 10, y: 110 },
      { x: 60, y: 110 }
    ],
    deltaMm: 5
  });
  assert.deepEqual(result, { ok: false, reason: "detached-corner" });
});

test("corner-slide refuses degenerate geometry (zero-length segment or neighbor)", () => {
  // 守る仕様 (T10): 方向の定まらないゼロ長 segment / 隣辺では壊れた数値を出さず、解けないと言う。
  const zeroSegment = solveCornerSlide({
    edgePoints: [
      { x: 0, y: 100 },
      { x: 0, y: 100 }
    ],
    corner: "end",
    neighborPoints: PERPENDICULAR_NEIGHBOR,
    deltaMm: 5
  });
  assert.deepEqual(zeroSegment, { ok: false, reason: "degenerate" });

  const zeroNeighbor = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: [
      { x: 0, y: 100 },
      { x: 0, y: 100 }
    ],
    deltaMm: 5
  });
  assert.deepEqual(zeroNeighbor, { ok: false, reason: "degenerate" });

  const tooFewPoints = solveCornerSlide({
    edgePoints: [{ x: 0, y: 0 }],
    corner: "end",
    neighborPoints: PERPENDICULAR_NEIGHBOR,
    deltaMm: 5
  });
  assert.deepEqual(tooFewPoints, { ok: false, reason: "degenerate" });
});

test("corner-slide reports no-solution instead of emitting broken numbers", () => {
  // 守る仕様 (T8/T10): 幾何的に届かないケースは no-solution。
  // (1) 縮めすぎ（末端 segment 長が 0 以下）は**別の理由**にする: 機構の容量オーバーであって、
  //     「隣辺の向きでは届かない」とは原因が違う（実データで実際に当たる壁なので取り違えさせない）。
  const collapsed = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: PERPENDICULAR_NEIGHBOR,
    deltaMm: -100
  });
  assert.deepEqual(collapsed, { ok: false, reason: "delta-exceeds-end-segment" });

  // (2) 垂直隣辺で縮める: 隣辺直線上のどの点も V から 100mm 以上（判別式 < 0）。
  const unreachable = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: PERPENDICULAR_NEIGHBOR,
    deltaMm: -5
  });
  assert.deepEqual(unreachable, { ok: false, reason: "no-solution" });
});

test("corner-slide refuses a slide beyond the finite neighbor segment (no flip past the far corner)", () => {
  // 守る仕様（レビュー P2）: 解は円∩無限直線なので、|t| が隣辺長以上（反対端 N を通り越して隣辺が
  //           反転する / 隣辺長を超える大延長）は「隣辺に沿って滑らせる」操作ではない。ok にせず
  //           no-solution とし、advisory 候補に載せない。
  // 再現: 隣辺 50mm に対し Δ=+100 → t = √(200²−100²) = 173.2… > 50。修正前は (173.2,100) を ok で返していた。
  const beyondFar = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: PERPENDICULAR_NEIGHBOR,
    deltaMm: 100
  });
  assert.deepEqual(beyondFar, { ok: false, reason: "no-solution" });

  // 負方向（隣辺の延長側）も同じ上限: 隣辺 3mm の延長線上を 5mm 引き戻す解は範囲外。
  const beyondNear = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: [
      { x: 0, y: 100 },
      { x: 0, y: 103 }
    ],
    deltaMm: -5
  });
  assert.deepEqual(beyondNear, { ok: false, reason: "no-solution" });

  // 境界の内側は依然解ける（隣辺 50mm・スライド √1025 ≈ 32mm < 50）。
  const inside = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: PERPENDICULAR_NEIGHBOR,
    deltaMm: 5
  });
  assert.ok(inside.ok);
});

test("corner-slide is deterministic (same input, same output)", () => {
  // 守る仕様 (T10): pure。時刻・乱数に依らず同じ入力から同じ出力。
  const input = {
    edgePoints: EDGE,
    corner: "end" as const,
    neighborPoints: [
      { x: 0, y: 100 },
      { x: 100, y: 200 }
    ],
    deltaMm: 5
  };
  assert.deepEqual(solveCornerSlide(input), solveCornerSlide(input));
});
