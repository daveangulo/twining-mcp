# Twining Hook Integration

## Plugin Hooks (Automatic with Plugin Install)

The Twining plugin includes five hooks that enforce the lifecycle gates. All five share the same guards: they no-op when `TWINING_DISABLED=true` and when the project has no `.twining/` directory, and they **fail open** — a missing sentinel, an unreadable file, or an absent git binary always allows rather than blocks. A coordination tool must never be the reason a commit or session-exit is impossible.

### SessionStart
Injects the lifecycle-gate guidance (assemble first, record last, with what a good record contains) into session context via `additionalContext` — including on resume. Since plugin 1.10.0 this is the sole delivery mechanism: the previous `ensure-claude-md-gates.sh` hook, which appended a gates block to the project's `CLAUDE.md` (issue #9), was removed. No user files are ever modified.

### PreToolUse (on `Bash`)
Blocks `git commit` commands if the agent hasn't called `twining_record`, `twining_decide`, or `twining_post` since the last commit. This enforces Gate 2 at the natural checkpoint — when code is being committed.

The check compares `.twining/.last-record` (a unix timestamp written synchronously by the three recording tools) against `git log -1 --format=%ct HEAD`. The sentinel write is synchronous, so same-turn record→commit batches work correctly and the hook is immune to transcript content. Trigger detection is argv-aware: `git commit-tree`, pipelines that mention "git commit", and `git commit --amend` are all skipped.

If no sentinel file exists at all — a fresh clone, or the MCP server never booted (npm outage, broken resolve) — the hook allows the commit with a visible warning instead of denying: the gate would be unsatisfiable, since the record tools aren't reachable. Normal gating resumes after the first successful record.

### PostToolUse (activity marker, on `Edit`/`Write`/`MultiEdit`/`NotebookEdit`)
Writes epoch-seconds to `.twining/.sessions/<session_id>` after every successful edit **whose target path belongs to this store's project** — the marker the Stop gate reads. Since plugin 1.33.0 the edit-path filter canonicalizes both sides through the nearest existing ancestor (`pwd -P`), so symlinked roots (`/tmp` → `/private/tmp`, symlinked homes) match correctly, and linked git worktrees of the project also count. Out-of-tree writes — scratch notes in `/tmp`, files in other repos — never stamp the marker, so a read-only session that takes notes elsewhere is never Gate-2 blocked. An absent or unparseable `file_path` stamps anyway (fail toward gate integrity).

### Stop (marker-based since plugin 1.16.0)
Blocks session exit only when **this session's own activity marker** is newer than `.last-record`. No git scan, no mtime scan — other sessions' activity can never block this one (the 1.10.0–1.15.x dirty-file mtime scan false-blocked recurringly under concurrent agents and was replaced; mtime had already been rejected once in decision 01KQWCCVTV). Fails open on a missing store, missing sentinel, missing session id, or missing marker — a read-only session has no marker and always exits freely. Honors `stop_hook_active` so a continuation after a block is never re-blocked.

### SubagentStop
Queues a status entry in `.twining/pending-posts.jsonl` when subagents complete, ensuring the orchestrator has visibility into subagent work. The MCP server drains the queue on next startup and posts each entry through the locked blackboard store — the hook never writes `blackboard.jsonl` directly, since a raw bash append can't take the store's lock and could interleave with a concurrent server write.

## Read-Only Audit Sessions

To audit a Twining store without writing to it:

- **Hooks:** on plugin ≥ 1.33.0 nothing special is needed — out-of-tree notes never trip Gate 2, and a session that edits no project files carries no marker. For belt-and-braces (or older plugins), run the audit session with `TWINING_DISABLED=true`; note this disables **all five** hooks including the pre-commit gate and session-start context, so scope it strictly to no-commit audit sessions.
- **Server:** connecting the MCP server to a **fresh** checkout still initializes `.twining/` (directories, `config.yml`, `.gitignore` reconciliation) at boot, and any sqlite boot creates WAL files. Against an already-initialized store the mutations are limited to gitignored churn (`metrics.jsonl`, `.sessions/`). A true no-write server mode is a tracked design decision (DD-6, read-audit remediation plan).
- **Viewing:** the dashboard (`http://localhost:24282`) is the supported read-only viewing surface.

## Auto-Archive on Git Commit (Optional)

Create `.git/hooks/post-commit`:

```bash
#!/bin/bash
if [ -d ".twining" ]; then
  echo '{"action": "archive", "trigger": "commit"}' >> .twining/pending-actions.jsonl
fi
```

Make it executable: `chmod +x .git/hooks/post-commit`

On the next MCP server startup, `PendingProcessor` will process the archive action. The sweep keeps the newest `archive.retain_recent` entries (default 200) plus decisions and unresolved needs/warnings/questions; a queued action may pass its own `retain` to override.

## Threshold-Based Auto-Archiving

When the blackboard exceeds `max_blackboard_entries_before_archive` (default: 500), the `BlackboardEngine` automatically triggers archiving after the next `post()` call. This is fire-and-forget and non-fatal — archive failures never block blackboard operations.

Configure the threshold in `.twining/config.yml`:

```yaml
archive:
  max_blackboard_entries_before_archive: 500
```

## Housekeeping

For periodic maintenance beyond auto-archiving, use `twining_housekeeping`. It handles archival, deduplication, stale decision surfacing, graph pruning, and metrics rotation in one call. Dry-run by default — preview before executing.
