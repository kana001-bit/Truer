// 実物の `slnt edges` runner: Seamlint の CLI を shell 呼び出しし（A1 subprocess）、その JSON を
// resolver が消費する SlntEdgesResult に parse する。これは IO — adapter に置き、core へは素の
// SlntEdgesRunner として注入するので、core/tests は pure に保たれる。
//
// slnt コマンド自体は CLI が設定する（env SEAMLINT_CLI か既定値）ので、「slnt がどこに在るか」は
// deployment の関心事で、core には焼き込まない。Seamlint はまだ未公開なので、典型的な値は
// `node <path>/src/cli/slnt.ts`。

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { statSync } from "node:fs";
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { Point } from "../../core/proposal/proposalSchema.ts";
import type { NotchType } from "../../core/constraint/constraintTypes.ts";
import type { SlntEdge, SlntEdgesResult, SlntEdgesRunner, SlntNotch } from "./resolveSeamPair.ts";

export const SLNT_RUN_FAILED = "seamlint.slnt_run_failed";

export class SlntRunError extends Error {
  code = SLNT_RUN_FAILED;
  constructor(message: string) {
    super(message);
    this.name = "SlntRunError";
  }
}

export interface SlntRunnerConfig {
  // argv 配列としての slnt コマンド。例: ["slnt"] や ["node", ".../src/cli/slnt.ts"]。
  slntCommand: string[];
  // `slnt edges <dxf> --block <name> --json` に渡す DXF file。
  dxfFile: string;
}

function isPoint(value: unknown): value is Point {
  if (typeof value !== "object" || value === null) return false;
  const point = value as Record<string, unknown>;
  return typeof point.x === "number" && typeof point.y === "number";
}

function isNotchType(value: unknown): value is NotchType {
  return value === "v" || value === "t" || value === "castle" || value === "check" || value === "u";
}

// `StructuralNotch` を matcher が使う部分集合へ coerce（[C6]）。matcher の主キーである `edgePosition` を持たない
// notch は順序付けできないので落とす（coerceEdge が壊れた edge を落とすのと同方針・defensive）。`notchType` は
// 弱い tie-breaker なので、欠落 / 不正値は undefined 扱いにして notch 自体は落とさない（order で拾える）。
function coerceNotch(value: unknown): SlntNotch | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const notch = value as Record<string, unknown>;
  if (typeof notch.edgePosition !== "number" || !Number.isFinite(notch.edgePosition)) {
    return undefined;
  }
  return {
    edgePosition: notch.edgePosition,
    onCorner: notch.onCorner === true,
    ambiguous: notch.ambiguous === true,
    ...(isNotchType(notch.notchType) ? { notchType: notch.notchType } : {})
  };
}

function coerceEdge(value: unknown): SlntEdge | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const edge = value as Record<string, unknown>;
  if (typeof edge.edgeId !== "number") return undefined;
  if (!Array.isArray(edge.points) || !edge.points.every(isPoint)) return undefined;
  // notches は applicable の matcher 用に carry する（[C6]）。無ければ []、壊れた notch（edgePosition 欠落）は落とす。
  const notches = Array.isArray(edge.notches)
    ? edge.notches.map(coerceNotch).filter((notch): notch is SlntNotch => notch !== undefined)
    : [];
  return { edgeId: edge.edgeId, points: edge.points as Point[], notches };
}

function coerceEdgesResult(value: unknown, blockName: string): SlntEdgesResult {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { edges?: unknown }).edges)
  ) {
    throw new SlntRunError(`slnt edges returned an unexpected shape for block ${blockName}.`);
  }
  const raw = value as { blockName?: unknown; edges: unknown[] };
  const edges: SlntEdge[] = [];
  for (const candidate of raw.edges) {
    const edge = coerceEdge(candidate);
    if (edge) edges.push(edge);
  }
  return {
    blockName: typeof raw.blockName === "string" ? raw.blockName : blockName,
    edges
  };
}

