---
name: twining-dispatch
description: Coordinate subagent dispatches through Twining — register agents, post delegations, create handoffs so all work is visible in the dashboard
auto-invocable: true
---

# Twining Dispatch — Subagent Coordination Protocol

When you dispatch subagents via the Agent tool, use this protocol to make every dispatch visible in the Twining coordination dashboard (Agents, Delegations, and Handoffs tabs).

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

**3. Create a handoff record**

```
twining_handoff({
  source_agent: "descriptive-agent-id",
  target_agent: "orchestrator",
  scope: "src/affected/area/",
  summary: "What the subagent accomplished",
  results: [{
    description: "Brief result description",
    status: "completed",                  // or "partial", "blocked", "failed"
    artifacts: ["file1.ts", "file2.ts"],  // files created/modified
    notes: "Any additional context"
  }],
  auto_snapshot: true
})
```

**4. Acknowledge the handoff**

```
twining_acknowledge({
  handoff_id: "<id from step 3>",
  agent_id: "orchestrator"
})
```

## Minimal Protocol (2 calls)

For rapid dispatches where full traceability isn't needed, use just register + handoff. This still populates the Agents and Handoffs dashboard tabs.

**Before dispatch:**
```
twining_register({ agent_id: "agent-name", capabilities: [...] })
```

**After dispatch:**
```
twining_handoff({
  source_agent: "agent-name",
  target_agent: "orchestrator",
  summary: "Result summary",
  results: [{ description: "...", status: "completed" }]
})
```

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
