#!/bin/bash
# Twining SubagentStop Hook — posts a status entry when a subagent completes
# Safety net: if the orchestrator forgets coordination, at least a status entry is recorded
# No external dependencies — pure bash only
set -euo pipefail

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

# Append a pending status post to the blackboard
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
AGENT_LABEL="${AGENT_TYPE:-unknown-subagent}"

# Write directly to blackboard.jsonl — same format as BlackboardStore
# Use a simple entry that the orchestrator can see
printf '{"id":"hook-%s","entry_type":"status","summary":"Subagent completed: %s","detail":"","scope":"project","agent_id":"%s","tags":["subagent-stop","hook-generated"],"timestamp":"%s","supersedes":null,"dismissed":false}\n' \
  "$(date +%s%N | cut -c1-13)" \
  "$AGENT_LABEL" \
  "$AGENT_LABEL" \
  "$TIMESTAMP" \
  >> "$TWINING_DIR/blackboard.jsonl"

exit 0
