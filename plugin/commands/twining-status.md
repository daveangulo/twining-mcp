---
name: twining:status
description: Show Twining project coordination status
---

Run `twining_status` and present the results in a readable format. Include:

1. **Blackboard** — Active entry count by type, any unresolved warnings
2. **Decisions** — Count by status (active, provisional, superseded, overridden)
3. **Knowledge Graph** — Entity and relation counts
4. **Agents** — Active, idle, and gone agents with capabilities
5. **Dashboard** — URL if the dashboard is running (default: http://localhost:24282)

If there are active warnings or unanswered questions, highlight them prominently.
