import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function runTru(args: string[]) {
  return spawnSync(process.execPath, ["./src/cli/tru.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8"
  });
}

test("tru --help prints usage and exits 0", () => {
  // 守る仕様: Milestone 0 完了条件。tru --help が起動し usage を出して exit 0。
  const result = runTru(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /tru propose/);
});

test("no arguments prints usage and exits 0", () => {
  // 守る仕様: 引数なしは help と同じ扱い (探索的に叩いても壊れない)。
  const result = runTru([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage:/);
});

test("unknown command exits 1 with usage on stderr", () => {
  // 守る仕様: 未知コマンドは cli エラーとして exit 1。
  const result = runTru(["frobnicate"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command/);
});

test("usage documents --reference and no longer requires --out on propose", () => {
  // 守る仕様: propose の usage に --reference が載り、--out は任意（[--out ...]）で示される。
  const result = runTru(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--reference <block>/);
  assert.match(result.stdout, /\[--out <proposal\.json>\]/);
});

test("propose --reference without a value is a usage error (exit 2)", () => {
  // 守る仕様: --reference は BLOCK 名を要する。値欠落は parse 段階の usage エラー（exit 2）で、file も slnt も触らない。
  const result = runTru(["propose", "x.dxf", "--diagnostic", "r.json", "--reference"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--reference requires at least one/);
});

test("propose --reference takes multiple BLOCK names (BACK FRONT is not a stray positional)", () => {
  // 守る仕様: --reference は多トークン（--accepted と同形）。`--reference BACK FRONT` の FRONT が 2 個目の
  //           位置引数に落ちて "Expected a single <pattern.dxf>" にならない（usage 誤り exit 2 ではなく先へ進む）。
  const result = runTru([
    "propose",
    "no-such.dxf",
    "--diagnostic",
    "no-such.json",
    "--reference",
    "BACK",
    "FRONT"
  ]);
  assert.notEqual(result.status, 2);
  assert.doesNotMatch(result.stderr, /Expected a single/);
});
