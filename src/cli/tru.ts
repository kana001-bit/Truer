#!/usr/bin/env node
// Truer CLI entry. The CLI layer owns argument parsing, file IO, stdout/stderr, and exit status;
// core stays pure. `propose` reads a Seamlint report + a DXF, builds a proposal file (and,
// with --preview, a seam overlay SVG). `apply` is not implemented yet (write target OPEN).

import { readFile, writeFile } from "node:fs/promises";

import { createProposalFile } from "../core/proposal/createProposalFile.ts";
import type { ResolveTargetResult } from "../core/proposal/createProposalFile.ts";
import { parseSeamlintReport, buildResolveSeamPair } from "../adapters/seamlint/index.ts";
import {
  createSlntEdgesRunner,
  resolveSlntCommand,
  tokenizeCommand
} from "../adapters/seamlint/slntRunner.ts";
import { renderProposalPreview } from "../preview/index.ts";

const USAGE = `tru — Truer CLI (MVP)

Usage:
  tru propose <pattern.dxf> --diagnostic <report.json> --out <proposal.json> [--preview <preview.svg>] [--slnt <cmd>]
  tru apply   <pattern.dxf> --proposal <proposal.json> --accepted <id...> --out <out>

Commands:
  propose   Seamlint 診断 (DXF) から補正案 (proposal) と preview を作る。source は書き換えない。
  apply     採用された proposal だけを --out に適用する (書き先は Loomit と未確定 / OPEN)。

propose options:
  --diagnostic <file>   Seamlint report JSON (CheckReport or GeometryRequestReport).
  --out <file>          Where to write the proposal JSON.
  --preview <file>      Optional: write a seam-overlay SVG (両辺 + Δ) for seam_length_mismatch.
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
}

function parseProposeArgs(args: string[]): ProposeOptions {
  const options: ProposeOptions = {};
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

// curve_kink point->edge resolution is not wired yet (Seamlint does not emit that address, and
// Truer does not project points onto net lines). Such diagnostics resolve to not-found and are
// recorded as skipped — never silently dropped, never guessed. The seam pair path uses
// resolveSeamPair, not this.
const resolveTargetNotWired = (): ResolveTargetResult => ({ status: "not-found" });

async function runPropose(args: string[]): Promise<number> {
  let options: ProposeOptions;
  try {
    options = parseProposeArgs(args);
  } catch (error) {
    process.stderr.write(`tru propose: ${errorMessage(error)}\n\n${USAGE}`);
    return 2;
  }

  if (!options.dxfFile || !options.diagnostic || !options.out) {
    process.stderr.write(
      "tru propose: <pattern.dxf>, --diagnostic, and --out are required.\n\n" + USAGE
    );
    return 2;
  }

  const dxfText = await readFile(options.dxfFile, "utf8");
  const reportText = await readFile(options.diagnostic, "utf8");

  let diagnostics;
  try {
    diagnostics = parseSeamlintReport(JSON.parse(reportText));
  } catch (error) {
    process.stderr.write(`tru propose: could not read Seamlint report: ${errorMessage(error)}\n`);
    return 1;
  }

  const slntCommand = options.slnt ? tokenizeCommand(options.slnt) : resolveSlntCommand();
  const runEdges = createSlntEdgesRunner({ slntCommand, dxfFile: options.dxfFile });

  const file = createProposalFile({
    sourceFile: options.dxfFile,
    sourceText: dxfText,
    diagnostics,
    resolveTarget: resolveTargetNotWired,
    resolveSeamPair: buildResolveSeamPair(runEdges)
  });

  await writeFile(options.out, JSON.stringify(file, null, 2) + "\n", "utf8");
  process.stdout.write(
    `propose: ${file.proposals.length} proposal(s), ${file.skipped.length} skipped -> ${options.out}\n`
  );

  if (options.preview) {
    await writeFile(options.preview, renderProposalPreview(file), "utf8");
    process.stdout.write(`preview: seam overlay -> ${options.preview}\n`);
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
    process.stderr.write("tru apply: まだ実装されていません (書き先が Loomit と未確定 / OPEN)。\n");
    return 1;
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
