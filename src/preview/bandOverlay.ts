// Band-seam overlay panel: 1 つの band_seam_sum_mismatch proposal を SVG group に描く。band は N-ary
// （バンド長辺 1 本 ↔ 隣接ピース群の仕上がり辺合計）なので、pairwise の 2 列 seam panel には合わない。
// band 辺 1 本を大きく描き、closure（バンド総周長 vs 隣接合計）と各 neighbour を数値で示す。さらに points が
// 解決できた neighbour 辺を band の下に小さな thumbnail で「形」でも並べる（role "neighbour"）。
// pure: panel は proposal.preview.edges（band 辺 + neighbour 辺）と proposal.bandReconciliation（数値）だけの
// 関数で、DXF を再読込したり Seamlint を再呼び出ししたりしない（self-contained, T2）。preview-only なので
// 「直った」line は描かない — 現状の band 辺 / neighbour 辺と数値だけを見せる。

import type { Point, Proposal } from "../core/proposal/proposalSchema.ts";
import { INK, MUTED, xmlEscape } from "./svgUtils.ts";

const COL_W = 180;
const COL_H = 200;
const PAD = 16;
const TITLE_H = 34;
const LABEL_H = 24;
const NEIGHBOR_LINE_H = 18;
const BAND_COLOR = "#7c3aed"; // 紫: band 辺
const NEIGHBOUR_COLOR = "#0891b2"; // 藍緑: neighbour 辺（band と別色）
// neighbour 辺の thumbnail strip（band 辺の下）。各辺は個別スケールで小箱に収める。
const THUMB = 84;
const THUMB_GAP = 14;
const THUMB_LABEL_H = 16;
const STRIP_HEADER_H = 22;

// neighbour 行ぶん高さが伸びる。band 辺列 + 右側の数値テキストを収める幅。
export const BAND_PANEL_W = PAD * 2 + COL_W + 260;

// proposal は band 辺の render geometry と bandReconciliation を持つとき band panel を得る。
export function hasBandOverlay(proposal: Proposal): boolean {
  return (
    proposal.bandReconciliation !== undefined &&
    (proposal.preview.edges?.some((edge) => edge.role === "band") ?? false)
  );
}

// 実際に描く neighbour 辺（points が解決できたもの）。数値は bandReconciliation.neighbours が別に持つ。
function drawnNeighbourEdges(proposal: Proposal): readonly Point[][] {
  return (proposal.preview.edges ?? [])
    .filter((edge) => edge.role === "neighbour")
    .map((edge) => edge.points);
}

// thumbnail strip の列数（panel 幅から決まる・決定的）。
function stripColumns(): number {
  const available = BAND_PANEL_W - 2 * PAD;
  return Math.max(1, Math.floor((available + THUMB_GAP) / (THUMB + THUMB_GAP)));
}

// thumbnail strip の高さ（描く neighbour 辺が 0 なら 0）。
function stripHeight(edgeCount: number): number {
  if (edgeCount === 0) return 0;
  const rows = Math.ceil(edgeCount / stripColumns());
  return PAD + STRIP_HEADER_H + rows * (THUMB + THUMB_LABEL_H);
}

// title を除いた本文（band 列 / 数値テキスト）の下端。strip はこの下に置く。
function contentBottom(neighbourNumbers: number): number {
  return Math.max(COL_H + LABEL_H, 60 + (neighbourNumbers + 3) * NEIGHBOR_LINE_H);
}

export function bandPanelHeight(proposal: Proposal): number {
  const neighbourNumbers = proposal.bandReconciliation?.neighbours.length ?? 0;
  return (
    TITLE_H + contentBottom(neighbourNumbers) + stripHeight(drawnNeighbourEdges(proposal).length)
  );
}

// points を stroke 色の polyline にして w×h の箱へ収める（各辺を個別に正規化）。band 辺は既定の
// COL_W×COL_H、neighbour thumbnail は THUMB×THUMB。呼び出し側が <g transform> で位置を与える。
function projectPolyline(
  points: readonly Point[],
  stroke: string,
  w = COL_W,
  h = COL_H,
  strokeWidth = 2.5
): string {
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
  const dw = Math.max(maxX - minX, 1e-6);
  const dh = Math.max(maxY - minY, 1e-6);
  const scale = Math.min(w / dw, h / dh);
  const offsetX = (w - dw * scale) / 2;
  const offsetY = (h - dh * scale) / 2;
  const coords = points
    .map((point) => {
      const x = offsetX + (point.x - minX) * scale;
      const y = offsetY + (maxY - point.y) * scale; // flip y
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return `<polyline points="${coords}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round" />`;
}

// neighbour 辺の thumbnail strip（band 列の下）。描く辺が無ければ空文字。identity/長さは右の数値行が
// 持つので、ここは「形」だけを band と別色で並べる（誤った 1:1 ラベルは付けない）。
function renderNeighbourStrip(edges: readonly Point[][], top: number): string {
  if (edges.length === 0) return "";
  const cols = stripColumns();
  const parts: string[] = [
    `<text x="${PAD}" y="${top + 14}" font-size="12" fill="${NEIGHBOUR_COLOR}">neighbour edges（形・各辺は個別スケール）</text>`
  ];
  edges.forEach((points, i) => {
    const tx = PAD + (i % cols) * (THUMB + THUMB_GAP);
    const ty = top + STRIP_HEADER_H + Math.floor(i / cols) * (THUMB + THUMB_LABEL_H);
    parts.push(
      `<rect x="${tx}" y="${ty}" width="${THUMB}" height="${THUMB}" rx="4" fill="none" stroke="#eef2f7" />`,
      `<g transform="translate(${tx}, ${ty})">${projectPolyline(points, NEIGHBOUR_COLOR, THUMB, THUMB, 1.8)}</g>`
    );
  });
  return parts.join("");
}

export function renderBandPanel(proposal: Proposal, yOffset: number): string {
  const band = proposal.bandReconciliation;
  const bandEdge = proposal.preview.edges?.find((edge) => edge.role === "band");
  if (!band || !bandEdge) return "";

  const neighbourEdges = drawnNeighbourEdges(proposal);
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

  const stripTop = TITLE_H + contentBottom(band.neighbours.length) + PAD;

  return [
    `<g transform="translate(0, ${yOffset})">`,
    `<rect x="${PAD / 2}" y="0" width="${BAND_PANEL_W - PAD}" height="${height}" rx="8" fill="none" stroke="#e5e7eb" />`,
    `<text x="${PAD}" y="22" font-size="14" font-weight="600" fill="${INK}">${xmlEscape(title)}</text>`,
    `<g transform="translate(${PAD}, ${TITLE_H})">${projectPolyline(bandEdge.points, BAND_COLOR)}</g>`,
    `<text x="${PAD + COL_W / 2}" y="${TITLE_H + COL_H + 16}" text-anchor="middle" font-size="12" fill="${BAND_COLOR}">band edge</text>`,
    rows,
    renderNeighbourStrip(neighbourEdges, stripTop),
    `</g>`
  ].join("");
}
