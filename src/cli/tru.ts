#!/usr/bin/env node
// Truer CLI の入口。CLI 層は引数 parsing・file IO・stdout/stderr・exit status を持つ; core は pure の
// まま。`propose` は Seamlint report + DXF を読み、proposal file を（--preview 付きなら overlay SVG も）
// 作る。`apply` は accept された proposal の補正 geometry を、--out の Truer 所有 DXF に書く
//（M3: 書き先はこの裁断用の補正済み DXF であって、.val/Loomit ではない）。

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { text as readStream } from "node:stream/consumers";

import { createProposalFile } from "../core/proposal/createProposalFile.ts";
import type { ResolveApplicable } from "../core/proposal/createProposalFile.ts";
import { validateProposalFile } from "../core/proposal/proposalSchema.ts";
import { foldBlockName } from "../core/proposal/blockName.ts";
import type {
  Proposal,
  ProposalFile,
  SeamSourceProvenance
} from "../core/proposal/proposalSchema.ts";
import {
  readConstraintRequest,
  type ConstraintRequest
} from "../adapters/loom/readConstraintPayload.ts";
import { buildSeamProvenance } from "../core/constraint/buildSeamProvenance.ts";
import { buildSeamApplicable } from "../core/constraint/buildSeamApplicable.ts";
import type { ConstraintPart, ConstraintPayload } from "../core/constraint/constraintTypes.ts";
import { planApply } from "../core/apply/applyProposal.ts";
import {
  parseSeamlintReport,
  buildResolveSeamPair,
  buildResolveBandSeam,
  buildResolveTarget,
  buildEdgePointsLookup,
  type SlntEdgesRunner
} from "../adapters/seamlint/index.ts";
import {
  createSlntEdgesRunner,
  detectCmdPercentRisk,
  resolveSlntCommand,
  tokenizeCommand
} from "../adapters/seamlint/slntRunner.ts";
import { DxfEditError, editNetLineVertex } from "../adapters/dxf/editNetLineVertex.ts";
import { renderProposalPreview } from "../preview/index.ts";
import { renderBandCutsheet, type CutScale, type OnFold } from "../preview/cutsheet.ts";
import { computeBandCutOutline } from "../core/geometry-edit/bandCutOutline.ts";
import { writeFileAtomic } from "./writeFileAtomic.ts";
import { isSameFilePath } from "./samePath.ts";

