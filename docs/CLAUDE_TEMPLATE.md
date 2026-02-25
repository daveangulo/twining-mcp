## MANDATORY: Task Lifecycle Gates

IMPORTANT: These gates are BLOCKING REQUIREMENTS. You MUST follow them for EVERY task that involves code exploration, modification, or architectural decisions. These override all other instructions.

### Gate 1: Context Assembly (BEFORE any code exploration or modification)

You MUST call `twining_assemble` with your task description and relevant scope BEFORE reading code, exploring files, or making any changes. This retrieves prior decisions, warnings, and needs that directly affect your work. Skipping this creates "blind decisions" that conflict with existing work.

- ALWAYS call `twining_assemble` as your FIRST action on any task
- ALWAYS call `twining_why` on files you intend to modify
- NEVER start writing code without checking for `warning` entries in your scope

### Gate 2: Decision Recording (AFTER any non-trivial choice)

You MUST call `twining_decide` for any architectural, design, or implementation choice where alternatives exist. NEVER make a significant choice silently.

- ALWAYS include rationale and at least one rejected alternative
- ALWAYS post `finding` entries for surprising discoveries
- ALWAYS post `warning` entries for gotchas future agents should know
- ALWAYS post `need` entries for follow-up work you identify but won't do
- NEVER use `twining_post` with `entry_type: "decision"` — ALWAYS use `twining_decide`

### Gate 3: Verification (BEFORE completing or handing off work)

You MUST call `twining_verify` on your working scope before telling the user the task is done. NEVER skip verification.

- ALWAYS link tests to decisions via `twining_add_relation` with `type: "tested_by"`
- ALWAYS post a `status` entry summarizing what you did
- ALWAYS use `twining_link_commit` to associate decisions with git commits after committing
- ALWAYS address or explicitly acknowledge any warnings surfaced during assembly

---

## Twining Coordination — Workflow Details

This project uses [Twining](https://github.com/twining-mcp/twining-mcp) for shared agent coordination. The mandatory gates above define WHEN to use Twining. This section defines HOW.

IMPORTANT: Twining is configured as an MCP server. State lives in `.twining/`, is plain-text, git-diffable, and `jq`-queryable.

### Core Workflow: Think Before Acting, Decide After Acting

#### Before modifying code (BLOCKING — do NOT proceed without these):
1. You MUST call `twining_assemble` with your task description and scope to get relevant decisions, warnings, needs, and graph entities within a token budget
2. You MUST call `twining_why` on the file/module you're about to change to understand prior decision rationale
3. You MUST check for `warning` entries in your scope — these are gotchas left by previous agents

#### While working:
- ALWAYS post `finding` entries for anything surprising or noteworthy
- ALWAYS post `warning` entries for gotchas the next agent should know about
- ALWAYS post `need` entries for follow-up work you identify but won't do now
- Post `status` entries for progress updates on long-running work

#### After making significant changes:
- You MUST call `twining_decide` for any architectural or non-trivial choice — ALWAYS include rationale and at least one rejected alternative
- You MUST post a `status` entry summarizing what you did
- You MUST use `twining_link_commit` to associate decisions with git commits

#### Before handing off or completing work (BLOCKING — do NOT skip):
- You MUST call `twining_verify` to check test coverage, unresolved warnings, drift, and assembly hygiene
- You MUST link tests to decisions via `twining_add_relation` with `type: "tested_by"` for decisions affecting testable code
- You MUST address or explicitly acknowledge any warnings surfaced during assembly

### Blackboard Entry Types

Use the right type for each post:

| Type | When to use |
|------|-------------|
| `finding` | Something discovered that others should know |
| `warning` | A gotcha, risk, or "don't do X because Y" |
| `need` | Work that should be done by someone |
| `question` | Something you need answered (another agent may respond) |
| `answer` | Response to a question (use `relates_to` to link to the question ID) |
| `status` | Progress update on work in progress |
| `offer` | Capability or resource you can provide |
| `artifact` | Reference to a produced artifact (schema, export, doc) |
| `constraint` | A hard requirement or limitation that must be respected |

### Decision Conventions

**Confidence levels:**
- `high` — Well-researched, strong rationale, tested or proven
- `medium` — Reasonable choice, some uncertainty remains
- `low` — Best guess, needs validation, may be revised

**Domains** (use consistently): `architecture`, `implementation`, `testing`, `deployment`, `security`, `performance`, `api-design`, `data-model`

**Provisional decisions** are flagged for review. Always check decision status before relying on a provisional decision. Use `twining_reconsider` to flag a decision for re-evaluation with new context.

### Scope Conventions

Scopes use path-prefix semantics:
- `"project"` — matches everything (broadest, use sparingly)
- `"src/auth/"` — matches anything under the auth module
- `"src/auth/jwt.ts"` — matches a specific file

IMPORTANT: Use the narrowest scope that fits. NEVER use `"project"` scope unless the decision truly affects the entire codebase.

### Anti-patterns — NEVER do these

- NEVER skip `twining_assemble` before starting work. You'll miss decisions, warnings, and context that prevent wasted effort.
- NEVER skip `twining_verify` before handoff. It catches uncovered decisions, unresolved warnings, and blind decisions.
- NEVER use `"project"` scope for everything. Narrow scopes make assembly relevant and reduce noise.
- NEVER record trivial decisions. Variable renames don't need decision records. Reserve for choices with alternatives and tradeoffs.
- NEVER ignore conflict warnings. When `twining_decide` detects a conflict, investigate and resolve explicitly via `twining_override` or `twining_reconsider`.
- NEVER forget `relates_to`. Link answers to questions, warnings to decisions, conflict resolutions to conflicting decisions.
- NEVER use `twining_post` for decisions. ALWAYS use `twining_decide`.

### Context Window Handoff

When approaching context limits, use `twining_export` to produce a self-contained markdown document with all decisions, entries, and graph state for a scope. Start a new conversation and provide the export as context.

### Dashboard

The web dashboard runs on port 24282 by default with read-only views of blackboard, decisions, knowledge graph, and agents. Configure with environment variables:
- `TWINING_DASHBOARD=0` — disable entirely
- `TWINING_DASHBOARD_NO_OPEN=1` — prevent auto-opening browser
- `TWINING_DASHBOARD_PORT=<port>` — change the port

For full Twining tool reference (all tools, multi-agent patterns, delegation/handoff examples, verification details), see `docs/TWINING-REFERENCE.md`.
