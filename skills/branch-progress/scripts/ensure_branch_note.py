from __future__ import annotations

import argparse
import re
import subprocess
from datetime import datetime
from pathlib import Path


INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*]+')


def detect_branch() -> str:
    result = subprocess.run(
        ["git", "branch", "--show-current"],
        check=True,
        capture_output=True,
        text=True,
    )
    branch = result.stdout.strip()
    if not branch:
        raise SystemExit("Unable to resolve the current branch name.")
    return branch


def sanitize_branch_name(branch: str) -> str:
    sanitized = INVALID_FILENAME_CHARS.sub("__", branch.strip())
    sanitized = sanitized.strip(" .")
    if not sanitized:
        raise SystemExit(f"Branch name '{branch}' cannot be converted into a file name.")
    return sanitized


def build_template(branch: str, note_path: Path, timestamp: str) -> str:
    return "\n".join(
        [
            f"# {branch}",
            "",
            f"- Branch: `{branch}`",
            f"- Note File: `{note_path.as_posix()}`",
            f"- Last Updated: {timestamp}",
            "",
            "## Objective",
            "",
            "- [ ] Summarize the goal of this branch.",
            "",
            "## Current Plan",
            "",
            "- [ ] Add the current work plan here.",
            "",
            "## Progress Log",
            "",
            f"- {timestamp} Created branch note.",
            "",
            "## Decisions",
            "",
            "- None yet.",
            "",
            "## Risks or Blockers",
            "",
            "- None noted.",
            "",
            "## Next Handoff",
            "",
            "1. Fill in the objective.",
            "2. Update the current plan before deeper work.",
            "3. Append progress entries as work moves.",
            "",
        ]
    )


def format_timestamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="minutes")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Create docs/branch/<branch>.md if it does not exist."
    )
    parser.add_argument("--branch", help="Branch name override. Defaults to the current git branch.")
    parser.add_argument(
        "--docs-root",
        default="docs/branch",
        help="Directory that stores branch notes. Defaults to docs/branch.",
    )
    args = parser.parse_args()

    branch = args.branch or detect_branch()
    docs_root = Path(args.docs_root)
    docs_root.mkdir(parents=True, exist_ok=True)

    note_name = f"{sanitize_branch_name(branch)}.md"
    note_path = docs_root / note_name

    if note_path.exists():
        print(note_path.as_posix())
        return 0

    timestamp = format_timestamp()
    note_path.write_text(build_template(branch, note_path, timestamp), encoding="utf-8")
    print(note_path.as_posix())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
