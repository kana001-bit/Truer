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
import type { SlntEdge, SlntEdgesResult, SlntEdgesRunner } from "./resolveSeamPair.ts";

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

function coerceEdge(value: unknown): SlntEdge | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const edge = value as Record<string, unknown>;
  if (typeof edge.edgeId !== "number") return undefined;
  if (!Array.isArray(edge.points) || !edge.points.every(isPoint)) return undefined;
  return { edgeId: edge.edgeId, points: edge.points as Point[] };
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
// ファイルの絶対パスを命令行に載せると `C:\...\%FOO%\slnt.cmd` のような正当なパスが壊れる。相対参照なら
// 実行ファイルの % を命令行に出さずに済む。引数は配列で渡し Node にクォートさせる（joined string + `/c` の
// 外側クォート剥がし問題も避ける）。
// 既知の残制約: 引数（dxf パス）自体が定義済み変数に一致する `%VAR%` を含むと cmd がそれを展開する — これは
// `.cmd` を Windows で起動する際の cmd.exe の原理的制約で caller 側から回避不能。`node <script>` / `.exe` 形式
// の slnt なら cmd を経由しないのでこの問題は一切起きない（そちらが推奨）。
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
  // `.cmd`/`.bat`: cmd.exe を起動し、対象は cwd + 相対名（`.\<basename>`）で参照して % 展開を避ける。
  return spawnSync(
    process.env.ComSpec ?? "cmd.exe",
    ["/d", "/s", "/c", "." + sep + basename(resolved), ...args],
    { cwd: dirname(resolved), encoding: "utf8" }
  );
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
