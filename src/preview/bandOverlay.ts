// Band-seam overlay panel: 1 つの band_seam_sum_mismatch proposal を SVG group に描く。band は N-ary
// （バンド長辺 1 本 ↔ 隣接ピース群の仕上がり辺合計）なので、pairwise の 2 列 seam panel には合わない。
// band 辺 1 本を描き、closure（バンド総周長 vs 隣接合計）と各 neighbour を数値で示す。
// pure: panel は proposal.preview.edges（band 辺）と proposal.bandReconciliation（数値）だけの関数で、
// DXF を再読込したり Seamlint を再呼び出ししたりしない（self-contained, T2）。preview-only なので
// 「直った」line は描かない — 現状の band 辺と数値だけを見せる。

import type { Point, Proposal } from "../core/proposal/proposalSchema.ts";
import { INK, MUTED, xmlEscape } from "./svgUtils.ts";

const COL_W = 180;
const COL_H = 200;
const PAD = 16;
const TITLE_H = 34;
const LABEL_H = 24;
const NEIGHBOR_LINE_H = 18;
const BAND_COLOR = "#7c3aed"; // 紫: band 辺

// neighbour 行ぶん高さが伸びる。band 辺列 + 右側の数値テキストを収める幅。
export const BAND_PANEL_W = PAD * 2 + COL_W + 260;
export function bandPanelHeight(proposal: Proposal): number {
  const neighbours = proposal.bandReconciliation?.neighbours.length ?? 0;
  return TITLE_H + Math.max(COL_H + LABEL_H, 60 + (neighbours + 3) * NEIGHBOR_LINE_H);
}

// proposal は band 辺の render geometry と bandReconciliation を持つとき band panel を得る。
export function hasBandOverlay(proposal: Proposal): boolean {
  return (
    proposal.bandReconciliation !== undefined &&
    (proposal.preview.edges?.some((edge) => edge.role === "band") ?? false)
  );
}

function projectPolyline(points: readonly Point[], stroke: string): string {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  const w = Math.max(maxX - minX, 1e-6);
  const h = Math.max(maxY - minY, 1e-6);
  const scale = Math.min(COL_W / w, COL_H / h);
  const offsetX = (COL_W - w * scale) / 2;
  const offsetY = (COL_H - h * scale) / 2;
  const coords = points
    .map((point) => {
      const x = offsetX + (point.x - minX) * scale;
      const y = offsetY + (maxY - point.y) * scale; // flip y
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return `<polyline points="${coords}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />`;
}

export function renderBandPanel(proposal: Proposal, yOffset: number): string {
  const band = proposal.bandReconciliation;
  const bandEdge = proposal.preview.edges?.find((edge) => edge.role === "band");
  if (!band || !bandEdge) return "";

  const height = bandPanelHeight(proposal);
  const title = `${proposal.id} — closure ${(band.closurePct * 100).toFixed(1)}% (Δ ${band.closureMm.toFixed(1)} mm)`;
  const textX = PAD + COL_W + 24;
  let textY = TITLE_H + 20;
  const line = (text: string, color = INK): string => {
    const element = `<text x="${textX}" y="${textY}" font-size="12" fill="${color}">${xmlEscape(text)}</text>`;
    textY += NEIGHBOR_LINE_H;
    return element;
  };

  const rows = [
    line(
      `band ${band.bandEdge.blockName}/${band.bandEdge.edgeId ?? "?"} · ${band.bandEdge.lengthMm.toFixed(1)} mm × ${band.bandCutQuantity} = ${band.bandTotalMm.toFixed(1)} mm`,
      BAND_COLOR
    ),
    line(`Σ neighbours = ${band.sumMm.toFixed(1)} mm`, MUTED),
    ...band.neighbours.map((neighbour) =>
      line(
        `· ${neighbour.blockName}/${neighbour.edgeId ?? "?"} · ${neighbour.finishedLengthMm.toFixed(1)} mm × ${neighbour.cutQuantity}`,
        MUTED
      )
    ),
    band.reference === "neighbours" && band.targetBandLengthMm !== undefined
      ? line(`target band edge = ${band.targetBandLengthMm.toFixed(1)} mm`, BAND_COLOR)
      : ""
  ].join("");

  return [
    `<g transform="translate(0, ${yOffset})">`,
    `<rect x="${PAD / 2}" y="0" width="${BAND_PANEL_W - PAD}" height="${height}" rx="8" fill="none" stroke="#e5e7eb" />`,
    `<text x="${PAD}" y="22" font-size="14" font-weight="600" fill="${INK}">${xmlEscape(title)}</text>`,
    `<g transform="translate(${PAD}, ${TITLE_H})">${projectPolyline(bandEdge.points, BAND_COLOR)}</g>`,
    `<text x="${PAD + COL_W / 2}" y="${TITLE_H + COL_H + 16}" text-anchor="middle" font-size="12" fill="${BAND_COLOR}">band edge</text>`,
    rows,
    `</g>`
  ].join("");
}