const USAGE = `tru — Truer CLI (MVP)

Usage:
  tru propose [<pattern.dxf>] --diagnostic <report.json> [--out <proposal.json>] [--reference <block>...] [--preview <preview.svg>] [--constraints <payload.json>|-] [--cut [<cut.svg>] --scale fit-a4|actual [--seam-allowance <mm>] [--on-fold long|short]] [--slnt <cmd>]
  tru apply   [<pattern.dxf>] --proposal <proposal.json> --accepted <id...> --out <out.dxf> [--slnt <cmd>]
  tru cut     [<pattern.dxf>] --proposal <proposal.json> --scale fit-a4|actual --out <cut.svg> [--seam-allowance <mm>] [--on-fold long|short] [--slnt <cmd>]

  <pattern.dxf> は省略可: 省略時は cwd 直下の *.dxf を使う（ちょうど 1 つのとき。0/複数なら明示指定を促す）。

Commands:
  propose   Seamlint 診断 (DXF) から補正案 (proposal) と preview を作る（--cut で band を裁つ stopgap SVG も）。source は書き換えない。
  apply     採用された proposal の補正を --out の DXF に書く。source は不変・書き込みは atomic。
  cut       既存 proposal JSON から band stopgap SVG を再レンダ（新規は propose --cut を推奨）。正式パターン(DXF)は書き換えない。

propose options:
  --diagnostic <file>   Seamlint report JSON (CheckReport or GeometryRequestReport).
  --reference <block>   固定 (基準=reference) とする側の BLOCK 名。複数指定可 (固定パーツ集合)。相手側を
                        これに合わせる目標を出す。seam_length_mismatch: 相手辺の目標 finished 長
                        (linkTarget)。band_seam_sum_mismatch: band を指定→band 固定 (neighbours を直す
                        向きだけ)、neighbour を指定→band が conform で band 長の目標 (targetBandLengthMm)。
                        どの blockName にも一致しない / 両側一致なら向きを決めず両方向 preview-only (T6)。
  --out <file>          proposal JSON の書き出し先。省略時は output/<dxf 名>.proposal.json (親が無ければ作成)。
  --preview <file>      Optional: overlay SVG (seam Δ / band closure / curve_kink before+after).
  --constraints <file|-> Optional: Loomit 拘束 payload（loomit.constraint-payload.v0、\`loom truer request\` の出力）。
                        \`-\` で stdin から読む（\`loom truer request --format json | tru propose --constraints -\`）。
                        seam 提案に「長さに効く .val パラメータ」を advisory で載せる（provenance-only・数値提案ではない）。
  --cut [<file>]        Optional・opt-in: band conform 提案を印刷 stopgap SVG に裁つ（tru cut を propose に畳んだ口）。
                        指定時のみ band ブロックの slnt 取得＋conform を走らせる。値なしは既定 output/<dxf 名>.cut.svg。
                        --scale が必須。band cut と同じレンダラ（矩形=一様 / 曲線帯=弧長スケール）。
  --scale <mode>        --cut 用: fit-a4 (A4 1枚のミニチュア) / actual (1:1 実寸・10cm 四角つきカバー + A4 タイル)。
  --seam-allowance <mm> --cut 用: 縫い代（裁ち線を仕上がり線の外へ）。既定 10。0 で仕上がり線のみ。矩形バンドのみ。
  --on-fold <long|short> --cut 用: わ辺（縫い代 0）の代表 1 辺。long=長辺 / short=短辺。省略=全辺一様。矩形バンドのみ。
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
  --seam-allowance <mm> 縫い代（裁ち線を仕上がり線の外へ）。既定 10。0 で仕上がり線のみ。実線=裁ち線 /
                        破線=仕上がり線。既定は全辺一様（--on-fold でわ辺のみ 0）。**矩形バンドのみ** —
                        曲線バンドは縫い代未対応で仕上がり線のみ（裁つときに手で足す）。
  --on-fold <long|short> わ辺（on the fold）の向き。long=長辺 / short=端辺（短辺）の代表 1 辺を「わ」とし、
                        その辺だけ縫い代 0（裁ち線=仕上がり線）にして「わ」ラベルを付ける。省略=全辺一様。
                        矩形バンドのみ（曲線バンドには効かない）。
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
  // Loomit の拘束 payload（loomit.constraint-payload.v0）の入力。指定時だけ seam 提案に source provenance を
  // additive で載せる。値はファイルパス、または `-`（stdin。パイプ `loom truer request | tru propose --constraints -`）。
  constraints?: string;
  // stopgap SVG（band cut を propose に畳む口）。--cut は opt-in（指定時のみ band conform を裁つ）。
  // 値なしなら既定パス。--scale は --cut 指定時のみ必須。seam-allowance / on-fold は cut と同義。
  cutRequested?: boolean;
  cut?: string;
  scale?: string;
  seamAllowanceMm?: number;
  onFold?: OnFold;
}

// flag の値の取り方。value=次の 1 token、multi=続く非 flag token を貪欲に（--accepted / --reference）、
// optional-value=続く token が非 flag ならそれを値に（--cut。無ければ flag の存在だけ）。
type ArgArity = "value" | "multi" | "optional-value";

const POSITIONAL_TOO_MANY = "Expected a single <pattern.dxf> path.";

interface ParsedCommandArgs {
  positional?: string;
  values: Record<string, string>;
  multi: Record<string, string[]>;
  present: Set<string>;
}

// propose / apply / cut 共通の引数ウォーカ。flag→arity の spec に従って token を消費し、位置引数
// <pattern.dxf> の扱いと多トークン flag の貪欲取り込みを 1 箇所にまとめる（コマンド間の実装ズレ＝
// `arg?.startsWith` 等を無くす）。多トークン flag（--accepted / --reference）の値が `.dxf` で終わる場合は、
// 置き場所を間違えた <pattern.dxf> が id / BLOCK 名へ silent に吸われる footgun なので、推測せず error に
// する（id/BLOCK 名が `.dxf` で終わることは無い）。per-flag の「最低 1 つ」等の意味検証は呼び出し側が行う。
function parseCommandArgs(args: string[], spec: Record<string, ArgArity>): ParsedCommandArgs {
  const result: ParsedCommandArgs = { values: {}, multi: {}, present: new Set() };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const arity = spec[arg];
    if (arity !== undefined) {
      result.present.add(arg);
      if (arity === "value") {
        result.values[arg] = requireValue(arg, args[++index]);
      } else if (arity === "optional-value") {
        if (index + 1 < args.length && !args[index + 1]!.startsWith("--")) {
          result.values[arg] = args[++index]!;
        }
      } else {
        // 同じ multi flag を繰り返すと累積する（`--reference BACK --reference FRONT` = [BACK, FRONT]）。
        // 上書きにすると 2 回目が 1 回目を消し、--reference なら固定パーツを / --accepted なら採用 id を
        // silent に落とす（T3）。既存分に push する。
        const values = result.multi[arg] ?? [];
        while (index + 1 < args.length && !args[index + 1]!.startsWith("--")) {
          const value = args[++index]!;
          if (/\.dxf$/i.test(value)) {
            throw new Error(
              `${arg} の値 "${value}" は DXF パスのようです。<pattern.dxf> は options より前に置いてください。`
            );
          }
          values.push(value);
        }
        result.multi[arg] = values;
      }
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (result.positional !== undefined) {
      throw new Error(POSITIONAL_TOO_MANY);
    }
    result.positional = arg;
  }
  return result;
}

// --seam-allowance / --on-fold は propose --cut と cut で同義なので、値の検証を 1 箇所で共有する。
function parseSeamAllowanceMm(raw: string): number {
  const mm = Number(raw);
  if (!Number.isFinite(mm) || mm < 0) {
    throw new Error("--seam-allowance must be a non-negative number (mm).");
  }
  return mm;
}

function parseOnFold(raw: string): OnFold {
  if (raw !== "long" && raw !== "short") {
    throw new Error('--on-fold must be "long" or "short".');
  }
  return raw;
}

const PROPOSE_SPEC: Record<string, ArgArity> = {
  "--diagnostic": "value",
  "--out": "value",
  "--preview": "value",
  "--slnt": "value",
  "--constraints": "value",
  "--reference": "multi",
  "--cut": "optional-value",
  "--scale": "value",
  "--seam-allowance": "value",
  "--on-fold": "value"
};

function parseProposeArgs(args: string[]): ProposeOptions {
  const parsed = parseCommandArgs(args, PROPOSE_SPEC);
  const options: ProposeOptions = { reference: parsed.multi["--reference"] ?? [] };
  if (parsed.positional !== undefined) options.dxfFile = parsed.positional;
  if (parsed.values["--diagnostic"] !== undefined)
    options.diagnostic = parsed.values["--diagnostic"];
  if (parsed.values["--out"] !== undefined) options.out = parsed.values["--out"];
  if (parsed.values["--preview"] !== undefined) options.preview = parsed.values["--preview"];
  if (parsed.values["--slnt"] !== undefined) options.slnt = parsed.values["--slnt"];
  if (parsed.values["--constraints"] !== undefined)
    options.constraints = parsed.values["--constraints"];
  // --reference は多トークン（`--reference BACK FRONT` = 固定パーツ集合）。指定はしたが BLOCK 名ゼロは error。
  if (parsed.present.has("--reference") && options.reference.length === 0) {
    throw new Error("--reference requires at least one BLOCK name.");
  }
  // --cut は opt-in（存在の有無を cutRequested で持つ）。値（出力パス）は任意。
  if (parsed.present.has("--cut")) {
    options.cutRequested = true;
    if (parsed.values["--cut"] !== undefined) options.cut = parsed.values["--cut"];
  }
  if (parsed.values["--scale"] !== undefined) options.scale = parsed.values["--scale"];
  if (parsed.values["--seam-allowance"] !== undefined) {
    options.seamAllowanceMm = parseSeamAllowanceMm(parsed.values["--seam-allowance"]);
  }
  if (parsed.values["--on-fold"] !== undefined) {
    options.onFold = parseOnFold(parsed.values["--on-fold"]);
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

const APPLY_SPEC: Record<string, ArgArity> = {
  "--proposal": "value",
  "--out": "value",
  "--slnt": "value",
  "--accepted": "multi"
};

function parseApplyArgs(args: string[]): ApplyOptions {
  const parsed = parseCommandArgs(args, APPLY_SPEC);
  const options: ApplyOptions = { accepted: parsed.multi["--accepted"] ?? [] };
  if (parsed.positional !== undefined) options.dxfFile = parsed.positional;
  if (parsed.values["--proposal"] !== undefined) options.proposal = parsed.values["--proposal"];
  if (parsed.values["--out"] !== undefined) options.out = parsed.values["--out"];
  if (parsed.values["--slnt"] !== undefined) options.slnt = parsed.values["--slnt"];
  // --accepted は多トークン（`--accepted a b c`）。指定はしたが id ゼロは error。
  if (parsed.present.has("--accepted") && options.accepted.length === 0) {
    throw new Error("--accepted requires at least one proposal id.");
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

// propose --cut / tru cut で --cut に値が無いときの既定出力先。--out の既定と同流儀（output/ 配下）。
function defaultCutOutPath(dxfFile: string): string {
  return join("output", `${basename(dxfFile, extname(dxfFile))}.cut.svg`);
}

// 辺 blockName（Seamlint 診断の住所）↔ payload の part を突き合わせる join（[C10]）。
//
// **住所の権威は `connectors[].pathRef`**（Loomit 回答 2026-07-28）。`parts[].piece` は `.val` の `<detail>` 名＝
// **export 前の綴り**（DXF の BLOCK 名は Valentina が export 時に大文字化した結果）なので、BLOCK 名として使っては
// いけない。実データで一致していたのは `loom connect` が `path_ref` の既定を `files.piece` にしているだけで、
// `--path-ref-a/b` で上書きできるし SVG 経路（`svg:path#armhole`）では必然的に別物になる。
//
// 手順:
//   1. payload に `pathRef` を宣言した connector が 1 つでもあれば **pathRef を権威**として引く。当たらなければ
//      join 失敗として扱い、**`piece` へ暗黙 fallback しない**（権威を混ぜると [C10] と同じ silent な誤 join に戻る）。
//   2. `pathRef` がどこにも無い旧 payload（Loomit が emit を始める前＝現行の実データ）だけ、従来の `piece` 照合に
//      落とす。**代用したことは run で 1 度だけ注記する**（silent に戻さない。Loomit が emit すれば自動で 1 に切り替わる）。
//
// 比較は `foldBlockName`（core と共有）で畳む。Loomit は normalize 済みの `pathRef` を出すので綴りは一致する想定
// だが、手書きの `path_ref` の case 揺れ（実データの `BACK` / `back`）に対する多層防御として残す。
//
// **join できないときは silent にしない。** 「候補ゼロ」「join 失敗」「part が payload に無い」を人が区別できるよう、
// 理由ごとに 1 度だけ stderr へ出す（IO なので CLI 層。core は純粋のまま）。複数 part に跨る一致は**推測せず諦める**（T6）。
function makeBlockNameJoin(
  payload: ConstraintPayload
): (blockName: string) => ConstraintPart | undefined {
  const warned = new Set<string>();
  let noticedPieceFallback = false;
  // 住所を宣言している connector。1 つでもあれば pathRef を権威とする。
  const addressed = payload.connectors.flatMap((connector) =>
    connector.pathRef !== undefined
      ? [{ partId: connector.partId, pathRef: connector.pathRef }]
      : []
  );

  const warnOnce = (key: string, message: string): undefined => {
    if (!warned.has(key)) {
      warned.add(key);
      process.stderr.write(`tru propose: 警告: ${message}\n`);
    }
    return undefined;
  };

  return (blockName) => {
    const folded = foldBlockName(blockName);

    if (addressed.length > 0) {
      const partIds = [
        ...new Set(
          addressed
            .filter((connector) => foldBlockName(connector.pathRef) === folded)
            .map((connector) => connector.partId)
        )
      ];
      if (partIds.length > 1) {
        return warnOnce(
          `ambiguous:${folded}`,
          `辺 BLOCK "${blockName}" の pathRef が複数の part に跨っています（${partIds.join(" / ")}）。` +
            `どれか推測せず provenance / applicable を載せません。`
        );
      }
      if (partIds.length === 0) {
        const declared = [...new Set(addressed.map((connector) => connector.pathRef))];
        return warnOnce(
          `no-match:${folded}`,
          `辺 BLOCK "${blockName}" に一致する pathRef が拘束 payload にありません` +
            `（宣言済み pathRef: ${declared.join(" / ")}）。この辺の provenance / applicable は載りません。`
        );
      }
      const part = payload.parts.find((candidate) => candidate.partId === partIds[0]);
      if (part) return part;
      // connector は見つかったが part 本体が無い: `files.source` / `files.piece` を持たない part は payload の
      // `parts[]` に載らない（Loomit 回答 §5c）。「宣言が足りない」と「join に失敗した」を区別して出す。
      return warnOnce(
        `missing-part:${folded}`,
        `辺 BLOCK "${blockName}" は connector（part "${partIds[0]}"）に一致しましたが、その part は拘束 payload の ` +
          `parts に含まれていません（.val source / piece 未宣言の part は載りません）。provenance / applicable は載りません。`
      );
    }

    // --- 旧 payload（pathRef 未宣言）の後方互換経路 ---
    if (!noticedPieceFallback) {
      noticedPieceFallback = true;
      process.stderr.write(
        `tru propose: 注記: 拘束 payload の connectors に pathRef が無いため、辺 BLOCK と ` +
          `parts[].piece の照合で代用します（住所の権威は pathRef。上流が emit すれば自動で切り替わります）。\n`
      );
    }
    const hits = payload.parts.filter((candidate) => foldBlockName(candidate.piece) === folded);
    if (hits.length === 1) {
      return hits[0];
    }
    if (hits.length > 1) {
      return warnOnce(
        `ambiguous:${folded}`,
        `辺 BLOCK "${blockName}" に対応する拘束 payload の piece が複数あります` +
          `（${hits.map((hit) => hit.piece).join(" / ")}）。どれか推測せず provenance / applicable を載せません。`
      );
    }
    const available = payload.parts.map((part) => part.piece);
    return warnOnce(
      `no-match:${folded}`,
      `辺 BLOCK "${blockName}" に対応する piece が拘束 payload にありません` +
        `（payload の piece: ${available.length > 0 ? available.join(" / ") : "なし"}）。` +
        `この辺の provenance / applicable は載りません。`
    );
  };
}

