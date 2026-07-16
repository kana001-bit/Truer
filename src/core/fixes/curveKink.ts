// curve_kink fix rule（M4 ① の first slice）: addressing した edge の net-line points と Seamlint の
// kink point を受け取り、Truer が確信を持って kink を滑らかにできるか判断し、できるならそれを行う
// 最小の change を作る。
//
// 補正（decision (i)、2026-07-16）: kink が乗っている内部 vertex 1 つを、その両隣を結ぶ直線上へ
// 動かし（弦への射影）、3 点を共線にして鋭い折れを消す。vertex は 1 つだけ — 最小・局所（T6）;
// endpoint は決して動かさない（T7）; Truer が確信を持って対応づけられないものは preview-only に
// 落とす（T8）。pure かつ決定的: 同じ入力 -> 同じ出力、丸めは emit 境界のみ（T10）。返す `changes` は
// preview でも apply でも applyChanges がそのまま再生する（T2 / T4）。

import type { Change, IntentConfidence, Point } from "../proposal/proposalSchema.ts";
import {
  nearestVertexIndex,
  pointsWithin,
  projectOntoLine,
  roundPoint
} from "../geometry-edit/index.ts";

// 診断点が net-line vertex に「この vertex」と見なせるほど近い距離（mm）。kink point は Seamlint の
// サンプル点（丸め済み）由来; flattened polyline ではそれらが net-line vertex なので、本当の一致は
// ~0。それより遠ければ、点は動かせる vertex に乗っていない — 推測せず preview-only に落とす（T8）。
const VERTEX_MATCH_TOLERANCE_MM = 0.01;

export interface CurveKinkFixInput {
  // addressing した edge の net-line 頂点（Seamlint `slnt edges` 由来、canonical points）。
  points: readonly Point[];
  // Seamlint `actual.point` — 鋭い折れがある位置。
  diagnosticPoint: Point;
  // `points` 内の kink vertex の正確な index（任意）。Seamlint が actual.edge.vertexIndex に載せて
  // いるときに使う。座標一致が非一意で弾いた tie を解くために使うが、`diagnosticPoint` と整合する
  // ときだけ（resolveVertexIndex 参照）: 点と食い違う index は stale な report を意味するので、信頼せず
  // 無視する（T8）。古い report には無い; その場合 fix は従来どおり点で一致させる。
  vertexIndex?: number;
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

// kink がどの vertex に乗っているか。Seamlint の正確な `vertexIndex` を優先するが、診断点と整合する
// ときだけ: 両方とも同じ report 由来なので、正しい report では `points[vertexIndex]` は `actual.point` に
// ある。stale / 別リビジョンの report は、もう点と一致しない vertexIndex を持ちうる; それを盲信すると
// 人間が flag されたのを見ていない vertex を動かす — confidently-wrong な編集（T8）。だから index の
// 唯一の役目は、座標一致が非一意（ほぼ重なる vertex）で弾いた tie を解くこと; 大きな不一致を上書き
// することは決してない。index が無い / 範囲外 / 不整合なら座標一致に戻り、それ自身も点が単一 vertex に
// 対応しないとき undefined を返す（-> preview-only）— まさに vertexIndex 導入前の安全な挙動。呼び出し側の
// endpoint guard（T7）はどちらでも依然として効く。
function resolveVertexIndex(input: CurveKinkFixInput): number | undefined {
  const { points, diagnosticPoint, vertexIndex } = input;
  if (
    vertexIndex !== undefined &&
    Number.isInteger(vertexIndex) &&
    vertexIndex >= 0 &&
    vertexIndex < points.length &&
    pointsWithin(points[vertexIndex]!, diagnosticPoint, VERTEX_MATCH_TOLERANCE_MM)
  ) {
    return vertexIndex;
  }
  return nearestVertexIndex(points, diagnosticPoint, VERTEX_MATCH_TOLERANCE_MM);
}

export function buildCurveKinkFix(input: CurveKinkFixInput): CurveKinkFix {
  const { points } = input;

  // 間を滑らかにする両隣を持つには、内部 vertex が最低 1 つ（3 点以上）要る。
  if (points.length < 3) {
    return previewOnly(
      "辺の頂点が少なく（3 点未満）、内部の頂点を滑らかに戻せません。確認のみ (preview-only)。"
    );
  }

  const index = resolveVertexIndex(input);
  if (index === undefined) {
    return previewOnly(
      "診断点が辺の net-line 頂点に一意に対応づきません。推測で線を引かず確認のみ (preview-only)。"
    );
  }

  // T7: endpoint は seam / notch / 閉じ線の意味を持つ; first slice では決して動かさない。
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
  // 既に弦上にある（emit 丸め後）: 動かすものは無い。no-op の change を emit しない。
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
