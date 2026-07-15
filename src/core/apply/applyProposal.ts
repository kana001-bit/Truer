// Pure apply planner: verify the safety gates and compute the vertex edits, WITHOUT doing any IO or
// touching the DXF. The CLI supplies the source text and a function to fetch each target edge's
// current points (via `slnt edges`), runs this planner, then splices the edits into the DXF
// (adapters/dxf/editNetLineVertex) and writes `--out` atomically. Keeping the gates here — pure —
// lets tests pin "refuse before any write" without a filesystem (references/critical-invariants.md
// T1 / T3 / T4).
//
// Gates, in order (any failure returns an error and the CLI writes nothing):
//   1. schema — unknown proposal schema is an explicit error, never mis-parsed (T9).
//   2. whole-file digest — the source must be the one propose digested (T3 backstop).
//   3. accept — only proposals named in `--accepted` OR already marked `status: "accepted"` are
//      applied; unknown `--accepted` ids are named, not ignored (T3).
//   4. edge digest — each addressed edge must be byte-identical to propose time (T3).
// The corrected geometry comes from applyChanges — the SAME function preview uses (T2) — and apply
// never re-runs a fix solver (T4).

import { PROPOSAL_SCHEMA_V0 } from "../proposal/proposalSchema.ts";
import type { Point, ProposalFile } from "../proposal/proposalSchema.ts";
import { digestEdgePoints, digestText } from "../proposal/proposalDigest.ts";
import { EndpointMoveError, UnsupportedChangeKindError, applyChanges } from "./applyChanges.ts";

export const APPLY_UNSUPPORTED_SCHEMA = "apply.unsupported_schema";
export const APPLY_DIGEST_MISMATCH = "apply.digest_mismatch";
export const APPLY_NOT_ACCEPTED = "apply.not_accepted";

// One vertex edit the CLI will splice into the DXF (adapters/dxf/editNetLineVertex): move the vertex
// currently at `from` to `to` in `blockName`'s layer-14 net line.
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
  // Fetches the CURRENT net-line points of a target edge (blockName, edgeId) from the source, so the
  // edge digest can be verified before writing. Supplied by the CLI (Seamlint `slnt edges`).
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
    // Accepted = named in --accepted, OR already marked accepted in the file (e.g. by a Studio).
    // Both are explicit human acceptance; the contract honors either (T3).
    const isAccepted = accepted.has(proposal.id) || proposal.status === "accepted";
    if (!isAccepted) {
      skipped.push({ id: proposal.id, reason: "not accepted" });
      continue;
    }
    if (proposal.mode === "preview-only" || proposal.changes.length === 0) {
      // Accepted but there is no line to write (preview-only shows nothing to apply, T2).
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
      // A change apply refuses to execute (unknown kind, T9 / endpoint move, T7): fail the whole run
      // before writing anything, naming the reason. Never a silent skip.
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

// The vertices that moved, as (from -> to) edits. Deterministic order (by index). apply introduces
// no new rounding — `to` is the value the fix already emitted.
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
