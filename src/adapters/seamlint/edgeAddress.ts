// Seamlint の edge address `{ blockName, edgeId, arcRange? }` の共有 reader。diagnostic の
// `actual.edge`（curve_kink）や `actual.fromEdge` / `actual.toEdge`（seam pair）に載る。ここが
// address の shape を知る唯一の場所なので、seam-pair resolver と単一 edge（curve_kink）resolver が
// 一致する。

export interface EdgeAddress {
  blockName: string;
  edgeId: number;
  arcRange?: [number, number];
  // Seamlint が curve_kink 用に emit しうる正確な vertex index（任意。addressing した edge の
  // `slnt edges` points への index — 両方 `structuralEdges` 由来なので Truer が取るのと同じ配列）。
  // あれば curve_kink fix が丸めに敏感な座標一致を省ける。seam pair や古い Seamlint report には無い;
  // その場合 fix は座標一致に戻る。
  vertexIndex?: number;
}

// 載っている arcRange は正規化された妥当な range（原点は最初の corner、0..1、start < end —
// proposalSchema.isArcRange と同じルール）でなければならない。無い / 壊れた arcRange は、validation を
// 落とすことになる proposal へ渡さず捨てる; edge は edgeId が依然 addressing する。
export function readArcRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [start, end] = value;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  if (!(start >= 0 && end <= 1 && start < end)) return undefined;
  return [start, end];
}

// `{ blockName, edgeId, arcRange? }` address を読む。edgeId は必須: `slnt edges`（loop 順の edgeId で
// index 付け）への join key であり、Seamlint は addressing された diagnostic には常に emit する。
// arcRange は任意 — proposal の address contract は「edgeId または arcRange」で、edgeId が既に満たす。
// address が無い、または使える edgeId が無いときは undefined を返す（例: whole-path mismatch は edge
// address を持たないので、単に解決されない — skip され、推測はしない）。
export function readEdgeAddress(value: unknown): EdgeAddress | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const address = value as Record<string, unknown>;
  if (typeof address.blockName !== "string" || address.blockName.length === 0) return undefined;
  if (typeof address.edgeId !== "number" || !Number.isInteger(address.edgeId)) return undefined;
  const arcRange = readArcRange(address.arcRange);
  const vertexIndex = readVertexIndex(address.vertexIndex);
  return {
    blockName: address.blockName,
    edgeId: address.edgeId,
    ...(arcRange ? { arcRange } : {}),
    ...(vertexIndex !== undefined ? { vertexIndex } : {})
  };
}

// 任意の vertexIndex は非負整数（edge の points への index）でなければならない。非整数 / 負 / 壊れた
// 値は信頼せず捨てる; その場合 fix は誤った vertex を index せず座標一致に戻る。
export function readVertexIndex(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}
