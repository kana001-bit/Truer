import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createSlntEdgesRunner,
  tokenizeCommand,
  resolveSlntCommand
} from "../src/adapters/seamlint/slntRunner.ts";

test("tokenizeCommand keeps quoted paths with spaces as one argv token", () => {
  // 守る仕様: `node "C:\Program Files\...\slnt.ts"` を空白で割らない（Windows の一般的な構成で壊れない）。
  assert.deepEqual(tokenizeCommand('node "C:\\Program Files\\seamlint\\src\\cli\\slnt.ts"'), [
    "node",
    "C:\\Program Files\\seamlint\\src\\cli\\slnt.ts"
  ]);
  assert.deepEqual(tokenizeCommand("node C:/Users/kannn/Seamlint/src/cli/slnt.ts"), [
    "node",
    "C:/Users/kannn/Seamlint/src/cli/slnt.ts"
  ]);
  assert.deepEqual(tokenizeCommand("'/opt/my seamlint/slnt'"), ["/opt/my seamlint/slnt"]);
  assert.deepEqual(tokenizeCommand("slnt"), ["slnt"]);
});

test('tokenizeCommand keeps inline-quoted flag values (--flag="value with spaces") as one token', () => {
  // 守る仕様: クォートはトークン途中にも現れる。--loader="C:\Program Files\..." を割らない。
  assert.deepEqual(
    tokenizeCommand('node --loader="C:\\Program Files\\tsx\\loader.mjs" C:/seamlint/slnt.ts'),
    ["node", "--loader=C:\\Program Files\\tsx\\loader.mjs", "C:/seamlint/slnt.ts"]
  );
  assert.deepEqual(tokenizeCommand("cmd --require='/opt/a b/hook.js'"), [
    "cmd",
    "--require=/opt/a b/hook.js"
  ]);
  // 隣接するクォート片は shell 同様に連結する。
  assert.deepEqual(tokenizeCommand('a"b c"d'), ["ab cd"]);
});

test("resolveSlntCommand tokenizes SEAMLINT_CLI (quote-aware) and defaults to slnt", () => {
  assert.deepEqual(resolveSlntCommand({ SEAMLINT_CLI: 'node "C:\\Program Files\\x\\slnt.ts"' }), [
    "node",
    "C:\\Program Files\\x\\slnt.ts"
  ]);
  assert.deepEqual(resolveSlntCommand({}), ["slnt"]);
  assert.deepEqual(resolveSlntCommand({ SEAMLINT_CLI: "   " }), ["slnt"]);
});

test(
  "createSlntEdgesRunner runs a .cmd-wrapped slnt on Windows (Node >= 24 .cmd spawn guard)",
  { skip: process.platform !== "win32" ? "Windows-only: .cmd spawn behavior" : false },
  () => {
    // 守る仕様: slnt が `.cmd`（npm 導入 / loom が --slnt で転送）でも edges を取れる。Node >= 24 は `.cmd` を
    //           `shell:true` 無しで spawn できず EINVAL になるので、runner は `.cmd` を shell 経由で起動する。
    const dir = mkdtempSync(join(tmpdir(), "truer-slnt-cmd-"));
    const script = join(dir, "fake-slnt.mjs");
    // 引数は無視して固定の edges JSON を返す最小の slnt スタブ。
    writeFileSync(
      script,
      "process.stdout.write(JSON.stringify({blockName:'BODY',edges:[{edgeId:0,points:[{x:0,y:0},{x:10,y:0}]}]}));\n"
    );
    const cmd = join(dir, "fake-slnt.cmd");
    writeFileSync(cmd, `@node "${script}" %*\r\n`);

    const runner = createSlntEdgesRunner({ slntCommand: [cmd], dxfFile: join(dir, "pattern.dxf") });
    const result = runner("BODY");
    assert.equal(result.blockName, "BODY");
    assert.equal(result.edges.length, 1);
    assert.deepEqual(result.edges[0]!.points, [
      { x: 0, y: 0 },
      { x: 10, y: 0 }
    ]);
  }
);
