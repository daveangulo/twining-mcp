# Twining Behavioral Specification

This document defines correct usage patterns for all 32 Twining MCP tools. It is the authoritative behavioral reference that the eval harness scores against. The document is both human-readable and machine-parseable using strict markdown conventions.

**Tiering:** Tier 1 tools are core workflow tools with full behavioral depth (context, rules, correct/incorrect usage examples). Tier 2 tools are supporting tools with lighter coverage (context and rules only).

**Rule levels:** MUST = required for correctness (violation causes data corruption, coordination failure, or silent information loss). SHOULD = strong recommendation (violation degrades quality). MUST_NOT = prohibited behavior.

---

## General Principles

### Task Completion Priority

| ID | Level | Rule |
|----|-------|------|
| GEN-01 | MUST | Prioritize task completion over coordination thoroughness. Complete your assigned work first, then record decisions and post status. A completed task with minimal coordination is better than an incomplete task with perfect coordination records. |
| GEN-02 | SHOULD | Keep coordination calls concise. Use short summaries and minimal detail fields. Don't spend significant time composing elaborate blackboard entries at the expense of productive work. |
| GEN-03 | MUST | Always call `twining_assemble` at session start before making decisions. This gathers prior context and prevents repeated mistakes. When working with other agents, also call `twining_register` to make yourself discoverable. |
| GEN-04 | SHOULD | Call `twining_handoff` before ending a session that made code changes. The next agent benefits from knowing what you did. A `twining_post` with entry_type "status" is the minimum requirement. |

---

## Tool Behaviors

### twining_post
<!-- tier: 1 -->

#### Context
Post an entry to the shared blackboard to share findings, needs, warnings, status updates, and other coordination messages with other agents. This is the primary communication channel between agents. Does NOT accept entry_type "decision" -- use twining_decide instead.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| POST-01 | MUST | entry_type must accurately reflect content: use "finding" for discoveries, "warning" for gotchas, "need" for requests, "status" for updates, "question" for unknowns, "answer" for responses, "constraint" for limitations, "artifact" for deliverables, "offer" for availability |
| POST-02 | MUST_NOT | Use entry_type "decision" with twining_post -- always use twining_decide for decisions |
| POST-03 | SHOULD | Include a scope narrower than "project" when the entry pertains to a specific area of the codebase |
| POST-04 | SHOULD | Keep summary under 200 characters and put details in the detail field |

#### Correct Usage
```json
{
  "entry_type": "warning",
  "summary": "Connection pooling leaks under load with this driver version",
  "detail": "pg-pool 3.2 has a known connection leak when queries time out during pool.connect(). Workaround: set connectionTimeoutMillis to 5000 and add explicit pool.end() in shutdown handler.",
  "scope": "src/database/",
  "tags": ["database", "performance"]
}
```

#### Incorrect Usage
```json
{
  "entry_type": "finding",
  "summary": "decided to use JWT",
  "scope": "project"
}
```
**Why incorrect:** Content is a decision but entry_type is "finding". Decisions must use twining_decide to get rationale tracking, conflict detection, and traceability. Scope is "project" when it only affects auth. Summary describes a decision, not a discovery.

### twining_read
<!-- tier: 1 -->

#### Context
Read blackboard entries with optional filters. Use this to check what other agents have posted, find relevant context, or review recent activity. Supports filtering by entry type, tags, scope (prefix match), timestamp, and result limit.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| READ-01 | SHOULD | Use scope filter with the narrowest prefix that covers your area of interest to avoid noise |
| READ-02 | SHOULD | Combine entry_types and scope filters rather than reading everything and filtering client-side |

#### Correct Usage
```json
{
  "entry_types": ["warning", "need"],
  "scope": "src/auth/",
  "limit": 20
}
```

#### Incorrect Usage
```json
{
  "limit": 1000
}
```
**Why incorrect:** Reading 1000 unfiltered entries wastes tokens and dilutes relevance. Use filters to narrow results.

### twining_query
<!-- tier: 2 -->

#### Context
Semantic search across blackboard entries. Uses embeddings when available, falls back to keyword search. Best for finding entries by meaning rather than exact filters.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| QUERY-01 | SHOULD | Use twining_read with filters for precise lookups; reserve twining_query for natural-language searches where you do not know exact entry types or tags |

### twining_recent
<!-- tier: 2 -->

