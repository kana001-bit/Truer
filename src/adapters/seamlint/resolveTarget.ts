// Seamlint `slnt edges`（A1 subprocess）による単一 edge の target 解決。builder は 2 つ:
//
//   - buildResolveTarget: propose 用。curve_kink diagnostic は edge address を
//     `actual.edge = { blockName, edgeId, arcRange? }` に持つ（Seamlint edge-addressing bridge、S0）。
//     この address を読んで edge の net-line `points` を取り、proposal を self-contained にする。
//   - buildEdgePointsLookup: apply 用。proposal target の (blockName, edgeId) を受け、source edge の
//     現在の points を取り直し、apply が書く前に edge digest を検証できるようにする（T3）。
//
// どちらも `slnt edges` を通る — Truer は自分で DXF を parse しない。edgeId は Seamlint では number、
// Truer の schema では string で、この境界で変換する。

import type {
  DiagnosticInput,
  ResolveTargetResult,
  ResolvedTarget
} from "../../core/proposal/createProposalFile.ts";
import type { Point } from "../../core/proposal/proposalSchema.ts";
import { readEdgeAddress } from "./edgeAddress.ts";
import type { SlntEdgesRunner } from "./resolveSeamPair.ts";

// 各 BLOCK の edges を run ごとに高々 1 回だけ問い合わせる（propose/apply を決定的に保ち、複数の
// diagnostic が同じ block に触れるときの冗長な subprocess 起動を避ける）。
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
    // edge address が無い（例: Seamlint がこの diagnostic に emit していない）-> 解決不能。
    // 推測はしない: diagnostic は silent に補正せず skip として記録する（T6 / T8）。
    if (!address) return { status: "not-found" };
    const points = fetchEdgePoints(run, address.blockName, address.edgeId);
    if (!points) return { status: "not-found" };
    const target: ResolvedTarget = {
      blockName: address.blockName,
      edgeId: String(address.edgeId),
      ...(address.arcRange ? { arcRange: address.arcRange } : {}),
      // Seamlint の正確な vertex index（curve_kink のみ）を運び、fix が座標一致を省けるようにする。
      // seam pair / 古い report には無い; その場合 fix は点での一致に戻る。
      ...(address.vertexIndex !== undefined ? { vertexIndex: address.vertexIndex } : {}),
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
