#!/usr/bin/env node
// Truer CLI の入口。CLI 層は引数 parsing・file IO・stdout/stderr・exit status を持つ; core は pure の
// まま。`propose` は Seamlint report + DXF を読み、proposal file を（--preview 付きなら overlay SVG も）
// 作る。`apply` は accept された proposal の補正 geometry を、--out の Truer 所有 DXF に書く
//（M3: 書き先はこの裁断用の補正済み DXF であって、.val/Loomit ではない）。

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

import { createProposalFile } from "../core/proposal/createProposalFile.ts";
import { validateProposalFile } from "../core/proposal/proposalSchema.ts";
import type { ProposalFile } from "../core/proposal/proposalSchema.ts";
import { planApply } from "../core/apply/applyProposal.ts";
import {
  parseSeamlintReport,
  buildResolveSeamPair,
  buildResolveBandSeam,
  buildResolveTarget,
  buildEdgePointsLookup
} from "../adapters/seamlint/index.ts";
import {
  createSlntEdgesRunner,
  detectCmdPercentRisk,
  resolveSlntCommand,
  tokenizeCommand
} from "../adapters/seamlint/slntRunner.ts";
import { DxfEditError, editNetLineVertex } from "../adapters/dxf/editNetLineVertex.ts";
import { renderProposalPreview } from "../preview/index.ts";
import { renderBandCutsheet, type CutScale } from "../preview/cutsheet.ts";
import { computeBandCutOutline } from "../core/geometry-edit/bandCutOutline.ts";
import { writeFileAtomic } from "./writeFileAtomic.ts";
import { isSameFilePath } from "./samePath.ts";

const USAGE = `tru — Truer CLI (MVP)

Usage:
  tru propose [<pattern.dxf>] --diagnostic <report.json> [--out <proposal.json>] [--reference <block>...] [--preview <preview.svg>] [--slnt <cmd>]
  tru apply   [<pattern.dxf>] --proposal <proposal.json> --accepted <id...> --out <out.dxf> [--slnt <cmd>]
  tru cut     [<pattern.dxf>] --proposal <proposal.json> --scale fit-a4|actual --out <cut.svg> [--slnt <cmd>]

  <pattern.dxf> は省略可: 省略時は cwd 直下の *.dxf を使う（ちょうど 1 つのとき。0/複数なら明示指定を促す）。

Commands:
  propose   Seamlint 診断 (DXF) から補正案 (proposal) と preview を作る。source は書き換えない。
  apply     採用された proposal の補正を --out の DXF に書く。source は不変・書き込みは atomic。
  cut       band 提案から、印刷して手で裁つ stopgap の SVG を作る。正式パターン(DXF)は書き換えない。

propose options:
  --diagnostic <file>   Seamlint report JSON (CheckReport or GeometryRequestReport).
  --reference <block>   固定 (基準=reference) とする側の BLOCK 名。複数指定可 (固定パーツ集合)。相手側を
                        これに合わせる目標を出す。seam_length_mismatch: 相手辺の目標 finished 長
                        (linkTarget)。band_seam_sum_mismatch: band を指定→band 固定 (neighbours を直す
                        向きだけ)、neighbour を指定→band が conform で band 長の目標 (targetBandLengthMm)。
                        どの blockName にも一致しない / 両側一致なら向きを決めず両方向 preview-only (T6)。
  --out <file>          proposal JSON の書き出し先。省略時は output/<dxf 名>.proposal.json (親が無ければ作成)。
  --preview <file>      Optional: overlay SVG (seam Δ / band closure / curve_kink before+after).
  --slnt <cmd>          slnt command for edge geometry (default: $SEAMLINT_CLI or "slnt").

apply options:
  --proposal <file>     The proposal JSON written by propose.
  --accepted <id...>    Proposal ids to apply (one or more). Nothing else is written (T3).
  --out <file>          Where to write the corrected DXF (must not be the source path).
  --slnt <cmd>          slnt command for edge geometry (default: $SEAMLINT_CLI or "slnt").

cut options:
  --proposal <file>     propose が書いた proposal JSON。band conform（targetBandLengthMm あり）を裁つ。
  --scale <mode>        fit-a4 (A4 1枚のミニチュア=デザイン確認・単一ファイル) / actual (1:1 実寸=フィット
                        確認。10cm 実寸四角つきカバー + A4 タイル複数枚)。
  --out <file>          印刷用 SVG の基底パス。actual は <base>.calibration.svg / <base>.tile-NofM.svg を、
                        band 複数なら proposal.id も挟んで書く（1 band の actual でも複数ファイル）。
  --slnt <cmd>          slnt command for edge geometry (default: $SEAMLINT_CLI or "slnt").

Options:
  -h, --help   Show this help.
`;

