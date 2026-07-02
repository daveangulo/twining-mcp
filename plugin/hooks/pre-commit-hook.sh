#!/bin/bash
# Twining PreToolUse hook — enforces decision recording before `git commit`.
#
# Compares .twining/.last-record (written synchronously by twining_record /
# twining_decide / twining_post) against the HEAD commit timestamp. The
# pre-1.9 implementation grepped the JSONL transcript for "git commit" and
# "twining_record" lines, which produced false blocks from (a) failed-attempt
# command bodies still in the transcript, (b) assistant prose containing
# the literal string "git commit", (c) heredoc commit-message bodies, and
# (d) transcript flush latency when record + commit batched in one model
# turn. See issues #11 and #13 for reproductions.
set -euo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0

HOOK_INPUT=$(cat)

# Parse JSON via node — bash regex extraction (#13) truncates commands
# containing escaped quotes. Node is a hard dep of the MCP server already.
COMMAND=$(node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  try {
    const j = JSON.parse(s);
    const cmd = (j.tool_input && j.tool_input.command) || j.command || "";
    process.stdout.write(cmd);
  } catch {
    process.stdout.write("");
  }
});
' <<<"$HOOK_INPUT" 2>/dev/null) || COMMAND=""

# Empty / unparseable input — allow rather than block on parser failure.
[[ -z "$COMMAND" ]] && exit 0

# Take only the leading clause before the first pipe / && / ; / ||. This
# stops `echo "...git commit..." | pbcopy` and heredocs from triggering (#11 Bug 2).
LEADING=$(printf '%s' "$COMMAND" | sed -E 's/[|;&].*//')

# Token-aware trigger: argv[0] must be exactly `git`, argv[1] exactly `commit`.
# Substring grep would match `git commit-tree`, `git --work-tree=… commit-graph`,
# release-note prose containing the phrase, etc.
read -r CMD0 CMD1 _REST <<<"$LEADING" || true
if [[ "${CMD0:-}" != "git" || "${CMD1:-}" != "commit" ]]; then
  exit 0
fi

# `--amend` is editing an existing commit, not creating new work — skip.
for tok in $LEADING; do
  [[ "$tok" == "--amend" ]] && exit 0
done

# Not a twining-managed project (no .twining/ in cwd) — silent allow so the
# hook doesn't break commits in unrelated repos when the plugin is global.
[[ ! -d ".twining" ]] && exit 0

SENTINEL=".twining/.last-record"

# Fail open when no record sentinel has ever been written in this checkout —
# fresh clone, npm outage, or the MCP server never booted. Blocking here is
# unsatisfiable (the record tools aren't reachable), and a coordination gate
# must never be the reason a commit is impossible. Warn once per attempt so
# the gap is visible; normal gating resumes after the first successful record.
if [[ ! -f "$SENTINEL" ]]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Twining has no record sentinel in this checkout (fresh clone or MCP server unavailable) — allowing the commit. Call twining_record once the server is up."}}\n'
  exit 0
fi

LAST_RECORD=0
raw=$(cat "$SENTINEL" 2>/dev/null || true)
# Strip non-digits to guard against partial writes / corruption.
raw="${raw//[^0-9]/}"
[[ -n "$raw" ]] && LAST_RECORD="$raw"

LAST_COMMIT_TIME=$(git log -1 --format=%ct HEAD 2>/dev/null || true)
LAST_COMMIT_TIME="${LAST_COMMIT_TIME//[^0-9]/}"
LAST_COMMIT_TIME="${LAST_COMMIT_TIME:-0}"

if (( LAST_RECORD > LAST_COMMIT_TIME )); then
  exit 0
fi

printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Call twining_record before committing — summarize what you did and any choices you made."}}\n'
exit 0
