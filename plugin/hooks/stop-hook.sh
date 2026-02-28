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
  # Check if session had substantive code changes (Edit, Write, NotebookEdit tool calls)
  HAS_EDITS=$(grep -c '"Edit"\|"Write"\|"NotebookEdit"' "$TRANSCRIPT_PATH" 2>/dev/null) || HAS_EDITS=0

  # Check if Twining decision/recording tools were used
  HAS_TWINING=$(grep -c 'twining_decide\|twining_post\|twining_verify\|twining_handoff' "$TRANSCRIPT_PATH" 2>/dev/null) || HAS_TWINING=0

  if [[ "$HAS_EDITS" -gt 0 ]] && [[ "$HAS_TWINING" -eq 0 ]]; then
    DECISION="block"
    REASON="This session made code changes but no Twining decisions or findings were recorded. Before ending, please: 1) Record any architectural or implementation decisions with twining_decide. 2) Post findings or status with twining_post. 3) If work is unfinished, create a handoff with twining_handoff. 4) Run twining_verify to check completeness."
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
