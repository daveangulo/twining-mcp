---
name: twining-handoff
description: Hand off work between agents or sessions with structured results and context snapshots
auto-invocable: true
---

# Twining Handoff — Agent and Session Handoff

You're transferring work to another agent, ending a session with incomplete work, or approaching context window limits. Create a structured handoff so the next agent (or your next session) can continue seamlessly.

## When to Invoke

- When completing partial work that another agent should continue
- When delegating a subtask to a specialized agent
- When approaching context window limits and need to continue in a new session
- When the user explicitly asks to hand off or pass work along

## Workflow

### Multi-Agent Handoff

When handing work to another agent:

#### 1. Summarize Results

Call `twining_handoff` with:
- `source_agent`: Your agent ID
- `target_agent`: The receiving agent's ID (if known; omit for any agent)
- `scope`: Area of work being handed off
- `summary`: What was done and what remains
- `results`: Array of result objects, each with:
  - `description`: What was accomplished
  - `status`: `"completed"`, `"partial"`, `"blocked"`, or `"failed"`
  - `artifacts`: Files created or modified (optional)
  - `notes`: Important context (optional)

Twining auto-assembles a context snapshot with relevant decision IDs, warning IDs, and finding IDs.

#### 2. Wait for Acknowledgment

The receiving agent should call `twining_acknowledge` with the handoff ID to confirm receipt.

### Context Window Handoff (Same Agent, New Session)

When approaching context limits and continuing in a new session:

#### 1. Export State

Call `twining_export` with the scope of your work. This produces a self-contained markdown document containing:
- All blackboard entries in scope
- All decisions with full rationale
- Knowledge graph entities and relations

#### 2. Create Summary

Call `twining_summarize` with the scope to get a compact overview:
- Active/provisional decision counts
- Open needs and warnings
- Recent activity narrative
- Planning state

#### 3. Start New Session

Provide the export markdown to the new session as context. The new session should begin with `twining_assemble` (orient skill) to get the latest state.

### Session End (No Continuation)

If work is complete and no handoff is needed, just run the verify skill instead. But if there IS unfinished work:

1. Post a `need` entry: `twining_post(entry_type="need", summary="<what needs doing>", scope="<area>")`
2. Post a `status` entry summarizing what you completed
3. The Stop hook will remind you to do this if you forget

## Handoff Quality Checklist

Before handing off, verify:
- All significant decisions are recorded (`twining_decide`)
- All warnings are posted for known gotchas
- Results accurately reflect completion status (don't say "completed" for partial work)
- Scope is specific enough for the receiving agent to `twining_assemble` on it
