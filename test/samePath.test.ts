import assert from "node:assert/strict";
import test from "node:test";

import { isSameFilePath } from "../src/cli/samePath.ts";

test("isSameFilePath treats identical resolved paths as the same file", () => {
  assert.equal(isSameFilePath("a/b/out.dxf", "a/b/out.dxf"), true);
  assert.equal(isSameFilePath("a/./b/out.dxf", "a/b/out.dxf"), true);
});

test("isSameFilePath treats clearly different paths as different", () => {
  assert.equal(isSameFilePath("a/b/out.dxf", "a/b/source.dxf"), false);
});

test("on Windows a case-only difference is the SAME file (apply must not overwrite source, T1)", () => {
  // The filesystem is case-insensitive on Windows, so C:\Foo.dxf and c:\foo.dxf are one file. A
  // case-sensitive compare would let apply write over the source. Only assert on win32.
  if (process.platform !== "win32") return;
  assert.equal(isSameFilePath("C:/Tmp/Foo.dxf", "c:/tmp/foo.dxf"), true);
  assert.equal(isSameFilePath("C:\\Tmp\\Foo.dxf", "c:\\tmp\\foo.dxf"), true);
});
