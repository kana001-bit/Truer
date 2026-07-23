// 拘束 payload（v0）から seam の provenance を組み立てる pure 関数（core・決定的、T10）。数値は出さない
// （provenance-only）。v0 では依存は part 単位（`parts[].dependsOn`）なので、connector は存在確認だけに使い、
// 候補は対象 part の dependsOn から取る。長さに効かない出現（linearity:none = cutSpline / 導出点）を落とし、
// 残りに coupling の**弱いヒント**を付ける。
//
// coupling は安全判定ではない: 「usedBy が両側を覆えば安全」は退化ケースのみ真の over-claim だったので、増分候補は
// 参照増分の usedBy を part 単位の弱いヒント（`usedByHint`）として添えるに留める。信頼できる per-seam coupling は
// Seamlint の notch→edge 対応（[C6]）待ち。applicable（具体数値）も [C6] 依存で本関数の範囲外。
//
// ⚠ CLI 未結線（2026-07-23）: このモジュールはまだ CLI / proposal から呼ばれていない。上流の
// `loom truer request`（Slice 5）が実装され次第、CLI で結線する。

import type { ConstraintPayload, ProvenanceCandidate, SeamProvenance } from "./constraintTypes.ts";

// provenance の並び: linear を先、次に nonlinear（none は既に落としている）。
const LINEARITY_ORDER: Record<string, number> = { linear: 0, nonlinear: 1, none: 2 };

export function buildSeamProvenance(
  payload: ConstraintPayload,
  target: { partId: string; connectorId: string }
): SeamProvenance {
  // v0: connector は join 鍵。seam の存在を connectors[] で確認し、依存は parts[partId].dependsOn から取る。
  const connectorExists = payload.connectors.some(
    (connector) =>
      connector.partId === target.partId && connector.connectorId === target.connectorId
  );
  if (!connectorExists) {
    return {
      target,
      candidates: [],
      droppedNoneCount: 0,
      note: `payload に (${target.partId}, ${target.connectorId}) の connector が無い`
    };
  }
  const part = payload.parts.find((candidate) => candidate.partId === target.partId);
  if (!part) {
    return {
      target,
      candidates: [],
      droppedNoneCount: 0,
      note: `payload に part "${target.partId}" が無い`
    };
  }

  const kept = part.dependsOn.filter((occurrence) => occurrence.linearity !== "none");
  const droppedNoneCount = part.dependsOn.length - kept.length;

  const candidates: ProvenanceCandidate[] = kept
    .map((occurrence) => classifyCandidate(occurrence, payload))
    // linear を先に。同 linearity 内は入力順を保つ（安定ソート＝決定的、T10）。
    .sort((left, right) => rank(left.occurrence.linearity) - rank(right.occurrence.linearity));

  return { target, candidates, droppedNoneCount };
}

function rank(linearity: string): number {
  return LINEARITY_ORDER[linearity] ?? 99;
}

function classifyCandidate(
  occurrence: ProvenanceCandidate["occurrence"],
  payload: ConstraintPayload
): ProvenanceCandidate {
  // 増分参照が無い＝inline 値 / measurement。片側編集になりうるので危険側（part-local）で見せる（[C8]）。
  if (occurrence.refs.length === 0) {
    return {
      occurrence,
      coupling: "part-local",
      reason:
        "式に増分参照が無い（inline 値 / measurement）。両側が動く保証が無く片側編集になりうる（危険側）"
    };
  }
  // 参照増分の usedBy の和を part 単位の**弱いヒント**として添える（安全判定ではない。per-seam 両側判定は [C6] 待ち）。
  const usedByHint = [
    ...new Set(occurrence.refs.flatMap((name) => payload.params[name]?.usedBy ?? []))
  ].sort();
  return {
    occurrence,
    coupling: "increment",
    usedByHint,
    reason: `増分 ${occurrence.refs.join(", ")} を参照（usedBy=${usedByHint.join(", ") || "なし"}）。part 単位の弱いヒントで per-seam の両側判定は [C6] 待ち`
  };
}