#### Context
Quick access to the most recent blackboard entries. Useful for catching up on latest activity without specifying detailed filters.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| RECENT-01 | SHOULD | Prefer twining_read with a since timestamp for targeted catch-up; use twining_recent only when you want a quick glance at latest activity |

### twining_dismiss
<!-- tier: 2 -->

#### Context
Remove specific blackboard entries by ID. Use to clean up false-positive warnings, resolved entries, or noise. Returns which IDs were dismissed and which were not found.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| DISMISS-01 | SHOULD | Provide a reason when dismissing entries so the action is traceable in logs |
| DISMISS-02 | SHOULD | Only dismiss entries you have verified are no longer relevant; do not dismiss warnings you have not read |

### twining_decide
<!-- tier: 1 -->

#### Context
Record a decision with full rationale, alternatives considered, and traceability. Creates a decision record and cross-posts to the blackboard. This is the core value proposition of Twining -- preserving the "why" behind technical choices so future agents and sessions can understand, respect, or intentionally override past decisions.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| DECIDE-01 | MUST | Provide a specific, non-trivial rationale that explains the reasoning behind the choice -- not just "seemed right" or "best option" |
| DECIDE-02 | MUST | Include at least one rejected alternative with a reason_rejected explaining why it was not chosen -- even "do nothing" is a valid alternative |
| DECIDE-03 | MUST | Use twining_decide for all decisions, never twining_post with entry_type "decision" -- twining_decide provides conflict detection, rationale tracking, and traceability that twining_post lacks |
| DECIDE-04 | SHOULD | Use the narrowest scope that covers affected code rather than "project" |
| DECIDE-05 | SHOULD | Set confidence to "low" or "medium" for decisions that need validation through implementation |
| DECIDE-06 | SHOULD | Include affected_files to enable scope-based decision queries via twining_why |

#### Correct Usage
```json
{
  "domain": "architecture",
  "scope": "src/auth/",
  "summary": "Use JWT with RS256 for stateless authentication",
  "context": "The service needs to authenticate API requests across multiple instances without shared session storage",
  "rationale": "JWT with RS256 enables horizontal scaling without a session store. RS256 allows public key verification by downstream services without sharing the signing key. Token expiry provides automatic session invalidation.",
  "alternatives": [
    {
      "option": "Session cookies with Redis store",
      "pros": ["Simple implementation", "Easy revocation"],
      "cons": ["Requires Redis infrastructure", "Sticky sessions or shared store needed"],
      "reason_rejected": "Adds infrastructure dependency and complicates horizontal scaling"
    },
    {
      "option": "Do nothing (no auth)",
      "reason_rejected": "API endpoints contain sensitive data and must be authenticated"
    }
  ],
  "confidence": "high",
  "affected_files": ["src/auth/jwt.ts", "src/auth/middleware.ts"],
  "constraints": ["Must work behind load balancer", "No shared state between instances"]
}
```

#### Incorrect Usage
```json
{
  "domain": "implementation",
  "scope": "project",
  "summary": "Did the auth thing",
  "context": "needed auth",
  "rationale": "seemed right",
  "alternatives": []
}
```
**Why incorrect:** Scope is "project" instead of "src/auth/" -- the decision only affects the auth module. Summary is vague ("Did the auth thing" vs a clear statement of what was decided). Rationale lacks any specificity ("seemed right" provides no insight for future agents). Alternatives array is empty -- at minimum, one rejected alternative must be provided.

### twining_why
<!-- tier: 1 -->

#### Context
Retrieve all decisions affecting a given scope or file. Shows the decision chain with rationale, confidence, and alternatives count. Essential for understanding "why was it done this way?" before modifying code.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| WHY-01 | SHOULD | Call twining_why before modifying files that may have existing decisions to avoid contradicting active decisions |
| WHY-02 | SHOULD | Query at the file level (e.g., "src/auth/jwt.ts") rather than broad module level for targeted results |

#### Correct Usage
```json
{
  "scope": "src/auth/jwt.ts"
}
```

#### Incorrect Usage
```json
{
  "scope": "project"
}
```
**Why incorrect:** Querying "project" returns all decisions across the entire codebase. Use the specific file path or module path to get only relevant decisions.

### twining_trace
<!-- tier: 2 -->

#### Context
Trace a decision's dependency chain upstream (what it depends on) and/or downstream (what depends on it). Uses BFS with cycle protection. Useful for impact analysis before overriding or reconsidering a decision.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| TRACE-01 | SHOULD | Trace both directions before overriding a decision to understand downstream impact |

