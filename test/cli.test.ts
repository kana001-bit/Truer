import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("propose with a bandEdge-less band report exits 0 and records the skip (slnt not spawned)", () => {
  // 守る仕様 (B1 訂正 / T8 + exit code 契約): band 診断は supported だが、bandEdge 住所（B1 additive）を
  //           持たない report では band 辺を addressing できず、resolver は slnt を spawn する前に not-found を
  //           返す → proposal.missing_band_fields で skip。proposal が 1 件も無くても tru propose は exit 0 で
  //           file を書き、理由付きで skipped に残す。slnt が無い環境でも成立（住所欠落で lazy spawn に到達しない）。
  const dir = mkdtempSync(join(tmpdir(), "truer-band-skip-"));
  const report = {
    status: "warning",
    target: "geometry-request",
    diagnostics: [
      {
        severity: "warning",
        code: "geometry.band_seam_sum_mismatch",
        target: "waistband",
        expected: { checkId: "waist", kind: "band-seam" },
        actual: {
          neighbours: [
            {
              partId: "front",
              blockName: "FRONT",
              edgeId: 0,
              arcRange: [0.499, 0.887],
              finishedLengthMm: 165,
              cutQuantity: 2
            }
          ],
          bandTotalMm: 700.25,
          sumMm: 330,
          closureMm: 370.25,
          closurePct: 52.88
        }
      }
    ],
    reports: []
  };
  const reportPath = join(dir, "band.report.json");
  writeFileSync(reportPath, JSON.stringify(report));
  const outPath = join(dir, "band.proposal.json");

  const result = runTru([
    "propose",
    "test/fixtures/curve-kink.dxf",
    "--diagnostic",
    reportPath,
    "--out",
    outPath
  ]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /0 proposal\(s\), 1 skipped/);

  const file = JSON.parse(readFileSync(outPath, "utf8")) as {
    proposals: unknown[];
    skipped: { code: string; diagnosticCode: string }[];
  };
  assert.equal(file.proposals.length, 0);
  assert.equal(file.skipped[0]!.code, "proposal.missing_band_fields");
  assert.equal(file.skipped[0]!.diagnosticCode, "geometry.band_seam_sum_mismatch");
});

// ---- <pattern.dxf> optional 化（cwd 単一 DXF 探索）----

// tru.ts の絶対パス。cwd を temp dir に差し替えて起動するため、相対パスではなく絶対で渡す。
const TRU_ABS = join(process.cwd(), "src/cli/tru.ts");
function runTruIn(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [TRU_ABS, ...args], { cwd, encoding: "utf8" });
}
// 診断ゼロの report（slnt を spawn せず 0 proposal で exit 0 になる最小形）。dxf 解決だけを検証する。
const EMPTY_REPORT = { status: "ok", target: "geometry-request", diagnostics: [], reports: [] };

test("usage shows <pattern.dxf> is optional", () => {
  // 守る仕様: propose/apply の usage が <pattern.dxf> を [ ] 付き（省略可）で示す。
  const result = runTru(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[<pattern\.dxf>\]/);
});

test("propose omits <pattern.dxf>: resolves the single DXF in cwd", () => {
  // 守る仕様: 「1 プロジェクト = 1 DXF」の通常運用は引数ゼロで通る。cwd 直下に *.dxf が 1 つなら
  //           それを source にして propose が成立する（proposal.source.file がその DXF を指す）。
  const dir = mkdtempSync(join(tmpdir(), "truer-dxf-solo-"));
  writeFileSync(join(dir, "solo.dxf"), "x");
  writeFileSync(join(dir, "empty.report.json"), JSON.stringify(EMPTY_REPORT));
  const outPath = join(dir, "p.json");

  const result = runTruIn(dir, ["propose", "--diagnostic", "empty.report.json", "--out", outPath]);
  assert.equal(result.status, 0);

  const file = JSON.parse(readFileSync(outPath, "utf8")) as { source: { file: string } };
  assert.match(file.source.file, /solo\.dxf$/);
});

test("propose omits <pattern.dxf>: multiple DXFs in cwd is a usage error (exit 2)", () => {
  // 守る仕様: cwd に *.dxf が複数あるときは推測せず exit 2 で明示指定を促す（両ファイル名を挙げる）。
  const dir = mkdtempSync(join(tmpdir(), "truer-dxf-multi-"));
  writeFileSync(join(dir, "a.dxf"), "x");
  writeFileSync(join(dir, "b.dxf"), "x");

  const result = runTruIn(dir, ["propose", "--diagnostic", "whatever.json"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /複数あります/);
  assert.match(result.stderr, /a\.dxf/);
  assert.match(result.stderr, /b\.dxf/);
});

test("propose omits <pattern.dxf>: no DXF in cwd is a usage error (exit 2)", () => {
  // 守る仕様: cwd に *.dxf が無ければ exit 2 でパス指定を促す（黙って 0 件処理にしない）。
  const dir = mkdtempSync(join(tmpdir(), "truer-dxf-none-"));

  const result = runTruIn(dir, ["propose", "--diagnostic", "whatever.json"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /DXF が見つかりません/);
});

test("propose explicit <pattern.dxf> overrides cwd auto-discovery", () => {
  // 守る仕様: 明示パスを渡せば cwd に複数 DXF があっても曖昧にならない（override として存続、廃止しない）。
  const dir = mkdtempSync(join(tmpdir(), "truer-dxf-override-"));
  writeFileSync(join(dir, "a.dxf"), "x");
  writeFileSync(join(dir, "b.dxf"), "x");
  writeFileSync(join(dir, "empty.report.json"), JSON.stringify(EMPTY_REPORT));
  const outPath = join(dir, "p.json");

  const result = runTruIn(dir, [
    "propose",
    "a.dxf",
    "--diagnostic",
    "empty.report.json",
    "--out",
    outPath
  ]);
  assert.equal(result.status, 0);
  const file = JSON.parse(readFileSync(outPath, "utf8")) as { source: { file: string } };
  assert.match(file.source.file, /a\.dxf$/);
});
