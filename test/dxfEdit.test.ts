import assert from "node:assert/strict";
import test from "node:test";

import {
  DXF_VERTEX_AMBIGUOUS,
  DXF_VERTEX_NOT_FOUND,
  DxfEditError,
  editNetLineVertex
} from "../src/adapters/dxf/editNetLineVertex.ts";

// 最小の ASTM 形 DXF: layer-1 outline と layer-14 net line を持つ BLOCK "BODY" 1 つ。layer-1 outline は
// 意図的に net line と vertex (0,0) を共有し、editor が layer 14 だけを触ることを示す。net line には
// 動かす専用の vertex (20,40) がある。
const DXF = [
  "0",
  "SECTION",
  "2",
  "BLOCKS",
  "0",
  "BLOCK",
  "2",
  "BODY",
  "0",
  "POLYLINE",
  "8",
  "1",
  "70",
  "1",
  "0",
  "VERTEX",
  "10",
  "0",
  "20",
  "0",
  "0",
  "VERTEX",
  "10",
  "60",
  "20",
  "60",
  "0",
  "SEQEND",
  "0",
  "POLYLINE",
  "8",
  "14",
  "70",
  "1",
  "0",
  "VERTEX",
  "10",
  "0",
  "20",
  "0",
  "0",
  "VERTEX",
  "10",
  "10",
  "20",
  "5",
  "0",
  "VERTEX",
  "10",
  "20",
  "20",
  "40",
  "0",
  "VERTEX",
  "10",
  "30",
  "20",
  "5",
  "0",
  "SEQEND",
  "0",
  "ENDBLK",
  "0",
  "ENDSEC",
  "0",
  "EOF",
  ""
].join("\n");

test("editNetLineVertex moves the matched layer-14 vertex and preserves every other byte (T6)", () => {
  const out = editNetLineVertex(DXF, "BODY", { x: 20, y: 40 }, { x: 20.5, y: 2.5 });

  const before = DXF.split("\n");
  const after = out.split("\n");
  assert.equal(before.length, after.length);

  const changed = before
    .map((line, index) => (line === after[index] ? -1 : index))
    .filter((index) => index >= 0);
  // 変わる行はちょうど 2 つ: (20,40) vertex の x 値行と y 値行。
  assert.equal(changed.length, 2);
  assert.equal(before[changed[0]!], "20");
  assert.equal(after[changed[0]!], "20.5");
  assert.equal(before[changed[1]!], "40");
  assert.equal(after[changed[1]!], "2.5");
});

test("editNetLineVertex ignores a coordinate that lives only on layer 1, not layer 14", () => {
  // (60,60) は layer-1 outline の vertex で layer-14 net line には無いので、見つかってはならない。
  assert.throws(
    () => editNetLineVertex(DXF, "BODY", { x: 60, y: 60 }, { x: 61, y: 61 }),
    (error: unknown) => error instanceof DxfEditError && error.code === DXF_VERTEX_NOT_FOUND
  );
});

test("editNetLineVertex refuses when the coordinate matches no layer-14 vertex", () => {
  assert.throws(
    () => editNetLineVertex(DXF, "BODY", { x: 999, y: 999 }, { x: 0, y: 0 }),
    (error: unknown) => error instanceof DxfEditError && error.code === DXF_VERTEX_NOT_FOUND
  );
});

test("editNetLineVertex refuses a wrong block name (vertex not found there)", () => {
  assert.throws(
    () => editNetLineVertex(DXF, "SLEEVE", { x: 20, y: 40 }, { x: 20.5, y: 2.5 }),
    (error: unknown) => error instanceof DxfEditError && error.code === DXF_VERTEX_NOT_FOUND
  );
});

test("editNetLineVertex refuses an ambiguous match rather than guess (T6/T8)", () => {
  // (7,7) に同一の layer-14 vertex が 2 つ: editor はどちらか 1 つを選んではならない。
  const ambiguous = [
    "0",
    "SECTION",
    "2",
    "BLOCKS",
    "0",
    "BLOCK",
    "2",
    "BODY",
    "0",
    "POLYLINE",
    "8",
    "14",
    "70",
    "1",
    "0",
    "VERTEX",
    "10",
    "7",
    "20",
    "7",
    "0",
    "VERTEX",
    "10",
    "9",
    "20",
    "9",
    "0",
    "VERTEX",
    "10",
    "7",
    "20",
    "7",
    "0",
    "SEQEND",
    "0",
    "ENDBLK",
    "0",
    "ENDSEC",
    "0",
    "EOF",
    ""
  ].join("\n");
  assert.throws(
    () => editNetLineVertex(ambiguous, "BODY", { x: 7, y: 7 }, { x: 8, y: 8 }),
    (error: unknown) => error instanceof DxfEditError && error.code === DXF_VERTEX_AMBIGUOUS
  );
});

test("editNetLineVertex preserves CRLF separators when the source uses them", () => {
  const crlf = DXF.replace(/\n/g, "\r\n");
  const out = editNetLineVertex(crlf, "BODY", { x: 20, y: 40 }, { x: 20.5, y: 2.5 });
  // 依然 CRLF で、vertex は動いた。
  assert.ok(out.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(out), "no bare LF introduced");
  assert.ok(out.includes("20.5\r\n"));
});
