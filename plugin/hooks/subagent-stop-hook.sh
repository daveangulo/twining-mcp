#!/bin/bash
# Twining SubagentStop Hook — posts a status entry when a subagent completes
# Safety net: if the orchestrator forgets coordination, at least a status entry is recorded
# No external dependencies — pure bash only
set -euo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0

# Read hook input from stdin (contains agent_id, transcript_path, etc.)
HOOK_INPUT=$(cat)

# Try agent_type, agent_name, description in order — first match wins
AGENT_LABEL=""
for FIELD in agent_type agent_name description; do
  if [[ "$HOOK_INPUT" =~ \"$FIELD\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
    AGENT_LABEL="${BASH_REMATCH[1]}"
    break
  fi
done
# No identity extracted — silence beats "unknown-subagent" noise
[[ -z "$AGENT_LABEL" ]] && exit 0

# Find the .twining directory.
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

# If no .twining directory found, nothing to do
if [[ -z "$TWINING_DIR" ]]; then
  exit 0
fi

# Queue a pending status post for the MCP server's PendingProcessor.
# Never write blackboard.jsonl directly — the server writes it under a
# lock this hook cannot take; pending-posts.jsonl is the unlocked drop
# box the server drains on startup, posting each line through the store.
printf '{"entry_type":"status","summary":"Subagent completed: %s","detail":"","scope":"project","agent_id":"%s","tags":["subagent-stop","hook-generated"]}\n' \
  "$AGENT_LABEL" \
  "$AGENT_LABEL" \
  >> "$TWINING_DIR/pending-posts.jsonl"

exit 0