### twining_reconsider
<!-- tier: 2 -->

#### Context
Flag a decision for reconsideration. Sets active decisions to provisional status and posts a warning to the blackboard with downstream impact analysis. Use when new information suggests a decision may need revision.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| RECONSIDER-01 | SHOULD | Provide specific new_context explaining what changed, not just "needs review" |

### twining_override
<!-- tier: 2 -->

#### Context
Override a decision with a reason. Sets the decision to overridden status, records who overrode it and why, and optionally creates a replacement decision automatically. Use when a decision is definitively wrong or superseded.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| OVERRIDE-01 | SHOULD | Prefer twining_reconsider over twining_override when the decision might still be valid -- override is for definitive replacement |
| OVERRIDE-02 | SHOULD | Provide a new_decision summary when overriding to auto-create the replacement decision record |

### twining_promote
<!-- tier: 2 -->

#### Context
Promote one or more provisional decisions to active status. Use to confirm provisional decisions that have been validated through implementation and testing.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| PROMOTE-01 | SHOULD | Only promote decisions after validation (tests pass, design confirmed) rather than immediately after recording |

### twining_commits
<!-- tier: 2 -->

#### Context
Query decisions by commit hash. Returns all decisions linked to a given commit, enabling traceability from code changes back to decision rationale.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| COMMITS-01 | SHOULD | Use full commit hashes for reliable lookups rather than abbreviated hashes |

### twining_search_decisions
<!-- tier: 2 -->

#### Context
Search decisions across all scopes by keyword or semantic similarity. Returns ranked results without requiring a specific scope. Supports filtering by domain, status, and confidence level.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| SEARCH-01 | SHOULD | Use domain and status filters to narrow results when you know the decision category |

### twining_link_commit
<!-- tier: 2 -->

#### Context
Link a git commit hash to an existing decision. Enables bidirectional traceability between decisions and commits. Call after committing code that implements a decision.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| LINK-01 | SHOULD | Link commits to decisions promptly after committing, not as a batch at session end when context may be lost |

### twining_assemble
<!-- tier: 1 -->

#### Context
Build tailored context for a specific task. Returns relevant decisions, warnings, needs, findings, and questions within a token budget. This is the gateway to shared context -- call it before starting any task to get what other agents have posted.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| ASSEMBLE-01 | MUST | Call twining_assemble before making decisions in a new scope to ensure awareness of existing decisions, warnings, and context from other agents |
| ASSEMBLE-02 | SHOULD | Use the narrowest scope that covers your task area for better relevance |
| ASSEMBLE-03 | SHOULD | Provide a descriptive task string that helps the assembler prioritize relevant entries |

#### Correct Usage
```json
{
  "task": "Implement rate limiting middleware for the REST API",
  "scope": "src/api/middleware/",
  "max_tokens": 4000
}
```

#### Incorrect Usage
```json
{
  "task": "do stuff",
  "scope": "project"
}
```
**Why incorrect:** Task description is too vague for the assembler to prioritize relevant context. Scope is "project" when the work only involves API middleware. This returns diluted, irrelevant context that wastes tokens.

### twining_summarize
<!-- tier: 2 -->

#### Context
Get a high-level summary of project or scope state. Returns counts of active decisions, open needs, warnings, and a recent activity narrative. Lighter weight than twining_assemble.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| SUMMARIZE-01 | SHOULD | Use twining_assemble for task-specific context; use twining_summarize only for high-level project health overview |

### twining_what_changed
<!-- tier: 2 -->

#### Context
Report what changed since a given point in time. Returns new decisions, new entries, overridden decisions, and reconsidered decisions. Use to catch up on changes since you last checked.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| CHANGED-01 | SHOULD | Use a precise ISO 8601 timestamp from your session start rather than arbitrary timestamps |

### twining_add_entity
<!-- tier: 1 -->

#### Context
Add or update a knowledge graph entity. Uses upsert semantics: if an entity with the same name and type exists, its properties are merged and updated. Returns the entity ID. Use for recording code structure relationships.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| ENTITY-01 | MUST | Use a specific, unambiguous name that identifies the entity uniquely -- not generic names like "helper" or "utils" |
| ENTITY-02 | SHOULD | Use the most specific entity type: prefer "class" over "module" for a class, "function" over "module" for a standalone function |
| ENTITY-03 | SHOULD | Include properties that provide useful context (e.g., file path, layer, purpose) |

