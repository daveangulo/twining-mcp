#!/bin/bash
# Twining Activity Marker Hook (PostToolUse: Edit|Write|MultiEdit|NotebookEdit)
#
# Writes epoch-seconds to .twining/.sessions/<session_id> on every successful
# file-editing tool call. The stop hook (#43) compares this marker against the
# record sentinel to decide whether THIS session did recordable work — the
# signal the old dirty-file-mtime scan only approximated (and false-blocked
# on: concurrent agent worktrees bumping directory mtimes, formatter touches,
# and alphabetical head-cap truncation of large dirty sets).
#
# Fail-open and silent by design: any missing input, missing .twining/, or
# write failure exits 0 with no output. This hook must never slow down or
# fail an edit.
set -euo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0

HOOK_INPUT=$(cat)

# Extract session_id (string field) with bash regex — no external deps.
SESSION_ID=""
if [[ "$HOOK_INPUT" =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  SESSION_ID="${BASH_REMATCH[1]}"
fi
# Sanitize: marker filename must not escape .sessions/ (path traversal).
# Slashes are removed by the character allowlist; leading dots are stripped
# so "." / ".." can never be the filename.
SESSION_ID="${SESSION_ID//[^A-Za-z0-9._-]/}"
while [[ "$SESSION_ID" == .* ]]; do SESSION_ID="${SESSION_ID#.}"; done
[[ -z "$SESSION_ID" ]] && exit 0

# Only act in twining-managed projects (walk up from cwd).
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

mkdir -p "$TWINING_DIR/.sessions" 2>/dev/null || exit 0
date +%s > "$TWINING_DIR/.sessions/$SESSION_ID" 2>/dev/null || true
exit 0
