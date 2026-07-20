import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProposalFile } from "../src/core/proposal/createProposalFile.ts";
import type { DiagnosticInput } from "../src/core/proposal/createProposalFile.ts";
import { buildResolveBandSeam } from "../src/adapters/seamlint/index.ts";
import type { SlntEdgesRunner, SlntEdgesResult } from "../src/adapters/seamlint/index.ts";

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

// ---- tru cut（band 印刷 stopgap SVG）----

// band 提案を作るための stub。WAISTBAND の band 辺（propose 側の住所解決用）を返す runner。
function cutBandRunner(): SlntEdgesRunner {
  return (blockName): SlntEdgesResult => {
    if (blockName === "WAISTBAND") {
      return {
        blockName,
        edges: [
          {
            edgeId: 0,
            points: [
              { x: 0, y: 0 },
              { x: 350, y: 0 }
            ]
          }
        ]
      };
    }
    throw new Error(`unexpected block ${blockName}`);
  };
}

// band_seam_sum_mismatch 診断（band 700=350×2 vs Σ neighbours 655 → closure 45）。
function cutBandDiagnostic(): DiagnosticInput {
  return {
    code: "geometry.band_seam_sum_mismatch",
    severity: "warning",
    target: "waistband",
    expected: { checkId: "waist", kind: "band-seam" },
    actual: {
      bandEdge: { blockName: "WAISTBAND", edgeId: 0, arcRange: [0.0, 0.45] },
      bandEdgeId: 0,
      bandLengthMm: 350,
      bandCutQuantity: 2,
      bandTotalMm: 700,
      sumMm: 655,
      closureMm: 45,
      closurePct: 0.0687,
      neighbours: [
        {
          partId: "front",
          blockName: "FRONT",
          edgeId: 0,
          arcRange: [0.499, 0.887],
          finishedLengthMm: 165,
          cutQuantity: 2
        },
        {
          partId: "back",
          blockName: "BACK",
          edgeId: 0,
          arcRange: [0.471, 0.899],
          finishedLengthMm: 162.5,
          cutQuantity: 2
        }
      ]
    },
    suggestion: ["x"]
  };
}

// band conform（reference=neighbours → targetBandLengthMm=655/2=327.5）の valid proposal を dir に書く。
function writeBandProposal(dir: string): string {
  const file = createProposalFile({
    sourceFile: "pattern.dxf",
    sourceText: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n",
    diagnostics: [cutBandDiagnostic()],
    resolveTarget: () => ({ status: "not-found" as const }),
    resolveBandSeam: buildResolveBandSeam(cutBandRunner(), ["FRONT"])
  });
  const path = join(dir, "band.proposal.json");
  writeFileSync(path, JSON.stringify(file));
  return path;
}

// 同一 band block（WAISTBAND）を指す band conform 提案を 2 件持つ valid proposal を書く。
function writeTwoBandProposals(dir: string): string {
  const file = createProposalFile({
    sourceFile: "pattern.dxf",
    sourceText: "0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n",
    diagnostics: [cutBandDiagnostic(), cutBandDiagnostic()],
    resolveTarget: () => ({ status: "not-found" as const }),
    resolveBandSeam: buildResolveBandSeam(cutBandRunner(), ["FRONT"])
  });
  const path = join(dir, "two.proposal.json");
  writeFileSync(path, JSON.stringify(file));
  return path;
}

// fake slnt: `edges <dxf> --block <name> --json` に矩形 or 三角形の edges を返す node スクリプト。
function writeFakeSlnt(dir: string, shape: "rect" | "triangle"): string {
  const corners = shape === "rect" ? "[[0,0],[350,0],[350,40],[0,40]]" : "[[0,0],[350,0],[175,40]]";
  const script = [
    "const a = process.argv.slice(2);",
    'const bi = a.indexOf("--block");',
    'const block = bi >= 0 ? a[bi + 1] : "?";',
    `const c = ${corners};`,
    "const edges = c.map((p, i) => ({ edgeId: i, points: [ { x: p[0], y: p[1] }, { x: c[(i + 1) % c.length][0], y: c[(i + 1) % c.length][1] } ] }));",
    "process.stdout.write(JSON.stringify({ blockName: block, edges }));"
  ].join("\n");
  const path = join(dir, "fake-slnt.js");
  writeFileSync(path, script);
  return path;
}

