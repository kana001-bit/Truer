import assert from "node:assert/strict";
import test from "node:test";

import {
  DXF_VERTEX_AMBIGUOUS,
  DXF_VERTEX_NOT_FOUND,
  DxfEditError,
  editNetLineVertex
} from "../src/adapters/dxf/editNetLineVertex.ts";

// A minimal ASTM-shaped DXF: one BLOCK "BODY" with a layer-1 outline and a layer-14 net line. The
// layer-1 outline shares the vertex (0,0) with the net line on purpose, to prove the editor only
// touches layer 14. The net line has a distinct vertex (20,40) we move.
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
  // Exactly two lines change: the x value line and the y value line of the (20,40) vertex.
  assert.equal(changed.length, 2);
  assert.equal(before[changed[0]!], "20");
  assert.equal(after[changed[0]!], "20.5");
  assert.equal(before[changed[1]!], "40");
  assert.equal(after[changed[1]!], "2.5");
});

test("editNetLineVertex ignores a coordinate that lives only on layer 1, not layer 14", () => {
  // (60,60) is a layer-1 outline vertex, not on the layer-14 net line, so it must not be found.
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
  // Two identical layer-14 vertices at (7,7): the editor must not pick one.
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
  // Still CRLF, and the vertex moved.
  assert.ok(out.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(out), "no bare LF introduced");
  assert.ok(out.includes("20.5\r\n"));
});
