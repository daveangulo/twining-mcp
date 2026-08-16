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

# Only act in twining-managed projects.
# Resolve the twining store. This block is mirrored across
# session-start-context.sh, pre-commit-hook.sh, stop-hook.sh,
# activity-marker-hook.sh, and subagent-stop-hook.sh (verbatim there; THIS
# copy adds only the MARKER_SCOPE_ROOT/MARKER_IN_WORKTREE assignments for
# the edit-path filter below), and matches the
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
MARKER_SCOPE_ROOT=""
MARKER_IN_WORKTREE=false
if [[ -n "${TWINING_PROJECT:-}" ]]; then
  PROJECT_ROOT="$TWINING_PROJECT"
  [[ "$PROJECT_ROOT" != /* ]] && PROJECT_ROOT="$(pwd)/$PROJECT_ROOT"
  [[ -d "$PROJECT_ROOT/.twining" ]] && TWINING_DIR="$PROJECT_ROOT/.twining"
  MARKER_SCOPE_ROOT="$PROJECT_ROOT"
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
          MARKER_SCOPE_ROOT="$DIR"
          MARKER_IN_WORKTREE=true
          break
        fi
      fi
    fi
    if [[ -d "$DIR/.twining" ]]; then
      TWINING_DIR="$DIR/.twining"
      MARKER_SCOPE_ROOT="$DIR"
      break
    fi
    DIR="$(dirname "$DIR")"
  done
fi
[[ -z "$TWINING_DIR" ]] && exit 0

# Edit-path filter (2026-08-16): stamp only for edits that belong to THIS
# store's project. Without it the marker fired on auto-memory writes under
# ~/.claude and on in-process subagents editing isolated worktrees under
# .claude/worktrees/ (both carry the controller's session_id), producing
# false Gate-2 stop-blocks. A session RUNNING IN a linked worktree stamps
# for edits under its own worktree root — its work records to the shared
# store. Absent or unparseable file_path falls through to stamping: fail
# toward gate integrity; the pre-commit hook still gates commits.
FILE_PATH=""
if [[ "$HOOK_INPUT" =~ \"file_path\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  FILE_PATH="${BASH_REMATCH[1]}"
elif [[ "$HOOK_INPUT" =~ \"notebook_path\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
  FILE_PATH="${BASH_REMATCH[1]}"
fi
if [[ -n "$FILE_PATH" && -n "$MARKER_SCOPE_ROOT" ]]; then
  [[ "$FILE_PATH" != /* ]] && FILE_PATH="$(pwd)/$FILE_PATH"
  case "$FILE_PATH" in
    "$MARKER_SCOPE_ROOT"/.claude/worktrees/*)
      # A subagent's isolated tree — not this session's recordable work.
      [[ "$MARKER_IN_WORKTREE" == true ]] || exit 0
      ;;
    "$MARKER_SCOPE_ROOT"/*)
      : # inside the project — recordable
      ;;
    *)
      exit 0 # outside the project (auto-memory, scratchpad, other repos)
      ;;
  esac
fi

mkdir -p "$TWINING_DIR/.sessions" 2>/dev/null || exit 0
date +%s > "$TWINING_DIR/.sessions/$SESSION_ID" 2>/dev/null || true
exit 0