test("cut: --scale must be fit-a4 or actual (usage error exit 2)", () => {
  const result = runTru([
    "cut",
    "x.dxf",
    "--proposal",
    "p.json",
    "--scale",
    "bogus",
    "--out",
    "o.svg"
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--scale must be fit-a4 or actual/);
});

test("cut: --proposal and --out are required (exit 2)", () => {
  const result = runTru(["cut", "x.dxf", "--scale", "actual"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--proposal and --out are required/);
});

test("cut: no band-conform proposal writes nothing (exit 0, slnt not spawned)", () => {
  // 守る仕様: targetBandLengthMm を持つ band 提案が無ければ、推測せず何も書かず exit 0（理由を出す）。
  const dir = mkdtempSync(join(tmpdir(), "truer-cut-none-"));
  const file = createProposalFile({
    sourceFile: "pattern.dxf",
    sourceText: "x",
    diagnostics: [],
    resolveTarget: () => ({ status: "not-found" as const })
  });
  const pp = join(dir, "empty.proposal.json");
  writeFileSync(pp, JSON.stringify(file));
  const out = join(dir, "cut.svg");
  const result = runTruIn(dir, ["cut", "--proposal", pp, "--scale", "actual", "--out", out]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /裁断できる band 提案がありません/);
  assert.equal(existsSync(out), false);
});

test("cut: band-conform proposal -> 実寸カバー + タイル（happy path, fake slnt）", () => {
  // 守る仕様: band conform 提案 + 矩形バンド → actual は calibration カバー + A4 タイルを書く。素の
  //           --out は書かず、カバーに 10cm 実寸四角と目標長 327.5（655/2）を載せる。
  const dir = mkdtempSync(join(tmpdir(), "truer-cut-ok-"));
  const pp = writeBandProposal(dir);
  const slnt = writeFakeSlnt(dir, "rect");
  writeFileSync(join(dir, "pattern.dxf"), "x");
  const out = join(dir, "cut.svg");
  const result = runTruIn(dir, [
    "cut",
    "pattern.dxf",
    "--proposal",
    pp,
    "--scale",
    "actual",
    "--slnt",
    `node ${slnt}`,
    "--out",
    out
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cut: WAISTBAND \(actual\)/);
  // actual は複数ファイル（カバー + タイル）。素の --out は書かれない。
  assert.equal(existsSync(out), false);
  const cover = join(dir, "cut.calibration.svg");
  assert.equal(existsSync(cover), true);
  const coverSvg = readFileSync(cover, "utf8");
  assert.match(coverSvg, /10cm/); // calibration square
  assert.match(coverSvg, /327\.5/); // 655/2 に縮んだ最長辺（dimText）
  const tiles = readdirSync(dir).filter((file) => /^cut\.tile-\d+of\d+\.svg$/.test(file));
  assert.ok(tiles.length >= 1, `tiles: ${tiles}`);
});

test("cut: non-rectangle band is skipped without writing (fake slnt returns triangle, T8)", () => {
  // 守る仕様: 矩形の直線バンドでなければ推測せず出さない。理由を出し、ファイルは書かない。
  const dir = mkdtempSync(join(tmpdir(), "truer-cut-tri-"));
  const pp = writeBandProposal(dir);
  const slnt = writeFakeSlnt(dir, "triangle");
  writeFileSync(join(dir, "pattern.dxf"), "x");
  const out = join(dir, "cut.svg");
  const result = runTruIn(dir, [
    "cut",
    "pattern.dxf",
    "--proposal",
    pp,
    "--scale",
    "actual",
    "--slnt",
    `node ${slnt}`,
    "--out",
    out
  ]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /skipped WAISTBAND/);
  assert.match(result.stdout, /not-a-rectangle/);
  assert.equal(existsSync(out), false);
});

test("cut: --seam-allowance をカバーに反映", () => {
  // 守る仕様: --seam-allowance <mm> が cutsheet に通り、カバーに縫い代が明記される。
  const dir = mkdtempSync(join(tmpdir(), "truer-cut-sa-"));
  const pp = writeBandProposal(dir);
  const slnt = writeFakeSlnt(dir, "rect");
  writeFileSync(join(dir, "pattern.dxf"), "x");
  const out = join(dir, "cut.svg");
  const result = runTruIn(dir, [
    "cut",
    "pattern.dxf",
    "--proposal",
    pp,
    "--scale",
    "actual",
    "--seam-allowance",
    "15",
    "--slnt",
    `node ${slnt}`,
    "--out",
    out
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(dir, "cut.calibration.svg"), "utf8"), /縫い代 15mm/);
});

test("cut: --seam-allowance が負なら usage error (exit 2)", () => {
  const result = runTru([
    "cut",
    "x.dxf",
    "--proposal",
    "p.json",
    "--scale",
    "actual",
    "--seam-allowance",
    "-5",
    "--out",
    "o.svg"
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /seam-allowance must be a non-negative number/);
});

test("cut: --on-fold long でわ辺（縫い代 0）をカバーに反映", () => {
  // 守る仕様: --on-fold long が cutsheet に通り、わ辺の裁ち方（縫い代 0）がカバーに明記される。
  const dir = mkdtempSync(join(tmpdir(), "truer-cut-fold-"));
  const pp = writeBandProposal(dir);
  const slnt = writeFakeSlnt(dir, "rect");
  writeFileSync(join(dir, "pattern.dxf"), "x");
  const out = join(dir, "cut.svg");
  const result = runTruIn(dir, [
    "cut",
    "pattern.dxf",
    "--proposal",
    pp,
    "--scale",
    "actual",
    "--seam-allowance",
    "10",
    "--on-fold",
    "long",
    "--slnt",
    `node ${slnt}`,
    "--out",
    out
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(dir, "cut.calibration.svg"), "utf8"), /わ辺（fold）は縫い代 0/);
});

test("cut: --on-fold が long/short 以外なら usage error (exit 2)", () => {
  const result = runTru([
    "cut",
    "x.dxf",
    "--proposal",
    "p.json",
    "--scale",
    "actual",
    "--on-fold",
    "diagonal",
    "--out",
    "o.svg"
  ]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--on-fold must be "long" or "short"/);
});

test("cut: 同一 block を指す複数提案は proposal.id で別ファイルに分ける（上書きしない, P2）", () => {
  // 守る仕様: blockName は一意でない。同じ band block（WAISTBAND）への cut 対象が複数あっても、
  //           一意な proposal.id でファイル名を分け、先に書いた成果物を静かに上書きしない。
  const dir = mkdtempSync(join(tmpdir(), "truer-cut-dup-"));
  const pp = writeTwoBandProposals(dir);
  const slnt = writeFakeSlnt(dir, "rect");
  writeFileSync(join(dir, "pattern.dxf"), "x");
  const out = join(dir, "cut.svg");
  const result = runTruIn(dir, [
    "cut",
    "pattern.dxf",
    "--proposal",
    pp,
    "--scale",
    "actual",
    "--slnt",
    `node ${slnt}`,
    "--out",
    out
  ]);
  assert.equal(result.status, 0, result.stderr);

  const proposals = (JSON.parse(readFileSync(pp, "utf8")) as { proposals: { id: string }[] })
    .proposals;
  assert.equal(proposals.length, 2);
  assert.notEqual(proposals[0]!.id, proposals[1]!.id);
  // 各提案が一意な proposal.id で分かれ、両方のカバーが残る（同一 WAISTBAND でも衝突しない）。
  for (const proposal of proposals) {
    assert.equal(
      existsSync(join(dir, `cut.${proposal.id}.calibration.svg`)),
      true,
      `cut.${proposal.id}.calibration.svg`
    );
  }
  // 複数出力なので素の --out（cut.svg）は使わない。
  assert.equal(existsSync(out), false);
});
