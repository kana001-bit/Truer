// geometry.seam_length_mismatch の両 edge を net-line points に解決する。Seamlint の `slnt edges` を
// shell 呼び出しして行う（A1: library import ではなく subprocess — 消費経路は Seamlint の文書化された
// CLI/structuralEdges contract であって、その内部実装ではない）。
//
// diagnostic は既に各辺の address `actual.fromEdge/toEdge = { blockName, edgeId, arcRange }` を持つ
//（Seamlint edge-addressing bridge）。この resolver はその address を使って edge の `points` を
// `slnt edges` から取り、edgeId を変換し（number -> string）、各辺の長さは diagnostic の
// fromLengthMm/toLengthMm（mismatch を測っている値）から取る。
//
// どちらを固定（基準 = reference）とみなすかは、CLI `--reference` で渡された BLOCK 名集合と from/to edge の
// blockName を照合して決める（片側だけ一致→その側が reference）。集合が空、両側一致、どちらも不一致のときは
// 決めない（reference undefined＝両方向 preview-only, T6、推測しない）。人が打つ part 名→BLOCK 名の翻訳は
// 上流（Loomit の `loom match`）が持ち、ここには解決済みの BLOCK 名が届く。

import type {
  DiagnosticInput,
  ResolvedSeamEdge,
  SeamEdgeNeighbor,
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

// 隣辺の軽量ビュー。points が辺として成立しない（2 点未満）候補は付けない — solver 側の
// 共有角チェックと合わせ、壊れた隣辺で corner-slide を解かないための defensive（T8）。
function toNeighbor(edge: SlntEdge | undefined): SeamEdgeNeighbor | undefined {
  if (!edge || !Array.isArray(edge.points) || edge.points.length < 2) return undefined;
  return { edgeId: String(edge.edgeId), points: edge.points };
}

function resolveEdge(
  address: EdgeAddress,
  lengthMm: number,
  runEdges: SlntEdgesRunner
): ResolvedSeamEdge | undefined {
  const result = runEdges(address.blockName);
  const index = result.edges.findIndex((candidate) => candidate.edgeId === address.edgeId);
  const edge = result.edges[index];
  if (!edge || !Array.isArray(edge.points) || edge.points.length < 2) return undefined;

  // 隣辺（②corner-slide の solve 用）: Seamlint の edges はループ順（edge[k].endPoint ===
  // edge[k+1].startPoint、閉ループなので wrap-around）。始点角の隣 = k-1、終点角の隣 = k+1。
  // 並びがループ順でない slnt 実装でも、solver の共有角チェックが不一致を弾く（推測しない）。
  const count = result.edges.length;
  let neighbors: ResolvedSeamEdge["neighbors"];
  if (count >= 2) {
    const start = toNeighbor(result.edges[(index - 1 + count) % count]);
    const end = toNeighbor(result.edges[(index + 1) % count]);
    if (start || end) {
      neighbors = { ...(start ? { start } : {}), ...(end ? { end } : {}) };
    }
  }

  return {
    blockName: address.blockName,
    edgeId: String(address.edgeId), // Seamlint は number で出す; Truer の schema は string を使う。
    ...(address.arcRange ? { arcRange: address.arcRange } : {}),
    points: edge.points,
    lengthMm,
    ...(neighbors !== undefined ? { neighbors } : {})
  };
}

export function buildResolveSeamPair(
  runEdges: SlntEdgesRunner,
  // 固定（基準 = reference）とみなす辺の BLOCK 名集合（`--reference`）。省略 / 空なら reference を決めず
  // 両方向 preview-only（T6）。順序は無関係なので Set 化して照合する。
  referenceBlockNames: readonly string[] = []
): (diagnostic: DiagnosticInput) => SeamPairResolution {
  const referenceBlocks = new Set(referenceBlockNames);
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

    // reference（固定辺）の決定: from/to の blockName が `--reference` 集合にあるかを見て、片側だけ一致すれば
    // その側を固定とする。両側一致（同一 BLOCK 内 seam / 両方指定）や、どちらも不一致は決めない
    //（reference undefined＝両方向を提示, T6、推測しない）。
    const fromIsReference = referenceBlocks.has(fromAddress.blockName);
    const toIsReference = referenceBlocks.has(toAddress.blockName);
    let reference: "from" | "to" | undefined;
    if (fromIsReference && !toIsReference) {
      reference = "from";
    } else if (toIsReference && !fromIsReference) {
      reference = "to";
    }

    return {
      status: "resolved",
      fromEdge,
      toEdge,
      ...(reference !== undefined ? { reference } : {})
    };
  };
}
