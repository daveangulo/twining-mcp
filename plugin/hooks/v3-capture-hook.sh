#!/bin/bash
# Twining v3 capture hook — one script for every capture/inject event.
#
# The host passes its event JSON on stdin; this script pipes it to
# `twining hook <host> <EventName>`, which does ALL the work (parse, hash,
# sign, append, render, receipt) and prints the host's JSON response.
#
# This script deliberately contains no JSON handling of its own. Both hook
# defects this project has shipped were bash string handling, and a capture
# hook now has to hash bytes and sign an event — things bash cannot do at all.
# Its entire job is: find the store, find the CLI, pipe, never fail.
#
# ARGUMENTS: $1 = host (claude-code|codex), $2 = event name.
# EXIT: always 0. STDOUT: only what the CLI printed.
set -uo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0

HOST="${1:-claude-code}"
EVENT="${2:-}"
[[ -z "$EVENT" ]] && exit 0

HOOK_INPUT=$(cat)

# Resolve the twining store. This block is mirrored VERBATIM across
# session-start-context.sh, pre-commit-hook.sh, stop-hook.sh,
# activity-marker-hook.sh, and subagent-stop-hook.sh, and matches the
# server's resolution (src/utils/project-root.ts): TWINING_PROJECT
# (explicit targeting; relative paths resolve against cwd) wins and is
# never worktree-redirected. Otherwise walk up from cwd; when a candidate
# root is a linked git worktree (.git is a regular FILE whose gitdir points
# at <main>/.git/worktrees/<name>), share the main checkout's .twining —
# but only when it already exists (hook-side fail-open guard, stricter than
# the server's, which may create the store fresh). Submodule gitdirs
# (".git/modules/...") never redirect. A linked-worktree root is always a
# walk BOUNDARY: when redirection is off (TWINING_WORKTREE_LOCAL=true) or
# the main checkout has no .twining, bind the worktree's own .twining if
# present and stop — never walk past the worktree into an ancestor's
# store, which the server (resolving from cwd) would never bind.
TWINING_DIR=""
if [[ -n "${TWINING_PROJECT:-}" ]]; then
  PROJECT_ROOT="$TWINING_PROJECT"
  [[ "$PROJECT_ROOT" != /* ]] && PROJECT_ROOT="$(pwd)/$PROJECT_ROOT"
  [[ -d "$PROJECT_ROOT/.twining" ]] && TWINING_DIR="$PROJECT_ROOT/.twining"
else
  DIR="$(pwd)"
  while [[ "$DIR" != "/" ]]; do
    if [[ -f "$DIR/.git" ]]; then
      GITDIR=""
      IFS= read -r GITDIR < "$DIR/.git" || true
      if [[ "$GITDIR" == "gitdir: "* ]]; then
        GITDIR="${GITDIR#gitdir: }"
        GITDIR="${GITDIR%$'\r'}"
        [[ "$GITDIR" != /* ]] && GITDIR="$DIR/$GITDIR"
        if [[ "$GITDIR" == */.git/worktrees/?* ]]; then
          MAIN_ROOT="${GITDIR%/.git/worktrees/*}"
          if [[ "${TWINING_WORKTREE_LOCAL:-}" != "true" && -n "$MAIN_ROOT" &&
                -d "$MAIN_ROOT/.twining" ]]; then
            TWINING_DIR="$MAIN_ROOT/.twining"
          elif [[ -d "$DIR/.twining" ]]; then
            TWINING_DIR="$DIR/.twining"
          fi
          break
        fi
      fi
    fi
    if [[ -d "$DIR/.twining" ]]; then
      TWINING_DIR="$DIR/.twining"
      break
    fi
    DIR="$(dirname "$DIR")"
  done
fi
[[ -z "$TWINING_DIR" ]] && exit 0

# Only act on a v3-enabled store. On a 2.x store the existing hooks are the
# whole mechanism and this one must be invisible — no output, no events, no
# behavior change. store.json with "format": 3 is the single switch.
STORE_JSON="$TWINING_DIR/store.json"
[[ -f "$STORE_JSON" ]] || exit 0
grep -q '"format"[[:space:]]*:[[:space:]]*3' "$STORE_JSON" 2>/dev/null || exit 0

# The store the CLI must bind is the one we just resolved — pass it explicitly
# rather than letting the CLI re-resolve from a cwd that may differ.
PROJECT_DIR="$(dirname "$TWINING_DIR")"

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || HOOK_DIR=""
LAUNCHER="$HOOK_DIR/../scripts/launch-cli.sh"
[[ -n "$HOOK_DIR" && -f "$LAUNCHER" ]] || exit 0

# Session and turn come from the ADAPTER, not the model: the host gave them to
# this hook, and the CLI reads them from the environment. A model cannot forge
# producer.principal (that is the host key) — at most it mislabels its own
# events.
SESSION_ID=""
if [[ "$HOOK_INPUT" =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  SESSION_ID="${BASH_REMATCH[1]}"
fi
TURN_ID=""
if [[ "$HOOK_INPUT" =~ \"(prompt_id|turn_id)\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  TURN_ID="${BASH_REMATCH[2]}"
fi

# `|| true` on the pipeline: a non-zero exit from the CLI must never surface as
# a hook failure. Stderr is left attached so diagnostics reach the host's debug
# log without entering the model's context.
printf '%s' "$HOOK_INPUT" | TWINING_SESSION_ID="$SESSION_ID" TWINING_TURN_ID="$TURN_ID" \
  sh "$LAUNCHER" hook "$HOST" "$EVENT" --project "$PROJECT_DIR" || true

exit 0
