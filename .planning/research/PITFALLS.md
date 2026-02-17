# Domain Pitfalls: Agent Coordination for Twining v1.3

**Domain:** Agent Registry, Capability Matching, Delegation, and Handoffs
**Researched:** 2026-02-17

## Critical Pitfalls

Mistakes that cause rewrites or major issues.

### Pitfall 1: Parallel Data Structure for Delegations
**What goes wrong:** Creating a separate delegation queue/file alongside the blackboard, leading to two places where "needs" live. Context assembly has to query both. Agents have to check both. Dashboard has to display both.
**Why it happens:** Natural instinct to create a new data model for a new concept, forgetting the blackboard already has `entry_type: "need"`.
**Consequences:** Fragmented state, duplicated queries in context assembly, inconsistent views across tools, doubled maintenance surface.
**Prevention:** Delegations ARE blackboard entries. The `twining_delegate` tool posts a regular "need" entry with structured metadata in the `detail` field. No new append-only stream needed. The `DelegationMatcher` parses metadata from existing entries.
**Detection:** If you find yourself adding a new JSONL file for delegations, stop. Use the blackboard.

### Pitfall 2: Breaking Backward Compatibility in ContextAssembler
**What goes wrong:** Making `HandoffStore` or `AgentStore` required constructor parameters in `ContextAssembler`, breaking all existing tests and the non-coordination code path.
**Why it happens:** Forgetting that the assembler is constructed in multiple places (server.ts, api-routes.ts, tests) and all must be updated simultaneously.
**Consequences:** Compilation failures across test suite, broken dashboard API, potential runtime errors.
**Prevention:** Follow the established pattern: new stores are optional constructor parameters with null defaults (`handoffStore?: HandoffStore | null`). Existing call sites don't change. New features are gated behind `if (this.handoffStore)` checks.
**Detection:** If any existing test fails after adding agent coordination, the integration is too tightly coupled.

