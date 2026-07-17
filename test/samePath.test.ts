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
  // Windows では filesystem が case 非依存なので、C:\Foo.dxf と c:\foo.dxf は同じ file。case 依存の
  // 比較は apply に source を上書きさせてしまう。assert は win32 でだけ行う。
  if (process.platform !== "win32") return;
  assert.equal(isSameFilePath("C:/Tmp/Foo.dxf", "c:/tmp/foo.dxf"), true);
  assert.equal(isSameFilePath("C:\\Tmp\\Foo.dxf", "c:\\tmp\\foo.dxf"), true);
});
