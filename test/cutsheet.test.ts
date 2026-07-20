import assert from "node:assert/strict";
import test from "node:test";

import { renderBandCutsheet } from "../src/preview/cutsheet.ts";
import type { BandCutOutline } from "../src/core/geometry-edit/bandCutOutline.ts";

// 実データ WAISTBAND を 655 に縮めた後の輪郭（655 × 50、min 角 = (381.2, 1024.5)）。
const OUTLINE: BandCutOutline = {
  corners: [
    { x: 381.2, y: 1074.5 },
    { x: 1036.2, y: 1074.5 },
    { x: 1036.2, y: 1024.5 },
    { x: 381.2, y: 1024.5 }
  ],
  fromLengthMm: 860,
  toLengthMm: 655,
  heightMm: 50,
  kind: "rectangle"
};

// 曲線バンドの輪郭（密 polyline・kind curved）。seam-allowance 未対応の分岐を試す。
const CURVED_OUTLINE: BandCutOutline = {
  corners: [
    { x: 0, y: 0 },
    { x: 50, y: 6 },
    { x: 100, y: 0 },
    { x: 100, y: -40 },
    { x: 50, y: -34 },
    { x: 0, y: -40 }
  ],
  fromLengthMm: 220,
  toLengthMm: 165,
  heightMm: 40,
  kind: "curved"
};

test("actual: カバー（10cm calibration square）+ A4 タイル複数枚を返す", () => {
  // 守る仕様: actual は 1:1。A4 に収まらないので、実寸確認の 10cm 四角つきカバー + A4 タイルを返す。
  //           印刷倍率の担保（calibration square）を必ず載せる。
  const pages = renderBandCutsheet({ outline: OUTLINE, scale: "actual" });
  assert.ok(pages.length >= 2, `cover + tiles: ${pages.length}`);

  const cover = pages[0]!;
  assert.equal(cover.label, "calibration");
  assert.match(cover.svg, /width="210mm" height="297mm"/); // A4 portrait
  assert.match(cover.svg, /10cm/); // calibration square の見出し
  assert.match(cover.svg, /width="100" height="100"/); // 10cm×10cm の実寸四角
  assert.match(cover.svg, /補正後バンド 655 × 50 mm/);

  const tiles = pages.slice(1);
  assert.ok(tiles.length >= 1, "at least one tile");
  for (const tile of tiles) {
    assert.match(tile.label, /^tile-\d+of\d+$/);
    assert.match(tile.svg, /width="\d+(\.\d+)?mm" height="\d+(\.\d+)?mm"/);
    assert.match(tile.svg, /clip-path="url\(#tileclip\)"/); // 型紙線を content にクリップ
  }
});

test("fit-a4: A4 1 ページに収める（縮尺ラベルつきミニチュア・1 ページ）", () => {
  const pages = renderBandCutsheet({ outline: OUTLINE, scale: "fit-a4" });
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.label, "");
  const svg = pages[0]!.svg;
  assert.match(svg, /width="297mm"/);
  assert.match(svg, /height="210mm"/);
  assert.match(svg, /縮尺 ≈ 1:/);
  assert.match(svg, /ミニチュア/);
});

test("determinism: 同じ入力 -> 同一ページ配列", () => {
  // 守る仕様: pure・決定的。同じ入力から byte 一致のページ配列。
  assert.deepEqual(
    renderBandCutsheet({ outline: OUTLINE, scale: "actual", title: "WAISTBAND" }),
    renderBandCutsheet({ outline: OUTLINE, scale: "actual", title: "WAISTBAND" })
  );
});

test("title を出す（任意見出し・カバーに）", () => {
  const pages = renderBandCutsheet({ outline: OUTLINE, scale: "actual", title: "WAISTBAND" });
  assert.match(pages[0]!.svg, /WAISTBAND/);
});

test("seam allowance: 裁ち線（実線）+ 仕上がり線（破線）を出し、カバーに縫い代を明記", () => {
  // 守る仕様: seamAllowanceMm>0 で裁ち線（net の外）を主線に、仕上がり線を破線で残す。カバーに縫い代表示。
  const pages = renderBandCutsheet({ outline: OUTLINE, scale: "actual", seamAllowanceMm: 10 });
  assert.match(pages[0]!.svg, /縫い代 10mm/);
  const tile = pages.find((page) => page.label.startsWith("tile-"))!;
  assert.match(tile.svg, /stroke-dasharray="4 2"/); // 仕上がり線（破線・型紙線）
});

