#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

function runGit(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function resolveBranchNotePath(repoRoot, branchName) {
  const segments = branchName.split("/").filter(Boolean);

  if (segments.length === 0) {
    throw new Error("Current branch name is empty.");
  }

  const fileName = `${segments[segments.length - 1]}.md`;
  return path.join(repoRoot, "docs", "branch", ...segments.slice(0, -1), fileName);
}

function buildTemplate(branchName, today) {
  return `# Branch Worklog: \`${branchName}\`

## Goal

Inferred from local context until confirmed by the user.

## Plan

- [ ] Confirm or refine the branch goal from the current diff and docs.
- [ ] Complete the next implementation step and update related tests or docs.
- [ ] Record validation results before handing off.

## Progress

- ${today}: Created this branch worklog.

## Open Questions

- None yet.

## Validation

- Not run yet.

## Next Handoff

Resume from the first unchecked plan item and update this note before ending the next session.
`;
}

const repoRoot = runGit(["rev-parse", "--show-toplevel"]);
const branchName = runGit(["branch", "--show-current"]);

if (!branchName) {
  throw new Error("Git returned an empty branch name. Detached HEAD is not supported.");
}

const notePath = resolveBranchNotePath(repoRoot, branchName);
const noteDir = path.dirname(notePath);
const today = new Date().toISOString().slice(0, 10);
const existed = existsSync(notePath);

mkdirSync(noteDir, { recursive: true });

if (!existed) {
  writeFileSync(notePath, buildTemplate(branchName, today), "utf8");
}

console.log(
  JSON.stringify(
    {
      branch: branchName,
      created: !existed,
      path: notePath
    },
    null,
    2
  )
);
