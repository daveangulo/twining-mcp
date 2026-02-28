---
name: twining-decide
description: Record architectural and implementation decisions with rationale, alternatives, and traceability
auto-invocable: true
---

# Twining Decide — Decision Recording

You've made (or are about to make) a significant technical choice. Record it so future sessions and agents can understand what was decided, why, and what alternatives were rejected.

## When to Invoke

- After choosing between architectural alternatives (e.g., REST vs gRPC, PostgreSQL vs MongoDB)
- After making implementation choices with tradeoffs (e.g., caching strategy, error handling approach)
- When the user says "let's go with", "I've decided", or makes an architectural choice
- After resolving a design question with alternatives considered
- NOT for trivial choices (variable names, formatting, simple config values)

## Workflow

### 1. Identify the Decision Scope

Use the narrowest path that covers the affected area:
- `"src/auth/"` for auth-related decisions
- `"src/database/schema.ts"` for a specific file
- Never `"project"` unless it truly affects everything

### 2. Record the Decision

Call `twining_decide` with:

- **`domain`**: One of `architecture`, `implementation`, `testing`, `deployment`, `security`, `performance`, `api-design`, `data-model`
- **`scope`**: Narrowest path covering affected code
- **`summary`**: One-line statement of the choice (e.g., "Use JWT for stateless authentication")
- **`context`**: What situation prompted this decision
- **`rationale`**: Why this option was chosen
- **`confidence`**: `high` (well-researched, proven), `medium` (reasonable, some uncertainty), or `low` (best guess, needs validation)
- **`alternatives`**: At least one rejected option with `option`, `reason_rejected`, and optionally `pros`/`cons`
- **`affected_files`**: File paths this decision impacts
- **`affected_symbols`**: Function/class names affected (optional)
- **`constraints`**: What limited the options (optional)

### 3. Post Related Findings and Warnings

As side effects of decisions, you often discover things worth sharing:

- **Findings**: Use `twining_post` with `entry_type: "finding"` for noteworthy discoveries
  - Example: "The payment module uses a deprecated API version"
- **Warnings**: Use `twining_post` with `entry_type: "warning"` for gotchas
  - Example: "Don't use connection pooling with this driver — it leaks under load"
- **Needs**: Use `twining_post` with `entry_type: "need"` for follow-up work
  - Example: "Migration script needed for schema change"

### 4. Handle Conflicts

If `twining_decide` detects a conflict with an existing decision:
1. A warning is auto-posted to the blackboard
2. Both decisions remain active
3. You MUST resolve the conflict explicitly:
   - `twining_override` — replace the old decision (records who and why)
   - `twining_reconsider` — flag the old decision for review (sets it to provisional)

### 5. Link to Commits

After committing code that implements a decision, call `twining_link_commit` with:
- `decision_id`: The decision ID returned by `twining_decide`
- `commit_hash`: The git commit hash

This creates traceability from decisions to code changes.

### 6. Promote Provisional Decisions

If you made a `low` or `medium` confidence decision that's now validated (tests pass, design confirmed), use `twining_promote` to upgrade it to `active` with `high` confidence.

## Anti-patterns

- NEVER use `twining_post` with `entry_type: "decision"` — always use `twining_decide`
- NEVER skip alternatives — even "do nothing" is a valid rejected alternative
- NEVER use `"project"` scope for a decision that only affects one module
- NEVER ignore conflict warnings — resolve them explicitly
