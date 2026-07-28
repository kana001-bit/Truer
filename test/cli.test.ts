import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProposalFile } from "../src/core/proposal/createProposalFile.ts";
import type { DiagnosticInput } from "../src/core/proposal/createProposalFile.ts";
import type { SeamReconciliation } from "../src/core/proposal/proposalSchema.ts";
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

test("multi-token flag rejects a .dxf value instead of silently swallowing a misplaced <pattern.dxf>", () => {
  // 守る仕様 (R3): --reference / --accepted は続く非 flag token を貪欲に取り込むので、options の後ろに
  //           置いた <pattern.dxf> は id / BLOCK 名として silent に吸われる footgun になる。値が .dxf で
  //           終わるなら推測せず usage error（exit 2）にし、file も slnt も触らない。
  const proposeSwallow = runTru([
    "propose",
    "--diagnostic",
    "r.json",
    "--reference",
    "FRONT",
    "pattern.dxf"
  ]);
  assert.equal(proposeSwallow.status, 2);
  assert.match(proposeSwallow.stderr, /DXF パス/);

  const applySwallow = runTru([
    "apply",
    "--proposal",
    "p.json",
    "--out",
    "out.dxf",
    "--accepted",
    "prop_001",
    "pattern.dxf"
  ]);
  assert.equal(applySwallow.status, 2);
  assert.match(applySwallow.stderr, /DXF パス/);
});