test("seam allowance 省略（=0）は仕上がり線のみ（型紙の破線なし・縫い代表示なし）", () => {
  const pages = renderBandCutsheet({ outline: OUTLINE, scale: "actual" });
  assert.doesNotMatch(pages[0]!.svg, /縫い代/);
  const tile = pages.find((page) => page.label.startsWith("tile-"))!;
  // content 境界の破線（"2 2"）はあるが、型紙の破線（"4 2"）は無い。
  assert.doesNotMatch(tile.svg, /stroke-dasharray="4 2"/);
});

test("on-fold: わ辺だけ縫い代 0。fit-a4 に「わ (fold)」ラベルと dimText 注記を出す", () => {
  // 守る仕様: --on-fold でわ辺の裁ち線を仕上がり線に一致させる（案A: 形は不変）。人に分かるよう「わ (fold)」
  //           ラベルと dimText の「わ辺=縫い代 0」を出す。
  const pages = renderBandCutsheet({
    outline: OUTLINE,
    scale: "fit-a4",
    seamAllowanceMm: 10,
    onFold: "long"
  });
  const svg = pages[0]!.svg;
  assert.match(svg, /わ \(fold\)/);
  assert.match(svg, /わ辺=縫い代 0/);
});

test("on-fold: actual カバーにわ辺の裁ち方（縫い代 0）を明記", () => {
  const pages = renderBandCutsheet({
    outline: OUTLINE,
    scale: "actual",
    seamAllowanceMm: 10,
    onFold: "short"
  });
  const cover = pages[0]!.svg;
  assert.match(cover, /わ辺（fold）は縫い代 0/);
  assert.match(cover, /わ辺=縫い代 0/); // dimText 注記
});

test("on-fold 無し（既定）は「わ」ラベル/注記を出さない（従来どおり全辺一様）", () => {
  const pages = renderBandCutsheet({ outline: OUTLINE, scale: "actual", seamAllowanceMm: 10 });
  const all = pages.map((page) => page.svg).join("");
  assert.doesNotMatch(all, /わ \(fold\)/);
  assert.doesNotMatch(all, /わ辺/);
});

test("on-fold: 縫い代 0 では効かない（裁ち代が無いのでわ表記なし）", () => {
  const pages = renderBandCutsheet({
    outline: OUTLINE,
    scale: "fit-a4",
    seamAllowanceMm: 0,
    onFold: "long"
  });
  assert.doesNotMatch(pages[0]!.svg, /わ \(fold\)/);
  assert.doesNotMatch(pages[0]!.svg, /わ辺/);
});

test("on-fold determinism: 同じ入力 -> 同一ページ配列（T10）", () => {
  assert.deepEqual(
    renderBandCutsheet({ outline: OUTLINE, scale: "actual", seamAllowanceMm: 10, onFold: "long" }),
    renderBandCutsheet({ outline: OUTLINE, scale: "actual", seamAllowanceMm: 10, onFold: "long" })
  );
});

test("curved outline: seam-allowance は無視され仕上がり線のみ + 注記（第一スライス）", () => {
  // 守る仕様: 曲線バンドは縫い代未対応。--seam-allowance>0 でも net 線のみにし、dimText とカバーに注記する。
  //           型紙の破線（裁ち線 vs 仕上がり線の 2 本）は出ない。
  const pages = renderBandCutsheet({
    outline: CURVED_OUTLINE,
    scale: "actual",
    seamAllowanceMm: 10
  });
  const cover = pages[0]!.svg;
  assert.match(cover, /曲線バンド（縫い代未対応・仕上がり線のみ）/); // dimText 注記
  assert.match(cover, /曲線バンドは縫い代未対応/); // カバー手順の注記
  assert.doesNotMatch(cover, /縫い代 10mm/); // 縫い代の寸法表記は出さない
  const tile = pages.find((page) => page.label.startsWith("tile-"))!;
  assert.doesNotMatch(tile.svg, /stroke-dasharray="4 2"/); // 仕上がり線 vs 裁ち線の 2 本は無い
});

test("curved outline: fit-a4 も仕上がり線のみ（縮尺ラベルは出る）", () => {
  const pages = renderBandCutsheet({
    outline: CURVED_OUTLINE,
    scale: "fit-a4",
    seamAllowanceMm: 10
  });
  assert.equal(pages.length, 1);
  assert.match(pages[0]!.svg, /曲線バンド（縫い代未対応/);
  assert.match(pages[0]!.svg, /縮尺 ≈ 1:/);
});

test("curved outline: seam-allowance 無しは注記なし（普通に仕上がり線）", () => {
  const pages = renderBandCutsheet({ outline: CURVED_OUTLINE, scale: "fit-a4" });
  assert.doesNotMatch(pages[0]!.svg, /縫い代未対応/);
});
