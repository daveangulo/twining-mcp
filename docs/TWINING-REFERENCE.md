# Twining Tool Reference

Full reference for all Twining MCP tools. See `CLAUDE.md` for mandatory workflow gates and core usage patterns.

---

## Tool Quick Reference

### Blackboard (shared communication)
| Tool | Purpose |
|------|---------|
| `twining_post` | Share findings, warnings, needs, questions, answers, status, offers, artifacts, constraints |
| `twining_read` | Read entries with filters (type, scope, tags, since, limit) |
| `twining_query` | Semantic search across entries (embeddings with keyword fallback) |
| `twining_recent` | Latest N entries, most recent first |

### Decisions (structured rationale)
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

### Context Assembly
| Tool | Purpose |
|------|---------|
| `twining_assemble` | Build tailored context for a task within a token budget |
| `twining_summarize` | Quick project overview with counts and activity narrative |
| `twining_what_changed` | Changes since a timestamp (decisions, entries, overrides) |

### Knowledge Graph
| Tool | Purpose |
|------|---------|
| `twining_add_entity` | Record a code entity (module, function, class, file, concept, pattern, dependency, api_endpoint) |
| `twining_add_relation` | Record a relationship (depends_on, implements, decided_by, affects, tested_by, calls, imports, related_to) |
| `twining_neighbors` | Explore entity connections up to depth 3 |
| `twining_graph_query` | Search entities by name or property |

Note: `twining_decide` auto-creates `file`/`function` entities with `decided_by` relations for `affected_files` and `affected_symbols`. Manual graph calls are for richer structure (imports, calls, implements).

### Agent Coordination
| Tool | Purpose |
|------|---------|
| `twining_agents` | List registered agents with capabilities and liveness |
| `twining_discover` | Find agents matching capabilities, ranked by overlap and liveness |
| `twining_delegate` | Post a delegation request with capability requirements |
| `twining_handoff` | Hand off work with results and auto-assembled context snapshot |
| `twining_acknowledge` | Accept a handoff |

### Verification
| Tool | Purpose |
|------|---------|
| `twining_verify` | Check test coverage, unresolved warnings, drift, assembly hygiene, and checkable constraints for a scope |

### Lifecycle
| Tool | Purpose |
|------|---------|
| `twining_status` | Health check — entry counts, decision counts, graph stats, warnings |
| `twining_archive` | Archive old entries to reduce working set (preserves decisions) |
| `twining_export` | Export full state as markdown for context window handoff or docs |

---

## Verification and Rigor

The verification step ensures decisions are backed by evidence and code hasn't drifted from documented intent.

### Decision-to-Test Traceability

Link tests to decisions to create an evidence trail:

```
# After recording the decision
twining_decide(
  domain="implementation",
  scope="src/auth/",
  summary="Use JWT for stateless auth",
  affected_files=["src/auth/middleware.ts"],
  ...
)

# After writing the test
twining_add_relation(
  source="src/auth/middleware.ts",
  target="test/auth.test.ts",
  type="tested_by",
  properties={ covers: "JWT middleware validation" }
)
```

The `twining_verify` tool checks for decisions without `tested_by` relations and flags them for review.

### Decision Conflict Detection

When `twining_decide` detects a conflict (same domain + overlapping scope + active status):

1. **The new decision is recorded normally** — decisions are never blocked by conflicts
2. **A warning is auto-posted to the blackboard** linking both decision IDs via `relates_to`
3. **Conflict metadata is recorded** on the new decision: `conflicts_with: [existing_id]`
4. **Both decisions remain active** until explicitly resolved

Resolution requires explicit action:
- Use `twining_override` to replace one decision (sets it to `overridden`, optionally creates replacement)
- Use `twining_reconsider` to flag one for review (sets to `provisional`)

Conflicts surface in the next `twining_assemble` call as high-priority warnings.

### Drift Detection

Decisions capture intent at a point in time. Code evolves. When a file listed in `affected_files` is modified after the decision timestamp without a superseding decision, that's **drift** — the documented rationale no longer matches reality.

`twining_verify` compares decision timestamps against git history for affected files and flags stale decisions.

### Checkable Constraints

Some constraints can be mechanically verified. Use the structured format:

```
twining_post(
  entry_type="constraint",
  summary="No direct fs calls outside storage/",
  detail='{"check_command": "grep -r \\"import.*node:fs\\" src/ --include=\\"*.ts\\" | grep -v storage/ | wc -l", "expected": "0"}',
  scope="src/"
)
```

The `twining_verify` tool executes `check_command` (sandboxed to project directory) and compares output against `expected`.

### Assembly-Before-Decision Tracking

If an agent calls `twining_decide` without having called `twining_assemble` in the same session, the decision was made without shared context. `twining_verify` checks for "blind decisions" and flags them.

---

## Multi-Agent Patterns

### Delegation
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

### Handoff (passing work between agents)
```
# Agent A verifies work before handing off
twining_verify(scope="src/auth/", checks=["test_coverage", "warnings"])

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
