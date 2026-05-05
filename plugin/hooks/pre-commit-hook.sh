#!/bin/bash
# Twining PreToolUse Hook — enforces decision recording before git commit
# Fires on Bash tool calls, checks if it's a git commit, and verifies
# that twining_decide or twining_post was called since the last commit.
# No external dependencies — pure bash + grep only
set -euo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0

# Read hook input from stdin
HOOK_INPUT=$(cat)

# Extract the command being run
COMMAND=""
if [[ "$HOOK_INPUT" =~ \"command\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  COMMAND="${BASH_REMATCH[1]}"
fi

# Only check git commit commands
if [[ -z "$COMMAND" ]] || ! echo "$COMMAND" | grep -q 'git commit'; then
  # Not a git commit — allow silently (no JSON output = allow)
  exit 0
fi

# Skip if this is an amend (likely fixing a prior commit, not new work)
if echo "$COMMAND" | grep -q '\-\-amend'; then
  exit 0
fi

# Extract transcript path
TRANSCRIPT_PATH=""
if [[ "$HOOK_INPUT" =~ \"transcript_path\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  TRANSCRIPT_PATH="${BASH_REMATCH[1]}"
fi

if [[ -z "$TRANSCRIPT_PATH" ]] || [[ ! -f "$TRANSCRIPT_PATH" ]]; then
  # No transcript available — allow (don't break commits)
  exit 0
fi

# Find last git commit in transcript (previous commits in this session)
LAST_COMMIT=$(grep -n 'git commit' "$TRANSCRIPT_PATH" 2>/dev/null | grep -v 'git commit.*--amend' | tail -1 | cut -d: -f1) || LAST_COMMIT=0
LAST_COMMIT=${LAST_COMMIT:-0}

# Find last Twining recording call (record, decide, or post) in transcript
LAST_TWINING=$(grep -n 'twining_record\|twining_decide\|twining_post' "$TRANSCRIPT_PATH" 2>/dev/null | tail -1 | cut -d: -f1) || LAST_TWINING=0
LAST_TWINING=${LAST_TWINING:-0}

# Allow if Twining recording happened after the last commit (or no prior commits)
if [[ "$LAST_TWINING" -gt "$LAST_COMMIT" ]]; then
  exit 0
fi

# Block — no Twining recording since last commit
printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Call twining_record before committing — summarize what you did and any choices you made."}}\n'
exit 0
