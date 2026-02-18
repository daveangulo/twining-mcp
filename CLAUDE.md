# Twining MCP Server

## Architecture
See TWINING-DESIGN-SPEC.md for full design. This is the authoritative reference for all data models, tool signatures, and behavior.

## Build Order
Build bottom-up in this order:
1. src/utils/ (types, ids, tokens)
2. src/storage/ (file-store, then blackboard-store, decision-store, graph-store)
3. src/engine/ (blackboard, decisions, graph, context-assembler, archiver)
4. src/embeddings/ (embedder, index-manager, search) — lazy-loaded, graceful fallback
5. src/tools/ (one file per tool group, matching spec exactly)
6. src/server.ts + src/index.ts (MCP registration and entry point)

## Conventions
- All IDs are ULIDs
- All file I/O goes through storage/ layer, never direct fs calls from engine/
- All tool handlers return structured errors, never throw
- Tests alongside implementation — write tests for each module before moving to next
- Use vitest for testing with temp directories

## Key Constraint
The embedding system MUST be lazy-loaded and MUST fall back gracefully to keyword search if ONNX fails. The server should never fail to start because of embedding issues.

---

## Twining Integration Guide for Claude Code

> **For other projects:** See [docs/CLAUDE_TEMPLATE.md](docs/CLAUDE_TEMPLATE.md) for a standalone template covering Twining + Serena + GSD integration that you can copy into any project's CLAUDE.md.

This section documents how to use Twining tools effectively when working on this codebase.

### Setup