// slnt を1回起動して結果を返す。Windows の `.cmd`/`.bat` は Node >= 24 が `shell:true` 無しで spawn できず
// `EINVAL` を投げる（CVE-2024-27980 対策）。npm 導入の slnt は Windows で `slnt.cmd` になり、loom が `--slnt`
// でその `.cmd` を Truer に転送してくるので、ここで扱わないと `loom match` が Truer 段で落ちる。実行ファイルを
// 解決して `.exe/.com` は直接 spawn、`.cmd/.bat` は cmd.exe 経由で起動する。posix は従来どおり shell 無しで
// 直接 spawn（ENOENT で未検出を拾う）。
//
// `.cmd/.bat` は cmd.exe を明示起動（.exe なので EINVAL しない）し、対象を **cwd=そのディレクトリ +
// `.\<basename>`**（相対）で参照する。cmd.exe は命令行の `%VAR%` を二重引用符内でも必ず展開するので、実行
// ファイルの絶対パスを命令行に載せると `C:\...\%FOO%\slnt.cmd` のような正当なパスが壊れる。相対参照なら実行
// ファイルの「ディレクトリ側」の % を命令行に出さずに済む。basename と各引数は二重引用符で囲んで cmd メタ文字
// （`& ( ) ^ < > |` 等）を literal 化し、外側にもう1組の引用符を足して `/s` にその外側だけ剥がさせ、内側の
// 引用をそのまま解釈させる（cross-spawn と同じ `/s` トリック）。windowsVerbatimArguments で Node の再クォートを止める。
// 既知の残制約: 引数（dxf パス）や basename 自体が定義済み変数に一致する `%VAR%` を含むと cmd が展開する
// （二重引用符内でも `%` だけは展開される。`.cmd` を Windows で起動する際の cmd.exe の原理的制約で caller 側
// から回避不能）。`node <script>` / `.exe` 形式の slnt なら cmd を経由しないのでこの問題は一切起きない（推奨）。
// この残制約は `detectCmdPercentRisk` が該当時に警告する。
function runSlnt(command: string, args: string[]): SpawnSyncReturns<string> {
  if (process.platform !== "win32") {
    return spawnSync(command, args, { encoding: "utf8" });
  }
  const resolved = resolveWindowsExecutable(command);
  if (resolved === undefined) {
    // 未検出は ENOENT 相当の error として返し、呼び出し側の "Could not run slnt" 分岐に載せる。
    return {
      pid: -1,
      output: [],
      stdout: "",
      stderr: "",
      status: null,
      signal: null,
      error: new Error("could not resolve executable on PATH/PATHEXT")
    };
  }
  const ext = extname(resolved).toLowerCase();
  if (ext === ".exe" || ext === ".com") {
    // 実行ファイルは直接叩ける（パス中のメタ文字にも影響されない）。
    return spawnSync(resolved, args, { encoding: "utf8" });
  }
  // `.cmd`/`.bat`: cmd.exe を起動。実行ファイルは cwd + 相対名で参照し（ディレクトリ % 回避）、basename と
  // 各引数を二重引用符で囲んで cmd メタ文字を literal 化、外側1組を `/s` に剥がさせて内側の引用を保つ。
  const quote = (value: string): string => `"${value}"`;
  const inner = [quote("." + sep + basename(resolved)), ...args.map(quote)].join(" ");
  return spawnSync(process.env.ComSpec ?? "cmd.exe", [`/d /s /c "${inner}"`], {
    cwd: dirname(resolved),
    windowsVerbatimArguments: true,
    encoding: "utf8"
  });
}

