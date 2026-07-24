---
name: twining-orient
description: Assembles Twining context by gathering prior decisions, warnings, and project state. Use at session start or when beginning work in a new scope area.
auto-invocable: true
---

# Twining Orient — Session Start

Before working, assemble shared context so you don't contradict prior decisions or miss warnings.

## Do This

1. **Call `twining_assemble`** with your task description and scope (narrowest path that fits, e.g., `"src/auth/"` not `"project"`). This returns decisions, warnings, needs, findings, status summary, and handoff context in a structured briefing.

2. **Read the warnings.** If `active_warnings` is non-empty, each one is a "don't do X because Y" from a previous agent. Ignoring them leads to repeated mistakes.

3. **Proceed.** You now have shared context. Respect active decisions. Post findings, warnings, and decisions as you work.

## Optional Steps

- Call `twining_why` on specific files you plan to modify to see their decision history
- Call `twining_register` if working alongside other agents (makes you discoverable) — requires `tools.full_surface: true`
- Use `twining_search_decisions` for keyword search across all scopes — requires `tools.full_surface: true`; otherwise widen the `scope` you pass to `twining_assemble`

## Scope Conventions

- `"src/auth/"` — matches anything under auth (preferred)
- `"src/auth/jwt.ts"` — matches a specific file
- `"project"` — matches everything (use sparingly — dilutes relevance)
