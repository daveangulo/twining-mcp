#!/bin/bash
# Twining Stop Hook — blocks session exit when THIS session made file edits
# that were never recorded via twining_record.
#
# Marker-based since plugin 1.16.0 (#43). The 1.10.0–1.15.x implementation
# compared the record sentinel against the newest mtime of dirty working-tree
# files — a leaky proxy that false-blocked recurringly in the field:
# concurrent agent worktrees bump untracked-directory mtimes after you
# record (unwinnable race), touch/checkout/formatters bump mtimes without
# recordable work, and the alphabetical `head -200` cap on large dirty sets
# hid real work while surfacing noise. mtime had already been rejected once
# (decision 01KQWCCVTV, 2026-05-05) before being reintroduced.
#
# Now: the PostToolUse activity-marker hook writes epoch-seconds to
# .twining/.sessions/<session_id> on every successful Edit/Write. This hook
# blocks only when that marker — this session's own last file edit — is
# newer than .twining/.last-record. No git scan, no mtime scan, and other
# sessions' activity can never block this one.
#
# Fail-open by design: no .twining/, no sentinel ever written (fresh clone /
# server down), no session_id, or no marker (read-only session, Bash-only
# edits, pre-1.16 session) — all allow silently. Bash-driven edits the
# marker misses are still gated at commit time by the pre-commit hook. A
# coordination gate must never be the reason a session cannot end.
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

# This session's activity marker. Sanitization MUST mirror
# activity-marker-hook.sh exactly, or the two scripts derive different
# filenames for the same session.
SESSION_ID=""
if [[ "$HOOK_INPUT" =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  SESSION_ID="${BASH_REMATCH[1]}"
fi
SESSION_ID="${SESSION_ID//[^A-Za-z0-9._-]/}"
while [[ "$SESSION_ID" == .* ]]; do SESSION_ID="${SESSION_ID#.}"; done
[[ -z "$SESSION_ID" ]] && exit 0

MARKER="$TWINING_DIR/.sessions/$SESSION_ID"
[[ ! -f "$MARKER" ]] && exit 0

LAST_RECORD=0
raw=$(cat "$SENTINEL" 2>/dev/null || true)
raw="${raw//[^0-9]/}"
[[ -n "$raw" ]] && LAST_RECORD="$raw"

LAST_EDIT=0
raw=$(cat "$MARKER" 2>/dev/null || true)
raw="${raw//[^0-9]/}"
[[ -n "$raw" ]] && LAST_EDIT="$raw"
[[ "$LAST_EDIT" -eq 0 ]] && exit 0

# Recorded at or after this session's last edit — allow. (>= tolerates
# same-second record-then-stop batching.)
if (( LAST_RECORD >= LAST_EDIT )); then
  exit 0
fi

printf '{"decision":"block","reason":"This session edited files after the last twining_record. Call twining_record before ending — what changed, choices you made, and any findings, warnings, or surprises worth leaving for the next session."}\n'
exit 0
