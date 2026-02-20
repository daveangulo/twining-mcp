# Twining Hook Integration

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

## Claude Code Hooks

Twining includes hooks in `.claude/settings.json`:
- **SubagentStop**: Posts a status entry when subagents complete
- **PreCompact**: Warns about context compaction (consider archiving)

## Threshold-Based Auto-Archiving

When the blackboard exceeds `max_blackboard_entries_before_archive` (default: 500), the `BlackboardEngine` automatically triggers archiving after the next `post()` call. This is fire-and-forget and non-fatal — archive failures never block blackboard operations.

Configure the threshold in `.twining/config.yml`:

```yaml
archive:
  max_blackboard_entries_before_archive: 500
```
