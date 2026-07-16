// proposal overlay（seam length + curve_kink）のための共有 SVG helper。pure な文字列ビルダー:
// overlay は proposal file だけの関数（self-contained）で、IO も DXF 再読込も Seamlint 再呼び出しも
// ない。型紙座標は y-up、SVG は y-down なので、射影時に y を反転する。

import type { Point } from "../core/proposal/proposalSchema.ts";

export const INK = "#111827"; // original / net line
export const MUTED = "#6b7280"; // 補助テキスト
export const CORRECTED_COLOR = "#2563eb"; // 青: 「after」（補正後）の line
export const DIAGNOSTIC_COLOR = "#dc2626"; // 赤: 診断点
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

// `refPoints` を w x h の box に収める projector（アスペクト比保持、中央寄せ、y 反転）。型紙の点を
// SVG 座標へ写す関数を返す。curve_kink panel のすべての layer — original、補正後、診断点 — は original
// edge から作った単一の projector を共有するので、同じ frame に重なる。
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