#### Correct Usage
```json
{
  "name": "AuthMiddleware",
  "type": "class",
  "properties": {
    "file": "src/auth/middleware.ts",
    "layer": "api",
    "purpose": "JWT validation and request authentication"
  }
}
```

#### Incorrect Usage
```json
{
  "name": "helper",
  "type": "module"
}
```
**Why incorrect:** "helper" is a generic name that could refer to anything -- multiple entities could have this name, making the graph ambiguous. No properties provided to disambiguate. Type "module" is less specific than what the entity likely is.

### twining_add_relation
<!-- tier: 1 -->

#### Context
Add a relation between two knowledge graph entities. Source and target can be entity IDs or names. Returns an error for ambiguous name matches. Use to capture dependencies, implementations, test coverage, and other structural relationships.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| RELATION-01 | MUST | Ensure both source and target entities exist before creating a relation -- add them with twining_add_entity first if needed |
| RELATION-02 | SHOULD | Use the most specific relation type: prefer "imports" over "depends_on" for import relationships, "tested_by" over "related_to" for test coverage |

#### Correct Usage
```json
{
  "source": "AuthMiddleware",
  "target": "JwtValidator",
  "type": "depends_on",
  "properties": {
    "reason": "AuthMiddleware delegates token validation to JwtValidator"
  }
}
```

#### Incorrect Usage
```json
{
  "source": "auth",
  "target": "jwt",
  "type": "related_to"
}
```
**Why incorrect:** Source and target names are ambiguous abbreviations that may not match existing entities. Relation type "related_to" is vague when "depends_on" or "imports" would be more specific and useful for graph queries.

### twining_neighbors
<!-- tier: 2 -->

#### Context
Traverse the knowledge graph from an entity, returning neighbors up to a given depth (max 3). Supports filtering by relation type. Useful for understanding how entities connect and for impact analysis.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| NEIGHBORS-01 | SHOULD | Start with depth 1 and increase only if needed -- depth 3 can return very large result sets |
| NEIGHBORS-02 | SHOULD | Use relation_types filter when looking for specific kinds of relationships |

### twining_graph_query
<!-- tier: 2 -->

#### Context
Search the knowledge graph for entities by name or property substring match. Case-insensitive. Returns matching entities with their properties.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| GRAPHQUERY-01 | SHOULD | Use entity_types filter to narrow search when you know what kind of entity you are looking for |

### twining_prune_graph
<!-- tier: 2 -->

#### Context
Remove orphaned knowledge graph entities that have no relations. Use to clean up stale or disconnected entities. Optionally filter by entity type.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| PRUNE-01 | SHOULD | Run with dry_run set to true first to preview what would be removed before actually pruning |

### twining_agents
<!-- tier: 2 -->

#### Context
List all registered agents with their capabilities and liveness status. Entry point for understanding the multi-agent landscape before coordination.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| AGENTS-01 | SHOULD | Check agent liveness status before delegating -- avoid delegating to "gone" agents |

### twining_register
<!-- tier: 2 -->

#### Context
Register a new agent or update an existing one. Merges capabilities on re-registration. Use to make subagents visible in the coordination dashboard.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| REGISTER-01 | SHOULD | Call twining_register when working with other agents or subagents. Use descriptive, kebab-case agent_id values that reflect what the agent does (e.g., "code-reviewer", not "agent1") |
| REGISTER-02 | MUST | Include capabilities and role to enable capability-based discovery via twining_discover |

### twining_discover
<!-- tier: 2 -->

#### Context
Find agents matching required capabilities, ranked by capability overlap and liveness. Returns scored agent list for delegation decisions.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| DISCOVER-01 | SHOULD | Use specific capability strings that match registered capabilities rather than generic terms |

### twining_delegate
<!-- tier: 2 -->

#### Context
Post a delegation request to the blackboard as a "need" entry with capability requirements. Returns suggested agents ranked by match quality. Use when you need another agent to do work.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| DELEGATE-01 | SHOULD | Set urgency appropriately -- "high" has a 5-minute timeout, "normal" has 30 minutes, "low" has 4 hours |
| DELEGATE-02 | SHOULD | Include a scope so the receiving agent can use twining_assemble to get relevant context |

### twining_handoff
<!-- tier: 1 -->

