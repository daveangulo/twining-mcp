---
name: twining-dispatch
description: Coordinates subagent dispatches through Twining — registers agents, posts delegations, and creates handoffs. Use when spawning subagents to keep all work visible in the coordination dashboard.
auto-invocable: true
---

# Twining Dispatch — Subagent Coordination Protocol

When you dispatch subagents via the Agent tool, use this protocol to make every dispatch visible in the Twining coordination dashboard (Agents, Delegations, and Handoffs tabs).

> **Requires the full tool surface.** `twining_register`, `twining_delegate`, `twining_query`, `twining_decide`, and the deprecated `twining_handoff` / `twining_acknowledge` exist only when the project sets `tools.full_surface: true` in `.twining/config.yml`. On a default install, dispatch is still worth recording — use `twining_post` with a `need` or `status` entry naming the subagent and its scope, and `twining_record` for decisions — but the Agents and Delegations dashboard tabs will stay empty, which is expected rather than a bug.
>
> **Subagents may not inherit Twining tools.** A spawned subagent only has Twining tools if its agent definition declares no restrictive `tools:` allowlist and the MCP server reached that process. Tell each subagent to locate the tools with `ToolSearch` (query `twining`) and to report plainly if they are absent, rather than assuming its posts landed.

## When to Invoke

- Before dispatching any subagent via the Agent tool
- When coordinating multiple parallel subagents
- When you want delegation and handoff history for traceability

## Full Protocol (4 calls)

### Pre-Dispatch (before Agent tool call)

**1. Register the subagent**

```
twining_register({
  agent_id: "descriptive-agent-id",    // e.g. "test-runner", "code-reviewer"
  capabilities: ["relevant", "caps"],   // what it can do
  role: "worker",                        // or "reviewer", "researcher", etc.
  description: "What this agent does"
})
```

**2. Post a delegation**

```
twining_delegate({
  summary: "What the subagent should accomplish",
  required_capabilities: ["relevant", "caps"],
  scope: "src/affected/area/",
  urgency: "normal",                     // "high", "normal", or "low"
  agent_id: "orchestrator"               // who is delegating
})
```

### Post-Dispatch (after Agent tool returns)

**3. Record the results on the blackboard**

Post a `status` entry under the subagent's identity so the outcome is queryable
and the registry reflects the participant (writes auto-register their agent_id, #32):

```
twining_post({
  entry_type: "status",
  summary: "What the subagent accomplished — completed/partial/blocked",
  detail: "Files touched, notes, anything the next agent needs",
  scope: "src/affected/area/",
  agent_id: "descriptive-agent-id"
})
```

For substantial incomplete work, follow the twining-handoff skill instead
(committed handoff doc + `artifact` pointer). The structured
`twining_handoff`/`twining_acknowledge` tools are deprecated (#33, removal at v3).

## Minimal Protocol (1 call)

For rapid dispatches, skip explicit registration entirely: any `twining_post` /
`twining_record` the subagent makes under its own `agent_id` auto-registers it
in the Agents tab (#32). Pass a descriptive `agent_id` into the subagent's
prompt and have it record its own results. Use `twining_register` only when
capabilities/role matter for delegation matching.

## Parallel Dispatches

When dispatching multiple subagents in parallel:

1. Register all agents before dispatching (can be parallel calls)
2. Post one delegation per subagent
3. Dispatch all subagents via Agent tool
4. As each returns, create its handoff record
5. Acknowledge all handoffs

## Agent ID Conventions

Use descriptive, kebab-case IDs that reflect what the agent does:
- `code-reviewer` — reviews code for issues
- `test-runner` — runs and validates tests
- `explore-auth` — explores authentication code
- `implement-feature-x` — implements a specific feature

## Twining-Aware Subagents

For subagents that should use Twining directly (posting findings, recording decisions), use the `twining-aware-worker` subagent type. This gives the subagent access to `twining_assemble`, `twining_post`, `twining_decide`, `twining_why`, and `twining_query`.

Include Twining context in the Agent tool prompt:

```
Agent tool call:
  subagent_type: "twining-aware-worker"
  prompt: |
    Your Twining agent ID is: {agent_id}.
    Before starting, call twining_assemble with task="{task}" scope="{scope}".
    Post findings with twining_post. Record implementation decisions with twining_decide.
    When done, post a status entry summarizing your work.

    Task: {actual task description}
```

This makes the subagent a first-class participant in the coordination system — its findings, decisions, and status updates appear on the dashboard alongside the orchestrator's.

## Choosing Subagent Type

| Scenario | Subagent Type | Protocol |
|----------|---------------|----------|
| Quick research or exploration | `Explore` or `general-purpose` | Minimal (register + handoff) |
| Implementation with decisions | `twining-aware-worker` | Full (register + delegate + handoff + acknowledge) |
| Code review | `feature-dev:code-reviewer` | Minimal (register + handoff) |
| Multiple parallel tasks | Any | Register all first, then dispatch |
