// pure な apply planner: safety gate を検証し vertex edit を計算する。IO も DXF への操作も一切しない。
// CLI が source text と、各 target edge の現在の points を取る関数（`slnt edges` 経由）を供給し、この
// planner を走らせ、その後 edit を DXF に差し込み（adapters/dxf/editNetLineVertex）、`--out` を atomic に
// 書く。gate をここに — pure に — 置くことで、test が filesystem 無しで「書く前に拒否する」を固定できる
//（references/critical-invariants.md T1 / T3 / T4）。
//
// gate（順番。どれかが失敗したら error を返し CLI は何も書かない）:
//   1. schema — 未知の proposal schema は明示的な error、決して mis-parse しない（T9）。
//   2. file 全体の digest — source は propose が digest したものでなければならない（T3 の backstop）。
//   3. accept — `--accepted` に名指しされた、または既に `status: "accepted"` の proposal だけを
//      適用する; 未知の `--accepted` id は無視せず名指しで報告する（T3）。
//   4. edge digest — addressing した各 edge は propose 時と byte 単位で一致していなければならない（T3）。
// 補正後 geometry は applyChanges から来る — preview が使うのと同じ関数（T2）— し、apply は fix solver を
// 再実行しない（T4）。

import { PROPOSAL_SCHEMA_V0 } from "../proposal/proposalSchema.ts";
import type { Point, ProposalFile } from "../proposal/proposalSchema.ts";
import { digestEdgePoints, digestText } from "../proposal/proposalDigest.ts";
import { EndpointMoveError, UnsupportedChangeKindError, applyChanges } from "./applyChanges.ts";

export const APPLY_UNSUPPORTED_SCHEMA = "apply.unsupported_schema";
export const APPLY_DIGEST_MISMATCH = "apply.digest_mismatch";
export const APPLY_NOT_ACCEPTED = "apply.not_accepted";

// CLI が DXF に差し込む 1 つの vertex edit（adapters/dxf/editNetLineVertex）: `blockName` の layer-14
// net line で、現在 `from` にある vertex を `to` へ動かす。
export interface VertexEdit {
  blockName: string;
  from: Point;
  to: Point;
}

export type ApplyPlan =
  | {
      status: "ok";
      edits: VertexEdit[];
      appliedIds: string[];
      skipped: { id: string; reason: string }[];
    }
  | { status: "error"; code: string; message: string };

export interface PlanApplyInput {
  file: ProposalFile;
  sourceText: string;
  acceptedIds: readonly string[];
  // target edge（blockName, edgeId）の現在の net-line points を source から取る。書き込み前に edge
  // digest を検証できるように。CLI が供給する（Seamlint `slnt edges`）。
  getCurrentPoints: (blockName: string, edgeId: string | undefined) => Point[] | undefined;
}

export function planApply(input: PlanApplyInput): ApplyPlan {
  const { file, sourceText, acceptedIds, getCurrentPoints } = input;

  if (file.schema !== PROPOSAL_SCHEMA_V0) {
    return {
      status: "error",
      code: APPLY_UNSUPPORTED_SCHEMA,
      message: `Unsupported proposal schema "${String(file.schema)}".`
    };
  }

  if (digestText(sourceText) !== file.source.sourceDigest) {
    return {
      status: "error",
      code: APPLY_DIGEST_MISMATCH,
      message: "Source DXF digest does not match the proposal (source changed since propose)."
    };
  }

  const accepted = new Set(acceptedIds);
  const ids = new Set(file.proposals.map((proposal) => proposal.id));
  const unknownAccepted = [...accepted].filter((id) => !ids.has(id));
  if (unknownAccepted.length > 0) {
    return {
      status: "error",
      code: APPLY_NOT_ACCEPTED,
      message: `No proposal with id ${unknownAccepted.map((id) => `"${id}"`).join(", ")} in this file.`
    };
  }

  const edits: VertexEdit[] = [];
  const appliedIds: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const proposal of file.proposals) {
    // accept 済み = --accepted に名指しされた、または file 内で既に accepted 済み（例: Studio による）。
    // どちらも明示的な人間の accept; contract はどちらも認める（T3）。
    const isAccepted = accepted.has(proposal.id) || proposal.status === "accepted";
    if (!isAccepted) {
      skipped.push({ id: proposal.id, reason: "not accepted" });
      continue;
    }
    if (proposal.mode === "preview-only" || proposal.changes.length === 0) {
      // accept 済みだが書く line が無い（preview-only は apply するものを何も見せない、T2）。
      skipped.push({ id: proposal.id, reason: "preview-only (nothing to apply)" });
      continue;
    }

    const address = `${proposal.target.blockName}/${proposal.target.edgeId ?? "?"}`;
    const current = getCurrentPoints(proposal.target.blockName, proposal.target.edgeId);
    if (!current) {
      return {
        status: "error",
        code: APPLY_DIGEST_MISMATCH,
        message: `Could not read the current geometry of ${address} to verify it before applying ${proposal.id}.`
      };
    }
    if (digestEdgePoints(current) !== proposal.target.targetDigest) {
      return {
        status: "error",
        code: APPLY_DIGEST_MISMATCH,
        message: `Edge ${address} changed since propose; refusing to apply ${proposal.id}.`
      };
    }

    let corrected: Point[];
    try {
      corrected = applyChanges(current, proposal.changes);
    } catch (error) {
      // apply が実行を拒否する change（未知 kind、T9 / endpoint move、T7）: 何か書く前に理由を名指しで
      // 挙げて run 全体を失敗させる。silent skip は決してしない。
      if (error instanceof UnsupportedChangeKindError || error instanceof EndpointMoveError) {
        return { status: "error", code: error.code, message: error.message };
      }
      throw error;
    }

    edits.push(...diffVertices(current, corrected, proposal.target.blockName));
    appliedIds.push(proposal.id);
  }

  return { status: "ok", edits, appliedIds, skipped };
}

// 動いた vertex を (from -> to) の edit として返す。決定的な順序（index 順）。apply は新たな丸めを
// 持ち込まない — `to` は fix が既に emit した値。
function diffVertices(
  before: readonly Point[],
  after: readonly Point[],
  blockName: string
): VertexEdit[] {
  const edits: VertexEdit[] = [];
  const count = Math.min(before.length, after.length);
  for (let index = 0; index < count; index += 1) {
    if (before[index]!.x !== after[index]!.x || before[index]!.y !== after[index]!.y) {
      edits.push({
        blockName,
        from: { x: before[index]!.x, y: before[index]!.y },
        to: { x: after[index]!.x, y: after[index]!.y }
      });
    }
  }
  return edits;
}