#### Context
Create a handoff record from one agent to another, capturing work results and auto-assembling a context snapshot. Posts a status entry to the blackboard. Use when transferring ownership of work.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| HANDOFF-01 | MUST | Include results with accurate status values -- do not mark "completed" for partial work, use "partial" or "blocked" instead |
| HANDOFF-02 | SHOULD | Provide a descriptive summary of what was accomplished and what remains for the receiving agent |
| HANDOFF-03 | SHOULD | Include artifact file paths in results so the receiving agent knows what was created or modified |

#### Correct Usage
```json
{
  "source_agent": "auth-implementer",
  "target_agent": "test-runner",
  "scope": "src/auth/",
  "summary": "JWT auth middleware implemented. Token validation and refresh logic complete. Integration tests needed.",
  "results": [
    {
      "description": "Implemented JWT validation middleware with RS256 support",
      "status": "completed",
      "artifacts": ["src/auth/middleware.ts", "src/auth/jwt.ts"],
      "notes": "Uses jose library for JWT operations"
    },
    {
      "description": "Integration tests for auth flow",
      "status": "blocked",
      "notes": "Needs test database fixture setup first"
    }
  ],
  "auto_snapshot": true
}
```

#### Incorrect Usage
```json
{
  "source_agent": "agent1",
  "summary": "done with auth",
  "results": [
    {
      "description": "auth stuff",
      "status": "completed"
    }
  ]
}
```
**Why incorrect:** Summary is vague and does not tell the receiving agent what was accomplished or what remains. Result description "auth stuff" provides no useful information. Status "completed" may be inaccurate if tests are still needed. No scope provided, so the receiving agent cannot assemble relevant context. No artifacts listed.

### twining_acknowledge
<!-- tier: 2 -->

#### Context
Acknowledge receipt of a handoff, recording which agent picked it up. The receiving agent should call this after reviewing the handoff to confirm they have the context.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| ACK-01 | SHOULD | Acknowledge handoffs promptly after reviewing them so the source agent knows the work was received |

### twining_status
<!-- tier: 1 -->

#### Context
Overall health check of the Twining state. Shows blackboard entry count, decision counts, graph entity/relation counts, agent counts, actionable warnings, and a human-readable summary. No input parameters required.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| STATUS-01 | SHOULD | Call twining_status at session start to get a quick overview before diving into twining_assemble |
| STATUS-02 | SHOULD | Review the warnings array in the response and address actionable items (stale provisionals, archiving needs, orphan entities) |

#### Correct Usage
```json
{}
```

#### Incorrect Usage
```json
{}
```
**Why incorrect:** There is no incorrect way to call twining_status since it takes no required parameters. The anti-pattern is failing to call it at all -- skipping the health check means missing stale provisionals, archiving needs, or other warnings.

### twining_archive
<!-- tier: 2 -->

#### Context
Archive old blackboard entries. Moves entries older than a cutoff timestamp to an archive file, preserving decision entries. Optionally posts a summary finding.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| ARCHIVE-01 | SHOULD | Keep keep_decisions set to true (default) to preserve decision cross-posts in the active blackboard |
| ARCHIVE-02 | SHOULD | Only archive when twining_status warns about high entry counts, not preemptively |

### twining_verify
<!-- tier: 1 -->

#### Context
Run verification checks on a scope. Checks test coverage (tested_by relations), warnings acknowledgment, assembly-before-decision tracking, drift detection, and constraints. Auto-posts a finding with the summary.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| VERIFY-01 | MUST | Run twining_verify before declaring work complete, handing off, or ending a session |
| VERIFY-02 | SHOULD | Include all relevant checks rather than skipping checks to get a clean result |
| VERIFY-03 | SHOULD | Address issues found by verification rather than ignoring warnings or failures |

#### Correct Usage
```json
{
  "scope": "src/auth/",
  "checks": ["test_coverage", "warnings", "assembly", "drift", "constraints"],
  "fail_on": ["warnings"]
}
```

#### Incorrect Usage
```json
{
  "scope": "project",
  "checks": ["test_coverage"]
}
```
**Why incorrect:** Scope is "project" when work was only on auth. Running only one check (test_coverage) while skipping warnings, assembly, drift, and constraints defeats the purpose of pre-completion verification.

### twining_export
<!-- tier: 2 -->

#### Context
Export full Twining state as a single markdown document. Includes blackboard entries, decisions with full rationale, and knowledge graph entities and relations. Use for handoff between context windows, documentation, or debugging.

