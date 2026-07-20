// band cutsheet の SVG レンダラ。用途は「印刷して手で裁つ stopgap」— 正式パターン(DXF)は書き換えない
// （apply ではない・別アーティファクト）。preview の overlay（レビュー用・px 座標）とは別に、ここは
// mm 実寸の SVG（width/height を mm・viewBox も mm）を吐くので、100% 印刷で原寸になる。pure: 補正後
// 輪郭（computeBandCutOutline の結果）と scale から SVG ページ配列を返すだけ（IO なし・決定的）。型紙は
// y-up、SVG は y-down なので y を反転する。
//
// scale:
//   fit-a4 : A4 1 ページに縮小して収める（1 ページ）。デザイン/シルエット確認用（寸法精度は不問）。
//   actual : 1:1（実寸）。フィット/可動確認用。A4 に収まらないので **カバーページ（実寸確認の 10cm 四角 +
//            貼り合わせ手順 + タイル地図）+ A4 タイル複数枚** を返す。各ページを 100% 印刷して貼り合わせる。
//
// 実寸印刷の生命線は「印刷倍率」。ビューア/プリンタが勝手に用紙に合わせて縮小すると数 mm ずれて着られない
// パターンになる。業界標準の calibration square（10cm×10cm）を必ずカバーに載せ、印刷後に定規で測って
// 100% を検証させる（市販ソーイング PDF と同じ）。

import type { Point } from "../core/proposal/proposalSchema.ts";
import type { BandCutOutline } from "../core/geometry-edit/bandCutOutline.ts";
import { boxOf, xmlEscape, type Box } from "./svgUtils.ts";

export type CutScale = "fit-a4" | "actual";

export interface BandCutsheetInput {
  readonly outline: BandCutOutline;
  readonly scale: CutScale;
  readonly title?: string; // 見出し（band block 名 / part 名など。任意）
}

// 1 出力ページ。label はファイル名の suffix（"" = 単票）。CLI が <base>.<label>.svg に書く。
export interface CutsheetPage {
  readonly label: string;
  readonly svg: string;
}

const A4_SHORT_MM = 210;
const A4_LONG_MM = 297;
const MARGIN_MM = 12; // fit-a4 のページ余白。
const LABEL_BAND_MM = 26; // fit-a4 の下部ラベル帯。
const RULER_MM = 100; // fit-a4 の縮尺バーの実長。
// actual タイル用。
const PAGE_MARGIN_MM = 8; // 各 A4 ページのプリンタ安全余白。
const TILE_OVERLAP_MM = 10; // 隣接ページの重なり（のりしろ）。
const TILE_FOOTER_MM = 12; // タイルページ下部の footer（ページ番号など）。
const DRAW_MARGIN_MM = 8; // 輪郭の周囲に付ける余白（タイル対象領域）。
const CALIB_MM = 100; // calibration square = 10cm。
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

function text(
  x: number,
  y: number,
  size: number,
  fill: string,
  content: string,
  anchor: "start" | "middle" | "end" = "start"
): string {
  return `<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}" fill="${fill}" text-anchor="${anchor}" font-family="sans-serif">${xmlEscape(content)}</text>`;
}

function dimText(outline: BandCutOutline): string {
  return `補正後バンド ${n(outline.toLengthMm)} × ${n(outline.heightMm)} mm（元 ${n(outline.fromLengthMm)} → ${n(outline.toLengthMm)} mm）`;
}

export function renderBandCutsheet(input: BandCutsheetInput): CutsheetPage[] {
  const box = boxOf(input.outline.corners);
  const contentW = Math.max(box.maxX - box.minX, 1e-6);
  const contentH = Math.max(box.maxY - box.minY, 1e-6);
  return input.scale === "fit-a4"
    ? [{ label: "", svg: renderFitA4(input, box, contentW, contentH) }]
    : renderActualPages(input, box, contentW, contentH);
}

// ---- fit-a4（デザイン確認用ミニチュア・1 ページ）----

// 型紙点（y-up）→ SVG mm 座標（y-down）。box.min を原点に寄せ、scale 倍し、(ox,oy) だけ移動する。
function project(point: Point, box: Box, scale: number, ox: number, oy: number): Point {
  return { x: ox + (point.x - box.minX) * scale, y: oy + (box.maxY - point.y) * scale };
}

