import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createSlntEdgesRunner,
  detectCmdPercentRisk,
  tokenizeCommand,
  resolveSlntCommand
} from "../src/adapters/seamlint/slntRunner.ts";

test("tokenizeCommand keeps quoted paths with spaces as one argv token", () => {
  // 守る仕様: `node "C:\Program Files\...\slnt.ts"` を空白で割らない（Windows の一般的な構成で壊れない）。
  assert.deepEqual(tokenizeCommand('node "C:\\Program Files\\seamlint\\src\\cli\\slnt.ts"'), [
    "node",
    "C:\\Program Files\\seamlint\\src\\cli\\slnt.ts"
  ]);
  assert.deepEqual(tokenizeCommand("node C:/tools/seamlint/src/cli/slnt.ts"), [
    "node",
    "C:/tools/seamlint/src/cli/slnt.ts"
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

test(
  "createSlntEdgesRunner runs a .cmd slnt whose directory name contains %VAR% (no cmd env expansion)",
  { skip: process.platform !== "win32" ? "Windows-only: .cmd %VAR% path behavior" : false },
  () => {
    // 守る仕様: slnt.cmd が「定義済み環境変数に一致する %VAR%」を名前に持つディレクトリ配下でも起動できる。
    //           cmd.exe は命令行の %VAR% を二重引用符内でも展開するので、実行ファイルは cwd + 相対名で参照して
    //           % を命令行に載せない。SLNTFOO を定義して %SLNTFOO% ディレクトリを作り、展開されると壊れる状況で確認。
    const prev = process.env.SLNTFOO;
    process.env.SLNTFOO = "expanded-wrong";
    try {
      const dir = mkdtempSync(join(tmpdir(), "truer-slnt-pct-"));
      const pctDir = join(dir, "%SLNTFOO%");
      mkdirSync(pctDir);
      const cmd = join(pctDir, "fake-slnt.cmd");
      // 外部参照なしの自己完結 .cmd（echo で edges JSON を返す）＝実行ファイルの起動(layer1)だけを固定する。
      writeFileSync(
        cmd,
        `@echo {"blockName":"BODY","edges":[{"edgeId":0,"points":[{"x":0,"y":0},{"x":10,"y":0}]}]}\r\n`,
        "utf8"
      );

      const runner = createSlntEdgesRunner({
        slntCommand: [cmd],
        dxfFile: join(pctDir, "pattern.dxf")
      });
      const result = runner("BODY");
      assert.equal(result.blockName, "BODY");
      assert.deepEqual(result.edges[0]!.points, [
        { x: 0, y: 0 },
        { x: 10, y: 0 }
      ]);
    } finally {
      if (prev === undefined) {
        delete process.env.SLNTFOO;
      } else {
        process.env.SLNTFOO = prev;
      }
    }
  }
);

test(
  "createSlntEdgesRunner runs a .cmd slnt whose name contains cmd metacharacters (e.g. &)",
  { skip: process.platform !== "win32" ? "Windows-only: .cmd metachar name" : false },
  () => {
    // 守る仕様: slnt.cmd の名前に cmd.exe メタ文字（& ( ) 等）が入っても起動できる。basename と引数を二重
    //           引用符で囲み、外側1組を /s に剥がさせて literal 化するため（cmd の & による分断を防ぐ）。
    const dir = mkdtempSync(join(tmpdir(), "truer-slnt-meta-"));
    const cmd = join(dir, "fake&slnt.cmd");
    writeFileSync(
      cmd,
      `@echo {"blockName":"BODY","edges":[{"edgeId":0,"points":[{"x":0,"y":0},{"x":10,"y":0}]}]}\r\n`,
      "utf8"
    );

    const runner = createSlntEdgesRunner({ slntCommand: [cmd], dxfFile: join(dir, "pattern.dxf") });
    const result = runner("BODY");
    assert.equal(result.blockName, "BODY");
    assert.deepEqual(result.edges[0]!.points, [
      { x: 0, y: 0 },
      { x: 10, y: 0 }
    ]);
  }
);

test(
  "detectCmdPercentRisk warns only for a .cmd slnt with a defined %VAR% in a path",
  { skip: process.platform !== "win32" ? "Windows-only: cmd %VAR% risk" : false },
  () => {
    // 守る仕様: slnt が .cmd/.bat かつ path に「定義済み環境変数に一致する %VAR%」があるときだけ警告文を返す。
    //           未定義変数の %...%（実際は cmd がそのまま残す＝動く）や、非 .cmd の slnt では警告しない（空振りしない）。
    const prev = process.env.SLNTPCT;
    process.env.SLNTPCT = "x";
    try {
      const warn = detectCmdPercentRisk(["C:\\tools\\slnt.cmd"], ["C:\\a\\%SLNTPCT%\\pattern.dxf"]);
      assert.match(warn ?? "", /%SLNTPCT%/);
      // 未定義変数 → 警告しない
      assert.equal(
        detectCmdPercentRisk(["C:\\tools\\slnt.cmd"], ["C:\\a\\%SLNT_UNDEFINED_XYZ%\\p.dxf"]),
        undefined
      );
      // 非 .cmd（node <script>）→ 警告しない
      assert.equal(
        detectCmdPercentRisk(["node", "C:\\x\\slnt.ts"], ["C:\\a\\%SLNTPCT%\\p.dxf"]),
        undefined
      );
    } finally {
      if (prev === undefined) {
        delete process.env.SLNTPCT;
      } else {
        process.env.SLNTPCT = prev;
      }
    }
  }
);

// `node <stub>` で slnt を模し、edges JSON を stdout に出す（クロスプラットフォーム。`.cmd` 版と違い Windows 限定でない）。
function runnerWithEdges(edges: unknown): ReturnType<typeof createSlntEdgesRunner> {
  const dir = mkdtempSync(join(tmpdir(), "truer-slnt-notch-"));
  const script = join(dir, "fake-slnt.mjs");
  writeFileSync(
    script,
    `process.stdout.write(JSON.stringify({ blockName: "BODY", edges: ${JSON.stringify(edges)} }));\n`
  );
  return createSlntEdgesRunner({
    slntCommand: [process.execPath, script],
    dxfFile: join(dir, "pattern.dxf")
  });
}

test("createSlntEdgesRunner carries each edge's notches (edgePosition/notchType/onCorner/ambiguous)", () => {
  // 守る仕様 (step2/[C6]): runner は各 edge の notches を落とさず carry する（旧実装は {edgeId, points} だけにしていた）。
  //           matcher の主キー edgePosition が無い notch は落とし、notchType の欠落は undefined（弱 tie-breaker）にする。
  //           座標 / offsetMm / loopPosition は matcher に不要なので carry しない。
  const runner = runnerWithEdges([
    {
      edgeId: 0,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 }
      ],
      notches: [
        {
          point: { x: 5, y: 0 },
          offsetMm: 2,
          edgePosition: 0.5,
          loopPosition: 0.3,
          onCorner: false,
          ambiguous: false,
          notchType: "v"
        },
        {
          point: { x: 0, y: 0 },
          offsetMm: 0,
          edgePosition: 0,
          loopPosition: 0,
          onCorner: true,
          ambiguous: false,
          notchType: "t"
        },
        {
          point: { x: 9, y: 0 },
          offsetMm: 1,
          edgePosition: 0.9,
          loopPosition: 0.9,
          onCorner: false,
          ambiguous: true
        },
        { point: { x: 1, y: 0 }, offsetMm: 1, onCorner: false, ambiguous: false, notchType: "v" }
      ]
    }
  ]);
  const notches = runner("BODY").edges[0]!.notches!;
  assert.equal(notches.length, 3); // edgePosition 欠落の 1 件は落ちる
  assert.deepEqual(notches[0], {
    edgePosition: 0.5,
    onCorner: false,
    ambiguous: false,
    notchType: "v"
  });
  assert.equal(notches[1]!.onCorner, true);
  assert.equal(notches[1]!.notchType, "t");
  assert.equal(notches[2]!.ambiguous, true);
  assert.equal(notches[2]!.notchType, undefined); // notchType 欠落 → undefined
});

test("createSlntEdgesRunner: notches 無しの edge は notches=[]（後方互換）", () => {
  // 守る仕様: notches を持たない slnt 出力でも壊れず、下流が常に配列を回せるよう [] にする。
  const runner = runnerWithEdges([
    {
      edgeId: 0,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 }
      ]
    }
  ]);
  assert.deepEqual(runner("BODY").edges[0]!.notches, []);
});
