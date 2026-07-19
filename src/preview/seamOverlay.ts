// Seam-length overlay panel: 1 つの seam_length_mismatch proposal を SVG group に描き、不一致な 2 edge と
// その Δ を見せる。pure: panel は proposal だけの関数（self-contained）— proposal.preview.edges を
// そのまま描き、DXF を再読込したり Seamlint を再呼び出ししたりしない（references/critical-invariants.md
// T2; 同じ points が seamReconciliation.*.edgeDigest に digest されているので overlay は正直）。
//
// preview-only は描く補正後の line が無いことを意味する。この panel は現在の 2 edge を見せ、gap に
// 注記を付ける; 「直った」（青い）line を捏造することはない。（後で seam length が補正後の line を
// 生むときは、ここではなく apply の applyChanges から来なければならない。）
//
// 各 edge は自分の列に置く（2 edge は独立した local 原点を持つ別々の BLOCK にあるので、1 つの frame を
// 共有せず列ごとに正規化・中央寄せする）。document の wrapper と積み重ねは ./index.ts にある。

import type { Point, Proposal } from "../core/proposal/proposalSchema.ts";
import { INK, boxOf, xmlEscape } from "./svgUtils.ts";

const COL_W = 180;
const COL_H = 220;
const PAD = 16;
const COL_GAP = 28;
const TITLE_H = 34;
const LABEL_H = 24;

const FROM_COLOR = "#2563eb";
const TO_COLOR = "#ea580c";

export const SEAM_PANEL_W = PAD * 2 + COL_W * 2 + COL_GAP;
export const SEAM_PANEL_H = TITLE_H + COL_H + LABEL_H;

// proposal は from/to 2 edge の render geometry を持つとき seam panel を得る。band 診断も
// preview.edges を持つ（role="band"）ので、from/to の存在で厳密に判定して band を拾わない。
export function hasSeamOverlay(proposal: Proposal): boolean {
  const edges = proposal.preview.edges;
  if (!edges) return false;
  return edges.some((edge) => edge.role === "from") && edges.some((edge) => edge.role === "to");
}

// edge の points を COL_W x COL_H の box に射影する: box に収め（アスペクト比保持）、中央寄せし、
// y を反転する（型紙 y-up -> SVG y-down）。決定的（座標は小数 2 桁）。
function projectPolyline(points: readonly Point[], stroke: string): string {
  const box = boxOf(points);
  const w = Math.max(box.maxX - box.minX, 1e-6);
  const h = Math.max(box.maxY - box.minY, 1e-6);
  const scale = Math.min(COL_W / w, COL_H / h);
  const offsetX = (COL_W - w * scale) / 2;
  const offsetY = (COL_H - h * scale) / 2;
  const coords = points
    .map((point) => {
      const x = offsetX + (point.x - box.minX) * scale;
      const y = offsetY + (box.maxY - point.y) * scale; // flip y
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return `<polyline points="${coords}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;
}

function column(points: readonly Point[], stroke: string, label: string, x: number): string {
  return [
    `<g transform="translate(${x}, ${TITLE_H})">`,
    projectPolyline(points, stroke),
    `</g>`,
    `<text x="${x + COL_W / 2}" y="${TITLE_H + COL_H + 16}" text-anchor="middle" font-size="12" fill="${stroke}">${xmlEscape(label)}</text>`
  ].join("");
}

function edgeLabel(
  role: string,
  blockName: string,
  edgeId: string | undefined,
  lengthMm: number
): string {
  return `${role} · ${blockName}/${edgeId ?? "?"} · ${lengthMm.toFixed(1)} mm`;
}

export function renderSeamPanel(proposal: Proposal, yOffset: number): string {
  const edges = proposal.preview.edges ?? [];
  const fromEdge = edges.find((edge) => edge.role === "from");
  const toEdge = edges.find((edge) => edge.role === "to");
  if (!fromEdge || !toEdge) return "";

  const seam = proposal.seamReconciliation;
  const title = seam
    ? `${proposal.id} — Δ ${seam.deltaMm.toFixed(1)} mm`
    : `${proposal.id} — seam length mismatch`;
  const fromLabel = seam
    ? edgeLabel("from", seam.fromEdge.blockName, seam.fromEdge.edgeId, seam.fromEdge.lengthMm)
    : "from";
  const toLabel = seam
    ? edgeLabel("to", seam.toEdge.blockName, seam.toEdge.edgeId, seam.toEdge.lengthMm)
    : "to";

  const toColX = PAD + COL_W + COL_GAP;
  return [
    `<g transform="translate(0, ${yOffset})">`,
    `<rect x="${PAD / 2}" y="0" width="${SEAM_PANEL_W - PAD}" height="${SEAM_PANEL_H}" rx="8" fill="none" stroke="#e5e7eb" />`,
    `<text x="${PAD}" y="22" font-size="14" font-weight="600" fill="${INK}">${xmlEscape(title)}</text>`,
    `<g transform="translate(${PAD}, 0)">${column(fromEdge.points, FROM_COLOR, fromLabel, 0)}</g>`,
    `<g transform="translate(0, 0)">${column(toEdge.points, TO_COLOR, toLabel, toColX)}</g>`,
    `</g>`
  ].join("");
}