function fitPolygon(
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

// 縮尺バー（fit-a4 用）。実長 RULER_MM を輪郭と同じ縮尺で描き、縮尺の目安にする（原寸検証ではない）。
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
    fitPolygon(input.outline.corners, box, scale, ox, oy),
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

// ---- actual（実寸・カバー + A4 タイル複数枚）----

interface Grid {
  readonly pageW: number;
  readonly pageH: number;
  readonly usableW: number;
  readonly usableH: number;
  readonly cols: number;
  readonly rows: number;
  readonly total: number;
}

// 描画領域 drawW×drawH を pageW×pageH の A4 タイルに割る（のりしろ TILE_OVERLAP・footer を差し引く）。
function gridFor(drawW: number, drawH: number, pageW: number, pageH: number): Grid {
  const usableW = pageW - 2 * PAGE_MARGIN_MM;
  const usableH = pageH - 2 * PAGE_MARGIN_MM - TILE_FOOTER_MM;
  const cols = Math.max(1, Math.ceil((drawW - TILE_OVERLAP_MM) / (usableW - TILE_OVERLAP_MM)));
  const rows = Math.max(1, Math.ceil((drawH - TILE_OVERLAP_MM) / (usableH - TILE_OVERLAP_MM)));
  return { pageW, pageH, usableW, usableH, cols, rows, total: cols * rows };
}

function renderActualPages(
  input: BandCutsheetInput,
  box: Box,
  contentW: number,
  contentH: number
): CutsheetPage[] {
  const drawW = contentW + 2 * DRAW_MARGIN_MM;
  const drawH = contentH + 2 * DRAW_MARGIN_MM;
  // 向きは総ページ数が少ない方を選ぶ（同数なら portrait）。
  const portrait = gridFor(drawW, drawH, A4_SHORT_MM, A4_LONG_MM);
  const landscape = gridFor(drawW, drawH, A4_LONG_MM, A4_SHORT_MM);
  const grid = landscape.total < portrait.total ? landscape : portrait;

  // 輪郭を 1:1 の描画フレーム [0,drawW]×[0,drawH]（y 反転済み）へ。中間の collinear 頂点は輪郭に無い。
  const drawn = input.outline.corners.map((corner) => ({
    x: DRAW_MARGIN_MM + (corner.x - box.minX),
    y: DRAW_MARGIN_MM + (box.maxY - corner.y)
  }));

  const pages: CutsheetPage[] = [{ label: "calibration", svg: renderCoverPage(input, grid) }];
  let index = 0;
  for (let r = 0; r < grid.rows; r += 1) {
    for (let c = 0; c < grid.cols; c += 1) {
      index += 1;
      pages.push({
        label: `tile-${index}of${grid.total}`,
        svg: renderTilePage(drawn, grid, c, r, index)
      });
    }
  }
  return pages;
}

// 実寸確認の四角（10cm×10cm）。印刷後に定規で測って 100% を検証する。上辺に 10mm ごとの目盛りも打つ。
function calibrationSquare(x: number, y: number): string {
  const parts: string[] = [
    `<rect x="${n(x)}" y="${n(y)}" width="${CALIB_MM}" height="${CALIB_MM}" fill="none" stroke="${INK}" stroke-width="0.4" />`
  ];
  for (let mm = 0; mm <= CALIB_MM; mm += 10) {
    const tick = mm % 50 === 0 ? 4 : 2.5;
    parts.push(
      `<line x1="${n(x + mm)}" y1="${n(y)}" x2="${n(x + mm)}" y2="${n(y + tick)}" stroke="${INK}" stroke-width="0.3" />`,
      `<line x1="${n(x)}" y1="${n(y + mm)}" x2="${n(x + tick)}" y2="${n(y + mm)}" stroke="${INK}" stroke-width="0.3" />`
    );
  }
  parts.push(text(x + CALIB_MM / 2, y + CALIB_MM / 2 + 2, 6, MUTED, "10cm", "middle"));
  return parts.join("");
}

// カバーページ（A4 portrait）: 実寸確認の四角 + 貼り合わせ手順 + タイル地図。
function renderCoverPage(input: BandCutsheetInput, grid: Grid): string {
  const x = PAGE_MARGIN_MM + 6;
  let y = PAGE_MARGIN_MM + 12;
  const parts: string[] = [text(x, y, 6, INK, "band cutsheet — 実寸(1:1) 印刷")];
  y += 8;
  if (input.title) {
    parts.push(text(x, y, 4, MUTED, input.title));
    y += 6;
  }
  parts.push(text(x, y, 4, INK, dimText(input.outline)));
  y += 10;

  parts.push(text(x, y, 4.5, INK, "① 実寸確認 — この四角を印刷後に定規で測る"));
  y += 5;
  parts.push(calibrationSquare(x, y));
  const rx = x + CALIB_MM + 8;
  parts.push(text(rx, y + 16, 3.8, INK, "ちょうど 10.0cm（100mm）なら実寸 OK。"));
  parts.push(text(rx, y + 23, 3.8, MUTED, "ズレたらプリンタの倍率 % を調整して刷り直す。"));
  parts.push(text(rx, y + 30, 3.8, MUTED, "『用紙に合わせる / Fit to page』は必ず OFF。"));
  parts.push(text(rx, y + 37, 3.8, MUTED, "100% / 実際のサイズ で印刷すること。"));
  y += CALIB_MM + 12;

  parts.push(
    text(
      x,
      y,
      4.5,
      INK,
      `② 貼り合わせ — 全 ${grid.total} ページ（${grid.cols} 列 × ${grid.rows} 行）`
    )
  );
  y += 5;
  parts.push(
    text(
      x,
      y,
      3.8,
      MUTED,
      `番号順に並べ、のりしろ ${TILE_OVERLAP_MM}mm を重ねて柄線を合わせて貼る。`
    )
  );
  y += 8;
  parts.push(tileMap(x, y, grid));
  return mmSvgDocument(A4_SHORT_MM, A4_LONG_MM, parts.join(""));
}

// タイル地図（番号つきの小さな格子）。番号は row-major で renderActualPages のタイル順と一致させる。
function tileMap(x: number, y: number, grid: Grid): string {
  const cell = 12;
  const gap = 2;
  const parts: string[] = [];
  let index = 0;
  for (let r = 0; r < grid.rows; r += 1) {
    for (let c = 0; c < grid.cols; c += 1) {
      index += 1;
      const cx = x + c * (cell + gap);
      const cy = y + r * (cell + gap);
      parts.push(
        `<rect x="${n(cx)}" y="${n(cy)}" width="${cell}" height="${cell}" fill="none" stroke="${MUTED}" stroke-width="0.3" />`,
        text(cx + cell / 2, cy + cell / 2 + 2, 4.5, INK, String(index), "middle")
      );
    }
  }
  return parts.join("");
}

// 見当マーク（content 矩形の四隅の十字）。トリミング / 位置合わせの目印。
function registrationCrosses(x: number, y: number, w: number, h: number): string {
  const arm = 3;
  const corners: [number, number][] = [
    [x, y],
    [x + w, y],
    [x, y + h],
    [x + w, y + h]
  ];
  return corners
    .map(
      ([cx, cy]) =>
        `<path d="M${n(cx - arm)} ${n(cy)} H${n(cx + arm)} M${n(cx)} ${n(cy - arm)} V${n(cy + arm)}" stroke="${INK}" stroke-width="0.3" />`
    )
    .join("");
}

// タイルページ（A4）: 描画フレームの窓 (c,r) を切り出し、content 矩形にクリップして 1:1 で描く。
function renderTilePage(
  drawn: readonly Point[],
  grid: Grid,
  c: number,
  r: number,
  index: number
): string {
  const windowX = c * (grid.usableW - TILE_OVERLAP_MM);
  const windowY = r * (grid.usableH - TILE_OVERLAP_MM);
  const contentX = PAGE_MARGIN_MM;
  const contentY = PAGE_MARGIN_MM;

  const pts = drawn
    .map((d) => `${n(contentX + (d.x - windowX))},${n(contentY + (d.y - windowY))}`)
    .join(" ");

  const footerY = grid.pageH - TILE_FOOTER_MM + 6;
  const body = [
    `<defs><clipPath id="tileclip"><rect x="${n(contentX)}" y="${n(contentY)}" width="${n(grid.usableW)}" height="${n(grid.usableH)}" /></clipPath></defs>`,
    // content 境界（トリミング / 位置合わせのガイド）。
    `<rect x="${n(contentX)}" y="${n(contentY)}" width="${n(grid.usableW)}" height="${n(grid.usableH)}" fill="none" stroke="${MUTED}" stroke-width="0.2" stroke-dasharray="2 2" />`,
    // 型紙線（content にクリップ）。隣接タイルと重なり部で線が連続するので、線を合わせて貼る。
    `<polygon points="${pts}" fill="none" stroke="${INK}" stroke-width="0.4" clip-path="url(#tileclip)" />`,
    registrationCrosses(contentX, contentY, grid.usableW, grid.usableH),
    text(
      PAGE_MARGIN_MM,
      footerY,
      3.8,
      INK,
      `タイル ${index} / ${grid.total}（列 ${c + 1} 行 ${r + 1}）`
    ),
    text(
      grid.pageW - PAGE_MARGIN_MM,
      footerY,
      3.4,
      MUTED,
      `のりしろ ${TILE_OVERLAP_MM}mm・柄線を合わせて貼る（手順はカバー）`,
      "end"
    )
  ].join("");
  return mmSvgDocument(grid.pageW, grid.pageH, body);
}
