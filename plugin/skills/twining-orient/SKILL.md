---
name: twining-orient
description: Assemble Twining context at session start — gather decisions, warnings, and project state before working
auto-invocable: true
---

# Twining Orient — Session Start Context Assembly

You are starting work on a task in a project that uses Twining for agent coordination. Before reading code, exploring files, or making any changes, you MUST assemble shared context.

## When to Invoke

- At the start of ANY task involving code exploration, modification, or architectural decisions
- When switching to a different area of the codebase
- When another agent's work may have changed shared state

## Workflow

### 1. Check Project Status

Call `twining_status` to get a health overview:
- How many active decisions, warnings, and blackboard entries exist
- Whether other agents are active
- Dashboard URL for visual exploration

### 2. Assemble Context for Your Task

Call `twining_assemble` with:
- `task`: A clear description of what you're about to do
- `scope`: The narrowest path that covers your work area (e.g., `"src/auth/"` not `"project"`)
- `max_tokens`: Leave at default (4000) unless you need more

This returns:
- **Active decisions** affecting your scope — respect these, don't contradict them
- **Warnings** — gotchas left by previous agents, MUST be addressed
- **Open needs** — work waiting to be done
- **Recent findings** — discoveries relevant to your area
- **Unanswered questions** — you may be able to answer these
- **Related graph entities** — code structure context
- **Planning state** — current phase and progress if GSD is active

### 3. Review Warnings

If `active_warnings` is non-empty, read each one carefully. Warnings are "don't do X because Y" messages from previous agents. Ignoring them leads to repeated mistakes.

### 4. Understand Decision History

For files you plan to modify, call `twining_why` with the file path as scope. This shows:
- What was decided about this file
- Why those choices were made
- What alternatives were rejected

### 5. Check for Agent Handoffs

If the assembly includes `recent_handoffs`, review them. Another agent may have left partial work or blockers for you.

If `suggested_agents` appears, other agents with relevant capabilities are available for delegation.

### 6. Search for Specific Context (Optional)

- Use `twining_query` for semantic search when you need to find entries by meaning rather than exact filters
- Use `twining_read` with filters (`entry_type`, `scope`, `tags`, `since`) for precise lookups
- Use `twining_recent` to see the latest activity across the project

## Scope Conventions

Scopes use path-prefix semantics:
- `"project"` — matches everything (use sparingly)
- `"src/auth/"` — matches anything under auth
- `"src/auth/jwt.ts"` — matches a specific file

Always use the narrowest scope that fits your task. Broad scopes dilute relevance.

## After Orientation

You now have shared context. Proceed with your task, and remember:
- Don't contradict active decisions without using `twining_reconsider` or `twining_override`
- Post `finding` entries for surprising discoveries
- Post `warning` entries for gotchas future agents should know
- Record significant decisions with `twining_decide` (see the twining-decide skill)
