---
name: twining-decide
description: Records architectural and implementation decisions with rationale, rejected alternatives, and traceability. Use after making any non-trivial choice where alternatives exist.
auto-invocable: true
---

# Twining Decide — Decision Recording

You've made (or are about to make) a significant technical choice. Record it so future sessions and agents can understand what was decided, why, and what alternatives were rejected.

> **Which tool to call.** `twining_record` is on the default tool surface and routes decisions to the same decision store as `twining_decide`. `twining_decide` and the decision-lifecycle verbs (`twining_link_commit`, `twining_override`, `twining_reconsider`, `twining_promote`) exist **only** when the project sets `tools.full_surface: true` in `.twining/config.yml`. Use `twining_record` unless you have confirmed the full surface is available — it works everywhere.

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

Call `twining_record` with a `summary` of what you did and a `decisions` array. Each entry is either a natural sentence — `"Chose JWT over server-side sessions — stateless auth survives horizontal scaling"` — or a structured object when the content is too long or too structured to split cleanly:

- **`summary`**: One-line statement of the choice (e.g., "Use JWT for stateless authentication")
- **`rationale`**: **Why this option was chosen.** Give the actual reasoning. If your rationale merely restates the summary, the record captures the WHAT and loses the WHY — which is the entire reason this system exists.
- **`alternatives`**: At least one rejected option with `option` and `reason_rejected`, optionally `pros`/`cons`
- **`context`**: What situation prompted this decision
- **`confidence`**: `high` (well-researched, proven), `medium` (reasonable, some uncertainty), `low` (best guess, needs validation)
- **`domain`**: e.g. `architecture`, `implementation`, `testing`, `deployment`, `security`, `performance`, `api-design`, `data-model` — inferred from content when omitted
- **`constraints`** / **`assumptions`**: What limited the options, and what you're treating as true

Set these at the top level of the same call: **`scope`** (narrowest path; auto-inferred from the git diff when omitted), **`affected_files`**, **`affected_symbols`**, and **`commit_hash`** if the implementing commit already exists.

### 3. Post Related Findings and Warnings

As side effects of decisions, you often discover things worth sharing. Pass them in `twining_record`'s `findings` array, or post them mid-session with `twining_post`:

- **Findings**: `entry_type: "finding"` for noteworthy discoveries
  - Example: "The payment module uses a deprecated API version"
- **Warnings**: `entry_type: "warning"` for gotchas
  - Example: "Don't use connection pooling with this driver — it leaks under load"
- **Needs**: `entry_type: "need"` for follow-up work
  - Example: "Migration script needed for schema change"

`twining_post` **rejects** a `summary` over 200 characters — keep it short and put the substance in `detail`. (`twining_record` truncates instead of rejecting.)

### 4. Link the Decision to Its Commit

Traceability matters: a decision nobody can tie to code is hard to act on later. Pass `commit_hash` to `twining_record`. If you record before committing, record again after the commit with the hash, or pass it on your next `twining_record` call.

*(Full surface only: `twining_link_commit` attaches a commit to an existing decision id.)*

### 5. Supersede Rather Than Contradict

If your decision replaces an earlier one, pass its id in `twining_record`'s `supersedes` field so the chain is preserved instead of leaving two contradictory active decisions. Use `depends_on` for decisions yours builds on. Get ids from `twining_assemble` or `twining_why`.

*(Full surface only: `twining_override` replaces a decision and records who and why; `twining_reconsider` flags one for review; `twining_promote` ratifies a provisional decision.)*

## Pre-requisite

Before recording a decision, you MUST have called `twining_assemble` earlier in this session. Making decisions without assembling context first is the "blind-decisions" anti-pattern — you risk contradicting existing decisions you don't know about.

## Anti-patterns

- NEVER decide without first calling `twining_assemble` ("blind-decisions" anti-pattern)
- NEVER record a rationale that just restates the summary — that stores the WHAT as if it were the WHY
- NEVER use `twining_post` with `entry_type: "decision"` — it is rejected; use `twining_record`
- NEVER skip alternatives — even "do nothing" is a valid rejected alternative
- NEVER use `"project"` scope for a decision that only affects one module
- NEVER leave a contradiction unresolved — supersede the old decision or say why both stand
