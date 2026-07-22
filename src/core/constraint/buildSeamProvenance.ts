// ⚠ 未結線・契約凍結（2026-07-23、レビュー D3）: constraint provenance の第一スライス（provenance-only）。
// このモジュールは CLI / proposal のどこからも呼ばれていない（未結線）。上流—Loomit の
// `loom truer request`（拘束 payload ビルダ = Slice 5）と、測定辺との突き合わせ（[C6]）—が確定するまで、
// 型・関数の shape を広げず凍結する。結線と数値提案（applicable）は上流確定後の別スライスで行う。
//
// 拘束 payload から seam の provenance を組み立てる pure 関数（core・決定的、T10）。数値は出さない
// （provenance-only）。長さに効かない出現（linearity:none = cutSpline / 導出点）を落とし、残りに coupling の
// 安全度を付けて「この seam の長さに効く候補＋役割＋安全度」を返す。applicable（具体数値）は測定辺との対応
// （[C6]）が要るので本関数の範囲外。

import type {
  ConstraintPayload,
  Coupling,
  ProvenanceCandidate,
  SeamProvenance
} from "./constraintTypes.ts";

// provenance の並び: linear を先、次に nonlinear（none は既に落としている）。
const LINEARITY_ORDER: Record<string, number> = { linear: 0, nonlinear: 1, none: 2 };

export function buildSeamProvenance(
  payload: ConstraintPayload,
  target: { partId: string; connectorId: string }
): SeamProvenance {
  // 同じ connectorId を持つ connector 群が 1 つの seam（両 part）。
  const sides = payload.connectors.filter(
    (connector) => connector.connectorId === target.connectorId
  );
  const thisSide = sides.find((connector) => connector.partId === target.partId);
  if (!thisSide) {
    return {
      target,
      candidates: [],
      droppedNoneCount: 0,
      note: `payload に (${target.partId}, ${target.connectorId}) の connector が無い`
    };
  }
  // seam の全 part（両側 coupling 判定に使う）。
  const seamParts = [...new Set(sides.map((connector) => connector.partId))];

  const kept = thisSide.dependsOn.filter((occurrence) => occurrence.linearity !== "none");
  const droppedNoneCount = thisSide.dependsOn.length - kept.length;

  const candidates: ProvenanceCandidate[] = kept
    .map((occurrence) => {
      const { coupling, reason } = classifyCoupling(occurrence.refs, payload, seamParts);
      return { occurrence, coupling, reason };
    })
    // linear を先に。同 linearity 内は入力順を保つ（安定ソート＝決定的、T10）。
    .sort((left, right) => rank(left.occurrence.linearity) - rank(right.occurrence.linearity));

  return { target, candidates, droppedNoneCount };
}

function rank(linearity: string): number {
  return LINEARITY_ORDER[linearity] ?? 99;
}

// coupling: 参照増分の usedBy が seam の全 part を覆うか。増分参照が無ければ inline 値/measurement で unknown。
function classifyCoupling(
  refs: readonly string[],
  payload: ConstraintPayload,
  seamParts: readonly string[]
): { coupling: Coupling; reason: string } {
  if (refs.length === 0) {
    // 増分参照が無い＝inline 値 / measurement。payload では両側が動く保証が無いので、安全側で part-local
    // （片側候補・危険寄り）として扱う（[C8]）。measurement はグローバルだが判別は defer、expr を見て人が判断。
    return {
      coupling: "part-local",
      reason:
        "式に増分参照が無い（inline 値 / measurement）。両側が動く保証が無く片側編集になりうる（危険側）"
    };
  }
  const allCovered = refs.every((name) => {
    const param = payload.params[name];
    if (!param) return false; // parser の inv3 が守られていれば起きない
    return seamParts.every((part) => param.usedBy.includes(part));
  });
  return allCovered
    ? {
        coupling: "both-sides",
        reason: `参照増分 ${refs.join(", ")} が seam 両側に効く（usedBy）`
      }
    : {
        coupling: "one-side",
        reason: "参照増分の usedBy が seam の片側しか覆わない（対応が壊れる）"
      };
}
