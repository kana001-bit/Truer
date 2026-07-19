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
  // 守る仕様: 隣辺が直線（ちょうど 2 点）でなければ solve しない（設計で確定。preview-only のまま）。
  const result = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: [
      { x: 0, y: 100 },
      { x: 25, y: 110 },
      { x: 50, y: 100 }
    ],
    deltaMm: 5
  });
  assert.deepEqual(result, { ok: false, reason: "curved-neighbor" });
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
  // (1) 縮めすぎ: 末端 segment 長が 0 以下になる。
  const collapsed = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: PERPENDICULAR_NEIGHBOR,
    deltaMm: -100
  });
  assert.deepEqual(collapsed, { ok: false, reason: "no-solution" });

  // (2) 垂直隣辺で縮める: 隣辺直線上のどの点も V から 100mm 以上（判別式 < 0）。
  const unreachable = solveCornerSlide({
    edgePoints: EDGE,
    corner: "end",
    neighborPoints: PERPENDICULAR_NEIGHBOR,
    deltaMm: -5
  });
  assert.deepEqual(unreachable, { ok: false, reason: "no-solution" });
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
