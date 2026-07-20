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
  heightMm: 50
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
