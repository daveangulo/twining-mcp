#!/bin/bash
# Twining Stop Hook — blocks session exit when uncommitted code changes lack
# a Twining recording.
#
# Transcript-free since plugin 1.10.0. The previous implementation grepped
# the session transcript for tool-call strings — the same technique the
# pre-commit hook abandoned after issues #11/#13: assistant prose mentioning
# "twining_record" counted as a call, and any transcript format drift broke
# detection silently. This version compares the record sentinel
# (.twining/.last-record, written synchronously by the recording tools)
# against the newest mtime of dirty files in the working tree.
#
# Fail-open by design: no .twining/, no sentinel ever written (fresh clone /
# server down), no git, or clean tree — all allow silently. A coordination
# gate must never be the reason a session cannot end.
set -euo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0

HOOK_INPUT=$(cat)

# Never re-block a continuation of an earlier block — avoids infinite loops.
if [[ "$HOOK_INPUT" =~ \"stop_hook_active\"[[:space:]]*:[[:space:]]*true ]]; then
  exit 0
fi

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

# No sentinel ever written here — the server never recorded in this checkout
# (fresh clone, npm outage, server crash). Blocking would be unsatisfiable.
SENTINEL="$TWINING_DIR/.last-record"
[[ ! -f "$SENTINEL" ]] && exit 0

LAST_RECORD=0
raw=$(cat "$SENTINEL" 2>/dev/null || true)
raw="${raw//[^0-9]/}"
[[ -n "$raw" ]] && LAST_RECORD="$raw"

# Newest mtime among dirty (modified/added/untracked, non-ignored) files.
# .twining/ itself is excluded — recording writes .twining files, which would
# otherwise race the sentinel timestamp across a second boundary.
PROJECT_ROOT="$(dirname "$TWINING_DIR")"
NEWEST=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  f="${line:3}"
  [[ "$f" == *" -> "* ]] && f="${f##* -> }"
  f="${f%\"}"; f="${f#\"}"
  [[ "$f" == .twining || "$f" == .twining/* ]] && continue
  p="$PROJECT_ROOT/$f"
  [[ -e "$p" ]] || continue
  m=$(stat -c %Y "$p" 2>/dev/null || stat -f %m "$p" 2>/dev/null || echo 0)
  m="${m//[^0-9]/}"
  [[ -n "$m" ]] && (( m > NEWEST )) && NEWEST="$m"
done < <(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null | head -200)

# Clean tree or git unavailable — committed work was already gated by the
# pre-commit hook; nothing uncommitted to record.
[[ "$NEWEST" -eq 0 ]] && exit 0

# Recorded at or after the newest change — allow. (>= tolerates same-second
# record-then-stop batching.)
if (( LAST_RECORD >= NEWEST )); then
  exit 0
fi

printf '{"decision":"block","reason":"Uncommitted changes are newer than the last twining_record. Call twining_record before ending — what changed, choices you made, and any findings, warnings, or surprises worth leaving for the next session."}\n'
exit 0
