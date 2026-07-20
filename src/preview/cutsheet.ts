// band cutsheet の SVG レンダラ。用途は「印刷して手で裁つ stopgap」— 正式パターン(DXF)は書き換えない
// （apply ではない・別アーティファクト）。preview の overlay（レビュー用・px 座標）とは別に、ここは
// mm 実寸の SVG（width/height を mm・viewBox も mm）を吐くので、100% 印刷で原寸になる。pure: 補正後
// 輪郭（computeBandCutOutline の結果）と scale から SVG 文字列を返すだけ（IO なし・決定的）。型紙は y-up、
// SVG は y-down なので y を反転する。
//
// scale:
//   fit-a4 : A4 1 ページに縮小して収める。デザイン/シルエット確認用（寸法精度は不問）。縮尺ラベルを載せる。
//   actual : 1:1（実寸）。フィット/可動確認用。A4 に収まらない帯は当面 1 枚で吐き、タイルは印刷側 or 後続
//            スライス（のりしろ・貼り合わせマーク）に委ねる。スケール定規で 100% 印刷を検証できる。
// どちらもスケール定規（実長 100mm・fit-a4 では輪郭と同縮尺の「縮尺バー」）を載せ、印刷倍率を担保する。

import type { Point } from "../core/proposal/proposalSchema.ts";
import type { BandCutOutline } from "../core/geometry-edit/bandCutOutline.ts";
import { boxOf, xmlEscape, type Box } from "./svgUtils.ts";

export type CutScale = "fit-a4" | "actual";

export interface BandCutsheetInput {
  readonly outline: BandCutOutline;
  readonly scale: CutScale;
  readonly title?: string; // 見出し（band block 名 / part 名など。任意）
}

const A4_SHORT_MM = 210;
const A4_LONG_MM = 297;
const MARGIN_MM = 12; // ページ余白（mm 実寸）。
const LABEL_BAND_MM = 26; // 下部のラベル + 定規帯の高さ（mm 実寸）。
const RULER_MM = 100; // スケール定規の実長。
const INK = "#111827";
const MUTED = "#6b7280";

// SVG 数値の決定的な整形（3 桁で丸め、末尾ゼロは String に任せる）。
function n(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

// mm 実寸の SVG document。width/height を mm・viewBox を同値（1 unit = 1mm）にするので、100% 印刷で原寸。
function mmSvgDocument(widthMm: number, heightMm: number, body: string): string {
  const w = n(widthMm);
  const h = n(heightMm);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">`,
    `<rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff" />`,
    body,
    `</svg>`,
    ""
  ].join("\n");
}

// 型紙点（y-up）→ SVG mm 座標（y-down）。box.min を原点に寄せ、scale 倍し、(ox,oy) だけ移動する。
function project(point: Point, box: Box, scale: number, ox: number, oy: number): Point {
  return { x: ox + (point.x - box.minX) * scale, y: oy + (box.maxY - point.y) * scale };
}

function polygon(
  corners: readonly Point[],
  box: Box,
  scale: number,
  ox: number,
  oy: number
): string {
  const pts = corners
    .map((corner) => {
      const q = project(corner, box, scale, ox, oy);
      return `${n(q.x)},${n(q.y)}`;
    })
    .join(" ");
  return `<polygon points="${pts}" fill="none" stroke="${INK}" stroke-width="0.4" />`;
}

function text(
  x: number,
  y: number,
  size: number,
  fill: string,
  content: string,
  anchor: "start" | "end" = "start"
): string {
  return `<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}" fill="${fill}" text-anchor="${anchor}" font-family="sans-serif">${xmlEscape(content)}</text>`;
}

