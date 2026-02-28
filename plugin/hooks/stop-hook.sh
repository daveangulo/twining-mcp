#!/bin/bash
# Twining Stop Hook — blocks session exit when code changes lack Twining recording
# Uses command type for reliable JSON output (prompt type is unreliable for Stop hooks)
# No external dependencies — pure bash + grep only
set -euo pipefail

# Read hook input from stdin
HOOK_INPUT=$(cat)

# Extract transcript_path without jq — match "transcript_path":"<value>"
TRANSCRIPT_PATH=""
if [[ "$HOOK_INPUT" =~ \"transcript_path\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  TRANSCRIPT_PATH="${BASH_REMATCH[1]}"
fi

DECISION="approve"
REASON="Session complete"

if [[ -n "$TRANSCRIPT_PATH" ]] && [[ -f "$TRANSCRIPT_PATH" ]]; then
  # Find line number of last code change (Edit, Write, NotebookEdit tool calls)
  LAST_EDIT=$(grep -n '"Edit"\|"Write"\|"NotebookEdit"' "$TRANSCRIPT_PATH" 2>/dev/null | tail -1 | cut -d: -f1) || LAST_EDIT=0
  LAST_EDIT=${LAST_EDIT:-0}

  # Find line number of last Twining recording tool call
  LAST_TWINING=$(grep -n 'twining_decide\|twining_post\|twining_verify\|twining_handoff' "$TRANSCRIPT_PATH" 2>/dev/null | tail -1 | cut -d: -f1) || LAST_TWINING=0
  LAST_TWINING=${LAST_TWINING:-0}

  # Block if code changes exist after the last Twining recording
  if [[ "$LAST_EDIT" -gt 0 ]] && [[ "$LAST_EDIT" -gt "$LAST_TWINING" ]]; then
    DECISION="block"
    REASON="Code changes detected after last Twining recording. Before ending, please: 1) Record any architectural or implementation decisions with twining_decide. 2) Post findings or status with twining_post. 3) If work is unfinished, create a handoff with twining_handoff. 4) Run twining_verify to check completeness."
  fi
fi

# Output JSON using printf — no jq dependency
# Values are safe (no user input, no special chars needing escaping)
if [[ "$DECISION" = "block" ]]; then
  printf '{"decision":"block","reason":"%s","systemMessage":"Twining housekeeping required — code changes detected without decision recording"}\n' "$REASON"
else
  printf '{"decision":"approve","reason":"Session complete"}\n'
fi

exit 0
