#!/bin/bash
# Twining SubagentStop Hook — posts a status entry when a subagent completes
# Safety net: if the orchestrator forgets coordination, at least a status entry is recorded
# No external dependencies — pure bash only
set -euo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0

# Read hook input from stdin (contains agent_id, transcript_path, etc.)
HOOK_INPUT=$(cat)

# Extract agent type/description from hook input
AGENT_TYPE=""
if [[ "$HOOK_INPUT" =~ \"agent_type\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  AGENT_TYPE="${BASH_REMATCH[1]}"
fi

# Find .twining directory — walk up from cwd
TWINING_DIR=""
DIR="$(pwd)"
while [[ "$DIR" != "/" ]]; do
  if [[ -d "$DIR/.twining" ]]; then
    TWINING_DIR="$DIR/.twining"
    break
  fi
  DIR="$(dirname "$DIR")"
done

# If no .twining directory found, nothing to do
if [[ -z "$TWINING_DIR" ]]; then
  exit 0
fi

# Queue a pending status post for the MCP server's PendingProcessor.
# Never write blackboard.jsonl directly — the server writes it under a
# lock this hook cannot take, so a raw append can interleave with a
# concurrent server write and corrupt lines. pending-posts.jsonl is the
# designated unlocked drop box: the server drains it on startup and posts
# each line through the locked store path.
AGENT_LABEL="${AGENT_TYPE:-unknown-subagent}"

printf '{"entry_type":"status","summary":"Subagent completed: %s","detail":"","scope":"project","agent_id":"%s","tags":["subagent-stop","hook-generated"]}\n' \
  "$AGENT_LABEL" \
  "$AGENT_LABEL" \
  >> "$TWINING_DIR/pending-posts.jsonl"

exit 0
