// Resolves BOTH edges of a geometry.seam_length_mismatch to their net-line points, by shelling
// out to Seamlint's `slnt edges` (A1: subprocess, not library import — the consumption path is
// Seamlint's documented CLI/structuralEdges contract, not its internals).
//
// The diagnostic already carries each side's address `actual.fromEdge/toEdge =
// { blockName, edgeId, arcRange }` (Seamlint edge-addressing bridge). This resolver uses those
// addresses to pull the edge's `points` from `slnt edges`, coerces edgeId (number -> string),
// and takes each side's length from the diagnostic's fromLengthMm/toLengthMm (what the mismatch
// is measured on). Which side absorbs Δ stays undecided (no Loomit/human reference token yet),
// so the pair is presented both directions (T6) and the proposal stays preview-only.

import type {
  DiagnosticInput,
  ResolvedSeamEdge,
  SeamPairResolution
} from "../../core/proposal/createProposalFile.ts";
import type { Point } from "../../core/proposal/proposalSchema.ts";
import { readEdgeAddress } from "./edgeAddress.ts";
import type { EdgeAddress } from "./edgeAddress.ts";

// The subset of `slnt edges --json` output this resolver consumes: each edge's id and points.
// Extra fields (arcRange/lengthMm/darts/notches/...) are ignored here — addresses and lengths
// come from the diagnostic.
export interface SlntEdge {
  edgeId: number;
  points: Point[];
}

export interface SlntEdgesResult {
  blockName: string;
  edges: SlntEdge[];
}

// Runs `slnt edges <dxf> --block <blockName> --json` and returns the parsed result. Injected so
// core and tests stay pure and the "where does slnt live" decision is a CLI concern. May throw
// if slnt fails to run (systemic) — that propagates; a merely-missing edge returns not-found.
export type SlntEdgesRunner = (blockName: string) => SlntEdgesResult;

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function resolveEdge(
  address: EdgeAddress,
  lengthMm: number,
  runEdges: SlntEdgesRunner
): ResolvedSeamEdge | undefined {
  const result = runEdges(address.blockName);
  const edge = result.edges.find((candidate) => candidate.edgeId === address.edgeId);
  if (!edge || !Array.isArray(edge.points) || edge.points.length < 2) return undefined;
  return {
    blockName: address.blockName,
    edgeId: String(address.edgeId), // Seamlint emits number; Truer's schema uses string.
    ...(address.arcRange ? { arcRange: address.arcRange } : {}),
    points: edge.points,
    lengthMm
  };
}

export function buildResolveSeamPair(
  runEdges: SlntEdgesRunner
): (diagnostic: DiagnosticInput) => SeamPairResolution {
  // Query each BLOCK's edges at most once per propose run (a report may hold several mismatches
  // over the same blocks). Keeps propose deterministic and avoids redundant subprocess spawns.
  const cache = new Map<string, SlntEdgesResult>();
  const cachedRun: SlntEdgesRunner = (blockName) => {
    const hit = cache.get(blockName);
    if (hit) return hit;
    const result = runEdges(blockName);
    cache.set(blockName, result);
    return result;
  };

  return (diagnostic) => {
    const actual = diagnostic.actual;
    const fromAddress = readEdgeAddress(actual?.fromEdge);
    const toAddress = readEdgeAddress(actual?.toEdge);
    // No edge addresses (e.g. sewn-seam whole-path) -> not a pair we can resolve.
    if (!fromAddress || !toAddress) return { status: "not-found" };

    const fromEdge = resolveEdge(fromAddress, numberOr(actual?.fromLengthMm, 0), cachedRun);
    const toEdge = resolveEdge(toAddress, numberOr(actual?.toLengthMm, 0), cachedRun);
    if (!fromEdge || !toEdge) return { status: "not-found" };

    // reference undecided (no Loomit/human token) -> both directions presented (T6).
    return { status: "resolved", fromEdge, toEdge };
  };
}
