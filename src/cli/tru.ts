#!/usr/bin/env node
// Truer CLI entry. Milestone 0 wires up `--help` and command dispatch; `propose`
// and `apply` are implemented in later milestones. The CLI layer owns argument
// parsing, file IO, stdout/stderr, and exit status — core stays pure.

const USAGE = `tru — Truer CLI (MVP)

Usage:
  tru propose <pattern.dxf> --diagnostic <report.json> --out <proposal.json> --preview <preview.svg>
  tru apply   <pattern.dxf> --proposal <proposal.json> --accepted <id...> --out <out>

Commands:
  propose   Seamlint 診断 (DXF) から補正案 (proposal) と preview を作る。source は書き換えない。
  apply     採用された proposal だけを --out に適用する (書き先は Loomit と未確定 / OPEN)。

Options:
  -h, --help   Show this help.

Status: Milestone 0 shell. propose / apply are not implemented yet.
`;

async function main(argv: string[]): Promise<number> {
  const [command] = argv;

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === "propose" || command === "apply") {
    process.stderr.write(`tru ${command}: まだ実装されていません (Milestone 0)。\n`);
    return 1;
  }

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`tru: unexpected error: ${message}\n`);
    process.exitCode = 1;
  }
);
