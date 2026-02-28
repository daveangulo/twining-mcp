---
name: twining:export
description: Export Twining state as markdown for context handoff or archival
---

Ask the user for the scope to export (default: entire project). Then run `twining_export` with that scope.

Present the exported markdown, which includes:
- All blackboard entries in scope
- All decisions with full rationale and alternatives
- Knowledge graph entities and relations

This is useful for:
- **Context window handoff** — paste into a new session to continue work with full history
- **Documentation** — snapshot of architectural decisions and coordination state
- **Debugging** — understanding what agents have done and why
