// geometry.seam_length_mismatch の両 edge を net-line points に解決する。Seamlint の `slnt edges` を
// shell 呼び出しして行う（A1: library import ではなく subprocess — 消費経路は Seamlint の文書化された
// CLI/structuralEdges contract であって、その内部実装ではない）。
//
// diagnostic は既に各辺の address `actual.fromEdge/toEdge = { blockName, edgeId, arcRange }` を持つ
//（Seamlint edge-addressing bridge）。この resolver はその address を使って edge の `points` を
// `slnt edges` から取り、edgeId を変換し（number -> string）、各辺の長さは diagnostic の
// fromLengthMm/toLengthMm（mismatch を測っている値）から取る。どちらが Δ を吸収するかは未決のまま
//（まだ Loomit/人間の reference token が無い）なので、ペアは両方向で提示し（T6）、proposal は
// preview-only のまま。

import type {
  DiagnosticInput,
  ResolvedSeamEdge,
  SeamPairResolution
} from "../../core/proposal/createProposalFile.ts";
import type { Point } from "../../core/proposal/proposalSchema.ts";
import { readEdgeAddress } from "./edgeAddress.ts";
import type { EdgeAddress } from "./edgeAddress.ts";

// この resolver が消費する `slnt edges --json` 出力の部分集合: 各 edge の id と points。
// 余分な field（arcRange/lengthMm/darts/notches/...）はここでは無視する — address と length は
// diagnostic から来る。
export interface SlntEdge {
  edgeId: number;
  points: Point[];
}

export interface SlntEdgesResult {
  blockName: string;
  edges: SlntEdge[];
}

// `slnt edges <dxf> --block <blockName> --json` を実行し、parse 済みの結果を返す。core と tests を
// pure に保ち「slnt がどこに在るか」の判断を CLI の関心事にするため注入する。slnt の実行が失敗
//（systemic）すると throw しうる — それは伝播する; 単に edge が無いだけなら not-found を返す。
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
    edgeId: String(address.edgeId), // Seamlint は number で出す; Truer の schema は string を使う。
    ...(address.arcRange ? { arcRange: address.arcRange } : {}),
    points: edge.points,
    lengthMm
  };
}

export function buildResolveSeamPair(
  runEdges: SlntEdgesRunner
): (diagnostic: DiagnosticInput) => SeamPairResolution {
  // 各 BLOCK の edges を propose run ごとに高々 1 回だけ問い合わせる（1 つの report が同じ block 上に
  // 複数の mismatch を持ちうる）。propose を決定的に保ち、冗長な subprocess 起動を避ける。
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
    // edge address が無い（例: 縫い合わせ seam の whole-path）-> 解決できるペアではない。
    if (!fromAddress || !toAddress) return { status: "not-found" };

    const fromEdge = resolveEdge(fromAddress, numberOr(actual?.fromLengthMm, 0), cachedRun);
    const toEdge = resolveEdge(toAddress, numberOr(actual?.toLengthMm, 0), cachedRun);
    if (!fromEdge || !toEdge) return { status: "not-found" };

    // reference は未決（Loomit/人間の token 無し）-> 両方向を提示する（T6）。
    return { status: "resolved", fromEdge, toEdge };
  };
}
