// geometry.band_seam_sum_mismatch の N-ary band 診断を解決する。band 辺は住所（actual.bandEdge）から
// net-line points まで解決し（digest / preview 用）、neighbours は住所+finished+cut のまま運ぶ
//（points 解決も preview 描画もしない first slice）。measured 値（bandTotal/sum/closure）は診断から
// 来る。reference（固定される正）は CLI `--reference` の BLOCK 名集合と band/neighbour の blockName を
// 照合して決める: band 固定 → "band"（neighbours を直す向き）/ neighbour 固定 → "neighbours"（band が
// conform・目標長あり）/ 両方 or どちらも無し → undefined（両方向 preview-only, T6、推測しない）。
//
// bandEdge を emit しない旧 Seamlint report では band 辺を addressing できない → not-found（推測しない）。
// core builder はそれを SKIP_MISSING_BAND_FIELDS の理由付き skip に落とす（T6/T8）。

import type {
  BandSeamResolution,
  DiagnosticInput,
  ResolvedBandNeighbor,
  ResolvedSeamEdge
} from "../../core/proposal/createProposalFile.ts";
import { readEdgeAddress, readArcRange } from "./edgeAddress.ts";
import type { SlntEdgesRunner } from "./resolveSeamPair.ts";

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

// neighbour trace 1 件を読む。住所（blockName + edgeId/arcRange の少なくとも一方）と finished 長
// （非負）・裁断枚数（正の整数）が揃わなければ undefined（壊れた trace は proposal に持ち込まない）。
function readNeighbor(value: unknown): ResolvedBandNeighbor | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.blockName !== "string" || raw.blockName.length === 0) return undefined;
  const edgeId =
    typeof raw.edgeId === "number" && Number.isInteger(raw.edgeId) ? String(raw.edgeId) : undefined;
  const arcRange = readArcRange(raw.arcRange);
  if (edgeId === undefined && arcRange === undefined) return undefined; // 住所が無い
  const finishedLengthMm = finiteNumber(raw.finishedLengthMm);
  const cutQuantity = positiveInt(raw.cutQuantity);
  if (finishedLengthMm === undefined || finishedLengthMm < 0 || cutQuantity === undefined) {
    return undefined;
  }
  return {
    blockName: raw.blockName,
    ...(edgeId !== undefined ? { edgeId } : {}),
    ...(arcRange !== undefined ? { arcRange } : {}),
    finishedLengthMm,
    cutQuantity
  };
}

export function buildResolveBandSeam(
  runEdges: SlntEdgesRunner,
  // 固定（基準 = reference）とみなす BLOCK 名集合（`--reference`）。band と neighbour で共有する
  // （pairwise の resolveSeamPair と同じ集合を CLI が渡す）。
  referenceBlockNames: readonly string[] = []
): (diagnostic: DiagnosticInput) => BandSeamResolution {
  const referenceBlocks = new Set(referenceBlockNames);
  const cache = new Map<string, ReturnType<SlntEdgesRunner>>();
  const cachedRun: SlntEdgesRunner = (blockName) => {
    const hit = cache.get(blockName);
    if (hit) return hit;
    const result = runEdges(blockName);
    cache.set(blockName, result);
    return result;
  };

  return (diagnostic) => {
    const actual = diagnostic.actual;
    // band 辺の住所（B1 で additive 追加。旧 report には無い → 解決できないペアではない）。
    const bandAddress = readEdgeAddress(actual?.bandEdge);
    if (!bandAddress) return { status: "not-found" };

    const bandLengthMm = finiteNumber(actual?.bandLengthMm);
    const bandCutQuantity = positiveInt(actual?.bandCutQuantity);
    const bandTotalMm = finiteNumber(actual?.bandTotalMm);
    const sumMm = finiteNumber(actual?.sumMm);
    const closureMm = finiteNumber(actual?.closureMm); // 符号付き（+ = バンドが長い）
    const closurePct = finiteNumber(actual?.closurePct);
    if (
      bandLengthMm === undefined ||
      bandLengthMm < 0 ||
      bandCutQuantity === undefined ||
      bandTotalMm === undefined ||
      sumMm === undefined ||
      closureMm === undefined ||
      closurePct === undefined
    ) {
      return { status: "not-found" };
    }

    // neighbours（住所つき trace）。空 / 壊れた要素があれば proposal を作らない（推測しない, T6）。
    const rawNeighbours = actual?.neighbours;
    if (!Array.isArray(rawNeighbours) || rawNeighbours.length === 0) return { status: "not-found" };
    const neighbours: ResolvedBandNeighbor[] = [];
    for (const raw of rawNeighbours) {
      const neighbour = readNeighbor(raw);
      if (!neighbour) return { status: "not-found" };
      neighbours.push(neighbour);
    }

    // band 辺の net-line points を `slnt edges` から解決（digest / preview 用）。addressing した辺が
    // 無い / points が辺にならない（2 点未満）なら解決失敗。
    const edgesResult = cachedRun(bandAddress.blockName);
    const edge = edgesResult.edges.find((candidate) => candidate.edgeId === bandAddress.edgeId);
    if (!edge || !Array.isArray(edge.points) || edge.points.length < 2) {
      return { status: "not-found" };
    }
    const bandEdge: ResolvedSeamEdge = {
      blockName: bandAddress.blockName,
      edgeId: String(bandAddress.edgeId),
      ...(bandAddress.arcRange ? { arcRange: bandAddress.arcRange } : {}),
      points: edge.points,
      lengthMm: bandLengthMm // band 辺 1 枚の finished 長。
    };

    // reference: band 固定か neighbours 固定か。片側だけ集合に一致すればその側を正とする。
    // 両側一致 / どちらも不一致 / 集合が空は undefined（両方向 preview-only, T6）。
    const bandInSet = referenceBlocks.has(bandAddress.blockName);
    const neighbourInSet = neighbours.some((neighbour) => referenceBlocks.has(neighbour.blockName));
    let reference: "band" | "neighbours" | undefined;
    if (bandInSet && !neighbourInSet) {
      reference = "band";
    } else if (neighbourInSet && !bandInSet) {
      reference = "neighbours";
    }

    return {
      status: "resolved",
      bandEdge,
      bandCutQuantity,
      bandTotalMm,
      sumMm,
      closureMm,
      closurePct,
      neighbours,
      ...(reference !== undefined ? { reference } : {})
    };
  };
}