test("repeated multi-token flags accumulate, not overwrite (--accepted keeps earlier ids)", () => {
  // 守る仕様 (R3 回帰): 同じ multi flag を繰り返すと累積する。上書きだと 2 回目が 1 回目を消し、
  //           --accepted なら採用 id を silent に落とす（T3）。末尾の空 --accepted が先行の prop_001 を
  //           消していれば「requires at least one」usage error になる。消していない（累積）ことを観測する。
  const result = runTru([
    "apply",
    "--accepted",
    "prop_001",
    "--accepted",
    "--proposal",
    "p.json",
    "--out",
    "o.dxf"
  ]);
  assert.doesNotMatch(result.stderr, /--accepted requires at least one/);
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

// ---- --constraints - （拘束 payload を stdin から受ける・パイプ配送）----

// 最小の valid v0 payload（封筒無し bare 形。adapter が受ける）。provenance の attach 経路は
// proposal.test.ts（core）で固定済みなので、ここでは stdin 読み取り経路だけを固定する。
const MINIMAL_CONSTRAINT_PAYLOAD = JSON.stringify({
  schema: "loomit.constraint-payload.v0",
  params: {},
  parts: [],
  connectors: []
});

test("propose --constraints - reads the constraint payload from stdin (pipe form)", () => {
  // 守る仕様: `--constraints -` は payload をファイルではなく stdin から読む（配送
  //           `loom truer request --format json | tru propose --constraints -` の受け口）。`-` を
  //           ファイル名として扱わない（扱えば ENOENT で exit 1 になる）。valid payload なら exit 0 で書ける。
  const dir = mkdtempSync(join(tmpdir(), "truer-constraints-stdin-"));
  writeFileSync(join(dir, "solo.dxf"), "x");
  writeFileSync(join(dir, "empty.report.json"), JSON.stringify(EMPTY_REPORT));
  const result = spawnSync(
    process.execPath,
    [
      TRU_ABS,
      "propose",
      "solo.dxf",
      "--diagnostic",
      "empty.report.json",
      "--out",
      "p.json",
      "--constraints",
      "-"
    ],
    { cwd: dir, encoding: "utf8", input: MINIMAL_CONSTRAINT_PAYLOAD }
  );
  assert.equal(result.status, 0);
  assert.match(result.stdout, /proposal\(s\)/);
  assert.equal(existsSync(join(dir, "p.json")), true);
});

test("propose --constraints - fails cleanly on malformed stdin (payload is actually consumed)", () => {
  // 守る仕様: stdin の payload が壊れていれば exit 1 で read error を出す。stdin が無視されていない証拠
  //           （無視なら壊れた入力でも exit 0 になる）。propose は source を触らない。
  const dir = mkdtempSync(join(tmpdir(), "truer-constraints-stdin-bad-"));
  writeFileSync(join(dir, "solo.dxf"), "x");
  writeFileSync(join(dir, "empty.report.json"), JSON.stringify(EMPTY_REPORT));
  const result = spawnSync(
    process.execPath,
    [
      TRU_ABS,
      "propose",
      "solo.dxf",
      "--diagnostic",
      "empty.report.json",
      "--out",
      "p.json",
      "--constraints",
      "-"
    ],
    { cwd: dir, encoding: "utf8", input: "{ not json" }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not read constraint payload/);
});

test("propose --constraints -: 封筒 status=warning / diagnostics 非空は警告を出すが exit 0（[C7]）", () => {
  // 守る仕様: payload 構築時の問題（piece 不在等）を封筒が報告するとき、provenance が不完全になりうるので
  //           黙って進めず stderr に警告を出す。ただし propose 自体は成功（advisory・exit 0・file は書ける）。
  const dir = mkdtempSync(join(tmpdir(), "truer-constraints-warn-"));
  writeFileSync(join(dir, "solo.dxf"), "x");
  writeFileSync(join(dir, "empty.report.json"), JSON.stringify(EMPTY_REPORT));
  const envelope = JSON.stringify({
    status: "warning",
    diagnostics: [
      {
        severity: "warning",
        code: "PART_SOURCE_VAL_PIECE_NOT_FOUND",
        message: 'files.piece "sleeve" が .val に無い'
      }
    ],
    payload: { schema: "loomit.constraint-payload.v0", params: {}, parts: [], connectors: [] }
  });
  const result = spawnSync(
    process.execPath,
    [
      TRU_ABS,
      "propose",
      "solo.dxf",
      "--diagnostic",
      "empty.report.json",
      "--out",
      "p.json",
      "--constraints",
      "-"
    ],
    { cwd: dir, encoding: "utf8", input: envelope }
  );
  assert.equal(result.status, 0); // advisory: propose は成功
  assert.equal(existsSync(join(dir, "p.json")), true);
  assert.match(result.stderr, /警告/);
  assert.match(result.stderr, /不完全/);
  assert.match(result.stderr, /PART_SOURCE_VAL_PIECE_NOT_FOUND/);
});

test("propose --constraints -: 封筒 status=ok / diagnostics 空は警告を出さない（誤警告しない）", () => {
  // 守る仕様（鳴ってはいけない面）: 問題の無い payload で余計な警告を出さない。status=ok かつ diagnostics 空。
  const dir = mkdtempSync(join(tmpdir(), "truer-constraints-ok-"));
  writeFileSync(join(dir, "solo.dxf"), "x");
  writeFileSync(join(dir, "empty.report.json"), JSON.stringify(EMPTY_REPORT));
  const envelope = JSON.stringify({
    status: "ok",
    diagnostics: [],
    payload: { schema: "loomit.constraint-payload.v0", params: {}, parts: [], connectors: [] }
  });
  const result = spawnSync(
    process.execPath,
    [
      TRU_ABS,
      "propose",
      "solo.dxf",
      "--diagnostic",
      "empty.report.json",
      "--out",
      "p.json",
      "--constraints",
      "-"
    ],
    { cwd: dir, encoding: "utf8", input: envelope }
  );
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /警告/);
});

// ---- --constraints の piece ↔ 辺 blockName join（[C10]）----
// 実 `part.loom` は payload の piece（`files.piece`）と診断の blockName（`connectors.*.path_ref`）を**別綴りで
// 書ける**（実データで `files.piece: back` / `path_ref: BACK`）。Seamlint の BLOCK 探索は `trim().toUpperCase()` で
// case を畳むが、**要求された綴りをそのまま blockName に echo する**ので、Truer 側が case-sensitive に join すると
// provenance / applicable が丸ごと落ちる（2026-07-27 の実 3 者パイプで発見）。落ちるときに silent だと
// 「候補ゼロ」と「join 失敗」を人が区別できないので、stderr に理由を出す。

// seam ペア診断 1 件（from=BACK / to=FRONT、いずれも edgeId 0）。長さは診断側から読まれる。
const JOIN_REPORT = {
  status: "warning",
  target: "geometry-request",
  diagnostics: [
    {
      severity: "warning",
      code: "geometry.seam_length_mismatch",
      target: "back.outseam/front.outseam",
      message: "Seam path lengths differ more than the configured tolerance.",
      expected: { maxLengthDiffMm: 3 },
      actual: {
        fromLengthMm: 100,
        toLengthMm: 112,
        lengthDiffMm: 12,
        fromEdge: { blockName: "BACK", edgeId: 0 },
        toEdge: { blockName: "FRONT", edgeId: 0 }
      }
    }
  ],
  reports: []
};

// fake slnt: どの --block でも「2 点の辺 0 ＋ 内部 notch 1 個」を返す。join のテストなので幾何は最小で足りる。
// notch を 1 個返すのは、conform 側（FRONT）で matcher → applicable まで通すため（k=n=1 で一意に matched）。
function writeJoinSlnt(dir: string): string {
  const script = [
    "const a = process.argv.slice(2);",
    'const bi = a.indexOf("--block");',
    'const block = bi >= 0 ? a[bi + 1] : "?";',
    "const edges = [",
    "  {",
    "    edgeId: 0,",
    "    points: [ { x: 0, y: 0 }, { x: 100, y: 0 } ],",
    "    notches: [ { edgePosition: 0.5, onCorner: false, ambiguous: false } ]",
    "  }",
    "];",
    "process.stdout.write(JSON.stringify({ blockName: block, edges }));"
  ].join("\n");
  const path = join(dir, "join-slnt.js");
  writeFileSync(path, script);
  return path;
}

// piece 名（と任意で connector の pathRef）を差し替えられる最小 payload。各 part に linear occurrence を 1 つ持たせて
// provenance 候補を作り、notch 1 個（linear 候補 1 本）を持たせて applicable が絞れる形にする。
function joinPayload(
  pieces: readonly string[],
  pathRefs?: readonly (string | undefined)[]
): string {
  const linear = {
    pointId: "9",
    type: "endLine",
    linearity: "linear",
    expr: "waist_circ + 2",
    refs: []
  };
  return JSON.stringify({
    schema: "loomit.constraint-payload.v0",
    params: {},
    parts: pieces.map((piece, index) => ({
      partId: `p${index}`,
      piece,
      dependsOn: [linear],
      notches: [{ order: 0, anchorPointId: "9", splineId: "s1", lengthCandidates: [linear] }]
    })),
    // pathRefs を渡すと connector に住所（`pathRef`）を宣言する＝Loomit が案A を emit した後の形。
    // 渡さなければ旧 payload（住所なし）＝`piece` 照合の後方互換経路。
    connectors: pieces.map((_piece, index) => ({
      partId: `p${index}`,
      connectorId: "outseam",
      ...(pathRefs?.[index] !== undefined ? { pathRef: pathRefs[index] } : {})
    }))
  });
}

interface JoinRunResult {
  status: number | null;
  stderr: string;
  seam: SeamReconciliation | undefined;
}

// join テスト共通の propose 実行。payload は stdin、辺ジオメトリは fake slnt から取る。
// `pathRefs` を渡すと connector に住所を宣言した payload（案A 後の形）になる。
function runJoinPropose(
  pieces: readonly string[],
  reference?: string,
  pathRefs?: readonly (string | undefined)[]
): JoinRunResult {
  const dir = mkdtempSync(join(tmpdir(), "truer-piece-join-"));
  writeFileSync(join(dir, "solo.dxf"), "x");
  writeFileSync(join(dir, "seam.report.json"), JSON.stringify(JOIN_REPORT));
  const slnt = writeJoinSlnt(dir);
  const result = spawnSync(
    process.execPath,
    [
      TRU_ABS,
      "propose",
      "solo.dxf",
      "--diagnostic",
      "seam.report.json",
      "--out",
      "p.json",
      "--constraints",
      "-",
      "--slnt",
      `node ${slnt}`,
      ...(reference !== undefined ? ["--reference", reference] : [])
    ],
    { cwd: dir, encoding: "utf8", input: joinPayload(pieces, pathRefs) }
  );
  const outPath = join(dir, "p.json");
  const file = existsSync(outPath)
    ? (JSON.parse(readFileSync(outPath, "utf8")) as {
        proposals: { seamReconciliation?: SeamReconciliation }[];
      })
    : undefined;
  return {
    status: result.status,
    stderr: result.stderr,
    seam: file?.proposals[0]?.seamReconciliation
  };
}

test("propose --constraints: piece と 辺 blockName の case が違っても join する（[C10] 回帰）", () => {
  // 守る仕様: payload の piece が `back`/`front`、診断の blockName が `BACK`/`FRONT` でも provenance が載る。
  //           case-sensitive に比較していた頃はここが丸ごと undefined になり、しかも silent だった。
  //           `piece` は診断側の綴り（人が住所として見る側）で返す。join できたので警告は出ない。
  const run = runJoinPropose(["back", "front"]);

  assert.equal(run.status, 0);
  const provenance = run.seam?.sourceProvenance;
  assert.ok(provenance, "sourceProvenance が載る");
  assert.deepEqual(
    provenance.map((entry) => entry.piece),
    ["BACK", "FRONT"]
  );
  assert.equal(provenance[0]!.candidates[0]!.expr, "waist_circ + 2");
  assert.doesNotMatch(run.stderr, /警告/);
});

test("propose --constraints: case 違いでも applicable まで届く（join は provenance と共有・[C10] 回帰）", () => {
  // 守る仕様: applicable の resolver も同じ join を使う。`--reference BACK` で conform=FRONT が決まり、
  //           payload の piece が `front`（小文字）でも FRONT の notch に届いて applicable が載る。
  //           deltaMm は conform 辺（112mm）を 100mm に縮める向きなので負。
  const run = runJoinPropose(["back", "front"], "BACK");

  assert.equal(run.status, 0);
  const applicable = run.seam?.applicable;
  assert.ok(applicable, "applicable が載る");
  assert.equal(applicable.piece, "FRONT");
  assert.equal(applicable.conform, "to");
  assert.equal(applicable.param.expr, "waist_circ + 2");
  assert.equal(applicable.deltaMm, -12);
});

test("propose --constraints: piece が payload に無ければ警告を出す（silent に落とさない・[C10]）", () => {
  // 守る仕様: join が失敗したら「候補ゼロ」と区別できるよう理由を出す。payload にある piece 名も並べる
  //           （出ない原因が綴り違いだと人が気付けるようにする）。propose 自体は advisory なので exit 0。
  const run = runJoinPropose(["sleeve"]);

  assert.equal(run.status, 0);
  assert.equal(run.seam?.sourceProvenance, undefined);
  assert.match(run.stderr, /BACK/);
  assert.match(run.stderr, /拘束 payload にありません/);
  assert.match(run.stderr, /sleeve/); // 利用可能な piece を並べる
});

test("propose --constraints: case だけ違う piece が複数なら推測せず諦めて警告（T6・[C10]）", () => {
  // 守る仕様: `back` と `BACK` が両方 payload にあると join は一意でない。どちらか選ぶと誤った piece の
  //           provenance を confidently-wrong に出すので、載せずに理由を出す（T6: 推測しない）。
  const run = runJoinPropose(["back", "BACK"]);

  assert.equal(run.status, 0);
  assert.equal(run.seam?.sourceProvenance, undefined);
  assert.match(run.stderr, /複数あります/);
});

// ---- 住所の権威は connectors[].pathRef（[C10] 案A の consumer 側）----
// `parts[].piece` は `.val` の detail 名で **住所の権威ではない**（Loomit 回答 2026-07-28）。pathRef を宣言した
// payload では pathRef で引き、**`piece` へ暗黙 fallback しない**。下の 2 本は「piece と pathRef が食い違う」形で
// どちらが効いているかを固定する（受理しただけで consumer が旧 join のままだと、この 2 本が落ちる）。

test("propose --constraints: pathRef が宣言されていれば piece ではなく pathRef で join する（[C10] 案A）", () => {
  // 守る仕様: piece（`back`/`front`）と pathRef（`BODY_BACK`/`BODY_FRONT`）が**別名**で、診断の blockName は
  //           pathRef 側（fake slnt / report は BACK / FRONT ではなく BODY_* を返す設定にはできないので、
  //           ここでは pathRef を診断の綴り BACK / FRONT に合わせ、piece をまったく別名にする）。
  //           piece で join していたら当たらない組み合わせで provenance が載ることを固定する。
  const run = runJoinPropose(["sleeve", "cuff"], undefined, ["BACK", "FRONT"]);

  assert.equal(run.status, 0);
  const provenance = run.seam?.sourceProvenance;
  assert.ok(provenance, "pathRef で join できて provenance が載る");
  assert.deepEqual(
    provenance.map((entry) => entry.piece),
    ["BACK", "FRONT"]
  );
  // 旧 join（piece 照合）なら `sleeve`/`cuff` は BACK/FRONT に当たらず、no-match 警告が出ていたはず。
  assert.doesNotMatch(run.stderr, /拘束 payload にありません/);
  // pathRef が宣言されているので piece 代用の注記も出ない。
  assert.doesNotMatch(run.stderr, /pathRef が無いため/);
});

test("propose --constraints: pathRef 宣言時に piece だけ一致しても join しない（権威を混ぜない・[C10]）", () => {
  // 守る仕様（鳴ってはいけない面）: piece は診断の blockName（BACK / FRONT）と一致するが、pathRef は別名。
  //           `pathRef` が権威なので **join は失敗させる**（piece へ暗黙 fallback すると「住所の権威は pathRef だけ」
  //           という契約が崩れ、[C10] と同じ誤 join に戻る）。失敗は silent にせず、宣言済み pathRef を並べて出す。
  const run = runJoinPropose(["BACK", "FRONT"], undefined, ["BODY_BACK", "BODY_FRONT"]);

  assert.equal(run.status, 0);
  assert.equal(run.seam?.sourceProvenance, undefined);
  assert.match(run.stderr, /一致する pathRef が拘束 payload にありません/);
  assert.match(run.stderr, /BODY_BACK/); // 宣言済み pathRef を並べる
});

test("propose --constraints: pathRef が一つも無い旧 payload は piece 照合に落として注記する（後方互換）", () => {
  // 守る仕様: Loomit が emit を始める前の payload（現行の実データ）は従来どおり piece で join する。ただし
  //           **代用したことを注記**する（silent に戻さない・Loomit 回答 §5b）。注記は run で 1 回だけ。
  const run = runJoinPropose(["back", "front"]);

  assert.equal(run.status, 0);
  assert.ok(run.seam?.sourceProvenance, "後方互換: piece 照合で provenance は載る");
  assert.match(run.stderr, /pathRef が無いため/);
  assert.equal(run.stderr.match(/pathRef が無いため/g)?.length, 1); // 1 回だけ
});

test("propose --constraints: pathRef が複数 part に跨るなら推測せず諦めて警告（T6・[C10]）", () => {
  // 守る仕様: 同じ pathRef を別 part の connector が宣言していたら、どちらの provenance か決められない。
  //           推測せず載せず、理由を出す（case だけ違う綴りも畳んで同一視するので同じ扱い）。
  const run = runJoinPropose(["sleeve", "cuff"], undefined, ["BACK", "back"]);

  assert.equal(run.status, 0);
  assert.equal(run.seam?.sourceProvenance, undefined);
  assert.match(run.stderr, /複数の part に跨っています/);
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

// fake slnt: `edges <dxf> --block <name> --json` に矩形 / 三角形 / 曲線帯（円環扇形）の edges を返す node
// スクリプト。curved は外弧・端・内弧・端の 4 辺 ribbon（長辺が多点の曲線）を返す。
function writeFakeSlnt(dir: string, shape: "rect" | "triangle" | "curved"): string {
  let body: string;
  if (shape === "curved") {
    body = [
      "const R = 200, r = 160, a0 = 0, a1 = 2, m = 8;",
      "const arc = (rad) => Array.from({ length: m }, (_u, i) => { const phi = a0 + (a1 - a0) * (i / (m - 1)); return { x: rad * Math.cos(phi), y: rad * Math.sin(phi) }; });",
      "const outer = arc(R), inner = arc(r);",
      "const edges = [",
      "  { edgeId: 0, points: outer },",
      "  { edgeId: 1, points: [outer[m - 1], inner[m - 1]] },",
      "  { edgeId: 2, points: [...inner].reverse() },",
      "  { edgeId: 3, points: [inner[0], outer[0]] }",
      "];",
      "process.stdout.write(JSON.stringify({ blockName: block, edges }));"
    ].join("\n");
  } else {
    const corners =
      shape === "rect" ? "[[0,0],[350,0],[350,40],[0,40]]" : "[[0,0],[350,0],[175,40]]";
    body = [
      `const c = ${corners};`,
      "const edges = c.map((p, i) => ({ edgeId: i, points: [ { x: p[0], y: p[1] }, { x: c[(i + 1) % c.length][0], y: c[(i + 1) % c.length][1] } ] }));",
      "process.stdout.write(JSON.stringify({ blockName: block, edges }));"
    ].join("\n");
  }
  const script = [
    "const a = process.argv.slice(2);",
    'const bi = a.indexOf("--block");',
    'const block = bi >= 0 ? a[bi + 1] : "?";',
    body
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
    `node "${slnt}"`,
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

test("cut: 曲線バンドを弧長スケールで裁つ（仕上がり線のみ・縫い代注記, fake slnt curved）", () => {
  // 守る仕様: 曲線バンド（4 辺 ribbon）は弧長スケールで conform して cutsheet を出す。縫い代は未対応なので
  //           仕上がり線のみ + 注記。skip はしない。
  const dir = mkdtempSync(join(tmpdir(), "truer-cut-curved-"));
  const pp = writeBandProposal(dir);
  const slnt = writeFakeSlnt(dir, "curved");
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
    `node "${slnt}"`,
    "--out",
    out
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /cut: WAISTBAND \(actual\)/); // skip ではなく出力
  assert.match(result.stdout, /曲線バンド — 縫い代は未対応/); // 注記
  const cover = readFileSync(join(dir, "cut.calibration.svg"), "utf8");
  assert.match(cover, /曲線バンドは縫い代未対応/);
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
    `node "${slnt}"`,
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
    `node "${slnt}"`,
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
    `node "${slnt}"`,
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
    `node "${slnt}"`,
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

// ---- propose --cut（band cut を propose に畳んだ口）----

// band conform 診断（bandEdge 住所つき）を report ファイルに書く。propose がこれを読み、--reference で
// neighbours を固定 → band conform（targetBandLengthMm=655/2=327.5）の提案を組む。
function writeBandReport(dir: string): string {
  const report = {
    status: "warning",
    target: "geometry-request",
    diagnostics: [cutBandDiagnostic()],
    reports: []
  };
  const path = join(dir, "band.report.json");
  writeFileSync(path, JSON.stringify(report));
  return path;
}

test("propose --cut: band conform 提案をその場で stopgap SVG に裁つ（tru cut を propose に畳んだ口）", () => {
  // 守る仕様: --cut を渡すと、propose が組んだ band conform 提案を同じ cutsheet レンダラで裁つ。proposal も
  //           従来どおり書かれる。actual は複数ページ（素の --cut パスではなく calibration + タイル）。
  const dir = mkdtempSync(join(tmpdir(), "truer-propose-cut-"));
  const reportPath = writeBandReport(dir);
  const slnt = writeFakeSlnt(dir, "rect");
  writeFileSync(join(dir, "pattern.dxf"), "x");
  const outProposal = join(dir, "prop.json");
  const outCut = join(dir, "cut.svg");
  const result = runTruIn(dir, [
    "propose",
    "pattern.dxf",
    "--diagnostic",
    reportPath,
    "--reference",
    "FRONT",
    "--out",
    outProposal,
    "--cut",
    outCut,
    "--scale",
    "actual",
    "--slnt",
    `node "${slnt}"`
  ]);
  assert.equal(result.status, 0, result.stderr);
  // proposal は従来どおり書かれる。
  assert.equal(existsSync(outProposal), true);
  // band cut と同じ規約: actual は複数ページなので素の cut.svg は書かず calibration を出す。
  assert.equal(existsSync(outCut), false);
  assert.equal(existsSync(join(dir, "cut.calibration.svg")), true);
  assert.match(result.stdout, /cut: WAISTBAND \(actual\)/);
  assert.match(readFileSync(join(dir, "cut.calibration.svg"), "utf8"), /327\.5/); // 655/2 に縮んだ最長辺
});

test("propose --cut は --scale が必須（欠落は usage error exit 2・file も slnt も触らない）", () => {
  // 守る仕様: --cut は --scale 必須。欠落は parse 後の早期チェックで exit 2（DXF/report を読む前に止まる）。
  const result = runTru(["propose", "x.dxf", "--diagnostic", "r.json", "--cut", "o.svg"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--cut requires --scale/);
});

test("propose without --cut writes no cutsheet (opt-in)", () => {
  // 守る仕様: --cut は opt-in。渡さなければ band conform 提案があっても SVG は一切書かず、cut 用の slnt 取得も
  //           走らせない（重い処理を既定で回さない）。proposal だけ書く。
  const dir = mkdtempSync(join(tmpdir(), "truer-propose-nocut-"));
  const reportPath = writeBandReport(dir);
  const slnt = writeFakeSlnt(dir, "rect");
  writeFileSync(join(dir, "pattern.dxf"), "x");
  const outProposal = join(dir, "prop.json");
  const result = runTruIn(dir, [
    "propose",
    "pattern.dxf",
    "--diagnostic",
    reportPath,
    "--reference",
    "FRONT",
    "--out",
    outProposal,
    "--slnt",
    `node "${slnt}"`
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(outProposal), true);
  const svgs = readdirSync(dir).filter((file) => file.endsWith(".svg"));
  assert.deepEqual(svgs, []);
});

test("propose: --scale / --seam-allowance / --on-fold は --cut 無しだと usage error (exit 2)", () => {
  // 守る仕様 (P2): cut 専用オプションを --cut 無しで渡す打ち間違いを silent 無視せず exit 2 にする。
  //           diagnostic チェックの直後・file も slnt も触る前で止まる（x.dxf / r.json は存在不要）。
  for (const extra of [
    ["--scale", "actual"],
    ["--seam-allowance", "10"],
    ["--on-fold", "long"]
  ]) {
    const result = runTru(["propose", "x.dxf", "--diagnostic", "r.json", ...extra]);
    assert.equal(result.status, 2, `${extra.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /--cut と一緒に指定/);
  }
});

// ---- propose -> apply 統合（実 subprocess の slnt stub 越し。A1 境界を CLI レベルで固定）----
//
// これまで apply のテストは planApply / editNetLineVertex を直接注入する unit 層だった。ここでは
// DXF + curve_kink 診断は test/fixtures（examples の runnable loop と同一内容の test 所有コピー）から、
// slnt stub は temp に書き出して、実際に `tru propose` → `tru apply` を spawn し、`--slnt "node <stub>"` で
// slnt subprocess の spawn 経路（A1）まで通す。fixture を examples から独立させ、examples を編集しても CI が
// 割れないようにする（D2 の P3）。stub を committed .mjs で test/ 下に置くと node --test が拾って実行して
// しまうため、band cut の writeFakeSlnt と同じく temp に書き出す。BODY の layer-14 net line
//（body-armhole.dxf と一致）を edge 0 として返す。
const FIXTURES_DIR = join(process.cwd(), "test/fixtures");
const FX_DXF = join(FIXTURES_DIR, "body-armhole.dxf");
const FX_DIAG = join(FIXTURES_DIR, "body-armhole.curve_kink.json");

function writeArmholeSlnt(dir: string): string {
  const script = [
    "const a = process.argv.slice(2);",
    'const bi = a.indexOf("--block");',
    "const block = bi >= 0 ? a[bi + 1] : undefined;",
    "const points = [{x:0,y:0},{x:40,y:40},{x:80,y:70},{x:120,y:40},{x:160,y:60}];",
    "process.stdout.write(JSON.stringify({ blockName: block, edges: [{ edgeId: 0, points }] }));"
  ].join("\n");
  const path = join(dir, "slnt-stub.js");
  writeFileSync(path, script);
  return path;
}

test("integration: propose -> apply through a spawned stub slnt writes the corrected DXF (A1, T1, T6)", () => {
  // 守る仕様: 実 subprocess の slnt(stub) を通した propose→apply の通しで、propose は内部 kink を
  //           local-adjustment(move-vertex) にし、apply は補正 DXF を --out にだけ書く。source は
  //           1 バイトも変えず（T1）、変更は kink 頂点 1 つ（y=70→40）だけ（T6）。
  // dir 名にわざと空白を入れる: --slnt に渡す stub パスを quote せず `node ${path}` にすると、CLI の
  // tokenizeCommand が空白で script path を割って壊れる。`node "${path}"` で quote してあることをここで
  // 回帰として固定する（quote が外れたら空白入り temp path でこのテストが割れる）。
  const dir = mkdtempSync(join(tmpdir(), "truer e2e "));
  const dxf = join(dir, "pattern.dxf");
  copyFileSync(FX_DXF, dxf);
  const slnt = `node "${writeArmholeSlnt(dir)}"`;
  const srcBefore = readFileSync(dxf, "utf8");
  const pJson = join(dir, "p.json");
  const fixed = join(dir, "fixed.dxf");

  const propose = runTruIn(dir, [
    "propose",
    "pattern.dxf",
    "--diagnostic",
    FX_DIAG,
    "--out",
    pJson,
    "--slnt",
    slnt
  ]);
  assert.equal(propose.status, 0, propose.stderr);
  const file = JSON.parse(readFileSync(pJson, "utf8")) as {
    proposals: { id: string; mode: string; changes: { kind: string }[] }[];
  };
  const prop = file.proposals[0]!;
  assert.equal(prop.mode, "local-adjustment"); // 内部 kink → 補正あり
  assert.equal(prop.changes[0]!.kind, "move-vertex");

  const apply = runTruIn(dir, [
    "apply",
    "pattern.dxf",
    "--proposal",
    pJson,
    "--accepted",
    prop.id,
    "--out",
    fixed,
    "--slnt",
    slnt
  ]);
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /1 proposal\(s\) applied/);

  // source 不変 (T1)
  assert.equal(readFileSync(dxf, "utf8"), srcBefore);
  // 補正 DXF が書かれ、source とちょうど 1 行だけ違う (T6)
  assert.equal(existsSync(fixed), true);
  const afterLines = readFileSync(fixed, "utf8").split(/\r\n|\r|\n/);
  const beforeLines = srcBefore.split(/\r\n|\r|\n/);
  assert.equal(beforeLines.length, afterLines.length);
  const changedIdx = beforeLines
    .map((line, i) => (line !== afterLines[i] ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(changedIdx.length, 1, `changed lines: ${changedIdx}`);
  assert.equal(beforeLines[changedIdx[0]!], "70"); // kink の y=70 が
  assert.equal(afterLines[changedIdx[0]!], "40"); // 弦上の 40 へ動いた
});

test("integration: apply refuses when the source DXF changed since propose (digest gate, T3)", () => {
  // 守る仕様: propose 後に source（DXF）が変わったら、apply は 1 バイトも書く前に digest mismatch で
  //           fail し、--out を作らない（T3）。propose⇔apply で source を silent に差し替えられない。
  const dir = mkdtempSync(join(tmpdir(), "truer-e2e-digest-"));
  const dxf = join(dir, "pattern.dxf");
  copyFileSync(FX_DXF, dxf);
  const slnt = `node "${writeArmholeSlnt(dir)}"`;
  const pJson = join(dir, "p.json");
  const fixed = join(dir, "fixed.dxf");

  const propose = runTruIn(dir, [
    "propose",
    "pattern.dxf",
    "--diagnostic",
    FX_DIAG,
    "--out",
    pJson,
    "--slnt",
    slnt
  ]);
  assert.equal(propose.status, 0, propose.stderr);
  const prop = (JSON.parse(readFileSync(pJson, "utf8")) as { proposals: { id: string }[] })
    .proposals[0]!;

  // propose 後に source を書き換える（末尾に 1 ペア足す = sourceDigest が変わる）。net line は不変だが
  // file 全体の digest が食い違うので、file-digest gate が edge を読む前に fail する。
  writeFileSync(dxf, readFileSync(dxf, "utf8") + "999\n999\n");

  const apply = runTruIn(dir, [
    "apply",
    "pattern.dxf",
    "--proposal",
    pJson,
    "--accepted",
    prop.id,
    "--out",
    fixed,
    "--slnt",
    slnt
  ]);
  assert.equal(apply.status, 1);
  assert.match(apply.stderr, /digest_mismatch/);
  assert.equal(existsSync(fixed), false); // 何も書かない
});
