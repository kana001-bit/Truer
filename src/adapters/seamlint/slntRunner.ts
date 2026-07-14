// The real `slnt edges` runner: shells out to Seamlint's CLI (A1 subprocess) and parses its
// JSON into the SlntEdgesResult the resolver consumes. This is IO — it lives in the adapter and
// is injected into core as a plain SlntEdgesRunner, so core/tests stay pure.
//
// The slnt command itself is configured by the CLI (env SEAMLINT_CLI or a default), so "where
// does slnt live" is a deployment concern, not baked into core. Seamlint is not published yet,
// so a typical value is `node <path>/src/cli/slnt.ts`.

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
  // The slnt command as an argv array, e.g. ["slnt"] or ["node", ".../src/cli/slnt.ts"].
  slntCommand: string[];
  // The DXF file passed to `slnt edges <dxf> --block <name> --json`.
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

// Splits a command string into argv, respecting single/double quotes so spaces inside a quote
// survive. A plain whitespace split shatters paths with spaces — a very common Windows case
// (Program Files, user names with spaces). Quotes may appear anywhere in a token, so both a
// fully quoted token (`node "C:\\Program Files\\...\\slnt.ts"`) and an inline-quoted flag
// (`--loader="C:\\Program Files\\tsx\\loader.mjs"`) tokenize correctly. Unquoted whitespace
// separates tokens; the delimiting quotes are stripped, their contents kept.
export function tokenizeCommand(command: string): string[] {
  // A token = one or more adjacent segments, each a quoted run or a run of non-space, non-quote
  // characters. This keeps `--flag="a b"` as a single token rather than splitting at the space.
  const wordPattern = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  const stripQuotes = /"([^"]*)"|'([^']*)'/g;
  return (command.match(wordPattern) ?? []).map((word) =>
    word.replace(
      stripQuotes,
      (_match, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted ?? ""
    )
  );
}

// Resolves the slnt command from the environment (SEAMLINT_CLI, quote-aware tokenized) or falls
// back to `slnt` on PATH. Kept here so the CLI stays thin.
export function resolveSlntCommand(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = env.SEAMLINT_CLI?.trim();
  if (configured) return tokenizeCommand(configured);
  return ["slnt"];
}
