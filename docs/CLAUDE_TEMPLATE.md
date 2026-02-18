# Twining + Serena + GSD Integration Template for Claude Code

> Copy the sections below into your project's `CLAUDE.md` to get maximum value from the Twining, Serena, and GSD tool ecosystem. Remove any sections for tools you don't use.

---

## Twining Integration

This project uses [Twining](https://github.com/twining-mcp/twining-mcp) for shared agent coordination. All agents must follow these practices.

### Setup

Twining is configured as an MCP server. On first use it creates `.twining/` with default config. State is plain-text, git-diffable, and `jq`-queryable.

### Core Workflow: Think Before Acting, Decide After Acting

#### Before modifying code:
1. Call `twining_assemble` with your task description and scope to get relevant decisions, warnings, needs, and graph entities within a token budget
2. Call `twining_why` on the file/module you're about to change to understand prior decision rationale
3. Check for `warning` entries in your scope — these are gotchas left by previous agents

#### While working:
- Post `finding` entries for anything surprising or noteworthy
- Post `warning` entries for gotchas the next agent should know about
- Post `need` entries for follow-up work you identify but won't do now
- Post `status` entries for progress updates on long-running work

#### After making significant changes:
- Call `twining_decide` for any architectural or non-trivial choice — always include rationale and at least one rejected alternative
- Post a `status` entry summarizing what you did
- Use `twining_link_commit` to associate decisions with git commits

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

**Important:** Do NOT use `twining_post` with `entry_type: "decision"`. Use `twining_decide` instead, which captures rationale, detects conflicts, populates the knowledge graph, and enables full traceability.

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

Use the narrowest scope that fits. `"project"` scope entries are always included in assembly results, so don't overuse it.

### Tool Quick Reference

#### Blackboard (shared communication)
| Tool | Purpose |
|------|---------|
| `twining_post` | Share findings, warnings, needs, questions, answers, status, offers, artifacts, constraints |
| `twining_read` | Read entries with filters (type, scope, tags, since, limit) |
| `twining_query` | Semantic search across entries (embeddings with keyword fallback) |
| `twining_recent` | Latest N entries, most recent first |

#### Decisions (structured rationale)
| Tool | Purpose |
|------|---------|
| `twining_decide` | Record a choice with rationale, alternatives, affected files/symbols, confidence |
| `twining_why` | Show decision chain for a file/module/scope |
| `twining_trace` | Trace decision dependencies upstream and downstream |
| `twining_reconsider` | Flag a decision for review with new context |
| `twining_override` | Replace a decision, recording who and why |
| `twining_search_decisions` | Search decisions by keyword, domain, status, confidence |
| `twining_link_commit` | Link a git commit to a decision |
| `twining_commits` | Find decisions associated with a commit |

#### Context Assembly
| Tool | Purpose |
|------|---------|
| `twining_assemble` | Build tailored context for a task within a token budget |
| `twining_summarize` | Quick project overview with counts and activity narrative |
| `twining_what_changed` | Changes since a timestamp (decisions, entries, overrides) |

#### Knowledge Graph
| Tool | Purpose |
|------|---------|
| `twining_add_entity` | Record a code entity (module, function, class, file, concept, pattern, dependency, api_endpoint) |
| `twining_add_relation` | Record a relationship (depends_on, implements, decided_by, affects, tested_by, calls, imports, related_to) |
| `twining_neighbors` | Explore entity connections up to depth 3 |
| `twining_graph_query` | Search entities by name or property |

Note: `twining_decide` auto-creates `file`/`function` entities with `decided_by` relations for `affected_files` and `affected_symbols`. Manual graph calls are for richer structure (imports, calls, implements).

#### Agent Coordination
| Tool | Purpose |
|------|---------|
| `twining_agents` | List registered agents with capabilities and liveness |
| `twining_discover` | Find agents matching capabilities, ranked by overlap and liveness |
| `twining_delegate` | Post a delegation request with capability requirements |
| `twining_handoff` | Hand off work with results and auto-assembled context snapshot |
| `twining_acknowledge` | Accept a handoff |

#### Lifecycle
| Tool | Purpose |
|------|---------|
| `twining_status` | Health check — entry counts, decision counts, graph stats, warnings |
| `twining_archive` | Archive old entries to reduce working set (preserves decisions) |
| `twining_export` | Export full state as markdown for context window handoff or docs |

### Multi-Agent Patterns

#### Delegation
```
# Identify what capabilities are needed
twining_discover(required_capabilities=["database", "postgresql"])

# Post a delegation request — returns suggested agents
twining_delegate(
  summary="Optimize slow user query",
  required_capabilities=["database"],
  urgency="high"
)
```

#### Handoff (passing work between agents)
```
# Agent A completes partial work
twining_handoff(
  source_agent="agent-a",
  target_agent="agent-b",
  summary="Auth refactoring — middleware done, routes remaining",
  results=[
    {description: "Extracted JWT middleware", status: "completed"},
    {description: "Route handler migration", status: "partial"}
  ]
)
# Context snapshot is auto-assembled from relevant decisions and warnings

# Agent B picks it up
twining_acknowledge(handoff_id="...", agent_id="agent-b")
```

#### Context Window Handoff
When approaching context limits, use `twining_export` to produce a self-contained markdown document with all decisions, entries, and graph state for a scope. Start a new conversation and provide the export as context.

### Anti-patterns

- **Don't skip `twining_assemble` before starting work.** You'll miss decisions, warnings, and context that prevent wasted effort.
- **Don't use `"project"` scope for everything.** Narrow scopes make assembly relevant and reduce noise.
- **Don't record trivial decisions.** Variable renames don't need decision records. Reserve for choices with alternatives and tradeoffs.
- **Don't forget `relates_to`.** Link answers to questions, warnings to decisions.
- **Don't use `twining_post` for decisions.** Always use `twining_decide`.

### Dashboard

The web dashboard runs on port 24282 by default with read-only views of blackboard, decisions, knowledge graph, and agents. Configure with environment variables:
- `TWINING_DASHBOARD=0` — disable entirely
- `TWINING_DASHBOARD_NO_OPEN=1` — prevent auto-opening browser
- `TWINING_DASHBOARD_PORT=<port>` — change the port

---

## Serena Integration

When Serena MCP tools are available alongside Twining, use them together for deeper code understanding and richer knowledge graph enrichment.

### Before Code Changes: Understand Structure

Use Serena's symbolic tools to understand code before modifying it:

```
# Get file overview without reading entire file
serena.get_symbols_overview("src/auth/middleware.ts", depth=1)

# Find a specific symbol's full definition
serena.find_symbol("JwtMiddleware", include_body=True)

# Understand who uses a symbol before changing it
serena.find_referencing_symbols("JwtMiddleware", relative_path="src/auth/middleware.ts")
```

Combine with Twining context:
```
# Get decision history for the file
twining_why(scope="src/auth/middleware.ts")

# Then use Serena to understand the current implementation
serena.find_symbol("JwtMiddleware", depth=1)  # See all methods
```

### After Decisions: Enrich Knowledge Graph

When `twining_decide` affects code structure, use Serena to discover relationships and record them in Twining's knowledge graph:

1. **Make the decision:**
   ```
   twining_decide(
     domain="architecture",
     scope="src/auth/",
     summary="Use JWT middleware pattern",
     affected_files=["src/auth/middleware.ts"],
     affected_symbols=["JwtMiddleware"],
     ...
   )
   # Auto-creates file/function entities with decided_by relations
   ```

2. **Use Serena to discover structural relationships:**
   ```
   serena.find_referencing_symbols("JwtMiddleware", relative_path="src/auth/middleware.ts")
   # Discovers: AuthRouter imports JwtMiddleware, UserController calls validate()
   ```

3. **Record the richer structure in Twining:**
   ```
   twining_add_entity(name="AuthRouter", type="module", properties={file: "src/auth/router.ts"})
   twining_add_relation(source="AuthRouter", target="JwtMiddleware", type="imports")
   twining_add_relation(source="UserController", target="JwtMiddleware/validate", type="calls")
   ```

### When to Enrich
- After decisions that add, remove, or restructure code modules
- When onboarding to understand a new area of the codebase
- After significant refactoring that changes dependency relationships

### When NOT to Enrich
- Trivial decisions (naming, formatting, config values)
- Decisions that don't change code structure
- When Serena tools are not available in the session

### Serena Best Practices
- Prefer `get_symbols_overview` over reading entire files — it's token-efficient
- Use `find_symbol` with `include_body=False` and `depth=1` to scan a class before diving into specific methods
- Always pass `relative_path` to constrain searches when you know the file location
- Use `search_for_pattern` for non-code files or when you don't know the symbol name

---

## GSD Integration

When using the GSD workflow system alongside Twining, the two tools complement each other: GSD manages the project roadmap and execution flow, while Twining captures the decisions and shared context produced during that work.

### Automatic Integration

Twining has built-in GSD awareness:
- **Decision sync:** Every `twining_decide` call auto-appends the decision summary to `.planning/STATE.md` under the `### Decisions` section, keeping GSD's state file in sync
- **Context assembly:** `twining_assemble` and `twining_summarize` automatically include `.planning/` state (current phase, progress, blockers, open requirements) when a `.planning/` directory exists
- **No manual wiring needed** — if both tools are configured, they find each other through the `.planning/` directory convention

### Workflow: GSD Phases + Twining Decisions

#### During `/gsd:plan-phase`
- Use `twining_assemble` to pull in prior decisions and warnings relevant to the phase scope
- Existing decisions from Twining inform the plan — preventing contradictory approaches

#### During `/gsd:execute-phase`
- Record architectural choices with `twining_decide` as you implement — these automatically appear in STATE.md
- Post `finding` entries for discoveries during implementation
- Post `warning` entries for risks or gotchas encountered
- Post `need` entries for follow-up work outside the current phase scope

#### During `/gsd:verify-work`
- Use `twining_why` on modified files to confirm decisions are documented
- Use `twining_search_decisions` to verify all phase decisions have been captured
- Check `twining_status` for any unresolved warnings

#### During `/gsd:complete-milestone`
- Use `twining_export` to capture the full decision/blackboard state at milestone boundary
- Use `twining_archive` to reduce the working set before the next milestone
- Decisions are preserved through archival — only transient blackboard entries are archived

### Phase Transitions
When starting a new phase:
```
# Get Twining context for the new scope
twining_assemble(task="Phase N: <description>", scope="<phase scope>")

# Check for blockers or warnings from prior phases
twining_read(entry_types=["warning", "need"], scope="<phase scope>")
```

When completing a phase:
```
# Summarize what was accomplished
twining_post(entry_type="status", summary="Phase N complete: <summary>", scope="<phase scope>")

# Link key commits to decisions
twining_link_commit(decision_id="...", commit_hash="<hash>")
```

### Multi-Agent GSD + Twining

When GSD spawns subagents (e.g., during `/gsd:execute-phase` with parallel plans):
- Each subagent should call `twining_assemble` before starting its plan
- Subagents post `finding`/`warning`/`need` entries as they work
- The orchestrator agent checks `twining_recent` between plan executions to catch warnings
- Use `twining_delegate` when a subagent identifies work outside its capabilities
- Use `twining_handoff` when a subagent completes partial work that another should continue

---

## MCP Server Configuration

Add all three servers to your `.mcp.json`:

```json
{
  "mcpServers": {
    "twining": {
      "command": "twining-mcp",
      "args": ["--project", "."]
    },
    "serena": {
      "command": "serena-mcp",
      "args": ["--project", "."]
    }
  }
}
```

GSD is configured separately as a Claude Code skill (see GSD documentation for setup).