// 辺 blockName → part（`makeBlockNameJoin`）→ その part の最初の connector → buildSeamProvenance → contract 用の
// SeamSourceProvenance に写す。provenance は piece 単位なので connector はどれでも同結果（[C6]）。join 失敗 /
// 候補ゼロは undefined（seam 提案に載せない）。.val 内部詳細（pointId/refs 等）は出さず式・役割・coupling だけ載せる。
function makeResolveProvenance(
  payload: ConstraintPayload,
  joinBlockName: (blockName: string) => ConstraintPart | undefined
): (piece: string) => SeamSourceProvenance | undefined {
  return (piece) => {
    const part = joinBlockName(piece);
    if (!part) return undefined;
    const connector = payload.connectors.find((candidate) => candidate.partId === part.partId);
    if (!connector) return undefined;
    const provenance = buildSeamProvenance(payload, {
      partId: part.partId,
      connectorId: connector.connectorId
    });
    if (provenance.candidates.length === 0) return undefined;
    return {
      piece,
      pieceWide: provenance.pieceWide,
      candidates: provenance.candidates.map((candidate) => ({
        expr: candidate.occurrence.expr,
        // none は buildSeamProvenance で既に落ちているので linear | nonlinear のみ。
        linearity: candidate.occurrence.linearity === "nonlinear" ? "nonlinear" : "linear",
        coupling: candidate.coupling,
        ...(candidate.usedByHint ? { usedByHint: candidate.usedByHint } : {}),
        reason: candidate.reason
      }))
    };
  };
}

