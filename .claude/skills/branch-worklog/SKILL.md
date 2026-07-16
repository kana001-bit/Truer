---
name: branch-worklog
description: Create and maintain a per-branch status note at `docs/branch/<branch>.md` with the current goal, plan, progress log, open questions, validation, and handoff steps. Use when starting or resuming a git branch, when the user asks to capture plan or progress, or when work should survive session or AI handoffs. Not for Truer implementation rules themselves (use truer-implementation) or for long-running, cross-branch task specs that separate confirmed vs unconfirmed facts (use task-spec-manager); this skill covers per-branch working notes only.
---

# Branch Worklog

Keep one branch note as the shared working memory for the current git branch. Use it to lower restart cost across sessions and across different agents.

## Workflow

1. Run `node ./.claude/skills/branch-worklog/scripts/ensure_branch_note.mjs` from the repository root. It resolves the current branch, creates the note if it does not exist, and prints the resolved path.
2. Open the printed `docs/branch/<branch>.md` and keep it current while you work.
3. Update the note again before you stop, hand off, or switch tasks.

Slash-separated branch names become nested folders under `docs/branch/` (e.g. `feature/curve-kink-apply` -> `docs/branch/feature/curve-kink-apply.md`). If Git is detached or the branch name is empty, stop and ask instead of guessing.

## Required Sections

- `Goal`
- `Plan`
- `Progress`
- `Open Questions`
- `Validation`
- `Next Handoff`

Keep the plan actionable. Prefer checklist items in `Plan` and short dated entries in `Progress`.

## Update Rules

- Update the note when work starts or resumes.
- Update it after meaningful implementation, debugging, review, or research progress.
- Update it whenever the plan materially changes.
- Refresh `Next Handoff` before ending the session.
- Record observable state only: files touched, commands run, decisions made, remaining work, and blockers.
- Do not write hidden reasoning or chain-of-thought into the note.

## Writing Style

- Keep entries brief and concrete.
- Use local dates such as `YYYY-MM-DD`, and exact file paths and branch names over vague summaries.
- When blocked, say what is blocked, what evidence exists, and the next likely recovery step.

## Handoff Goal

Leave the next agent with enough context to continue without rediscovering the branch state from scratch.
