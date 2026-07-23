// 拘束 payload（v0）から seam の provenance を組み立てる pure 関数（core・決定的、T10）。数値は出さない
// （provenance-only）。v0 では依存は part 単位（`parts[].dependsOn`）なので、connector は存在確認だけに使い、
// 候補は対象 part の dependsOn から取る。長さに効かない出現（linearity:none = cutSpline / 導出点）を落とし、
// 残りに coupling の**弱いヒント**を付ける。
//
// coupling は安全判定ではない: 「usedBy が両側を覆えば安全」は退化ケースのみ真の over-claim だったので、増分候補は
// 参照増分の usedBy を part 単位の弱いヒント（`usedByHint`）として添えるに留める。信頼できる per-seam coupling は
// Seamlint の notch→edge 対応（[C6]）待ち。applicable（具体数値）も [C6] 依存で本関数の範囲外。
//
// CLI 結線済み（PR #33）: `tru propose --constraints <file>` から `makeResolveProvenance`（`src/cli/tru.ts`）経由で呼ばれ、
// seam 提案に source provenance を additive に載せる。subprocess runner（`loom truer request | tru propose`）は上流 Loomit の
// emitter（Slice 5）待ちで未結線。

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
      pieceWide: false,
      candidates: [],
      droppedNoneCount: 0,
      note: `payload に (${target.partId}, ${target.connectorId}) の connector が無い`
    };
  }
  const part = payload.parts.find((candidate) => candidate.partId === target.partId);
  if (!part) {
    return {
      target,
      pieceWide: false,
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

  // v0 の依存は piece 単位で connectorId では絞れない（[C6]）。多 seam piece では他 seam の候補も混ざるので、
  // 「この connector 専用」と誤解させないよう pieceWide を明示する。
  return {
    target,
    pieceWide: true,
    candidates,
    droppedNoneCount,
    note: `候補は piece "${part.piece}" 単位（connector で絞れない・[C6]）。多 seam piece では他 seam の候補も含む`
  };
}

function rank(linearity: string): number {
  return LINEARITY_ORDER[linearity] ?? 99;
}

function classifyCandidate(
  occurrence: ProvenanceCandidate["occurrence"],
  payload: ConstraintPayload
): ProvenanceCandidate {
  // 「動かせるツマミ」= declared:true の増分を参照する候補だけ increment とする。declared:false（宣言の無い参照）や
  // 参照無し（inline 値 / measurement）は turn できるツマミではないので part-local（片側編集になりうる危険側、[C8]）。
  const declaredRefs = occurrence.refs.filter((name) => payload.params[name]?.declared === true);
  if (declaredRefs.length === 0) {
    return {
      occurrence,
      coupling: "part-local",
      reason:
        occurrence.refs.length === 0
          ? "式に増分参照が無い（inline 値 / measurement）。片側編集になりうる（危険側）"
          : `参照増分 ${occurrence.refs.join(", ")} が全て未宣言（動かせるツマミ無し）。片側編集になりうる（危険側）`
    };
  }
  // declared:true の参照増分の usedBy の和を part 単位の**弱いヒント**として添える（安全判定ではない・per-seam は [C6] 待ち）。
  const usedByHint = [
    ...new Set(declaredRefs.flatMap((name) => payload.params[name]?.usedBy ?? []))
  ].sort();
  return {
    occurrence,
    coupling: "increment",
    usedByHint,
    reason: `動かせる増分 ${declaredRefs.join(", ")} を参照（usedBy=${usedByHint.join(", ") || "なし"}）。part 単位の弱いヒントで per-seam の両側判定は [C6] 待ち`
  };
}