// スケール定規。実長 RULER_MM を輪郭と同じ scale で描き、10mm ごとに tick、両端に 0 / "100mm" を出す。
// actual(scale=1) では原寸検証、fit-a4(scale<1) では縮尺の目安（縮尺バー）になる。
function scaleBar(x: number, y: number, scale: number): string {
  const length = RULER_MM * scale;
  const parts: string[] = [
    `<line x1="${n(x)}" y1="${n(y)}" x2="${n(x + length)}" y2="${n(y)}" stroke="${INK}" stroke-width="0.3" />`
  ];
  for (let mm = 0; mm <= RULER_MM; mm += 10) {
    const tx = x + mm * scale;
    const tick = mm % 50 === 0 ? 2.5 : 1.5;
    parts.push(
      `<line x1="${n(tx)}" y1="${n(y - tick)}" x2="${n(tx)}" y2="${n(y)}" stroke="${INK}" stroke-width="0.3" />`
    );
  }
  parts.push(text(x, y + 4, 3.2, MUTED, "0"));
  parts.push(text(x + length, y + 4, 3.2, MUTED, `${RULER_MM}mm`, "end"));
  return parts.join("");
}

function dimText(outline: BandCutOutline): string {
  return `補正後バンド ${n(outline.toLengthMm)} × ${n(outline.heightMm)} mm（元 ${n(outline.fromLengthMm)} → ${n(outline.toLengthMm)} mm）`;
}

export function renderBandCutsheet(input: BandCutsheetInput): string {
  const box = boxOf(input.outline.corners);
  const contentW = Math.max(box.maxX - box.minX, 1e-6);
  const contentH = Math.max(box.maxY - box.minY, 1e-6);
  return input.scale === "fit-a4"
    ? renderFitA4(input, box, contentW, contentH)
    : renderActual(input, box, contentW, contentH);
}

// A4 1 ページに縮小して収める（デザイン確認用ミニチュア）。輪郭の縦横比で向きを選ぶ。
function renderFitA4(
  input: BandCutsheetInput,
  box: Box,
  contentW: number,
  contentH: number
): string {
  const landscape = contentW >= contentH;
  const pageW = landscape ? A4_LONG_MM : A4_SHORT_MM;
  const pageH = landscape ? A4_SHORT_MM : A4_LONG_MM;
  const availW = pageW - 2 * MARGIN_MM;
  const availH = pageH - 2 * MARGIN_MM - LABEL_BAND_MM;
  const scale = Math.min(availW / contentW, availH / contentH);
  const ox = MARGIN_MM + (availW - contentW * scale) / 2;
  const oy = MARGIN_MM + (availH - contentH * scale) / 2;

  const ratio = scale > 0 ? 1 / scale : 0;
  const labelY = pageH - LABEL_BAND_MM + 6;
  const body = [
    polygon(input.outline.corners, box, scale, ox, oy),
    input.title ? text(MARGIN_MM, MARGIN_MM - 3, 4, MUTED, input.title) : "",
    text(MARGIN_MM, labelY, 4, INK, dimText(input.outline)),
    text(
      MARGIN_MM,
      labelY + 6,
      3.4,
      MUTED,
      `縮尺 ≈ 1:${n(Math.round(ratio * 10) / 10)}（デザイン確認用ミニチュア。寸法確認は --scale actual）`
    ),
    scaleBar(MARGIN_MM, labelY + 14, scale)
  ].join("");
  return mmSvgDocument(pageW, pageH, body);
}

// 1:1（実寸）。当面 1 枚で吐く（A4 に収まらない帯はタイル印刷 or 後続スライスで貼り合わせ対応）。
function renderActual(
  input: BandCutsheetInput,
  box: Box,
  contentW: number,
  contentH: number
): string {
  const scale = 1;
  const ox = MARGIN_MM;
  const oy = MARGIN_MM;
  const pageW = 2 * MARGIN_MM + contentW;
  const pageH = 2 * MARGIN_MM + contentH + LABEL_BAND_MM;

  const labelY = pageH - LABEL_BAND_MM + 6;
  const body = [
    polygon(input.outline.corners, box, scale, ox, oy),
    input.title ? text(MARGIN_MM, MARGIN_MM - 3, 4, MUTED, input.title) : "",
    text(MARGIN_MM, labelY, 4, INK, dimText(input.outline)),
    text(
      MARGIN_MM,
      labelY + 6,
      3.4,
      MUTED,
      "実寸（1:1）。下の定規が実測 100mm なら 100% 印刷。A4 超はタイル印刷で貼り合わせ。"
    ),
    scaleBar(MARGIN_MM, labelY + 14, scale)
  ].join("");
  return mmSvgDocument(pageW, pageH, body);
}