interface ProposeOptions {
  dxfFile?: string;
  diagnostic?: string;
  out?: string;
  preview?: string;
  slnt?: string;
  // 「固定（基準 = reference）とみなす側」の BLOCK 名。seam_length_mismatch では固定辺、
  // band_seam_sum_mismatch では band か neighbour 群のどちらを正とするか。人が打つのは part 名だが、
  // part→BLOCK 名の翻訳は上流（Loomit の `loom match`）が持ち、CLI には解決済みの BLOCK 名が渡る
  //（例 `--reference FRONT`）。複数指定＝固定パーツ集合。照合は adapter が行い core は pure のまま。
  reference: string[];
}

function parseProposeArgs(args: string[]): ProposeOptions {
  const options: ProposeOptions = { reference: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--diagnostic") {
      options.diagnostic = requireValue(arg, args[++index]);
    } else if (arg === "--out") {
      options.out = requireValue(arg, args[++index]);
    } else if (arg === "--preview") {
      options.preview = requireValue(arg, args[++index]);
    } else if (arg === "--slnt") {
      options.slnt = requireValue(arg, args[++index]);
    } else if (arg === "--reference") {
      // 続く非 flag token を BLOCK 名として取り込む（複数=固定パーツ集合）。`--accepted <id...>` と同じ多トークン形
      // なので `--reference BACK FRONT` も `--reference BACK --reference FRONT` も通る。usage の `<block>...` と一致。
      const before = options.reference.length;
      while (index + 1 < args.length && !args[index + 1]!.startsWith("--")) {
        options.reference.push(args[++index]!);
      }
      if (options.reference.length === before) {
        throw new Error("--reference requires at least one BLOCK name.");
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.dxfFile !== undefined) {
      throw new Error("Expected a single <pattern.dxf> path.");
    } else {
      options.dxfFile = arg;
    }
  }
  return options;
}

interface ApplyOptions {
  dxfFile?: string;
  proposal?: string;
  out?: string;
  accepted: string[];
  slnt?: string;
}

function parseApplyArgs(args: string[]): ApplyOptions {
  const options: ApplyOptions = { accepted: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--proposal") {
      options.proposal = requireValue(arg, args[++index]);
    } else if (arg === "--out") {
      options.out = requireValue(arg, args[++index]);
    } else if (arg === "--slnt") {
      options.slnt = requireValue(arg, args[++index]);
    } else if (arg === "--accepted") {
      // 続く非 flag token を proposal id として取り込む。
      while (index + 1 < args.length && !args[index + 1]!.startsWith("--")) {
        options.accepted.push(args[++index]!);
      }
      if (options.accepted.length === 0) {
        throw new Error("--accepted requires at least one proposal id.");
      }
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.dxfFile !== undefined) {
      throw new Error("Expected a single <pattern.dxf> path.");
    } else {
      options.dxfFile = arg;
    }
  }
  return options;
}

function requireValue(optionName: string, value: string | undefined): string {
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

// --out 省略時の proposal 既定出力先（直叩きデバッグ用）。DXF 名から導き output/ 配下に置く。
function defaultProposalOutPath(dxfFile: string): string {
  return join("output", `${basename(dxfFile, extname(dxfFile))}.proposal.json`);
}

// <pattern.dxf> 省略時の解決。cwd 直下（非再帰）の *.dxf を探し、ちょうど 1 つならそれを使う。
// 「1 プロジェクト = 1 DXF（全パーツ同梱）」の通常運用を引数ゼロで通すため。0 個 / 複数個は推測せず
// error にして明示指定を促す（複数 = シナリオ別 DXF 等）。Seamlint report は source パスを持たないので、
// 探索元は filesystem（実行ディレクトリ）だけ。orchestration の loom は常に明示パスを渡すので影響なし。
async function resolveDxfFile(explicit: string | undefined): Promise<string> {
  if (explicit !== undefined) {
    return explicit;
  }
  const entries = await readdir(process.cwd(), { withFileTypes: true });
  const dxfs = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".dxf")
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (dxfs.length === 1) {
    return dxfs[0]!;
  }
  if (dxfs.length === 0) {
    throw new Error(
      "カレントディレクトリに DXF が見つかりません。<pattern.dxf> でパスを指定してください。"
    );
  }
  throw new Error(
    `カレントディレクトリに DXF が複数あります (${dxfs.join(", ")})。<pattern.dxf> でどれを使うか指定してください。`
  );
}

