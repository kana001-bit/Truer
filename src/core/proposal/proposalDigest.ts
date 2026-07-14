// Digests used to detect that a source file or a target edge changed between
// `propose` and `apply` (references/critical-invariants.md T3).
//
// Normalization decision (fixed for v0, shared by propose and apply):
//   - sourceDigest: sha256 of the raw source file text (DXF; legacy SVG on the old
//     path), unchanged. The whole file is the thing we promise not to have silently
//     edited.
//   - targetDigest: sha256 of the addressed edge's geometry text after collapsing
//     runs of whitespace to a single space and trimming — computed here by
//     `digestPathData`. Geometry text that differs only in spacing is the same
//     geometry, so it must produce the same digest. (The function keeps its
//     path-data name; on the DXF path it is fed the edge's net-line text.)
//
// Changing this normalization later breaks compatibility with existing proposals,
// so it lives in one place and is reused verbatim by apply.

import { createHash } from "node:crypto";
import type { Point } from "./proposalSchema.ts";

export function digestText(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

export function normalizePathData(pathData: string): string {
  return pathData.trim().replace(/\s+/g, " ");
}

export function digestPathData(pathData: string): string {
  return digestText(normalizePathData(pathData));
}

// Canonical serialization of a structural edge's net-line vertices (from Seamlint
// `structuralEdges`), shared by propose and apply. The edge digest is sha256 of this
// string; the SAME points stored verbatim in `preview.edges` re-serialize to the same
// digest, so a seam overlay is reproducible from the proposal alone (self-contained).
//
// Points are emitted full precision (not rounded): this is the digest source of truth,
// so staleness detection (T3) must stay exact, mirroring Seamlint's "don't round the
// address/geometry" stance. Changing this format breaks existing proposals, so it lives
// in one place and is reused verbatim by apply.
export function serializeEdgePoints(points: readonly Point[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

export function digestEdgePoints(points: readonly Point[]): string {
  return digestText(serializeEdgePoints(points));
}
