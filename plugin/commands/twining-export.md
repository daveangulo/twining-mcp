---
name: twining:export
description: Export Twining state as markdown for context handoff or archival
---

Ask the user for the scope to export (default: entire project). Then run `twining_export` with that scope.

`twining_export` requires `tools.full_surface: true` in `.twining/config.yml`. If it is unavailable, say so plainly and offer `twining_assemble` (scoped briefing) or `twining_status` (health summary) instead — do not fabricate an export.

Present the exported markdown, which includes:
- All blackboard entries in scope
- All decisions with full rationale and alternatives
- Knowledge graph entities and relations

This is useful for:
- **Context window handoff** — paste into a new session to continue work with full history
- **Documentation** — snapshot of architectural decisions and coordination state
- **Debugging** — understanding what agents have done and why