Add Twining to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "twining": {
      "command": "twining-mcp",
      "args": ["--project", "."]
    }
  }
}
```

On first use, Twining creates a `.twining/` directory with default config. Add `.twining/embeddings/*.index`, `.twining/archive/`, and `.twining/models/` to `.gitignore` (done automatically). The rest of `.twining/` is plain-text and git-diffable.

### Core Workflow: Think Before Acting

The single highest-value habit is **context assembly before work, decisions after work**.

#### Before modifying code:
1. `twining_assemble` with your task description and scope — this returns relevant decisions, warnings, needs, and knowledge graph entities within a token budget, so you start with full context
2. `twining_why` on the specific file/module you're about to change — this shows the decision chain explaining *why* things are the way they are
3. Check for `warning` entries in your scope — these are gotchas left by previous agents

#### While working:
- `twining_post` with `entry_type: "finding"` for anything surprising or noteworthy
- `twining_post` with `entry_type: "warning"` for gotchas the next agent should know about
- `twining_post` with `entry_type: "need"` for follow-up work you identify but won't do now

#### After making significant changes:
- `twining_decide` for any architectural or non-trivial implementation choice — always include rationale and at least one rejected alternative
- `twining_post` with `entry_type: "status"` summarizing what you did

### Tool Reference (27 tools)

#### Blackboard (shared agent communication)
| Tool | When to use |
|------|-------------|
| `twining_post` | Share findings, warnings, needs, questions, answers, status updates, offers, artifacts, or constraints. Does NOT accept `entry_type: "decision"` — use `twining_decide` instead. |
| `twining_read` | Read blackboard entries with filters (type, scope, tags, since). Returns most recent entries when limit is applied. |
| `twining_query` | Semantic search across blackboard entries. Uses embeddings when available, keyword fallback otherwise. |
| `twining_recent` | Quick view of latest N entries (most recent first). |

**Entry types and when to use each:**
- `finding` — Something you discovered that others should know ("The auth module uses a custom JWT parser")
- `warning` — A gotcha or risk ("Changing X will break Y because of Z")
- `need` — Work that should be done ("The migration script needs a rollback path")
- `question` — Something you need answered ("Should we use Redis or Memcached for sessions?")
- `answer` — Response to a question (use `relates_to` to link to the question ID)
- `status` — Progress update ("Completed database migration, 3 tables updated")
- `offer` — Capability or resource announcement ("I can handle TypeScript refactoring tasks")
- `artifact` — Reference to a produced artifact ("API schema exported to docs/api.yaml")
- `constraint` — A hard requirement or limitation ("Must maintain backwards compat with v2 clients")

#### Decisions (structured rationale capture)
| Tool | When to use |
|------|-------------|
| `twining_decide` | Record any non-trivial choice with full rationale, alternatives considered, affected files/symbols, and confidence level. Auto-creates knowledge graph entities for affected files/symbols. |
| `twining_why` | Before modifying a file — shows all decisions that affect it and why. |
| `twining_trace` | Understand decision dependencies — what this decision depends on and what depends on it. |
| `twining_reconsider` | Flag a decision for review with new context. Sets it to provisional and posts a warning. |
| `twining_override` | Replace a decision with a new one, recording who overrode it and why. |
| `twining_search_decisions` | Search across all decisions by keyword, domain, status, or confidence. |
| `twining_link_commit` | Link a git commit to a decision for bidirectional traceability. |
| `twining_commits` | Find which decisions were associated with a specific commit. |

**Decision confidence levels:**
- `high` — Well-researched, strong rationale, tested or proven
- `medium` — Reasonable choice, some uncertainty remains
- `low` — Best guess, needs validation, may be revised

**Decision domains** (suggested): `architecture`, `implementation`, `testing`, `deployment`, `security`, `performance`, `api-design`, `data-model`

#### Context Assembly (intelligent context injection)
| Tool | When to use |
|------|-------------|
| `twining_assemble` | Before starting any task. Returns decisions, warnings, needs, questions, graph entities, and planning state — all scored by relevance and fitted within a token budget. |
| `twining_summarize` | Quick project overview — counts of decisions, entries, warnings, and recent activity narrative. |
| `twining_what_changed` | Catch up after a break — shows new decisions, entries, overrides, and reconsiderations since a timestamp. |

#### Knowledge Graph (code structure mapping)
| Tool | When to use |
|------|-------------|
| `twining_add_entity` | Record a code entity (module, function, class, file, concept, pattern, dependency, api_endpoint). Upsert semantics. |
| `twining_add_relation` | Record a relationship between entities (depends_on, implements, decided_by, affects, tested_by, calls, imports, related_to). |
| `twining_neighbors` | Explore how an entity connects to others, up to depth 3. |
| `twining_graph_query` | Search entities by name or property substring. |

Note: `twining_decide` now auto-creates `file` and `function` entities with `decided_by` relations for its `affected_files` and `affected_symbols`. You only need manual graph calls for richer structure (imports, calls, implements, etc.).

#### Agent Coordination (multi-agent workflows)
| Tool | When to use |
|------|-------------|
| `twining_agents` | List all registered agents with capabilities and liveness status. |
| `twining_discover` | Find agents matching required capabilities, ranked by overlap and liveness. |
| `twining_delegate` | Post a delegation request with capability requirements. Returns suggested agents. |
| `twining_handoff` | Hand off work to another agent with results, context snapshot, and summary. |
| `twining_acknowledge` | Accept a handoff, recording who picked it up. |

#### Lifecycle
| Tool | When to use |
|------|-------------|
| `twining_status` | Health check — entry counts, decision counts, graph stats, warnings. |
| `twining_archive` | Archive old entries to reduce working set. Preserves decision entries. |
| `twining_export` | Export full state as markdown for handoff between context windows or documentation. |

### Scope Conventions

Scopes use path-prefix semantics:
- `"project"` — matches everything (broadest)
- `"src/auth/"` — matches anything under the auth module
- `"src/auth/jwt.ts"` — matches a specific file
- Decisions, entries, and graph queries all filter by scope

Use the narrowest scope that fits. `"project"` scope entries are always included in assembly results.

### Multi-Agent Coordination Patterns

#### Delegation pattern
```
# Agent A identifies work it can't do
twining_discover(required_capabilities=["database", "postgresql"])
twining_delegate(summary="Optimize slow user query", required_capabilities=["database"], urgency="high")
# Returns suggested agents ranked by match quality
```

#### Handoff pattern
```
# Agent A completes partial work and hands off
twining_handoff(
  source_agent="agent-a",
  target_agent="agent-b",
  summary="Auth refactoring — middleware done, routes remaining",
  results=[{description: "Extracted JWT middleware", status: "completed"},
           {description: "Route handler migration", status: "partial"}]
)
# Auto-assembles context snapshot with relevant decisions and warnings

# Agent B picks it up
twining_acknowledge(handoff_id="...", agent_id="agent-b")
```

#### Context window handoff
When a conversation is about to hit context limits:
```
twining_export(scope="src/auth/")
# Produces a self-contained markdown document with all decisions,
# blackboard entries, and graph state for the scope
# Start a new conversation and paste the export as context
```

### Dashboard

The web dashboard starts automatically on port 24282. Disable with `TWINING_DASHBOARD=0`, prevent browser auto-open with `TWINING_DASHBOARD_NO_OPEN=1`, or change the port with `TWINING_DASHBOARD_PORT=<port>`.

The dashboard provides read-only views of:
- Blackboard entries (filterable by type, scope, tags)
- Decision timeline (interactive vis-timeline)
- Knowledge graph (cytoscape.js visualization)
- Agent coordination state (registered agents, delegations, handoffs)

### Anti-patterns to Avoid

- **Don't use `twining_post` for decisions.** It will be rejected. Use `twining_decide` which captures rationale, detects conflicts, links the knowledge graph, and enables traceability.
- **Don't skip `twining_assemble` before starting work.** You'll miss decisions, warnings, and context that could prevent wasted effort or contradictory changes.
- **Don't use `"project"` scope for everything.** Narrow scopes make assembly results more relevant and reduce noise.
- **Don't record trivial decisions.** "Renamed variable from x to y" doesn't need a decision record. Reserve decisions for choices with alternatives and tradeoffs.
- **Don't forget `relates_to`.** When posting an answer, link it to the question. When posting a warning about a decision, link it to the decision ID.

---

## Serena Knowledge Graph Enrichment Workflow

When Serena MCP tools are available alongside Twining, agents should enrich Twining's knowledge graph after making decisions that affect code structure. This is an agent-mediated workflow — the agent orchestrates both Serena and Twining tools.

### After `twining_decide` (when decision affects code symbols):

1. **Identify affected symbols** from the decision's `affected_files` and `affected_symbols`
2. **Use Serena** to analyze the symbols:
   - `find_symbol` to get full symbol details (class, function, method)
   - `find_referencing_symbols` to discover usage patterns
   - `get_symbols_overview` for file-level structure
3. **Use Twining** to record the code structure:
   - `twining_add_entity` for each significant symbol (classes, key functions, modules)
   - `twining_add_relation` for dependencies between symbols (calls, imports, implements)
   - Link entities to decisions with `decided_by` relations
4. **Example flow:**
   ```
   # Agent makes a decision
   twining_decide(domain="architecture", scope="src/auth/", summary="Use JWT middleware pattern", ...)

   # Agent uses Serena to understand the code
   serena.find_symbol("JwtMiddleware")  # Get symbol details
   serena.find_referencing_symbols("JwtMiddleware")  # Find usage

   # Agent enriches Twining's knowledge graph
   twining_add_entity(name="JwtMiddleware", type="class", properties={file: "src/auth/jwt.ts"})
   twining_add_entity(name="AuthRouter", type="module", properties={file: "src/auth/router.ts"})
   twining_add_relation(source="AuthRouter", target="JwtMiddleware", type="imports")
   ```

Note: `twining_decide` now auto-creates basic `file`/`function` entities and `decided_by` relations. The Serena enrichment workflow adds richer structural detail (imports, calls, implements) beyond what the auto-population provides.

### When NOT to enrich:
- Trivial decisions (naming, formatting, config values)
- Decisions that don't affect code structure
- When Serena tools are not available in the current session
