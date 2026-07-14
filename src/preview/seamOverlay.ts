// Seam-length overlay: renders a proposal file's seam_length_mismatch proposals to an SVG that
// shows the two mismatched edges and their Δ. Pure: SVG is a function of the proposal alone
// (self-contained) — it draws proposal.preview.edges verbatim and never re-reads the DXF or
// re-calls Seamlint (references/critical-invariants.md T2; the overlay is honest because the
// same points were digested into seamReconciliation.*.edgeDigest).
//
// preview-only means there is NO corrected line to draw. This overlay shows the two CURRENT
// edges and annotates the gap; it never invents a "fixed" (blue) line. If a corrected line is
// ever drawn, it must come from apply's applyChanges, not from here.
//
// Each edge sits in its own column (the two edges live in different BLOCKs with independent
// local origins, so they are normalized and centered per column rather than sharing one frame).
// Pattern coordinates are y-up; SVG is y-down, so y is flipped when projecting.

import type { Point, Proposal, ProposalFile } from "../core/proposal/proposalSchema.ts";

const COL_W = 180;
const COL_H = 220;
const PAD = 16;
const COL_GAP = 28;
const TITLE_H = 34;
const LABEL_H = 24;
const PANEL_GAP = 20;
const PANEL_W = PAD * 2 + COL_W * 2 + COL_GAP;
const PANEL_H = TITLE_H + COL_H + LABEL_H;

const FROM_COLOR = "#2563eb";
const TO_COLOR = "#ea580c";
const INK = "#111827";
const MUTED = "#6b7280";

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boxOf(points: readonly Point[]): Box {
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
  return { minX, minY, maxX, maxY };
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Projects an edge's points into a COL_W x COL_H box: fit to the box (preserve aspect), center,
// and flip y (pattern y-up -> SVG y-down). Deterministic (2-decimal coords).
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

function renderPanel(proposal: Proposal, yOffset: number): string {
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
    `<rect x="${PAD / 2}" y="0" width="${PANEL_W - PAD}" height="${PANEL_H}" rx="8" fill="none" stroke="#e5e7eb" />`,
    `<text x="${PAD}" y="22" font-size="14" font-weight="600" fill="${INK}">${xmlEscape(title)}</text>`,
    `<g transform="translate(${PAD}, 0)">${column(fromEdge.points, FROM_COLOR, fromLabel, 0)}</g>`,
    `<g transform="translate(0, 0)">${column(toEdge.points, TO_COLOR, toLabel, toColX)}</g>`,
    `</g>`
  ].join("");
}

function svgDocument(width: number, height: number, body: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />`,
    body,
    `</svg>`,
    ""
  ].join("\n");
}

// Renders every seam_length_mismatch proposal (those carrying preview.edges) as a stacked panel.
// A proposal file with no seam overlays yields a small placeholder SVG (honest: nothing to show).
export function renderProposalPreview(file: ProposalFile): string {
  const seamProposals = file.proposals.filter(
    (proposal) => (proposal.preview.edges?.length ?? 0) > 0
  );

  if (seamProposals.length === 0) {
    return svgDocument(
      PANEL_W,
      64,
      `<text x="${PAD}" y="36" font-size="13" fill="${MUTED}">No seam overlays in this proposal file.</text>`
    );
  }

  const totalH = PAD * 2 + seamProposals.length * PANEL_H + (seamProposals.length - 1) * PANEL_GAP;
  let y = PAD;
  const panels = seamProposals
    .map((proposal) => {
      const panel = renderPanel(proposal, y);
      y += PANEL_H + PANEL_GAP;
      return panel;
    })
    .join("");

  return svgDocument(PANEL_W, totalH, panels);
}
