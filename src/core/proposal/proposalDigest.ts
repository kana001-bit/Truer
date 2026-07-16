// source file や target edge が `propose` と `apply` の間で変わったことを検知するための digest
//（references/critical-invariants.md T3）。
//
// 正規化の決定（v0 で固定、propose と apply で共有）:
//   - sourceDigest: 生の source file text（DXF; 旧経路では legacy SVG）の sha256、加工なし。
//     silent に編集していないと約束する対象は file 全体。
//   - targetDigest: addressing した edge の geometry text を、連続する whitespace を単一 space に
//     潰して trim した後の sha256 — ここでは `digestPathData` が計算する。spacing だけが違う
//     geometry text は同じ geometry なので、同じ digest を生まねばならない。（関数名は path-data の
//     まま; DXF 経路では edge の net-line text を渡す。）
//
// この正規化を後で変えると既存 proposal との互換が壊れるので、1 箇所に置き apply がそのまま再利用する。

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

// structural edge の net-line 頂点（Seamlint `structuralEdges` 由来）の canonical な serialization。
// propose と apply で共有する。edge digest はこの文字列の sha256; `preview.edges` にそのまま格納した
// 同じ points は同じ digest に再 serialize されるので、seam overlay は proposal だけから再現できる
//（self-contained）。
//
// points は full precision で emit する（丸めない）: これは digest の source of truth なので、
// staleness 検知（T3）は厳密でなければならず、Seamlint の「address/geometry を丸めない」姿勢に倣う。
// この format を変えると既存 proposal が壊れるので、1 箇所に置き apply がそのまま再利用する。
export function serializeEdgePoints(points: readonly Point[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

export function digestEdgePoints(points: readonly Point[]): string {
  return digestText(serializeEdgePoints(points));
}
