#!/bin/bash
# Twining SessionStart Hook (command type)
# Replaces the prompt-type entry that crashed on session resume:
# "ToolUseContext is required for prompt hooks. This is a bug." (issue #8)
#
# Emits a single-line JSON envelope so Claude Code injects the gate reminder
# into context at the start of every session, including resume events.
# No external dependencies.
set -euo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Twining MCP tools are available. Two gates: (1) `twining_assemble` FIRST — before reading code. (2) `twining_record` LAST — before committing or ending. See CLAUDE.md \"Twining Lifecycle Gates\" for details."}}
JSON
