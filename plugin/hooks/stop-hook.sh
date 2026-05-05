#!/bin/bash
# Twining Stop Hook — blocks session exit when code changes lack Twining recording
# Prevents context loss in multi-session workflows.
# Detects whether decisions are needed (architectural changes) vs just a status post.
# No external dependencies — pure bash + grep only
set -euo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0

# Read hook input from stdin
HOOK_INPUT=$(cat)

# Extract transcript_path
TRANSCRIPT_PATH=""
if [[ "$HOOK_INPUT" =~ \"transcript_path\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  TRANSCRIPT_PATH="${BASH_REMATCH[1]}"
fi

if [[ -z "$TRANSCRIPT_PATH" ]] || [[ ! -f "$TRANSCRIPT_PATH" ]]; then
  printf '{"decision":"approve","reason":"Session complete"}\n'
  exit 0
fi

# Check if agent made code changes
LAST_EDIT=$(grep -n '"name":"Edit","input"\|"name":"Write","input"\|"name":"NotebookEdit","input"' "$TRANSCRIPT_PATH" 2>/dev/null | tail -1 | cut -d: -f1) || LAST_EDIT=0
LAST_EDIT=${LAST_EDIT:-0}

# No code changes — nothing to record
if [[ "$LAST_EDIT" -eq 0 ]]; then
  printf '{"decision":"approve","reason":"Session complete"}\n'
  exit 0
fi

# Check if agent already recorded via Twining after last edit
LAST_TWINING=$(grep -n 'twining_record\|twining_decide\|twining_post' "$TRANSCRIPT_PATH" 2>/dev/null | tail -1 | cut -d: -f1) || LAST_TWINING=0
LAST_TWINING=${LAST_TWINING:-0}

# Already recorded — allow
if [[ "$LAST_TWINING" -gt "$LAST_EDIT" ]]; then
  printf '{"decision":"approve","reason":"Session complete"}\n'
  exit 0
fi

# Count edits and new files to gauge complexity
EDIT_COUNT=$(grep -c '"name":"Edit","input"' "$TRANSCRIPT_PATH" 2>/dev/null) || EDIT_COUNT=0
WRITE_COUNT=$(grep -c '"name":"Write","input"' "$TRANSCRIPT_PATH" 2>/dev/null) || WRITE_COUNT=0
TOTAL=$((EDIT_COUNT + WRITE_COUNT))

# Block — ask agent to call twining_record (one tool, one natural sentence)
printf '{"decision":"block","reason":"Call twining_record before ending — summarize what you changed and any choices you made."}\n'

exit 0
