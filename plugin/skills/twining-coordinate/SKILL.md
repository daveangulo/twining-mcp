---
name: twining-coordinate
description: Discover agents, delegate tasks, and coordinate multi-agent work through capability matching
auto-invocable: true
---

# Twining Coordinate — Multi-Agent Delegation and Discovery

You need work done by a specialized agent, or you want to understand what agents are available for a task.

## When to Invoke

- When a task requires capabilities beyond your own
- When work can be parallelized across multiple agents
- When you need to find an agent with specific expertise
- When delegating a subtask to run in isolation

## Workflow

### 1. Discover Available Agents

Call `twining_agents` to see all registered agents with:
- Their capabilities (e.g., `["database", "postgresql", "migration"]`)
- Liveness status (`active`, `idle`, `gone`)
- Role and description

### 2. Find Matching Agents

Call `twining_discover` with:
- `required_capabilities`: Array of capability strings needed for the task
- `include_gone`: Set to `false` to exclude agents that haven't been active recently (default: `true`)
- `min_score`: Minimum match score threshold (0-1, default: 0)

Results are ranked by:
- **Capability overlap**: How many required capabilities the agent has
- **Liveness score**: Active (1.0) > Idle (0.5) > Gone (0.1)
- **Total score**: Weighted combination of both

### 3. Delegate Work

Call `twining_delegate` with:
- `summary`: Clear description of what needs to be done
- `required_capabilities`: Skills needed for the task
- `urgency`: `"high"` (5 min timeout), `"normal"` (30 min), or `"low"` (4 hours)
- `scope`: Area of codebase affected
- `tags`: Additional categorization

This posts a delegation entry to the blackboard and returns:
- The entry ID
- Expiration time
- Suggested agents ranked by fit

### 4. Monitor

After delegation:
- Check `twining_recent` for acknowledgment responses
- The receiving agent will call `twining_acknowledge` on the associated handoff
- Use `twining_read` with `entry_type: "status"` to monitor progress updates

## Delegation vs. Handoff

- **Delegation**: "I need someone to do X" — you keep working on other things
- **Handoff**: "I'm done with my part, here's the state" — you're transferring ownership

Use `twining_delegate` for delegation, `twining_handoff` for handoffs (see the twining-handoff skill).

## Capability Conventions

Use descriptive, hierarchical capability strings:
- `"database"`, `"database/postgresql"`, `"database/migration"`
- `"frontend"`, `"frontend/react"`, `"frontend/css"`
- `"testing"`, `"testing/integration"`, `"testing/e2e"`
- `"security"`, `"security/auth"`, `"security/crypto"`