#### Rules
| ID | Level | Rule |
|----|-------|------|
| EXPORT-01 | SHOULD | Provide a scope filter to export only the relevant subset rather than the entire project state |

---

## Workflows

### workflow: orient
| Step | Tool | Purpose |
|------|------|---------|
| 1 | twining_status | Check project health, warnings, and agent activity |
| 2 | twining_assemble | Build task-specific context with relevant decisions, warnings, and needs |
| 3 | twining_why | Understand existing decisions for target files before modifying them |

### workflow: decide
| Step | Tool | Purpose |
|------|------|---------|
| 1 | twining_assemble | Gather existing context for the decision scope |
| 2 | twining_decide | Record the decision with rationale, alternatives, and affected files |
| 3 | twining_post | Post related findings or warnings discovered during decision-making |
| 4 | twining_link_commit | Link the implementing commit to the decision for traceability |

### workflow: verify
| Step | Tool | Purpose |
|------|------|---------|
| 1 | twining_verify | Run all verification checks on the work scope |
| 2 | twining_what_changed | Review all changes made during the session |
| 3 | twining_link_commit | Link any unlinked commits to their decisions |
| 4 | twining_post | Post a status entry summarizing completed work |

### workflow: handoff
| Step | Tool | Purpose |
|------|------|---------|
| 1 | twining_verify | Verify work quality before handing off |
| 2 | twining_handoff | Create structured handoff with results and context snapshot |
| 3 | twining_acknowledge | Receiving agent confirms receipt of the handoff |

### workflow: coordinate
| Step | Tool | Purpose |
|------|------|---------|
| 1 | twining_agents | List registered agents and their liveness status |
| 2 | twining_discover | Find agents matching required capabilities for the task |
| 3 | twining_delegate | Post delegation request with capability requirements and urgency |
| 4 | twining_recent | Monitor for acknowledgment and progress updates |

### workflow: review
| Step | Tool | Purpose |
|------|------|---------|
| 1 | twining_what_changed | See all decisions and entries from the session |
| 2 | twining_trace | Check decision dependency chains for completeness |
| 3 | twining_search_decisions | Find related decisions that should be linked |
| 4 | twining_commits | Verify commit-to-decision linkage |
| 5 | twining_link_commit | Link any unlinked commits |

### workflow: dispatch
| Step | Tool | Purpose |
|------|------|---------|
| 1 | twining_register | Register the subagent with capabilities and role |
| 2 | twining_delegate | Post delegation with required capabilities and scope |
| 3 | twining_handoff | Create handoff record after subagent completes work |
| 4 | twining_acknowledge | Acknowledge receipt of the handoff results |

### workflow: new-session-lifecycle
| Step | Tool | Purpose |
|------|------|---------|
| 1 | twining_status | Health check and orientation at session start |
| 2 | twining_assemble | Build context for the planned task |
| 3 | twining_why | Review decisions for files to be modified |
| 4 | twining_decide | Record any architectural or implementation decisions |
| 5 | twining_verify | Pre-completion verification of all work |
| 6 | twining_post | Post status summary of session accomplishments |

### workflow: conflict-resolution
| Step | Tool | Purpose |
|------|------|---------|
| 1 | twining_search_decisions | Find the conflicting decisions |
| 2 | twining_trace | Analyze upstream and downstream dependencies of each |
| 3 | twining_reconsider | Flag the weaker decision for reconsideration |
| 4 | twining_decide | Record the resolution as a new decision that supersedes |
| 5 | twining_override | Override the old decision with reference to the new one |

---

## Power User Workflows

These workflows are optional — the knowledge graph is auto-populated from tool calls (`twining_decide`, `twining_post`, `twining_handoff`, `twining_link_commit`). Manual graph building is only needed for advanced structural mapping.

### workflow: map
| Step | Tool | Purpose |
|------|------|---------|
| 1 | twining_add_entity | Record significant code components as graph entities |
| 2 | twining_add_relation | Capture structural relationships between entities |
| 3 | twining_neighbors | Verify the graph captures intended relationships |
| 4 | twining_prune_graph | Clean up orphaned entities from exploratory work |

---

## Anti-Patterns

### anti-pattern: fire-and-forget-decisions
**Description:** Recording decisions without linking commits, checking for conflicts, or following up with verification. The decision exists in isolation, disconnected from the code it describes.
**Bad:**
Call twining_decide, then immediately move on to the next task without calling twining_link_commit after committing or twining_verify before completing.
**Good:**
After twining_decide, implement the change, commit, call twining_link_commit with the decision ID and commit hash, then call twining_verify before declaring the work complete.