### Pitfall 3: Heartbeat-Based Liveness
**What goes wrong:** Designing a heartbeat protocol where agents must periodically call `twining_heartbeat` to stay "alive." Agents that forget (or don't implement it) appear dead.
**Why it happens:** Heartbeats are the standard approach in distributed systems. Tempting to port the pattern.
**Consequences:** Wasted tokens on heartbeat calls (each MCP tool call costs API tokens). New agents that don't know about heartbeats appear inactive. Coordination overhead exceeds coordination value. The MCP request/response model has no background channel for keepalive.
**Prevention:** Infer liveness from `last_active` timestamps. Any Twining tool call updates the agent's `last_active`. Status thresholds: <5min = active, <1hr = idle, >1hr = gone.
**Detection:** If you're defining a `twining_heartbeat` tool, reconsider.

### Pitfall 4: Forced Assignment Violating Self-Selection
**What goes wrong:** `twining_delegate` assigns work to a specific agent. The assigned agent never picks it up because it's not monitoring for assignments, or it's already busy, or it doesn't exist anymore.
**Why it happens:** Pipeline thinking ("route task to worker") instead of blackboard thinking ("broadcast need, agents self-select").
**Consequences:** Stuck delegations. Agents waiting for assigned agents that never come. The orchestrating agent has to handle failure/timeout for each assignment. Creates coupling between delegator and specific agents.
**Prevention:** `twining_delegate` posts a need and returns suggestions. It does NOT assign. The consuming agent voluntarily picks up work by reading needs and calling `twining_handoff` when done.
**Detection:** If the delegation response includes an "assigned_to" field, the design has gone wrong.

## Moderate Pitfalls

### Pitfall 5: Stale Agent Registry
**What goes wrong:** Agents register once and never update. The registry fills with "gone" agents from past sessions. Discovery returns agents that no longer exist.
**Prevention:** Two mechanisms: (1) Upsert-by-name so re-registration from a new session updates the existing record. (2) `twining_discover` filters by liveness status by default (active only), with `include_idle` opt-in. Old agents gracefully age to "gone" status without manual cleanup.

### Pitfall 6: Handoff Context Drift
**What goes wrong:** Agent A creates a handoff with a context snapshot. By the time Agent B reads it, the referenced decisions have been superseded or overridden. Agent B acts on stale context.
**Prevention:** The context snapshot stores decision IDs and their status at snapshot time. The consuming agent should call `twining_assemble` (which returns current state) and compare with the snapshot to detect drift. Document this in tool descriptions so agents know to verify.

### Pitfall 7: Capability String Explosion
**What goes wrong:** No conventions for capability naming. One agent registers `["TypeScript"]`, another `["typescript"]`, another `["ts"]`. Matching fails on case/synonym differences.
**Prevention:** (1) Normalize capabilities to lowercase on registration. (2) Document recommended capability vocabulary in CLAUDE.md instructions. (3) Use substring matching in discovery so "type" matches "typescript". Accept some fuzziness -- perfect matching is an anti-feature (see capability ontology anti-pattern).

### Pitfall 8: Circular Dependency in Engine Construction
**What goes wrong:** `AgentEngine` needs `ContextAssembler` (for handoff context snapshots). `ContextAssembler` needs `AgentStore` and `HandoffStore` (for assembly integration). If `AgentEngine` also needs to be injected into `ContextAssembler`, you get a circular dependency.
**Prevention:** Keep the dependency graph acyclic. `AgentEngine` calls `ContextAssembler.assemble()` to create context snapshots for handoffs -- this is a method call, not a constructor dependency. `ContextAssembler` receives `HandoffStore` and `AgentStore` directly (not `AgentEngine`). The two modules share stores but don't depend on each other.

### Pitfall 9: Dashboard API Creating Duplicate Store Instances
**What goes wrong:** The dashboard `api-routes.ts` already creates its own store instances in a closure. Adding `AgentStore` and `HandoffStore` creates a second set of instances that may read stale data if the MCP-side stores have pending writes.
**Prevention:** This is an existing pattern -- the dashboard reads files directly, same as the MCP stores do. File locking ensures write consistency. Reads are eventually consistent (dashboard polls every 3s). No architectural change needed -- just create `AgentStore` and `HandoffStore` in the `createApiHandler` closure alongside existing stores.

## Minor Pitfalls

### Pitfall 10: Over-Indexing Handoff Records
**What goes wrong:** Creating too many index fields for handoffs (by agent, by scope, by status, by delegation_id). Each index field must be maintained on every write.
**Prevention:** Start with a minimal index (id, need_id, from_agent, summary, scope, status, created_at). Add index fields only when queries demand them. Linear scan of the index is fine for <1000 handoffs.

### Pitfall 11: Embedding Integration for Agent Records
**What goes wrong:** Trying to generate embeddings for agent capabilities or handoff results, adding coupling to the lazy-loaded embedding system.
**Prevention:** Skip embeddings for v1.3. Agent discovery uses tag matching (precise, fast). Handoff results are found by scope/need_id reference, not semantic search. Embeddings can be added later if needed.

### Pitfall 12: Dashboard Tab Proliferation
**What goes wrong:** Adding a new "Agents" tab, a "Delegations" tab, and a "Handoffs" tab, creating 8+ tabs total.
**Prevention:** Single "Agents" tab with three views: Registry list (default), Pending Delegations, Handoff History. Use view-mode toggles within the tab, same pattern as Decisions tab (table/timeline) and Graph tab (table/visual).

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| Types + Storage (Phase 1) | Over-designing AgentRecord with too many fields | Start minimal: name, capabilities, last_active. Extend later. |
| Types + Storage (Phase 1) | Handoff store not following decision store patterns | Copy DecisionStore structure exactly: individual files + index.json |
| Engine (Phase 2) | AgentEngine doing too much -- registration + discovery + delegation + handoff in one class | Consider splitting into focused methods, but keep as one class. The existing DecisionEngine handles decide + why + trace + reconsider + override in one class -- same pattern. |
| Engine (Phase 2) | Delegation matching being too clever (ML, embeddings) | Simple tag AND-match. "Required: [testing, typescript]" matches agents with both tags. Return all matches, sorted by overlap count. |
| Integration (Phase 3) | Breaking existing context assembly tests | New params are optional with null defaults. Add new test file, don't modify existing context-assembler.test.ts heavily. |
| Integration (Phase 3) | `twining_status` bloat -- too much agent info in status | Just add `registered_agents: number, active_agents: number`. Keep it as counts, not full listings. |
| Dashboard (Phase 4) | Agent status indicators not updating | Dashboard polls every 3s. Status is inferred from timestamps on each request. No caching issues. |
| Dashboard (Phase 4) | Handoff detail view being empty | Ensure API endpoint loads full handoff record (not just index entry) for detail display. |

## Sources

- Twining codebase analysis -- existing patterns, constructor signatures, test structure
- [Blackboard Architecture Pitfalls](https://arxiv.org/html/2507.01701v1) -- Over-engineering control mechanisms
- [Claude Code Agent Teams Known Limitations](https://code.claude.com/docs/en/agent-teams) -- Session resumption, task coordination failures
- [Multi-Agent Coordination Overhead](https://www.theamericanjournals.com/index.php/tajet/article/view/7396) -- 12-18% coordination overhead finding
