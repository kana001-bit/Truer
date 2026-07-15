// Shared SVG helpers for the proposal overlays (seam length + curve_kink). Pure string builders:
// an overlay is a function of the proposal file alone (self-contained), with no IO, no DXF re-read,
// and no Seamlint re-call. Pattern coordinates are y-up; SVG is y-down, so y is flipped when
// projecting.

import type { Point } from "../core/proposal/proposalSchema.ts";

export const INK = "#111827"; // original / net line
export const MUTED = "#6b7280"; // secondary text
export const CORRECTED_COLOR = "#2563eb"; // blue: the "after" (corrected) line
export const DIAGNOSTIC_COLOR = "#dc2626"; // red: the diagnostic point
export const PAD = 16;
export const PANEL_GAP = 20;

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function boxOf(points: readonly Point[]): Box {
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

export function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function svgDocument(width: number, height: number, body: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" />`,
    body,
    `</svg>`,
    ""
  ].join("\n");
}

// A projector that fits `refPoints` into a w x h box (preserve aspect, center, flip y). Returns a
// function mapping a pattern point to SVG coords. All layers of a curve_kink panel — original,
// corrected, diagnostic point — share ONE projector built from the original edge, so they overlay
// in the same frame.
export function fitProjector(
  refPoints: readonly Point[],
  w: number,
  h: number
): (point: Point) => { x: number; y: number } {
  const box = boxOf(refPoints);
  const dw = Math.max(box.maxX - box.minX, 1e-6);
  const dh = Math.max(box.maxY - box.minY, 1e-6);
  const scale = Math.min(w / dw, h / dh);
  const offsetX = (w - dw * scale) / 2;
  const offsetY = (h - dh * scale) / 2;
  return (point) => ({
    x: offsetX + (point.x - box.minX) * scale,
    y: offsetY + (box.maxY - point.y) * scale // flip y
  });
}
