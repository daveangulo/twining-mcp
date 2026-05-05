# Twining Hook Integration

## Plugin Hooks (Automatic with Plugin Install)

The Twining plugin includes four hooks that enforce the lifecycle gates:

### SessionStart
- **Command hook:** Ensures `CLAUDE.md` contains the Twining Lifecycle Gates section (idempotent)
- **Prompt hook:** Reminds agents of the two gates — `twining_assemble` first, `twining_record` last

### PreToolUse (on `Bash`)
Blocks `git commit` commands if the agent hasn't called `twining_record`, `twining_decide`, or `twining_post` since the last commit. This enforces Gate 2 at the natural checkpoint — when code is being committed.

The check compares `.twining/.last-record` (a unix timestamp written synchronously by the three recording tools) against `git log -1 --format=%ct HEAD`. The sentinel write is synchronous, so same-turn record→commit batches work correctly and the hook is immune to transcript content. Trigger detection is argv-aware: `git commit-tree`, pipelines that mention "git commit", and `git commit --amend` are all skipped. The hook silently allows in repos without a `.twining/` directory.

### Stop
Blocks session exit if code changes (Edit/Write calls) occurred after the last Twining recording call. Asks for one action: "Call `twining_record` before ending."

### SubagentStop
Posts a status entry to the blackboard when subagents complete, ensuring the orchestrator has visibility into subagent work.

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
