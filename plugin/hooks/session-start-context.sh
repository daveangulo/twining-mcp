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

# PATH-restricted spawn environments (agent-team teammates, GUI-launched
# apps) can lack the directory that holds npx, so the stdio MCP server
# fails to spawn and every twining tool is silently absent. This hook runs
# with the same environment Claude Code used for that spawn, so `command -v`
# here sees exactly what the server spawn saw. Emitting the gates in that
# state would demand tool calls the session cannot make — surface a loud,
# actionable warning instead and suppress the gates (fail open, never block).
if ! command -v npx >/dev/null 2>&1; then
  cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Twining — MCP server unavailable in this session\n\nWARNING: `npx` is not on this session's PATH, so the twining MCP stdio server could not be launched and twining tools are silently absent. This happens when Claude Code is spawned with a minimal environment: agent-team teammates (e.g. cmux split panes), GUI-launched apps, some CI shells.\n\nFix (macOS/Linux): wrap the server command in a login shell so PATH is rebuilt, e.g. in `.mcp.json`: `\"command\": \"sh\", \"args\": [\"-lc\", \"exec npx -y twining-mcp --project .\"]`. Or launch Claude Code from a terminal where `npx` resolves.\n\nThe twining lifecycle gates do NOT apply to this session — do not attempt twining tool calls. Note coordination-relevant decisions in your final summary so a twining-connected session can record them."}}
JSON
  exit 0
fi

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Coordination — Twining Lifecycle Gates\n\nTwining MCP tools are available. Two BLOCKING gates for tasks involving code exploration, modification, or architectural decisions:\n\nGate 1 — Context Assembly (BEFORE any work): call `twining_assemble` with the task description and the narrowest scope (e.g. `src/auth/`, not `project`) before reading code or making changes; call `twining_why` on files you intend to modify.\n\nGate 2 — Record (BEFORE committing or ending): call `twining_record` before every git commit and before ending the session — hooks enforce this. Include what you did (summary) and choices you made (decisions, as natural sentences: \"Chose X over Y — reason\"). Record findings, warnings, and surprises as you go via `twining_post` — they are what make the blackboard useful to the next session.\n\nRun `twining_housekeeping({})` at the start of long sessions (preview is safe)."}}
JSON