async function runPropose(args: string[]): Promise<number> {
  let options: ProposeOptions;
  try {
    options = parseProposeArgs(args);
  } catch (error) {
    process.stderr.write(`tru propose: ${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }

  if (!options.diagnostic) {
    process.stderr.write("tru propose: --diagnostic is required.\n\n" + USAGE);
    return 2;
  }

  let dxfFile: string;
  try {
    dxfFile = await resolveDxfFile(options.dxfFile);
  } catch (error) {
    process.stderr.write(`tru propose: ${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }

  const dxfText = await readFile(dxfFile, "utf8");
  const reportText = await readFile(options.diagnostic, "utf8");

  let diagnostics;
  try {
    diagnostics = parseSeamlintReport(JSON.parse(reportText));
  } catch (error) {
    process.stderr.write(`tru propose: could not read Seamlint report: ${errorMessage(error)}\n`);
    return 1;
  }

  const slntCommand = options.slnt ? tokenizeCommand(options.slnt) : resolveSlntCommand();
  const runEdges = createSlntEdgesRunner({ slntCommand, dxfFile });
  // Windows で slnt が .cmd/.bat かつ dxf パスに定義済み %VAR% があると cmd.exe が展開して失敗しうる。事前に警告。
  const cmdRisk = detectCmdPercentRisk(slntCommand, [dxfFile]);
  if (cmdRisk) {
    process.stderr.write(`tru propose: warning: ${cmdRisk}\n`);
  }

  const file = createProposalFile({
    sourceFile: dxfFile,
    sourceText: dxfText,
    diagnostics,
    // curve_kink は単一 edge を diagnostic の actual.edge address から解決する（Seamlint
    // edge-addressing bridge）。address が無ければ not-found を返し、diagnostic は skip される、
    // 推測はしない（T6 / T8）。
    resolveTarget: buildResolveTarget(runEdges),
    // seam ペアの reference（固定辺）は、診断の from/to edge の blockName を `--reference` の BLOCK 名集合と
    // 照合して決める（adapter の責務。core は pure）。集合が空なら従来どおり両方向 preview-only（T6）。
    resolveSeamPair: buildResolveSeamPair(runEdges, options.reference),
    // band 診断（N-ary）も同じ `--reference` 集合を band/neighbour の blockName と照合して固定側を決める。
    resolveBandSeam: buildResolveBandSeam(runEdges, options.reference)
  });

  // --out は任意。省略時は output/<dxf 名>.proposal.json を既定にし、親ディレクトリが無ければ作る。
  // loom 経由の match では loom が常に絶対 --out（<outputs.dir>/match/<from>-<to>.proposal.json）を
  // 渡すので、この既定は直叩きデバッグ用。指定パスの親も無ければ作る（loom の match/ サブディレクトリ対応）。
  const outPath = options.out ?? defaultProposalOutPath(dxfFile);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(file, null, 2) + "\n", "utf8");
  process.stdout.write(
    `propose: ${file.proposals.length} proposal(s), ${file.skipped.length} skipped -> ${outPath}\n`
  );

  if (options.preview) {
    await writeFile(options.preview, renderProposalPreview(file), "utf8");
    process.stdout.write(`preview: overlay -> ${options.preview}\n`);
  }

  return 0;
}

async function runApply(args: string[]): Promise<number> {
  let options: ApplyOptions;
  try {
    options = parseApplyArgs(args);
  } catch (error) {
    process.stderr.write(`tru apply: ${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }

  if (!options.proposal || !options.out) {
    process.stderr.write("tru apply: --proposal and --out are required.\n\n" + USAGE);
    return 2;
  }

  let dxfFile: string;
  try {
    dxfFile = await resolveDxfFile(options.dxfFile);
  } catch (error) {
    process.stderr.write(`tru apply: ${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }

  // source の上書きは決してしない: apply は --out のみ、in-place は禁止（T1）。Windows では
  // case を無視するので、大文字小文字だけの違い（C:\Foo と c:\foo = 同じ file）でも guard に掛かる。
  if (isSameFilePath(options.out, dxfFile)) {
    process.stderr.write(
      "tru apply: apply.out_overwrites_source: --out must not be the source DXF path.\n"
    );
    return 1;
  }

  const dxfText = await readFile(dxfFile, "utf8");
  const proposalText = await readFile(options.proposal, "utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(proposalText);
  } catch (error) {
    process.stderr.write(`tru apply: could not read proposal JSON: ${errorMessage(error)}\n`);
    return 1;
  }
  const validationErrors = validateProposalFile(parsed);
  if (validationErrors.length > 0) {
    process.stderr.write(`tru apply: invalid proposal file: ${validationErrors.join("; ")}\n`);
    return 1;
  }
  const file = parsed as ProposalFile;

  const slntCommand = options.slnt ? tokenizeCommand(options.slnt) : resolveSlntCommand();
  const runEdges = createSlntEdgesRunner({ slntCommand, dxfFile });
  const cmdRisk = detectCmdPercentRisk(slntCommand, [dxfFile]);
  if (cmdRisk) {
    process.stderr.write(`tru apply: warning: ${cmdRisk}\n`);
  }
  const getCurrentPoints = buildEdgePointsLookup(runEdges);

  let plan;
  try {
    plan = planApply({
      file,
      sourceText: dxfText,
      acceptedIds: options.accepted,
      getCurrentPoints
    });
  } catch (error) {
    // 例: slnt subprocess の実行が失敗（systemic）。何か書く前に失敗させる。
    process.stderr.write(`tru apply: ${errorMessage(error)}\n`);
    return 1;
  }

  if (plan.status === "error") {
    process.stderr.write(`tru apply: ${plan.code}: ${plan.message}\n`);
    return 1;
  }

  // 各 vertex edit を DXF に差し込む。他のすべての byte は保つ（T6）。
  let resultText = dxfText;
  try {
    for (const edit of plan.edits) {
      resultText = editNetLineVertex(resultText, edit.blockName, edit.from, edit.to);
    }
  } catch (error) {
    if (error instanceof DxfEditError) {
      process.stderr.write(`tru apply: ${error.code}: ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  if (plan.appliedIds.length === 0) {
    process.stdout.write(
      "apply: 0 proposal(s) applied (nothing accepted, or all preview-only); nothing written.\n"
    );
    return 0;
  }

  await writeFileAtomic(options.out, resultText);
  process.stdout.write(
    `apply: ${plan.appliedIds.length} proposal(s) applied (${plan.appliedIds.join(", ")}) -> ${options.out}\n`
  );
  return 0;
}

interface CutOptions {
  dxfFile?: string;
  proposal?: string;
  scale?: string;
  out?: string;
  slnt?: string;
}

function parseCutArgs(args: string[]): CutOptions {
  const options: CutOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--proposal") {
      options.proposal = requireValue(arg, args[++index]);
    } else if (arg === "--scale") {
      options.scale = requireValue(arg, args[++index]);
    } else if (arg === "--out") {
      options.out = requireValue(arg, args[++index]);
    } else if (arg === "--slnt") {
      options.slnt = requireValue(arg, args[++index]);
    } else if (arg?.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.dxfFile !== undefined) {
      throw new Error("Expected a single <pattern.dxf> path.");
    } else if (arg !== undefined) {
      options.dxfFile = arg;
    }
  }
  return options;
}

// 衝突しない出力先。<base>.<suffix1>.<suffix2><ext>（undefined/空は除く）。band が複数のときは
// proposal.id（file 内で一意 — blockName は一意でない）で、actual のように複数ページのときは page label
// （calibration / tile-NofM）で分ける。同一バンドの複数 advisory が同じパスへ書かれ上書きされるのを防ぐ。
function cutOutPathFor(outPath: string, ...suffixes: (string | undefined)[]): string {
  const ext = extname(outPath);
  const stem = outPath.slice(0, outPath.length - ext.length);
  const suffix = suffixes
    .filter((part): part is string => part !== undefined && part.length > 0)
    .map((part) => `.${part}`)
    .join("");
  return `${stem}${suffix}${ext}`;
}

// tru cut: band 提案から、印刷して手で裁つ stopgap の SVG を作る。正式パターン(DXF)は書き換えない
// （apply とは別・ゲート無しの使い捨てアーティファクト）。band conform（targetBandLengthMm がある band
// 提案）だけを対象にし、band ブロックの全辺を slnt edges で取って輪郭を目標長へ縮め（矩形直線のみ）、
// SVG を書く。曲線 / 非矩形 / 退化は推測せず出さない（T8）。
async function runCut(args: string[]): Promise<number> {
  let options: CutOptions;
  try {
    options = parseCutArgs(args);
  } catch (error) {
    process.stderr.write(`tru cut: ${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }

  if (!options.proposal || !options.out) {
    process.stderr.write("tru cut: --proposal and --out are required.\n\n" + USAGE);
    return 2;
  }
  if (options.scale !== "fit-a4" && options.scale !== "actual") {
    process.stderr.write("tru cut: --scale must be fit-a4 or actual.\n\n" + USAGE);
    return 2;
  }
  const scale: CutScale = options.scale;

  const proposalText = await readFile(options.proposal, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(proposalText);
  } catch (error) {
    process.stderr.write(`tru cut: could not read proposal JSON: ${errorMessage(error)}\n`);
    return 1;
  }
  const validationErrors = validateProposalFile(parsed);
  if (validationErrors.length > 0) {
    process.stderr.write(`tru cut: invalid proposal file: ${validationErrors.join("; ")}\n`);
    return 1;
  }
  const file = parsed as ProposalFile;

  // 裁てるのは band conform（targetBandLengthMm がある band 提案）だけ。目標長が無い（band 固定 / 未決）
  // 提案は縮める寸法が定まらないので出さない（推測しない、T8）。
  const cuttable = file.proposals.filter(
    (proposal) => proposal.bandReconciliation?.targetBandLengthMm !== undefined
  );
  if (cuttable.length === 0) {
    process.stdout.write(
      "cut: 裁断できる band 提案がありません（band conform の targetBandLengthMm が必要）。何も書きません。\n"
    );
    return 0;
  }

  // 裁つものがある場合だけ DXF を要求する（band ブロックの全辺を slnt edges で取るため）。
  let dxfFile: string;
  try {
    dxfFile = await resolveDxfFile(options.dxfFile);
  } catch (error) {
    process.stderr.write(`tru cut: ${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }

  const slntCommand = options.slnt ? tokenizeCommand(options.slnt) : resolveSlntCommand();
  const runEdges = createSlntEdgesRunner({ slntCommand, dxfFile });
  const cmdRisk = detectCmdPercentRisk(slntCommand, [dxfFile]);
  if (cmdRisk) {
    process.stderr.write(`tru cut: warning: ${cmdRisk}\n`);
  }

  for (const proposal of cuttable) {
    const band = proposal.bandReconciliation!;
    const blockName = band.bandEdge.blockName;
    const targetLengthMm = band.targetBandLengthMm!;

    // band ブロックの全辺を slnt edges で取り、閉じた輪郭を作る（A1: 辺 geometry は subprocess で取得）。
    let edgesResult;
    try {
      edgesResult = runEdges(blockName);
    } catch (error) {
      // slnt 実行失敗は systemic。何か書く前に失敗させる。
      process.stderr.write(`tru cut: ${errorMessage(error)}\n`);
      return 1;
    }

    const outline = computeBandCutOutline({
      edges: edgesResult.edges.map((edge) => edge.points),
      targetLengthMm
    });
    if (!outline.ok) {
      // 曲線 / 非矩形 / 退化は推測せず出さない（T8）。理由を出して次の band へ。
      process.stdout.write(
        `cut: skipped ${blockName}（${outline.reason}）— 矩形の直線バンドでないため出力しません。\n`
      );
      continue;
    }

    const pages = renderBandCutsheet({ outline: outline.outline, scale, title: blockName });
    for (const page of pages) {
      // ファイル名 = base +（band 複数なら .<id>）+（複数ページなら .<label>）。単票（1 提案・1 ページ・
      // label 空）だけ素の --out に書く。それ以外は衝突しないよう分ける（同一 block の上書き防止）。
      const singleFile = cuttable.length === 1 && pages.length === 1 && page.label === "";
      const outPath = singleFile
        ? options.out
        : cutOutPathFor(
            options.out,
            cuttable.length > 1 ? proposal.id : undefined,
            page.label || undefined
          );
      await mkdir(dirname(outPath), { recursive: true });
      await writeFileAtomic(outPath, page.svg);
      process.stdout.write(
        `cut: ${blockName} (${scale})${page.label ? ` [${page.label}]` : ""} -> ${outPath}\n`
      );
    }
  }

  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === "propose") {
    return await runPropose(argv.slice(1));
  }

  if (command === "apply") {
    return await runApply(argv.slice(1));
  }

  if (command === "cut") {
    return await runCut(argv.slice(1));
  }

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  return 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`tru: unexpected error: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
);
