import assert from "node:assert/strict";
import test from "node:test";

import { tokenizeCommand, resolveSlntCommand } from "../src/adapters/seamlint/slntRunner.ts";

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
