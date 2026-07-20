import assert from "node:assert/strict";
import test from "node:test";

import {
  computeBandCutOutline,
  offsetRectangleOutward,
  foldEdgeIndex
} from "../src/core/geometry-edit/bandCutOutline.ts";
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

// 半径 radius の円弧上に angle0..angle1 を m 点で。曲線バンド（円環扇形）の合成に使う。
function arcPoints(radius: number, angle0: number, angle1: number, m: number): Point[] {
  return Array.from({ length: m }, (_unused, i) => {
    const phi = angle0 + (angle1 - angle0) * (i / (m - 1));
    return { x: radius * Math.cos(phi), y: radius * Math.sin(phi) };
  });
}

// 円環扇形バンドの 4 辺（外弧=長辺・端=短辺2本・内弧=長辺）。閉ループ順（slnt edges 風）。
function annularBandEdges(
  rInner: number,
  rOuter: number,
  angle0: number,
  angle1: number,
  m: number
): Point[][] {
  const outer = arcPoints(rOuter, angle0, angle1, m);
  const inner = arcPoints(rInner, angle0, angle1, m);
  return [
    outer, // e0: 外弧 forward
    [outer[outer.length - 1]!, inner[inner.length - 1]!], // e1: angle1 端
    [...inner].reverse(), // e2: 内弧 reverse
    [inner[0]!, outer[0]!] // e3: angle0 端
  ];
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
  assert.equal(result.outline.kind, "rectangle");
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

test("accepts a straight edge that has extra collinear vertices (P2: no false negative)", () => {
  // 守る仕様: slnt edges は直線でも中間に collinear 頂点を持つ polyline を返しうる。頂点数（2 点ちょうど）
  //           ではなく同一直線性で straight を判定するので、有効な矩形バンドを曲線扱いで弾かない。
  const edges = [
    [
      { x: 0, y: 0 },
      { x: 175, y: 0 }, // collinear 中間頂点（端点間の直線上）
      { x: 350, y: 0 }
    ],
    [
      { x: 350, y: 0 },
      { x: 350, y: 40 }
    ],
    [
      { x: 350, y: 40 },
      { x: 0, y: 40 }
    ],
    [
      { x: 0, y: 40 },
      { x: 0, y: 0 }
    ]
  ];
  const result = computeBandCutOutline({ edges, targetLengthMm: 300 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outline.fromLengthMm, 350);
  assert.equal(result.outline.toLengthMm, 300);
  assert.equal(result.outline.heightMm, 40);
});

test("is deterministic (same input -> byte-identical output)", () => {
  // 守る仕様: pure・決定的（T10）。同じ入力から同じ輪郭。
  const input = { edges: rectEdges(WAISTBAND_CORNERS), targetLengthMm: 655 };
  assert.deepEqual(computeBandCutOutline(input), computeBandCutOutline(input));
});

test("conforms a curved band by arc-length scale: outer -> target, width preserved, kind curved", () => {
  // 守る仕様 (案A): 曲線バンド（4 辺 ribbon で 1 本以上が曲線）は弧長スケール。参照辺（最長=外弧）を目標弧長へ
  //           相似スケールし、幅は局所保持（内弧は局所幅ぶん内側）。円環扇形 r100/R140/90°: 外弧 140·π/2≈219.9。
  const edges = annularBandEdges(100, 140, 0, Math.PI / 2, 40);
  const result = computeBandCutOutline({ edges, targetLengthMm: 165 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.outline.kind, "curved");
  assert.ok(
    Math.abs(result.outline.fromLengthMm - 219.9) < 1,
    `from ~219.9: ${result.outline.fromLengthMm}`
  );
  assert.ok(Math.abs(result.outline.toLengthMm - 165) < 1, `to ~165: ${result.outline.toLengthMm}`);
  assert.ok(Math.abs(result.outline.heightMm - 40) < 1, `height ~40: ${result.outline.heightMm}`); // 幅 R-r=40 保持
  // 密 polyline（角 4 点ではない）。
  assert.ok(result.outline.corners.length > 4, `dense polyline: ${result.outline.corners.length}`);
});

test("curved conform is deterministic (T10)", () => {
  // 守る仕様: pure・決定的（固定サンプル数・決定的 anchor）。同じ入力から同じ輪郭。
  const edges = annularBandEdges(100, 140, 0, Math.PI / 2, 40);
  assert.deepEqual(
    computeBandCutOutline({ edges, targetLengthMm: 165 }),
    computeBandCutOutline({ edges, targetLengthMm: 165 })
  );
});

test("rejects an over-shrunk curved band whose inner contour would fold/self-intersect (T8, P1)", () => {
  // 守る仕様 (T8): 幅が縮小後の局所曲率半径を超えると内辺が反転して裁断不能になる。静かに success で出さず
  //           degenerate で reject する。R140/r100 の 90° 帯を target 60 へ → 縮小後外半径≈38 < 幅 40。
  const edges = annularBandEdges(100, 140, 0, Math.PI / 2, 40);
  const result = computeBandCutOutline({ edges, targetLengthMm: 60 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "degenerate");
});

test("rejects a 4-edge curved shape that is not a closed ribbon (T8)", () => {
  // 守る仕様 (T8): 曲線でも 4 辺が閉ループを成さなければ band 輪郭として扱わない（推測しない）。
  const outer = arcPoints(140, 0, Math.PI / 2, 10);
  const inner = arcPoints(100, 0, Math.PI / 2, 10);
  const edges = [
    outer,
    [outer[9]!, { x: 5, y: 5 }], // 端が inner 端に届かず閉じない
    [...inner].reverse(),
    [inner[0]!, outer[0]!]
  ];
  const result = computeBandCutOutline({ edges, targetLengthMm: 165 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "not-a-rectangle");
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

// ---- offsetRectangleOutward（縫い代 = 裁ち線）----

test("offsetRectangleOutward: 矩形を全辺 amount mm 外へ広げる（裁ち線）", () => {
  // 守る仕様: net 矩形の各辺を外向きに amount 動かす = 縫い代を足した裁ち線。軸並行は各角が (±amount) だけ外へ。
  const rect: Point[] = [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 300, y: 50 },
    { x: 0, y: 50 }
  ];
  assert.deepEqual(offsetRectangleOutward(rect, 10), [
    { x: -10, y: -10 },
    { x: 310, y: -10 },
    { x: 310, y: 60 },
    { x: -10, y: 60 }
  ]);
});

test("offsetRectangleOutward: amount <= 0 は net 輪郭のまま（縫い代なし）", () => {
  const rect: Point[] = [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 300, y: 50 },
    { x: 0, y: 50 }
  ];
  assert.deepEqual(offsetRectangleOutward(rect, 0), rect);
  assert.deepEqual(offsetRectangleOutward(rect, -5), rect);
});

test("offsetRectangleOutward: 回転矩形でも各辺が外へ amount 動く（辺長 +2·amount）", () => {
  const rect: Point[] = [
    { x: 0, y: 0 },
    { x: 300, y: 0 },
    { x: 300, y: 50 },
    { x: 0, y: 50 }
  ].map((corner) => rotate(corner, Math.PI / 6));
  const lens = edgeLengths(offsetRectangleOutward(rect, 10)).sort((a, b) => a - b);
  assert.ok(Math.abs(lens[0]! - 70) < 0.02 && Math.abs(lens[1]! - 70) < 0.02, `short ~70: ${lens}`);
  assert.ok(
    Math.abs(lens[2]! - 320) < 0.02 && Math.abs(lens[3]! - 320) < 0.02,
    `long ~320: ${lens}`
  );
});

const RECT_300x50: Point[] = [
  { x: 0, y: 0 }, // edge0 下（長辺）
  { x: 300, y: 0 }, // edge1 右（短辺）
  { x: 300, y: 50 }, // edge2 上（長辺）
  { x: 0, y: 50 } // edge3 左（短辺）
];

test("offsetRectangleOutward: 辺ごとの縫い代 — わ辺(0)はその辺だけ仕上がり線に一致（案A）", () => {
  // 守る仕様: わ辺（縫い代 0）はその辺の裁ち線が仕上がり線に重なる（法線方向へ動かない）。他辺は amount 外へ。
  //           形は変えない（ミラーしない）。edge0（下）をわ辺=0、他 3 辺=10。
  assert.deepEqual(offsetRectangleOutward(RECT_300x50, [0, 10, 10, 10]), [
    { x: -10, y: 0 }, // 下辺の裁ち線は y=0 = 仕上がり線に一致（縫い代 0）
    { x: 310, y: 0 },
    { x: 310, y: 60 },
    { x: -10, y: 60 }
  ]);
});

test("offsetRectangleOutward: 全辺同値の配列は scalar と一致（後方互換）", () => {
  // 守る仕様: number と「全辺同値の配列」は同じ裁ち線。per-edge 一般化が一様ケースを壊さない。
  assert.deepEqual(
    offsetRectangleOutward(RECT_300x50, [10, 10, 10, 10]),
    offsetRectangleOutward(RECT_300x50, 10)
  );
  // 全辺 0 の配列は net のまま。
  assert.deepEqual(offsetRectangleOutward(RECT_300x50, [0, 0, 0, 0]), RECT_300x50);
});

test("foldEdgeIndex: long=最長辺 / short=端辺 の代表 1 辺を決定的に選ぶ", () => {
  // 守る仕様: 対辺 2 本のうち midpoint が下（min y, tie は左 min x）の辺を代表に選ぶ（対称なので合同）。
  //           long → edge0(下, mid y=0)、short → edge3(左, mid x=0)。4 辺でなければ undefined。
  assert.equal(foldEdgeIndex(RECT_300x50, "long"), 0);
  assert.equal(foldEdgeIndex(RECT_300x50, "short"), 3);
  assert.equal(
    foldEdgeIndex(
      [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 0, y: 1 }
      ],
      "long"
    ),
    undefined
  );
});
