#!/bin/bash
# Twining SubagentStop Hook — posts a status entry when a subagent completes
# Safety net: if the orchestrator forgets coordination, at least a status entry is recorded
# No external dependencies — pure bash only
set -euo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0

# Read hook input from stdin (contains agent_id, transcript_path, etc.)
HOOK_INPUT=$(cat)

# Try agent_type, agent_name, description in order — first match wins
AGENT_LABEL=""
for FIELD in agent_type agent_name description; do
  if [[ "$HOOK_INPUT" =~ \"$FIELD\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    AGENT_LABEL="${BASH_REMATCH[1]}"
    break
  fi
done
# No identity extracted — silence beats "unknown-subagent" noise
[[ -z "$AGENT_LABEL" ]] && exit 0

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
# lock this hook cannot take; pending-posts.jsonl is the unlocked drop
# box the server drains on startup, posting each line through the store.
printf '{"entry_type":"status","summary":"Subagent completed: %s","detail":"","scope":"project","agent_id":"%s","tags":["subagent-stop","hook-generated"]}\n' \
  "$AGENT_LABEL" \
  "$AGENT_LABEL" \
  >> "$TWINING_DIR/pending-posts.jsonl"

exit 0
