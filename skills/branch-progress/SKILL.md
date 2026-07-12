---
name: branch-progress
description: Create and maintain a per-branch status note at `docs/branch/<branch>.md` with the current objective, plan, progress log, blockers, decisions, and handoff steps. Use when starting or resuming a git branch, when the user asks to capture plan or progress, or when work should survive session or AI handoffs. Not for Truer implementation rules themselves (use truer-implementation) or for long-running, cross-branch task specs that separate confirmed vs unconfirmed facts (use task-spec-manager); this skill covers per-branch working notes only.
---

# Branch Progress

Keep one branch note as the shared working memory for the current git branch. Use it to lower restart cost across sessions and across different agents.

## Workflow

1. Resolve the current branch with `git branch --show-current`.
2. Run `scripts/ensure_branch_note.py` to create the note if it does not already exist.
3. Open `docs/branch/<branch>.md` and keep it current while you work.
4. Update the note again before you stop, hand off, or switch tasks.

If the branch name contains filename-invalid characters such as `/`, the script replaces them with `__` when creating the file. The note should still record the original branch name in the body.

## Required Sections

- `Objective`
- `Current Plan`
- `Progress Log`
- `Decisions`
- `Risks or Blockers`
- `Next Handoff`

Keep the plan actionable. Prefer checklist items in `Current Plan` and short timestamped entries in `Progress Log`.

## Update Rules

- Update the note when work starts or resumes.
- Update it after meaningful implementation, debugging, review, or research progress.
- Update it whenever the plan materially changes.
- Refresh `Next Handoff` before ending the session.
- Record observable state only: files touched, commands run, decisions made, remaining work, and blockers.
- Do not write hidden reasoning or chain-of-thought into the note.

## Writing Style

- Keep entries brief and concrete.
- Use local timestamps such as `YYYY-MM-DD HH:MM +09:00` or ISO local time.
- Prefer exact file paths and branch names over vague summaries.
- When blocked, say what is blocked, what evidence exists, and the next likely recovery step.

## Script

Run the bootstrap script from the repository root:

```powershell
& <python> skills/branch-progress/scripts/ensure_branch_note.py
```

Arguments:

- `--branch <name>` to create or inspect a note for another branch explicitly.
- `--docs-root <path>` to store notes somewhere other than `docs/branch`.

If `python` is not on `PATH`, use the bundled workspace Python runtime that Codex exposes for this environment.

## Handoff Goal

Leave the next agent with enough context to continue without rediscovering the branch state from scratch.
