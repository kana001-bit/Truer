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

test("actual: mm 実寸の SVG（1:1・原寸検証用の 100mm 定規つき）", () => {
  // 守る仕様: actual は 1:1。ページは輪郭＋余白＋ラベル帯の mm 実寸で、100% 印刷が原寸になる。
  const svg = renderBandCutsheet({ outline: OUTLINE, scale: "actual" });
  // 幅 = 655 + 余白 2×12 = 679mm、viewBox も mm 同値（1 unit = 1mm）。
  assert.match(svg, /width="679mm"/);
  assert.match(svg, /viewBox="0 0 679 100"/);
  // 輪郭は 1:1: 左上角 (381.2,1074.5)→(12,12)、右上角 (1036.2,1074.5)→(667,12)。
  assert.match(svg, /<polygon points="[^"]*12,12[^"]*667,12/);
  // 寸法ラベルと 100mm スケール定規（倍率検証）。
  assert.match(svg, /補正後バンド 655 × 50 mm/);
  assert.match(svg, /100mm/);
});

test("fit-a4: A4 1 ページに収める（縮尺ラベルつきミニチュア）", () => {
  // 守る仕様: fit-a4 は A4 1 枚。横長の帯なので landscape（297×210mm）を選び、縮尺を明記する。
  const svg = renderBandCutsheet({ outline: OUTLINE, scale: "fit-a4" });
  assert.match(svg, /width="297mm"/);
  assert.match(svg, /height="210mm"/);
  assert.match(svg, /viewBox="0 0 297 210"/);
  assert.match(svg, /縮尺 ≈ 1:/);
  assert.match(svg, /ミニチュア/);
});

test("determinism: 同じ入力 -> 同一 SVG 文字列", () => {
  // 守る仕様: pure・決定的。同じ入力から byte 一致。
  assert.equal(
    renderBandCutsheet({ outline: OUTLINE, scale: "actual", title: "WAISTBAND" }),
    renderBandCutsheet({ outline: OUTLINE, scale: "actual", title: "WAISTBAND" })
  );
});

test("title を出す（任意見出し）", () => {
  const svg = renderBandCutsheet({ outline: OUTLINE, scale: "fit-a4", title: "WAISTBAND" });
  assert.match(svg, /WAISTBAND/);
});
