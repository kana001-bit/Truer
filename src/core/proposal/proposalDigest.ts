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

export function digestText(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

export function normalizePathData(pathData: string): string {
  return pathData.trim().replace(/\s+/g, " ");
}

export function digestPathData(pathData: string): string {
  return digestText(normalizePathData(pathData));
}
