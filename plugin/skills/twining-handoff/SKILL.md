---
name: twining-handoff
description: Hands off work between agents or sessions via a committed handoff document plus a blackboard pointer. Use when ending a session with incomplete work, switching agents, or approaching context limits.
auto-invocable: true
---

# Twining Handoff — Agent and Session Handoff

You're transferring work to another agent, ending a session with incomplete work, or approaching context window limits. Create a handoff the next agent (or your next session) can actually continue from.

> **Pattern change (#33):** the structured `twining_handoff` / `twining_acknowledge` tools are deprecated and scheduled for removal in v3. Field data across real projects showed zero calls to them, while every project that handed off well did it with rich committed markdown docs. This skill now teaches that pattern: **a committed doc + a blackboard pointer.**

## When to Invoke

- When completing partial work that another agent should continue
- When delegating a subtask to a specialized agent
- When approaching context window limits and need to continue in a new session
- When the user explicitly asks to hand off or pass work along

For a session that simply finished its work, `twining_record` (Gate 2) is the handoff — don't write a doc for completed work with nothing pending.

## Workflow

### 1. Write the handoff document

Create a markdown file under the project's docs or planning area (follow the project's existing convention; `docs/handoffs/YYYY-MM-DD-<topic>.md` is a good default). Include:

- **State of the work** — what's done, what's in flight, what's untouched
- **Next steps** — concrete, ordered, with enough context to start cold
- **Decisions and constraints** — link Twining decision IDs; don't restate rationale the store already holds
- **Gotchas** — anything that will waste the next agent's first hour
- **Verification** — how to check the current state actually works (test commands, expected output)

`twining_export` (scope-limited) and `twining_summarize` are useful raw material for the doc — export gives full entries and decisions, summarize gives the compact overview. Both require `tools.full_surface: true`; on a default install, `twining_assemble` on the handoff scope gives you the same briefing the next agent will receive, which is the right thing to write the doc against anyway.

### 2. Commit the document

Commit the doc (alongside `.twining/` state, per project convention). A handoff that only exists in a context window is not a handoff.

### 3. Post the pointer

Post an `artifact` entry so the next session's `twining_assemble` surfaces it:

```
twining_post({
  entry_type: "artifact",
  summary: "Handoff: <topic> — <one-line state>",
  detail: "<repo-relative path to the doc>. Next steps: <first step>.",
  scope: "<area of work>",
  tags: ["handoff"]
})
```

If work is incomplete, also post a `need` entry per outstanding obligation — open needs survive archive sweeps until resolved; the artifact pointer alone does not carry that guarantee.

### 4. Record the session

Call `twining_record` as usual (Gate 2) with a summary that names the handoff doc.

## Handoff Quality Checklist

Before handing off, verify:
- All significant decisions are recorded (`twining_record` / `twining_decide`)
- All warnings are posted for known gotchas
- The doc is committed, not just written
- The `artifact` pointer's scope is specific enough for the receiving agent to `twining_assemble` on it
- Completion status is honest — don't say "completed" for partial work
