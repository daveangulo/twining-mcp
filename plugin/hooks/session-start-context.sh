#!/bin/bash
# Twining SessionStart Hook (command type)
# Replaces the prompt-type entry that crashed on session resume:
# "ToolUseContext is required for prompt hooks. This is a bug." (issue #8)
#
# Since plugin 1.10.0 this hook is the sole delivery mechanism for the
# lifecycle gates: the ensure-claude-md-gates.sh hook (which appended a gates
# block to the project's CLAUDE.md on SessionStart, issue #9) was removed.
# additionalContext injects the same guidance into every session — including
# resume — without ever mutating user files.
# No external dependencies.
set -euo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0

# Only inject in twining-managed projects.
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

# Prune stale session activity markers (#43) — written by the PostToolUse
# activity-marker hook, read by the stop hook. Old markers are dead sessions;
# best-effort, never fails the hook.
if [[ -d "$TWINING_DIR/.sessions" ]]; then
  find "$TWINING_DIR/.sessions" -type f -mtime +7 -delete 2>/dev/null || true
fi

# The bundled server spawns through plugin/scripts/launch-server.sh, which
# recovers the login-shell PATH itself (rung cascade: override -> pin ->
# npx -> npm-prefix -> global -> bundled). Probe the SAME
# launcher here to mirror the server spawn exactly: only when the launcher
# resolves no runner is the server genuinely absent. Gates would be
# unsatisfiable then; warn instead (fail open). The warning must carry the
# TWINING_DISABLED escape hatch — in a previously-initialized checkout the
# pre-commit gate still blocks `git commit` even with the server down.
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || HOOK_DIR=""
LAUNCHER="$HOOK_DIR/../scripts/launch-server.sh"

RUNNER="none"
NODE_V="none"
if [[ -n "$HOOK_DIR" && -f "$LAUNCHER" ]]; then
  # Probe-line contract (see launch-server.sh — never change its shape):
  #   runner=<override|pin|npx|npm-prefix|global|bundled|none> node=<version|none>
  PROBE="$(sh -lc "\"$LAUNCHER\" --probe" 2>/dev/null || true)"
  # Login-shell profiles may echo to stdout ahead of the probe output; the
  # probe line is always the LAST line of the substitution, so keep only it.
  PROBE="${PROBE##*$'\n'}"
  if [[ "$PROBE" == runner=*" node="* ]]; then
    RUNNER="${PROBE#runner=}"
    RUNNER="${RUNNER%% *}"
    NODE_V="${PROBE##*node=}"
    if [[ "$NODE_V" != "none" ]]; then
      # Versions match ^v[0-9.]+$; strip anything else so the interpolation
      # into the JSON payload below stays JSON-safe.
      NODE_V="${NODE_V//[^v0-9.]/}"
      [[ -n "$NODE_V" ]] || NODE_V="none"
    fi
  fi
elif sh -lc 'command -v npx' >/dev/null 2>&1; then
  # Partially-updated install (hook present, launcher missing): fall back to
  # the pre-launcher login-shell npx check so the hook never crashes.
  RUNNER="npx"
fi

if [[ "$RUNNER" == "none" ]]; then
  if [[ "$NODE_V" != "none" ]]; then
    # npm-less Node distribution (Debian/Ubuntu 'apt install nodejs', Alpine,
    # Amazon Linux): node runs but nothing can execute npm packages.
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Twining MCP server unavailable\\n\\nNode.js %s is installed but no npm/npx was found — this Node.js distribution ships without npm (common with Debian/Ubuntu '\''apt install nodejs'\'', Alpine, Amazon Linux). Fix: install npm via the system package manager or reinstall Node.js from https://nodejs.org, then restart Claude Code or run /mcp to reconnect. Until fixed twining tools are absent, and in a previously-initialized checkout the commit gate WILL still block `git commit` — prefix commits with `TWINING_DISABLED=true git commit ...` — and note key decisions in your final summary for a connected session to record."}}\n' "$NODE_V"
  else
    cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Twining MCP server unavailable\n\n`npx` is not resolvable even from a login shell, so the twining stdio server could not start and twining tools are absent. Install Node.js >= 22.13 (or fix the PATH exported by your shell profile). In a previously-initialized checkout the commit gate WILL still block `git commit` — prefix commits with `TWINING_DISABLED=true git commit ...` — and note key decisions in your final summary for a connected session to record."}}
JSON
  fi
  exit 0
fi

cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Coordination — Twining Lifecycle Gates\n\nTwining MCP tools are available. Two BLOCKING gates for tasks involving code exploration, modification, or architectural decisions:\n\nGate 1 — Context Assembly (BEFORE any work): call `twining_assemble` with the task description and the narrowest scope (e.g. `src/auth/`, not `project`) before reading code or making changes; call `twining_why` on files you intend to modify.\n\nGate 2 — Record (BEFORE committing or ending): call `twining_record` before every git commit and before ending the session — hooks enforce this. Include what you did (summary) and choices you made (decisions, as natural sentences: \"Chose X over Y — reason\"). Record findings, warnings, and surprises as you go via `twining_post` — they are what make the blackboard useful to the next session.\n\nRun `twining_housekeeping({})` at the start of long sessions (preview is safe)."}}
JSON
