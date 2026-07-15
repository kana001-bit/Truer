// Pure geometry helpers for edge/vertex edits: nearest-vertex mapping, chord projection, and the
// single emit-rounding boundary. No IO, no domain knowledge — just points in, points out
// (references/implementation-rules.md Module Boundaries). Rounding lives HERE and only here so
// preview and apply emit identical coordinates and proposals stay byte-stable (T10).

import type { Point } from "../proposal/proposalSchema.ts";

// Decimal places at the geometry emit boundary. Corrected coordinates are rounded here and only
// here (T10). 3 places mirrors Seamlint's point rounding — sub-micron at mm scale, far below any
// cut precision — so it never changes the pattern in a way a human could see.
export const EMIT_DECIMALS = 3;

export function roundCoord(value: number): number {
  const factor = 10 ** EMIT_DECIMALS;
  return Math.round(value * factor) / factor;
}

export function roundPoint(point: Point): Point {
  return { x: roundCoord(point.x), y: roundCoord(point.y) };
}

function distanceSq(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// Index of the vertex nearest `target`, but only if it is within `tolerance` AND unambiguous (no
// other vertex within tolerance). Returns undefined otherwise: the diagnostic point does not land
// cleanly on exactly one net-line vertex, so the caller must not guess which vertex to move (T8).
export function nearestVertexIndex(
  points: readonly Point[],
  target: Point,
  tolerance: number
): number | undefined {
  const tolSq = tolerance * tolerance;
  let best = -1;
  let bestSq = Infinity;
  let withinCount = 0;
  for (let index = 0; index < points.length; index += 1) {
    const dSq = distanceSq(points[index]!, target);
    if (dSq <= tolSq) withinCount += 1;
    if (dSq < bestSq) {
      bestSq = dSq;
      best = index;
    }
  }
  if (best < 0 || bestSq > tolSq || withinCount !== 1) return undefined;
  return best;
}

// Foot of the perpendicular from `p` onto the infinite line through `a` and `b`. Placing the kink
// vertex here makes it collinear with its two neighbours, so the sharp turn is removed. Full
// precision (rounding happens once, at the emit boundary). Returns undefined when a and b coincide
// (no line to project onto).
export function projectOntoLine(p: Point, a: Point, b: Point): Point | undefined {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return undefined;
  const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  return { x: a.x + t * abx, y: a.y + t * aby };
}
