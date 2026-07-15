// curve_kink fix rule (first slice of M4 ①): given the addressed edge's net-line points and the
// Seamlint kink point, decide whether Truer can confidently smooth the kink, and if so produce the
// minimal change that does it.
//
// Correction (decision (i), 2026-07-16): move the ONE interior vertex the kink sits on onto the
// straight line between its two neighbours (chord projection), making the three points collinear so
// the sharp turn disappears. One vertex only — minimal and local (T6); endpoints are never moved
// (T7); anything Truer cannot map with confidence falls back to preview-only (T8). Pure and
// deterministic: same input -> same output, rounding only at the emit boundary (T10). The returned
// `changes` are replayed verbatim by applyChanges for both preview and apply (T2 / T4).

import type { Change, IntentConfidence, Point } from "../proposal/proposalSchema.ts";
import { nearestVertexIndex, projectOntoLine, roundPoint } from "../geometry-edit/index.ts";

// How close (mm) the diagnostic point must sit to a net-line vertex to count as "this vertex". The
// kink point comes from Seamlint's sampled points (rounded); on a flattened polyline those are the
// net-line vertices, so a real match is ~0. Anything farther means the point does not land on a
// vertex we can move — fall back to preview-only rather than guess (T8).
const VERTEX_MATCH_TOLERANCE_MM = 0.01;

export interface CurveKinkFixInput {
  // Addressed edge's net-line vertices (from Seamlint `slnt edges`, canonical points).
  points: readonly Point[];
  // Seamlint `actual.point` — where the sharp turn is.
  diagnosticPoint: Point;
}

export interface CurveKinkFix {
  mode: "preview-only" | "local-adjustment";
  changes: Change[];
  intent: { kind: string; confidence: IntentConfidence; reviewRequired: true };
  notes: string[];
}

function previewOnly(note: string): CurveKinkFix {
  return {
    mode: "preview-only",
    changes: [],
    intent: { kind: "inspect-local-kink", confidence: "low", reviewRequired: true },
    notes: [note]
  };
}

export function buildCurveKinkFix(input: CurveKinkFixInput): CurveKinkFix {
  const { points, diagnosticPoint } = input;

  // Need at least one interior vertex (>= 3 points) to have two neighbours to smooth between.
  if (points.length < 3) {
    return previewOnly(
      "辺の頂点が少なく（3 点未満）、内部の頂点を滑らかに戻せません。確認のみ (preview-only)。"
    );
  }

  const index = nearestVertexIndex(points, diagnosticPoint, VERTEX_MATCH_TOLERANCE_MM);
  if (index === undefined) {
    return previewOnly(
      "診断点が辺の net-line 頂点に一意に対応づきません。推測で線を引かず確認のみ (preview-only)。"
    );
  }

  // T7: endpoints carry seam / notch / closure meaning; never move them in the first slice.
  if (index === 0 || index === points.length - 1) {
    return previewOnly(
      "kink が辺の端点に対応します。端点は縫い合わせ・閉じの意味を持つため動かさず確認のみ (preview-only)。"
    );
  }

  const original = points[index]!;
  const projected = projectOntoLine(original, points[index - 1]!, points[index + 1]!);
  if (projected === undefined || !Number.isFinite(projected.x) || !Number.isFinite(projected.y)) {
    return previewOnly("隣接 2 点が退化していて滑らかな線を作れません。確認のみ (preview-only)。");
  }

  const to = roundPoint(projected);
  const roundedOriginal = roundPoint(original);
  // Already on the chord (after emit rounding): nothing to move. Do not emit a no-op change.
  if (to.x === roundedOriginal.x && to.y === roundedOriginal.y) {
    return previewOnly(
      "頂点は既に滑らかな線上にあり、動かす補正はありません。確認のみ (preview-only)。"
    );
  }

  const change: Change = { kind: "move-vertex", vertexIndex: index, to };
  return {
    mode: "local-adjustment",
    changes: [change],
    intent: { kind: "smooth-curve-kink", confidence: "medium", reviewRequired: true },
    notes: [
      `辺内部の頂点 ${index} を、隣り合う 2 点を結ぶ線上へ寄せて kink を滑らかにします。`,
      "端点は動かしていません。採用すると補正済み DXF を --out に書きます (preview==apply)。"
    ]
  };
}
