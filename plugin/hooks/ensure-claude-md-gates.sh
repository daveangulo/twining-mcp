#!/bin/bash
# Twining SessionStart Hook — ensures CLAUDE.md contains lifecycle gates
# Idempotent: checks for marker before appending. Runs before the prompt hook
# so that gates have persistent CLAUDE.md authority, not just transient prompt weight.
# No external dependencies — pure bash + grep only
set -euo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0

# Find project root by walking up from CWD
PROJECT_ROOT="$PWD"
while [[ "$PROJECT_ROOT" != "/" ]]; do
  if [[ -d "$PROJECT_ROOT/.git" ]] || [[ -d "$PROJECT_ROOT/.twining" ]]; then
    break
  fi
  PROJECT_ROOT="$(dirname "$PROJECT_ROOT")"
done

if [[ "$PROJECT_ROOT" = "/" ]]; then
  exit 0  # Not in a recognizable project, skip silently
fi

# Opt-out flag — explicit user choice to keep this hook silent for this project
if [[ -f "$PROJECT_ROOT/.twining/.no-claude-md-gates" ]]; then
  exit 0
fi

CLAUDE_MD="$PROJECT_ROOT/CLAUDE.md"
MARKER="Twining Lifecycle Gates"

# Marker may live in any of these locations — check all before deciding to write.
# Order: cheapest first, project files before global file.
SEARCH_PATHS=(
  "$PROJECT_ROOT/CLAUDE.md"
  "$PROJECT_ROOT/CLAUDE.local.md"
  "$PROJECT_ROOT/.claude/CLAUDE.local.md"
  "$HOME/.claude/CLAUDE.md"
)

for candidate in "${SEARCH_PATHS[@]}"; do
  if [[ -f "$candidate" ]] && grep -q "$MARKER" "$candidate" 2>/dev/null; then
    exit 0
  fi
done

# Append the gates section (creates CLAUDE.md if it doesn't exist)
cat >> "$CLAUDE_MD" << 'GATES'

## Coordination — Twining Lifecycle Gates

IMPORTANT: These gates are BLOCKING REQUIREMENTS for every task involving code exploration, modification, or architectural decisions.

### Gate 1: Context Assembly (BEFORE any work)
- MUST call `twining_assemble` with task description and narrowest scope BEFORE reading code or making changes
- MUST call `twining_why` on files you intend to modify
- NEVER start working without these calls — skipping creates blind decisions that conflict with existing work

### Gate 2: Record (BEFORE committing or ending)
- MUST call `twining_record` before every `git commit` or session end — hooks enforce this
- Include what you did (summary) and any choices you made (decisions array)
- Write decisions as natural sentences: "Chose X over Y — reason"
- For findings/warnings during work, use `twining_post` directly

### Housekeeping
- Run `twining_housekeeping({})` at the start of long sessions to check for stale state — preview is safe, execute only if needed

### Critical Rules
- Use narrowest scope: `src/auth/` not `project`
- NEVER skip Gate 1 — #1 cause of wasted work and conflicting decisions
- NEVER skip Gate 2 — hooks will block your commit and session exit until you record
GATES

exit 0