// applicable resolver: conform 辺の測定 notch × その piece の .val notch を matcher にかけ、単一 linear param が絞れたとき
// だけ SeamApplicable を返す（piece を添える）。辺 blockName → part の照合は provenance と**同一の join**
// （`makeBlockNameJoin`）を共有する（[C10]。2 箇所で規則がずれないように 1 つに寄せた）。join 失敗 / notch マッチ
// 不成立 / linear が 0 or 複数 なら undefined（applicable を載せない = provenance-only）。
function makeResolveApplicable(
  joinBlockName: (blockName: string) => ConstraintPart | undefined
): ResolveApplicable {
  return ({ piece, measured, deltaMm, conform }) => {
    const part = joinBlockName(piece);
    if (!part) return undefined;
    const result = buildSeamApplicable(measured, part.notches, deltaMm, conform);
    if (!result) return undefined;
    return { piece, ...result };
  };
}

// [C7]: 拘束 payload の封筒が「構築時に問題があった」（status!=ok / diagnostics 非空）と報告しているとき、
// source provenance は不完全になりうる（該当 piece が payload から欠けている等）。黙って進めず stderr に
// 警告を出す（propose 自体は成功＝advisory）。IO なので CLI 層に置く（core は純粋のまま）。
function warnPartialConstraints(request: ConstraintRequest): void {
  const parts = [
    request.status !== undefined && request.status !== "ok"
      ? `status=${request.status}`
      : undefined,
    request.diagnostics.length > 0 ? `diagnostics ${request.diagnostics.length} 件` : undefined
  ].filter((part): part is string => part !== undefined);
  process.stderr.write(
    `tru propose: 警告: 拘束 payload に ${parts.join(" / ")} — source provenance は不完全な可能性があります` +
      `（該当 piece が payload から欠けている等）。\n`
  );
  for (const diagnostic of request.diagnostics) {
    const severity = diagnostic.severity ? `[${diagnostic.severity}] ` : "";
    const code = diagnostic.code ? `${diagnostic.code}: ` : "";
    process.stderr.write(`  - ${severity}${code}${diagnostic.message}\n`);
  }
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

  // --cut 系オプション（--scale / --seam-allowance / --on-fold）は --cut と組でないと意味を持たない。
  // --cut 無しで渡されたら silent に無視せず usage error にする（打ち間違いを exit 0 で見逃さないため）。
  if (
    !options.cutRequested &&
    (options.scale !== undefined ||
      options.seamAllowanceMm !== undefined ||
      options.onFold !== undefined)
  ) {
    process.stderr.write(
      "tru propose: --scale / --seam-allowance / --on-fold は --cut と一緒に指定してください。\n\n" +
        USAGE
    );
    return 2;
  }

  // --cut は --scale 必須（band cut と同じ）。欠落は file も slnt も触る前に usage error（exit 2）で止める。
  if (options.cutRequested && options.scale !== "fit-a4" && options.scale !== "actual") {
    process.stderr.write("tru propose: --cut requires --scale fit-a4|actual.\n\n" + USAGE);
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

  // --constraints（任意）: Loomit の拘束 payload を読み、seam 提案の piece ごとに source provenance を解決する
  // resolver を組む。指定が無ければ resolver も無し（seam 提案に provenance は載らない）。`-` なら stdin から読む
  // ＝パイプ配送 `loom truer request --format json | tru propose --constraints -` の受け口（file 方式も従来どおり）。
  let resolveProvenance: ((piece: string) => SeamSourceProvenance | undefined) | undefined;
  let resolveApplicable: ResolveApplicable | undefined;
  if (options.constraints) {
    let request: ConstraintRequest;
    try {
      const payloadText =
        options.constraints === "-"
          ? await readStream(process.stdin)
          : await readFile(options.constraints, "utf8");
      request = readConstraintRequest(JSON.parse(payloadText));
    } catch (error) {
      process.stderr.write(
        `tru propose: could not read constraint payload: ${errorMessage(error)}\n`
      );
      return 1;
    }
    // 封筒が payload 構築時の問題（piece 不在等）を報告しているときは source provenance が不完全になりうる。
    // Truer は黙って進めず人に surface する（[C7]／「わからないものを silent に捨てない」）。propose 自体は
    // 成功のまま（advisory・exit は変えない）。status が無い bare 形は ok 相当で警告しない。
    if (
      (request.status !== undefined && request.status !== "ok") ||
      request.diagnostics.length > 0
    ) {
      warnPartialConstraints(request);
    }
    // 辺 blockName → part の join は provenance / applicable で共有する（規則が 2 箇所でずれないように・[C10]）。
    // warn / 注記の dedupe 状態も共有されるので、同じ理由のメッセージは run で 1 回しか出ない。
    const joinBlockName = makeBlockNameJoin(request.payload);
    resolveProvenance = makeResolveProvenance(request.payload, joinBlockName);
    resolveApplicable = makeResolveApplicable(joinBlockName);
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
    resolveBandSeam: buildResolveBandSeam(runEdges, options.reference),
    // 拘束 payload が渡されたときだけ seam 提案に source provenance を additive で載せる。
    ...(resolveProvenance ? { resolveProvenance } : {}),
    // 同じく拘束 payload 供給時のみ: reference で調整辺が決まり notch マッチで単一 linear param が絞れれば applicable（数値）。
    ...(resolveApplicable ? { resolveApplicable } : {})
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

  // --cut（opt-in）: この場で band conform 提案を印刷 stopgap SVG に裁つ（tru cut を propose に畳んだ口）。
  // read-only な派生 SVG なので propose と同居できる（apply とは別・ゲート無し）。propose 用に組んだ runEdges を
  // そのまま流用する。scale は上で検証済み（cutRequested なら fit-a4|actual）。
  if (options.cutRequested && (options.scale === "fit-a4" || options.scale === "actual")) {
    const scale: CutScale = options.scale;
    const cuttable = cuttableBandProposals(file);
    if (cuttable.length === 0) {
      process.stdout.write(
        "cut: 裁断できる band 提案がありません（band conform の targetBandLengthMm が必要）。何も書きません。\n"
      );
    } else {
      const cutOut = options.cut ?? defaultCutOutPath(dxfFile);
      const cutStatus = await writeBandCutsheets({
        cuttable,
        runEdges,
        scale,
        out: cutOut,
        ...(options.seamAllowanceMm !== undefined
          ? { seamAllowanceMm: options.seamAllowanceMm }
          : {}),
        ...(options.onFold ? { onFold: options.onFold } : {})
      });
      if (cutStatus !== 0) return cutStatus;
    }
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
  seamAllowanceMm?: number;
  onFold?: OnFold;
}

const CUT_SPEC: Record<string, ArgArity> = {
  "--proposal": "value",
  "--scale": "value",
  "--out": "value",
  "--slnt": "value",
  "--seam-allowance": "value",
  "--on-fold": "value"
};

function parseCutArgs(args: string[]): CutOptions {
  const parsed = parseCommandArgs(args, CUT_SPEC);
  const options: CutOptions = {};
  if (parsed.positional !== undefined) options.dxfFile = parsed.positional;
  if (parsed.values["--proposal"] !== undefined) options.proposal = parsed.values["--proposal"];
  if (parsed.values["--scale"] !== undefined) options.scale = parsed.values["--scale"];
  if (parsed.values["--out"] !== undefined) options.out = parsed.values["--out"];
  if (parsed.values["--slnt"] !== undefined) options.slnt = parsed.values["--slnt"];
  if (parsed.values["--seam-allowance"] !== undefined) {
    options.seamAllowanceMm = parseSeamAllowanceMm(parsed.values["--seam-allowance"]);
  }
  if (parsed.values["--on-fold"] !== undefined) {
    options.onFold = parseOnFold(parsed.values["--on-fold"]);
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

// 裁てるのは band conform（targetBandLengthMm がある band 提案）だけ。目標長が無い（band 固定 / 未決）提案は
// 縮める寸法が定まらないので出さない（推測しない、T8）。propose --cut と tru cut が同じ判定を共有する。
function cuttableBandProposals(file: ProposalFile): Proposal[] {
  return file.proposals.filter(
    (proposal) => proposal.bandReconciliation?.targetBandLengthMm !== undefined
  );
}

// 裁てる band 提案を印刷 stopgap SVG（cutsheet）へ書き出す共有ルーチン。propose --cut（in-memory の proposal
// file）と tru cut（既存 proposal JSON の再レンダ）が同じレンダラを通る＝band の裁ち方を一元化する。band ブロックの
// 全辺を slnt edges で取り、輪郭を目標長へ縮め（矩形=一様スケール / 曲線帯=弧長スケール）SVG を書く。4 辺 ribbon
// でない / 退化は推測せず出さない（T8）。曲線は縫い代未対応。slnt 失敗は systemic なので何か書く前に 1 で止める。
async function writeBandCutsheets(params: {
  cuttable: Proposal[];
  runEdges: SlntEdgesRunner;
  scale: CutScale;
  out: string;
  seamAllowanceMm?: number;
  onFold?: OnFold;
}): Promise<number> {
  const { cuttable, runEdges, scale, out } = params;
  for (const proposal of cuttable) {
    const band = proposal.bandReconciliation!;
    const blockName = band.bandEdge.blockName;
    const targetLengthMm = band.targetBandLengthMm!;

    // band ブロックの全辺を slnt edges で取り、閉じた輪郭を作る（A1: 辺 geometry は subprocess で取得）。
    let edgesResult;
    try {
      edgesResult = runEdges(blockName);
    } catch (error) {
      process.stderr.write(`cut: ${errorMessage(error)}\n`);
      return 1;
    }

    const outline = computeBandCutOutline({
      edges: edgesResult.edges.map((edge) => edge.points),
      targetLengthMm
    });
    if (!outline.ok) {
      // 4 辺 ribbon（矩形 or 曲線帯）でない / 退化は推測せず出さない（T8）。理由を出して次の band へ。
      process.stdout.write(
        `cut: skipped ${blockName}（${outline.reason}）— band 輪郭（4 辺 ribbon）として扱えないため出力しません。\n`
      );
      continue;
    }
    // 曲線バンドは縫い代未対応（第一スライス）: 要求されていれば net 線のみになる旨を告げる。
    if (outline.outline.kind === "curved" && (params.seamAllowanceMm ?? 10) > 0) {
      process.stdout.write(
        `cut: ${blockName} は曲線バンド — 縫い代は未対応（仕上がり線のみ）。裁つときは手で縫い代を足す。\n`
      );
    }

    // 縫い代の既定は 10mm（cut = 布を裁つ用途）。`--seam-allowance 0` で仕上がり線のみ（0 は保持）。
    // `--on-fold` があればわ辺だけ縫い代 0（案A・矩形のみ）。曲線バンドは kind により cutsheet が net のみにする。
    const pages = renderBandCutsheet({
      outline: outline.outline,
      scale,
      title: blockName,
      seamAllowanceMm: params.seamAllowanceMm ?? 10,
      ...(params.onFold ? { onFold: params.onFold } : {})
    });
    for (const page of pages) {
      // ファイル名 = base +（band 複数なら .<id>）+（複数ページなら .<label>）。単票（1 提案・1 ページ・
      // label 空）だけ素の out に書く。それ以外は衝突しないよう分ける（同一 block の上書き防止）。
      const singleFile = cuttable.length === 1 && pages.length === 1 && page.label === "";
      const outPath = singleFile
        ? out
        : cutOutPathFor(
            out,
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

// tru cut: band 提案から、印刷して手で裁つ stopgap の SVG を作る。正式パターン(DXF)は書き換えない
// （apply とは別・ゲート無しの使い捨てアーティファクト）。band conform（targetBandLengthMm がある band
// 提案）だけを対象にし、band ブロックの全辺を slnt edges で取って輪郭を目標長へ縮め（矩形=一様スケール /
// 曲線帯=弧長スケール）、SVG を書く。4 辺 ribbon でない / 退化は推測せず出さない（T8）。曲線は縫い代未対応。
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

  const cuttable = cuttableBandProposals(file);
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

  return await writeBandCutsheets({
    cuttable,
    runEdges,
    scale,
    out: options.out,
    ...(options.seamAllowanceMm !== undefined ? { seamAllowanceMm: options.seamAllowanceMm } : {}),
    ...(options.onFold ? { onFold: options.onFold } : {})
  });
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
