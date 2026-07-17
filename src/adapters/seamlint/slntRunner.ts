// 実物の `slnt edges` runner: Seamlint の CLI を shell 呼び出しし（A1 subprocess）、その JSON を
// resolver が消費する SlntEdgesResult に parse する。これは IO — adapter に置き、core へは素の
// SlntEdgesRunner として注入するので、core/tests は pure に保たれる。
//
// slnt コマンド自体は CLI が設定する（env SEAMLINT_CLI か既定値）ので、「slnt がどこに在るか」は
// deployment の関心事で、core には焼き込まない。Seamlint はまだ未公開なので、典型的な値は
// `node <path>/src/cli/slnt.ts`。

import { spawnSync } from "node:child_process";
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

export function createSlntEdgesRunner(config: SlntRunnerConfig): SlntEdgesRunner {
  const [command, ...baseArgs] = config.slntCommand;
  if (!command) {
    throw new SlntRunError("Empty slnt command. Set SEAMLINT_CLI or pass --slnt.");
  }

  return (blockName): SlntEdgesResult => {
    const result = spawnSync(
      command,
      [...baseArgs, "edges", config.dxfFile, "--block", blockName, "--json"],
      { encoding: "utf8" }
    );

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