// PATH / PATHEXT を辿って Windows 実行ファイルの実体パスを返す（相対パスは cwd 基準、絶対はそのまま）。
// 見つからなければ undefined。loom `packages/cli/src/commands/subprocess.ts` の resolveExecutable と同型。
function resolveWindowsExecutable(bin: string): string | undefined {
  const cwd = process.cwd();
  const hasSeparator = bin.includes("/") || bin.includes("\\");
  const candidates: string[] = [];
  if (isAbsolute(bin) || hasSeparator) {
    candidates.push(resolve(cwd, bin));
  } else {
    const pathDirs = (process.env.PATH ?? "").split(delimiter).filter((dir) => dir.length > 0);
    pathDirs.unshift(cwd); // cmd.exe 同様まず cwd を見る
    for (const dir of pathDirs) {
      candidates.push(join(dir, bin));
    }
  }
  const pathExts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((ext) => ext.length > 0);
  for (const candidate of candidates) {
    // 拡張子無しの名前は PATHEXT を補って解決する（`slnt` -> `slnt.cmd` 等）。
    if (extname(candidate) === "") {
      for (const ext of pathExts) {
        if (isFile(candidate + ext)) {
          return candidate + ext;
        }
      }
      continue;
    }
    if (isFile(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// slnt が `.cmd`/`.bat` で、渡す path に「定義済み環境変数に一致する `%VAR%`」が含まれると、cmd.exe が起動時に
// それを環境変数として展開し、実在するファイルでも「パスが見つかりません」で失敗する（Windows の .cmd 起動の
// 原理的制約。runSlnt は実行ファイル側の % は cwd + 相対名で回避するが、引数 path の % は回避不能）。その状況を
// 事前検出して人向けの警告文を返す（無ければ undefined）。判定だけで、stderr 出力は CLI 層が行う。未定義変数の
// `%...%` は cmd がそのまま残す（実際に動く）ので警告しない＝空振りしない。
export function detectCmdPercentRisk(slntCommand: string[], paths: string[]): string | undefined {
  if (process.platform !== "win32") return undefined;
  const [command] = slntCommand;
  if (!command) return undefined;
  const resolved = resolveWindowsExecutable(command);
  const ext = (resolved ? extname(resolved) : extname(command)).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return undefined;
  // Windows の環境変数は case-insensitive。定義済み名を大文字で集める。
  const defined = new Set(Object.keys(process.env).map((name) => name.toUpperCase()));
  const hits = new Set<string>();
  for (const path of paths) {
    for (const match of path.matchAll(/%([^%]+)%/g)) {
      const name = match[1];
      if (name && defined.has(name.toUpperCase())) hits.add(match[0]);
    }
  }
  if (hits.size === 0) return undefined;
  return (
    `slnt が .cmd/.bat のため、パス内の ${[...hits].join(", ")} が cmd.exe に環境変数として展開され、` +
    `実在するファイルでも失敗することがあります。回避するには非 .cmd の slnt（例: --slnt "node <path>/slnt.ts"）を使ってください。`
  );
}

export function createSlntEdgesRunner(config: SlntRunnerConfig): SlntEdgesRunner {
  const [command, ...baseArgs] = config.slntCommand;
  if (!command) {
    throw new SlntRunError("Empty slnt command. Set SEAMLINT_CLI or pass --slnt.");
  }
  // dxf は絶対パス化する。`.cmd/.bat` 経路では cmd.exe の cwd を実行ファイルのディレクトリへ変えるので、相対
  // dxf パスだとそこ基準に解決されて壊れる。絶対化しておけば cwd 変更の影響を受けない（同一ファイルを指す）。
  const dxfFile = resolve(config.dxfFile);

  return (blockName): SlntEdgesResult => {
    const result = runSlnt(command, [
      ...baseArgs,
      "edges",
      dxfFile,
      "--block",
      blockName,
      "--json"
    ]);

    if (result.error) {
      throw new SlntRunError(`Could not run slnt ("${command}"): ${result.error.message}`);
    }
    if (result.status !== 0) {
      const detail = (result.stderr || result.stdout || "").trim();
      throw new SlntRunError(
        `slnt edges failed for block "${blockName}" (exit ${result.status}): ${detail}`
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new SlntRunError(`slnt edges did not return JSON for block "${blockName}".`);
    }
    return coerceEdgesResult(parsed, blockName);
  };
}

// command 文字列を argv に分割する。single/double quote を尊重し、quote 内の space が残るようにする。
// 素の whitespace 分割は space を含む path を壊す — Windows でごく一般的（Program Files、space を含む
// ユーザー名）。quote は token 内のどこにでも現れうるので、完全に quote された token
//（`node "C:\\Program Files\\...\\slnt.ts"`）も inline quote の flag
//（`--loader="C:\\Program Files\\tsx\\loader.mjs"`）も正しく tokenize する。quote されていない
// whitespace が token を区切る; 区切りの quote は剥がし、中身は残す。
export function tokenizeCommand(command: string): string[] {
  // token = 隣接する 1 つ以上の segment。各 segment は quote された run か、space でも quote でもない
  // 文字の run。これで `--flag="a b"` を space で分割せず単一 token として保つ。
  const wordPattern = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  const stripQuotes = /"([^"]*)"|'([^']*)'/g;
  return (command.match(wordPattern) ?? []).map((word) =>
    word.replace(
      stripQuotes,
      (_match, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted ?? ""
    )
  );
}

// slnt コマンドを environment（SEAMLINT_CLI、quote を意識して tokenize）から解決するか、PATH 上の
// `slnt` に fallback する。CLI を薄く保つためここに置く。
export function resolveSlntCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.SEAMLINT_CLI?.trim();
  if (configured) return tokenizeCommand(configured);
  return ["slnt"];
}