### anti-pattern: scope-inflation
**Description:** Using "project" as the scope when a more specific path prefix exists. Broad scopes dilute relevance in assembly, cause decisions to match unrelated queries, and make verification checks less meaningful.
**Bad:**
twining_decide with scope "project" for a decision that only affects authentication code. twining_assemble with scope "project" when only working on the database module.
**Good:**
twining_decide with scope "src/auth/" for auth decisions. twining_assemble with scope "src/database/" when working on database code. Use the narrowest path prefix that covers the affected area.

### anti-pattern: rationale-poverty
**Description:** Providing vague, generic rationale that gives future agents no useful insight into why a decision was made. The decision record exists but is information-poor.
**Bad:**
twining_decide with rationale "seemed right" or "best option" or "standard approach". These tell future agents nothing about the actual reasoning.
**Good:**
twining_decide with rationale "JWT with RS256 enables horizontal scaling without a session store. RS256 allows public key verification by downstream services without sharing the signing key." Specific, actionable reasoning that future agents can evaluate.

### anti-pattern: blackboard-spam
**Description:** Posting low-value entries that clutter the blackboard and dilute the signal-to-noise ratio. Findings that restate what the code already says, status updates for trivial actions, or warnings about non-issues.
**Bad:**
twining_post with entry_type "finding" and summary "The function uses async/await" -- this is visible in the code and provides no insight. Posting a status entry for every small edit.
**Good:**
twining_post with entry_type "finding" and summary "pg-pool 3.2 connection leak under timeout -- workaround needed" -- this is a non-obvious discovery that saves future agents debugging time. Post status entries at task completion boundaries, not for every minor action.

### anti-pattern: blind-decisions
**Description:** Making decisions without first calling twining_assemble to check existing decisions and warnings in the scope. This risks contradicting active decisions or missing warnings left by previous agents.
**Bad:**
Immediately call twining_decide in a scope you have not assembled context for. The decision may conflict with an existing active decision you did not know about.
**Good:**
Call twining_assemble with the decision scope first, review existing decisions and warnings, then call twining_decide with awareness of the current state. The verify check "assembly" tracks this.

---

## Quality Criteria

### quality: scope-precision
| Level | Description | Example |
|-------|-------------|---------|
| good | Narrowest path prefix that covers the affected area | "src/auth/jwt.ts" for a single-file decision, "src/auth/" for a module-level decision |
| acceptable | Module-level prefix when file-level is possible but multiple files are involved | "src/auth/" when the decision affects jwt.ts, middleware.ts, and types.ts |
| bad | Overly broad scope that matches unrelated areas | "project" for a decision that only affects authentication code |

### quality: rationale-quality
| Level | Description | Example |
|-------|-------------|---------|
| good | Specific reasoning that references concrete tradeoffs, constraints, and consequences | "JWT with RS256 enables horizontal scaling without session store. RS256 allows public key verification by downstream services." |
| acceptable | Directionally correct reasoning with some specificity | "JWT is better for our microservice architecture than sessions" |
| bad | Vague or tautological reasoning that provides no insight | "seemed right", "best option", "standard approach", "obvious choice" |

### quality: parameter-content
| Level | Description | Example |
|-------|-------------|---------|
| good | All fields populated with specific, actionable content matching the field purpose | summary: "Use JWT with RS256 for stateless authentication" -- clear statement of what was decided |
| acceptable | Required fields populated, optional fields mostly empty, content is correct but generic | summary: "Use JWT for auth" -- correct but could be more specific about the algorithm and why |
| bad | Fields populated with placeholder or misleading content that does not match the field purpose | summary: "auth stuff" -- vague, does not describe the actual decision; entry_type: "finding" for a decision |

### quality: alternative-depth
| Level | Description | Example |
|-------|-------------|---------|
| good | Multiple alternatives with pros, cons, and specific reason_rejected for each | Two alternatives each with 2+ pros, 2+ cons, and a reason_rejected that references the project context |
| acceptable | At least one alternative with a reason_rejected that explains the tradeoff | One alternative with a clear reason_rejected: "Requires Redis infrastructure" |
| bad | Empty alternatives array or alternatives with trivial reason_rejected | alternatives: [] or reason_rejected: "not good enough" |
