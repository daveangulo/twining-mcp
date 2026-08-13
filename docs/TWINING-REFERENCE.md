# Twining Tool Reference

Full reference for all Twining MCP tools. See `CLAUDE.md` for mandatory workflow gates and core usage patterns.

---

## Core Tools (always registered)

| Tool | Gate | Purpose |
|------|------|---------|
| `twining_assemble` | Gate 1 | Build tailored context — decisions, warnings, handoffs, within a token budget |
| `twining_record` | Gate 2 | Record what you did and choices made — natural language parsed into structured decisions |
| `twining_post` | During work | Share findings, warnings, needs, or status updates |
| `twining_resolve` | During work | Mark open needs/questions/warnings handled — persists `status: "resolved"` with resolver identity and note; the record stays on the board as history. The everyday exit from the open lane (dismiss is for noise only) |
| `twining_why` | Gate 1 | Check what decisions constrain a file before modifying it |
| `twining_housekeeping` | Maintenance | Deduplicate, surface stale state, prune, rotate (dry-run by default). The board-archive pass is opt-in (`archive: true`) and retains the newest `archive.retain_recent` entries. Add `staleness_review: true` for orphan detection (missing scope/files/branch) or `merge_sweep: true` to flag entries from branches deleted since the last run |
| `twining_archive_stale` | Maintenance | Archive caller-confirmed IDs from `staleness_review` or `merge_sweep`. Decisions move to `archived` status; blackboard entries are dismissed. Provenance preserved. Warns on batches above 5% of live decisions — staleness scores are heuristics |
| `twining_unarchive` | Maintenance | Restore archived decisions to `active` — the undo for a bad archive sweep. Assemble/why report hidden archived decisions as `archived_excluded_count` |
| `twining_status` | Anytime | Health check — entry counts, decision counts, actionable warnings |
| `twining_archive` | Maintenance | Move blackboard entries to the archive tier. Takes no cutoff by default — an argument-free call archives everything archivable, so pass `before` or `retain` (keep newest N) unless a full sweep is intended |
| `twining_add_entity` | Optional | Record a code entity in the knowledge graph |
| `twining_add_relation` | Optional | Record a relationship in the knowledge graph |
| `twining_neighbors` | Optional | Explore entity connections up to depth 3 |
| `twining_graph_query` | Optional | Search graph entities by name or property |
| `twining_prune_graph` | Maintenance | Remove stale graph nodes |

That is the complete default surface — 15 tools. **If a tool is not in this table, it does not exist unless the project sets `tools.full_surface: true`.** Notably `twining_decide`, `twining_link_commit`, `twining_amend`, `twining_verify`, `twining_dismiss`, and `twining_handoff` are *not* available by default: use `twining_record` instead, whose `decisions` array writes to the same store and which also accepts `commit_hash`, `supersedes`, and `depends_on`. `supersedes` requires exactly one decision in the call — with several, the superseding record is ambiguous and the supersession is skipped with `supersedes_skipped: true` in the response; a nonexistent target is reported as `supersedes_dangling` instead of being silently ignored.

## Extended Tools (require `full_surface: true`)

These are **not** callable on a default install. Enable them in `.twining/config.yml`:

```yaml
tools:
  full_surface: true
```

### Blackboard (shared communication)
| Tool | Purpose |
|------|---------|
| `twining_read` | Read entries with filters (type, scope, tags, since, limit) |
| `twining_query` | Semantic search across entries (embeddings with keyword fallback) |
| `twining_recent` | Latest N entries, most recent first |
| `twining_dismiss` | Remove noise entries (false positives, duplicates, test debris). Deletes the live row; a tombstone with the reason is appended to `.twining/archive/`. Handled items should use the default-surface resolve tool instead |

### Decisions (structured rationale)
| Tool | Purpose |
|------|---------|
| `twining_decide` | Record a choice with rationale, alternatives, affected files/symbols, confidence |
| `twining_trace` | Trace decision dependencies upstream and downstream |
| `twining_reconsider` | Flag a decision for review with new context |
| `twining_override` | Replace a decision, recording who and why |
| `twining_promote` | Ratify a provisional decision |
| `twining_search_decisions` | Search decisions by keyword, domain, status, confidence |
| `twining_link_commit` | Link a git commit to a decision |
| `twining_amend` | Append-only affected_files/affected_symbols repair on an existing decision |
| `twining_commits` | Find decisions associated with a commit |

### Context Assembly
| Tool | Purpose |
|------|---------|
| `twining_summarize` | Quick project overview with counts and activity narrative |
| `twining_what_changed` | Changes since a timestamp (decisions, entries, overrides) |

### Triage
| Tool | Purpose |
|------|---------|
| `twining_triage` | Review queue for provisional decisions and open obligations |

Note: `twining_decide` auto-creates `file`/`function` entities with `decided_by` relations for `affected_files` and `affected_symbols`. Manual graph calls are for richer structure (imports, calls, implements).

### Agent Coordination
| Tool | Purpose |
|------|---------|
| `twining_agents` | List registered agents with capabilities and liveness |
| `twining_discover` | Find agents matching capabilities, ranked by overlap and liveness |
| `twining_delegate` | Post a delegation request with capability requirements |
| `twining_handoff` | **Deprecated in v2.0** — hand off work with results and auto-assembled context snapshot |
| `twining_acknowledge` | **Deprecated in v2.0** — accept a handoff |

> **Deprecation note (v2.0):** `twining_handoff`/`twining_acknowledge` are deprecated. Field usage shows real handoffs happen as rich, git-committed markdown documents; the structured API is too shallow for that job and saw zero field calls. The tools still work in v2.x. Their replacement — a redesign around document-shaped payloads, or removal in v3 — is tracked in [#33](https://github.com/daveangulo/twining-mcp/issues/33).

### Verification
| Tool | Purpose |
|------|---------|
| `twining_verify` | Check test coverage, unresolved warnings, drift, assembly hygiene, and checkable constraints for a scope |

### Lifecycle
| Tool | Purpose |
|------|---------|
| `twining_export` | Export full state as markdown for context window handoff or docs |

(`twining_status` and `twining_archive` are on the **default** surface — see the Core Tools table above.)

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

### Cross-Branch Contradictions (v2 contract)

On the v2 sqlite backend, sync is set-union by construction: records are immutable ULID-named files under `.twining/records/`, so a git merge is "both sets of files land" — conflict-free at merge time. The consequence (FOUNDATION-PLAN D3): **contradictory decisions made on different branches coexist after the merge**, each labeled with its provenance (agent, branch, timestamp).

Contradiction handling therefore happens at read time, not merge time:

1. `twining_assemble` and housekeeping surface cross-branch contradictions the same way as same-branch conflicts above
2. The staleness/reconsider flow archives the losers
3. Both decisions *were* made — surfacing, not silent merging, is the contract

This is a deliberate contract change in v2: teams should expect to occasionally see both sides of a branch-divergent decision in a briefing and resolve it with `twining_override` / `twining_reconsider`, rather than never seeing the contradiction at all.

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
