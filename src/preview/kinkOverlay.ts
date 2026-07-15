// curve_kink overlay panel: renders one curve_kink proposal to an SVG group showing the addressed
// edge and, for a local-adjustment, the corrected line.
//
// The corrected (blue) line is NOT computed here with a preview-only formula — it is
// applyChanges(edge.points, changes), the SAME function apply uses to write the corrected DXF. So
// the blue line a human accepts is byte-for-byte the line apply writes (references/
// critical-invariants.md T2). A preview-only proposal has changes:[], so applyChanges returns the
// original points unchanged and no blue line is drawn — we never invent a correction that isn't
// there (T2, T8).
//
// All layers (original ink line, corrected blue line, red diagnostic point) share ONE projector
// built from the original edge, so they overlay in a single frame. Pure and self-contained: the
// panel is a function of the proposal alone (preview.edge.points), no DXF / Seamlint re-call.

import type { Proposal } from "../core/proposal/proposalSchema.ts";
import { applyChanges } from "../core/apply/applyChanges.ts";
import {
  CORRECTED_COLOR,
  DIAGNOSTIC_COLOR,
  INK,
  MUTED,
  PAD,
  fitProjector,
  xmlEscape
} from "./svgUtils.ts";
import type { Point } from "../core/proposal/proposalSchema.ts";

const FRAME = 240;
const TITLE_H = 34;
const LABEL_H = 24;

export const KINK_PANEL_W = PAD * 2 + FRAME;
export const KINK_PANEL_H = TITLE_H + FRAME + LABEL_H;

// A proposal gets a curve_kink panel when it carries the single addressed edge's render geometry.
export function hasKinkOverlay(proposal: Proposal): boolean {
  return (
    proposal.sourceDiagnostic.code === "geometry.curve_kink" &&
    (proposal.preview.edge?.points.length ?? 0) >= 2
  );
}

function polyline(
  points: readonly Point[],
  project: (point: Point) => { x: number; y: number },
  stroke: string,
  width: number,
  dashed = false
): string {
  const coords = points
    .map((point) => {
      const projected = project(point);
      return `${projected.x.toFixed(2)},${projected.y.toFixed(2)}`;
    })
    .join(" ");
  const dash = dashed ? ` stroke-dasharray="5 4"` : "";
  return `<polyline points="${coords}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${dash} />`;
}

export function renderKinkPanel(proposal: Proposal, yOffset: number): string {
  const edge = proposal.preview.edge;
  if (!edge) return "";
  const original = edge.points;

  // The corrected line comes from apply's function, not a preview-only approximation (T2). For a
  // preview-only proposal changes is [] and this equals `original`, so nothing extra is drawn. If
  // applyChanges refuses the change (a corrupted proposal with an unknown kind or an endpoint move),
  // draw no corrected line rather than crash — we never show a "fixed" line apply would reject.
  let corrected: readonly Point[] | undefined;
  if (proposal.changes.length > 0) {
    try {
      corrected = applyChanges(original, proposal.changes);
    } catch {
      corrected = undefined;
    }
  }
  const point = proposal.preview.diagnosticPoint;
  const project = fitProjector(original, FRAME, FRAME);

  const layers: string[] = [
    // Original net line first (dashed when a corrected line will sit on top, so both read).
    polyline(original, project, INK, 2, corrected !== undefined)
  ];
  if (corrected !== undefined) {
    layers.push(polyline(corrected, project, CORRECTED_COLOR, 2.5));
  }
  if (point) {
    const projected = project(point);
    layers.push(
      `<circle cx="${projected.x.toFixed(2)}" cy="${projected.y.toFixed(2)}" r="3.5" fill="${DIAGNOSTIC_COLOR}" />`
    );
  }

  const kind = corrected !== undefined ? "smoothed" : "preview-only";
  const title = `${proposal.id} — curve kink (${kind})`;
  const label = `${proposal.target.blockName}/${proposal.target.edgeId ?? "?"} · ${proposal.mode}`;

  return [
    `<g transform="translate(0, ${yOffset})">`,
    `<rect x="${PAD / 2}" y="0" width="${KINK_PANEL_W - PAD}" height="${KINK_PANEL_H}" rx="8" fill="none" stroke="#e5e7eb" />`,
    `<text x="${PAD}" y="22" font-size="14" font-weight="600" fill="${INK}">${xmlEscape(title)}</text>`,
    `<g transform="translate(${PAD}, ${TITLE_H})">${layers.join("")}</g>`,
    `<text x="${PAD + FRAME / 2}" y="${TITLE_H + FRAME + 16}" text-anchor="middle" font-size="12" fill="${MUTED}">${xmlEscape(label)}</text>`,
    `</g>`
  ].join("");
}
