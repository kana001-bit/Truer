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
