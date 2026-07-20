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

# Since plugin 1.13.0 the bundled server spawns through a login shell
# (`sh -lc`), so PATH-minimal session spawns (agent teammate / GUI launch)
# still resolve npx from the user's shell profile. Mirror that exact
# resolution here: only when even a login shell can't find npx is the server
# genuinely absent. Gates would be unsatisfiable; warn instead (fail open).
if ! sh -lc 'command -v npx' >/dev/null 2>&1; then
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Twining MCP server unavailable\n\n`npx` is not resolvable even from a login shell, so the twining stdio server could not start and twining tools are absent. Install Node.js >= 22.13 (or fix the PATH exported by your shell profile). Twining gates do NOT apply to this session; note key decisions in your final summary for a connected session to record."}}
JSON
  exit 0
fi

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Coordination — Twining Lifecycle Gates\n\nTwining MCP tools are available. Two BLOCKING gates for tasks involving code exploration, modification, or architectural decisions:\n\nGate 1 — Context Assembly (BEFORE any work): call `twining_assemble` with the task description and the narrowest scope (e.g. `src/auth/`, not `project`) before reading code or making changes; call `twining_why` on files you intend to modify.\n\nGate 2 — Record (BEFORE committing or ending): call `twining_record` before every git commit and before ending the session — hooks enforce this. Include what you did (summary) and choices you made (decisions, as natural sentences: \"Chose X over Y — reason\"). Record findings, warnings, and surprises as you go via `twining_post` — they are what make the blackboard useful to the next session.\n\nRun `twining_housekeeping({})` at the start of long sessions (preview is safe)."}}
JSON
