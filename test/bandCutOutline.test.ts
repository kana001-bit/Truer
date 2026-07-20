import assert from "node:assert/strict";
import test from "node:test";

import { computeBandCutOutline } from "../src/core/geometry-edit/bandCutOutline.ts";
import type { Point } from "../src/core/proposal/proposalSchema.ts";

// 閉じた 4 角から矩形の辺列（各辺 2 点）を作る。
function rectEdges(corners: readonly Point[]): Point[][] {
  return corners.map((corner, i) => [corner, corners[(i + 1) % corners.length]!]);
}

// 閉じた輪郭の各辺長。
function edgeLengths(corners: readonly Point[]): number[] {
  return corners.map((corner, i) => {
    const next = corners[(i + 1) % corners.length]!;
    return Math.hypot(next.x - corner.x, next.y - corner.y);
  });
}

function rotate(corner: Point, radians: number): Point {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { x: corner.x * c - corner.y * s, y: corner.x * s + corner.y * c };
}

// 実データ WAISTBAND と同じ 860×50 の軸並行矩形。
const WAISTBAND_CORNERS: Point[] = [
  { x: 381.2, y: 1074.5 },
  { x: 1241.2, y: 1074.5 },
  { x: 1241.2, y: 1024.5 },
  { x: 381.2, y: 1024.5 }
];

test("resizes an axis-aligned rectangle: longest edge -> target, height unchanged", () => {
  // 守る仕様: band conform の目標長へ最長辺だけを縮め、短辺（高さ）と直角は保つ。860 -> 655 / 高さ 50。
  const result = computeBandCutOutline({
    edges: rectEdges(WAISTBAND_CORNERS),
    targetLengthMm: 655
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outline.fromLengthMm, 860);
  assert.equal(result.outline.toLengthMm, 655);
  assert.equal(result.outline.heightMm, 50);
  // 最長辺 860 だけ 655 に、短辺 50 は不変。
  assert.deepEqual(result.outline.corners, [
    { x: 381.2, y: 1074.5 },
    { x: 1036.2, y: 1074.5 },
    { x: 1036.2, y: 1024.5 },
    { x: 381.2, y: 1024.5 }
  ]);
});

test("resizes a rotated rectangle too (axis-independent)", () => {
  // 守る仕様: 回転してエクスポートされた矩形でも、最長辺方向に沿ってスケールし目標長へ合わせる（高さ不変）。
  const rotated = WAISTBAND_CORNERS.map((corner) => rotate(corner, Math.PI / 6)); // 30°
  const result = computeBandCutOutline({ edges: rectEdges(rotated), targetLengthMm: 655 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const lens = edgeLengths(result.outline.corners).sort((a, b) => a - b);
  // 短辺 2 本 ≈ 50、長辺 2 本 ≈ 655（丸め誤差以内）。
  assert.ok(Math.abs(lens[0]! - 50) < 0.05 && Math.abs(lens[1]! - 50) < 0.05, `short ~50: ${lens}`);
  assert.ok(
    Math.abs(lens[2]! - 655) < 0.05 && Math.abs(lens[3]! - 655) < 0.05,
    `long ~655: ${lens}`
  );
});

test("is deterministic (same input -> byte-identical output)", () => {
  // 守る仕様: pure・決定的（T10）。同じ入力から同じ輪郭。
  const input = { edges: rectEdges(WAISTBAND_CORNERS), targetLengthMm: 655 };
  assert.deepEqual(computeBandCutOutline(input), computeBandCutOutline(input));
});

test("rejects a curved edge (does not guess a net line, T8)", () => {
  // 守る仕様: 曲線辺（3 点以上）は輪郭を推測しない。
  const edges = [
    [
      { x: 0, y: 0 },
      { x: 100, y: 0 }
    ],
    [
      { x: 100, y: 0 },
      { x: 100, y: 50 }
    ],
    [
      { x: 100, y: 50 },
      { x: 50, y: 60 },
      { x: 0, y: 50 }
    ], // 曲線（3 点）
    [
      { x: 0, y: 50 },
      { x: 0, y: 0 }
    ]
  ];
  const result = computeBandCutOutline({ edges, targetLengthMm: 655 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "non-straight-edge");
});

test("rejects a non-rectangle (trapezoid) (T8)", () => {
  // 守る仕様: 台形（対辺が等長でない / 隣辺が直角でない）はスケールで高さが崩れるので出さない。
  const trapezoid: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 80, y: 50 },
    { x: 20, y: 50 }
  ];
  const result = computeBandCutOutline({ edges: rectEdges(trapezoid), targetLengthMm: 655 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not-a-rectangle");
});

test("rejects a non-4-sided outline (T8)", () => {
  // 守る仕様: 4 辺の矩形でなければ矩形として扱わない（三角形など）。
  const triangle: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 50, y: 50 }
  ];
  const result = computeBandCutOutline({ edges: rectEdges(triangle), targetLengthMm: 655 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not-a-rectangle");
});

test("rejects a non-positive target length (degenerate)", () => {
  // 守る仕様: 目標長が非正 / 非有限なら退化として出さない。
  for (const target of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = computeBandCutOutline({
      edges: rectEdges(WAISTBAND_CORNERS),
      targetLengthMm: target
    });
    assert.equal(result.ok, false, `target=${target}`);
    if (result.ok) continue;
    assert.equal(result.reason, "degenerate");
  }
});
