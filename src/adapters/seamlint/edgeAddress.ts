// Shared reader for a Seamlint edge address `{ blockName, edgeId, arcRange? }`, carried on a
// diagnostic's `actual.edge` (curve_kink) or `actual.fromEdge` / `actual.toEdge` (seam pair). This
// is the ONE place that knows the address shape, so the seam-pair resolver and the single-edge
// (curve_kink) resolver agree.

export interface EdgeAddress {
  blockName: string;
  edgeId: number;
  arcRange?: [number, number];
}

// A carried arcRange must be a valid normalized range (origin at the first corner, 0..1,
// start < end — same rule as proposalSchema.isArcRange). An absent or malformed arcRange is dropped
// rather than passed into a proposal that would then fail validation; edgeId still addresses the edge.
export function readArcRange(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [start, end] = value;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  if (!(start >= 0 && end <= 1 && start < end)) return undefined;
  return [start, end];
}

// Reads a `{ blockName, edgeId, arcRange? }` address. edgeId is required: it is the join key into
// `slnt edges` (indexed by loop-order edgeId) and Seamlint always emits it on addressed diagnostics.
// arcRange is OPTIONAL — the proposal address contract is "edgeId or arcRange", and edgeId already
// satisfies it. Returns undefined when the address is absent or has no usable edgeId (e.g. a
// whole-path mismatch carries no edge address, so it simply does not resolve — skipped, never guessed).
export function readEdgeAddress(value: unknown): EdgeAddress | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const address = value as Record<string, unknown>;
  if (typeof address.blockName !== "string" || address.blockName.length === 0) return undefined;
  if (typeof address.edgeId !== "number" || !Number.isInteger(address.edgeId)) return undefined;
  const arcRange = readArcRange(address.arcRange);
  return {
    blockName: address.blockName,
    edgeId: address.edgeId,
    ...(arcRange ? { arcRange } : {})
  };
}
