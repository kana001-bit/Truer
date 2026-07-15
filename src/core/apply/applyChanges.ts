// The single function that turns a proposal's `changes` into corrected edge geometry.
//
// Both `preview` (the overlay's blue "after" line) and `apply` (what gets written to the
// corrected DXF) go through THIS function — never a second, preview-only approximation — so
// the line a human accepts in preview is byte-for-byte the line apply writes
// (references/critical-invariants.md T2). apply also does not re-run any fix solver: it just
// replays the recorded `changes` (T4).
//
// Pure and deterministic (T10): same points + same changes -> same output, no IO / time /
// randomness. Operates on the addressed edge's net-line points (DXF flattened polyline). Unknown
// change kinds are an explicit error, never a silent skip (T9).

import type { Change, Point } from "../proposal/proposalSchema.ts";

export const APPLY_UNSUPPORTED_CHANGE_KIND = "apply.unsupported_change_kind";
export const APPLY_ENDPOINT_MOVE_FORBIDDEN = "apply.endpoint_move_forbidden";

// Thrown when a change carries a kind applyChanges cannot execute on net-line points. The CLI
// turns this into an `apply.unsupported_change_kind` error report rather than writing anything
// (T9); it never silently drops the change.
export class UnsupportedChangeKindError extends Error {
  readonly code = APPLY_UNSUPPORTED_CHANGE_KIND;
  readonly kind: string;

  constructor(kind: string) {
    super(`apply does not support change kind ${JSON.stringify(kind)} on a net-line edge`);
    this.name = "UnsupportedChangeKindError";
    this.kind = kind;
  }
}

// Thrown when a move-vertex change targets an edge endpoint (first or last vertex). Endpoints carry
// seam / notch / closure meaning, so the first slice never moves them (T7). The curve_kink fix never
// emits such a change; this is the apply/preview backstop against a hand-edited or corrupted proposal
// slipping an endpoint move past validation.
export class EndpointMoveError extends Error {
  readonly code = APPLY_ENDPOINT_MOVE_FORBIDDEN;
  readonly vertexIndex: number;

  constructor(vertexIndex: number, pointCount: number) {
    super(
      `move-vertex targets vertex ${vertexIndex}, an endpoint of the ${pointCount}-point edge; endpoints are never moved (T7)`
    );
    this.name = "EndpointMoveError";
    this.vertexIndex = vertexIndex;
  }
}

// Applies `changes` in order to a copy of `points`, returning the corrected net-line points.
// The input is never mutated (purity). Coordinates are copied verbatim from the recorded change
// — the fix already did the (rounded, deterministic) geometry math, so apply introduces no new
// rounding of its own (T10: rounding lives at the fix's emit boundary, not here).
export function applyChanges(points: readonly Point[], changes: readonly Change[]): Point[] {
  let result: Point[] = points.map((point) => ({ x: point.x, y: point.y }));
  for (const change of changes) {
    result = applyOne(result, change);
  }
  return result;
}

function applyOne(points: Point[], change: Change): Point[] {
  switch (change.kind) {
    case "move-vertex": {
      const { vertexIndex } = change;
      if (vertexIndex < 0 || vertexIndex >= points.length) {
        // A recorded index outside the edge means the proposal and the edge disagree; refuse
        // rather than write a garbled line. (The digest gate should catch a changed edge before
        // this, but applyChanges stays defensive so it never emits NaN or an out-of-range write.)
        throw new RangeError(
          `move-vertex vertexIndex ${vertexIndex} is out of range for an edge with ${points.length} points`
        );
      }
      // T7: never move an endpoint, even if a hand-edited proposal asks for it. The fix only ever
      // targets interior vertices; this is the last line of defense before a physical write.
      if (vertexIndex === 0 || vertexIndex === points.length - 1) {
        throw new EndpointMoveError(vertexIndex, points.length);
      }
      const next = points.slice();
      next[vertexIndex] = { x: change.to.x, y: change.to.y };
      return next;
    }
    // `replace-path-data` is a legacy SVG kind (operates on a path `d` string, not net-line
    // points), so it cannot be applied here. Treat it — and any future/unknown kind — as an
    // explicit unsupported-kind error (T9), never a silent skip.
    default:
      throw new UnsupportedChangeKindError((change as Change).kind);
  }
}
