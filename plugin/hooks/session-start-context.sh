#!/bin/bash
# Twining SessionStart Hook (command type)
# Replaces the prompt-type entry that crashed on session resume:
# "ToolUseContext is required for prompt hooks. This is a bug." (issue #8)
#
# Since plugin 1.10.0 this hook is the sole delivery mechanism for the
# lifecycle gates: the ensure-claude-md-gates.sh hook (which appended a gates
# block to the project's CLAUDE.md on SessionStart, issue #9) was removed.
# additionalContext injects the same guidance into every session — including
# resume — without ever mutating user files.
# No external dependencies.
set -euo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0

# Only inject in twining-managed projects (walk up from cwd).
TWINING_DIR=""
DIR="$(pwd)"
while [[ "$DIR" != "/" ]]; do
  if [[ -d "$DIR/.twining" ]]; then
    TWINING_DIR="$DIR/.twining"
    break
  fi
  DIR="$(dirname "$DIR")"
done
[[ -z "$TWINING_DIR" ]] && exit 0

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Coordination — Twining Lifecycle Gates\n\nTwining MCP tools are available. Two BLOCKING gates for tasks involving code exploration, modification, or architectural decisions:\n\nGate 1 — Context Assembly (BEFORE any work): call `twining_assemble` with the task description and the narrowest scope (e.g. `src/auth/`, not `project`) BEFORE reading code or making changes; call `twining_why` on files you intend to modify. Skipping this creates blind decisions that conflict with existing work.\n\nGate 2 — Record (BEFORE committing or ending): call `twining_record` before every git commit and before ending the session — hooks enforce this. Include what you did (summary) and choices you made (decisions, as natural sentences: \"Chose X over Y — reason\"). Also record findings, warnings, and surprises as you encounter them via `twining_post` — these are what make the blackboard useful to the next session, not just the summary.\n\nHousekeeping: run `twining_housekeeping({})` at the start of long sessions to check for stale state (preview is safe)."}}
JSON
