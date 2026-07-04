// Digests used to detect that a source SVG or a target path changed between
// `propose` and `apply` (references/critical-invariants.md T3).
//
// Normalization decision (fixed for v0, shared by propose and apply):
//   - sourceDigest: sha256 of the raw SVG file text, unchanged. The whole file is
//     the thing we promise not to have silently edited.
//   - pathDigest:   sha256 of the path `d` string after collapsing runs of
//     whitespace to a single space and trimming. Path data that differs only in
//     spacing is the same geometry, so it must produce the same digest.
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
