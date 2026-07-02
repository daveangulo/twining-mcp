# Twining Hook Integration

## Plugin Hooks (Automatic with Plugin Install)

The Twining plugin includes four hooks that enforce the lifecycle gates. All four share the same guards: they no-op when `TWINING_DISABLED=true` and when the project has no `.twining/` directory, and they **fail open** — a missing sentinel, an unreadable file, or an absent git binary always allows rather than blocks. A coordination tool must never be the reason a commit or session-exit is impossible.

### SessionStart
Injects the lifecycle-gate guidance (assemble first, record last, with what a good record contains) into session context via `additionalContext` — including on resume. Since plugin 1.10.0 this is the sole delivery mechanism: the previous `ensure-claude-md-gates.sh` hook, which appended a gates block to the project's `CLAUDE.md` (issue #9), was removed. No user files are ever modified.

### PreToolUse (on `Bash`)
Blocks `git commit` commands if the agent hasn't called `twining_record`, `twining_decide`, or `twining_post` since the last commit. This enforces Gate 2 at the natural checkpoint — when code is being committed.

The check compares `.twining/.last-record` (a unix timestamp written synchronously by the three recording tools) against `git log -1 --format=%ct HEAD`. The sentinel write is synchronous, so same-turn record→commit batches work correctly and the hook is immune to transcript content. Trigger detection is argv-aware: `git commit-tree`, pipelines that mention "git commit", and `git commit --amend` are all skipped.

If no sentinel file exists at all — a fresh clone, or the MCP server never booted (npm outage, broken resolve) — the hook allows the commit with a visible warning instead of denying: the gate would be unsatisfiable, since the record tools aren't reachable. Normal gating resumes after the first successful record.

### Stop
Blocks session exit when uncommitted changes are newer than the last Twining recording. Transcript-free since plugin 1.10.0: it compares the `.last-record` sentinel against the newest mtime of dirty working-tree files (`git status --porcelain`, with `.twining/` itself excluded). The previous implementation grepped the session transcript for tool-call strings — the same technique the pre-commit hook abandoned after issues #11/#13. Honors `stop_hook_active` so a continuation after a block is never re-blocked, and allows silently when the tree is clean (committed work was already gated by the pre-commit hook), when no sentinel exists, or when git is unavailable.

### SubagentStop
Queues a status entry in `.twining/pending-posts.jsonl` when subagents complete, ensuring the orchestrator has visibility into subagent work. The MCP server drains the queue on next startup and posts each entry through the locked blackboard store — the hook never writes `blackboard.jsonl` directly, since a raw bash append can't take the store's lock and could interleave with a concurrent server write.

## Auto-Archive on Git Commit (Optional)

Create `.git/hooks/post-commit`:

```bash
#!/bin/bash
if [ -d ".twining" ]; then
  echo '{"action": "archive", "trigger": "commit"}' >> .twining/pending-actions.jsonl
fi
```

Make it executable: `chmod +x .git/hooks/post-commit`

On the next MCP server startup, `PendingProcessor` will process the archive action.

## Threshold-Based Auto-Archiving

When the blackboard exceeds `max_blackboard_entries_before_archive` (default: 500), the `BlackboardEngine` automatically triggers archiving after the next `post()` call. This is fire-and-forget and non-fatal — archive failures never block blackboard operations.

Configure the threshold in `.twining/config.yml`:

```yaml
archive:
  max_blackboard_entries_before_archive: 500
```

## Housekeeping

For periodic maintenance beyond auto-archiving, use `twining_housekeeping`. It handles archival, deduplication, stale decision surfacing, graph pruning, and metrics rotation in one call. Dry-run by default — preview before executing.
