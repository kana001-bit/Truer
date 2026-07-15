// Single-edge target resolution via Seamlint `slnt edges` (A1 subprocess). Two builders:
//
//   - buildResolveTarget: for propose. A curve_kink diagnostic carries its edge address on
//     `actual.edge = { blockName, edgeId, arcRange? }` (Seamlint edge-addressing bridge, S0). This
//     reads that address and pulls the edge's net-line `points`, so the proposal is self-contained.
//   - buildEdgePointsLookup: for apply. Given a proposal target's (blockName, edgeId), re-fetch the
//     source edge's CURRENT points so apply can verify the edge digest before writing (T3).
//
// Both go through `slnt edges` — Truer never parses DXF itself. edgeId is number in Seamlint and
// string in Truer's schema, coerced at this boundary.

import type {
  DiagnosticInput,
  ResolveTargetResult,
  ResolvedTarget
} from "../../core/proposal/createProposalFile.ts";
import type { Point } from "../../core/proposal/proposalSchema.ts";
import { readEdgeAddress } from "./edgeAddress.ts";
import type { SlntEdgesRunner } from "./resolveSeamPair.ts";

// Queries each BLOCK's edges at most once per run (keeps propose/apply deterministic and avoids
// redundant subprocess spawns when several diagnostics touch the same block).
function cachingRunner(runEdges: SlntEdgesRunner): SlntEdgesRunner {
  const cache = new Map<string, ReturnType<SlntEdgesRunner>>();
  return (blockName) => {
    const hit = cache.get(blockName);
    if (hit) return hit;
    const result = runEdges(blockName);
    cache.set(blockName, result);
    return result;
  };
}

function fetchEdgePoints(
  run: SlntEdgesRunner,
  blockName: string,
  edgeId: number
): Point[] | undefined {
  const result = run(blockName);
  const edge = result.edges.find((candidate) => candidate.edgeId === edgeId);
  if (!edge || !Array.isArray(edge.points) || edge.points.length < 2) return undefined;
  return edge.points;
}

export function buildResolveTarget(
  runEdges: SlntEdgesRunner
): (diagnostic: DiagnosticInput) => ResolveTargetResult {
  const run = cachingRunner(runEdges);
  return (diagnostic) => {
    const address = readEdgeAddress(diagnostic.actual?.edge);
    // No edge address (e.g. Seamlint has not emitted one for this diagnostic) -> not resolvable.
    // Never guessed: the diagnostic is recorded as skipped, not silently corrected (T6 / T8).
    if (!address) return { status: "not-found" };
    const points = fetchEdgePoints(run, address.blockName, address.edgeId);
    if (!points) return { status: "not-found" };
    const target: ResolvedTarget = {
      blockName: address.blockName,
      edgeId: String(address.edgeId),
      ...(address.arcRange ? { arcRange: address.arcRange } : {}),
      points
    };
    return { status: "resolved", target };
  };
}

export function buildEdgePointsLookup(
  runEdges: SlntEdgesRunner
): (blockName: string, edgeId: string | undefined) => Point[] | undefined {
  const run = cachingRunner(runEdges);
  return (blockName, edgeId) => {
    if (edgeId === undefined) return undefined;
    const numeric = Number(edgeId);
    if (!Number.isInteger(numeric)) return undefined;
    return fetchEdgePoints(run, blockName, numeric);
  };
}
