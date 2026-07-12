import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SvgAdapterError,
  findSvgPathById,
  readSvgPaths,
  replaceSvgPathData
} from "../src/adapters/svg/index.ts";
import { digestPathData } from "../src/core/proposal/proposalDigest.ts";

const FIXTURE = readFileSync("examples/armhole-kink.svg", "utf8");
const ARMHOLE_D = "M 40 140 C 42 80 88 42 120 72 L 124 130 L 70 154";
const SLEEVE_D = "M 40 140 C 48 84 92 48 122 76 C 148 106 144 140 72 154";
const NEW_D = "M 40 140 C 42 80 88 42 121 74 L 124 130 L 70 154";

test("reads body-armhole d from the fixture SVG", () => {
  // 守る仕様 (M2 完了条件): armhole-kink.svg から body-armhole の d を読める。
  const path = findSvgPathById(FIXTURE, "body-armhole");
  assert.equal(path.id, "body-armhole");
  assert.equal(path.d, ARMHOLE_D);
});

test("readSvgPaths lists every targetable path in order", () => {
  // 守る仕様: id を持つ path を過不足なく読む。
  assert.deepEqual(
    readSvgPaths(FIXTURE).map((path) => path.id),
    ["body-armhole", "sleeve-cap"]
  );
});

test("unknown id throws path_not_found, never a guess", () => {
  // 守る仕様 (T6): id 不在は推測せず error。
  assert.throws(
    () => findSvgPathById(FIXTURE, "no-such-path"),
    (error: unknown) => error instanceof SvgAdapterError && error.code === "proposal.path_not_found"
  );
});

test("duplicate id throws duplicate_path_id, never a guess", () => {
  // 守る仕様 (T6): id 重複は推測で 1 本選ばず error。
  const duplicate = `<svg><path id="dup" d="M 0 0 L 1 1"/><path id="dup" d="M 0 0 L 2 2"/></svg>`;
  assert.throws(
    () => findSvgPathById(duplicate, "dup"),
    (error: unknown) =>
      error instanceof SvgAdapterError && error.code === "proposal.duplicate_path_id"
  );
});

test("replacing one path's d preserves every other byte of the SVG", () => {
  // 守る仕様 (T6): 対象 d 以外（他 path・属性・整形・viewBox）を保存する。full 再シリアライズしない。
  const out = replaceSvgPathData(FIXTURE, "body-armhole", NEW_D);

  assert.equal(findSvgPathById(out, "body-armhole").d, NEW_D);
  assert.equal(findSvgPathById(out, "sleeve-cap").d, SLEEVE_D);
  assert.match(out, /stroke="blue"/);
  assert.match(out, /viewBox="0 0 220 180"/);

  // Strongest form: masking the changed d region on both sides yields identical text,
  // i.e. exactly one span differs and nothing else moved.
  assert.equal(out.replace(NEW_D, "<D>"), FIXTURE.replace(ARMHOLE_D, "<D>"));
});

test("path digest changes after replacement, sibling digest is unchanged", () => {
  // 守る仕様 (M2 完了条件): 差し替え後は対象 path の digest だけが変わる。
  const before = findSvgPathById(FIXTURE, "body-armhole");
  const out = replaceSvgPathData(FIXTURE, "body-armhole", NEW_D);
  const after = findSvgPathById(out, "body-armhole");

  assert.notEqual(digestPathData(before.d), digestPathData(after.d));
  assert.equal(digestPathData(SLEEVE_D), digestPathData(findSvgPathById(out, "sleeve-cap").d));
});

test("replacement rejects empty or attribute-breaking path data", () => {
  // 守る仕様: 空や引用符を含む d は属性を壊すため受け付けない。
  assert.throws(() => replaceSvgPathData(FIXTURE, "body-armhole", "   "));
  assert.throws(() => replaceSvgPathData(FIXTURE, "body-armhole", 'M 0 0 " L 1 1'));
});
