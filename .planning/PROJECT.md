# Twining MCP Server

## What This Is

Twining is an MCP server for Claude Code that provides a shared coordination layer between AI agents. It combines a blackboard-pattern shared state system, a first-class decision log with full lifecycle management, a selective context assembler with semantic search, a lightweight knowledge graph, local ONNX embeddings, agent coordination with capability-based discovery, delegation matching, and structured handoffs — all backed by plain files (`.jsonl`/`.json`) that are git-trackable and human-inspectable. It includes an embedded web dashboard for browsing, searching, and visualizing all Twining state including agent coordination. It integrates with the GSD planning workflow (bidirectional state sync), git history (decision-to-commit traceability), and Serena code intelligence (agent-mediated knowledge graph enrichment).

## Core Value

Agents share *why* decisions were made, not just *what* was done — eliminating the information silos that degrade multi-agent coding workflows across context windows.

## Requirements

### Validated

- ✓ Blackboard system for shared state (post, read, query, recent) — v1
- ✓ Decision tracker with full rationale, alternatives, and traceability (decide, why, trace, reconsider, override) — v1
- ✓ Context assembler that builds tailored context packages per task (assemble, summarize, what_changed) — v1
- ✓ Knowledge graph for entity and relation tracking (add_entity, add_relation, neighbors, graph_query) — v1
- ✓ Local semantic search via ONNX embeddings with graceful fallback to keyword search — v1
- ✓ Lifecycle management (archive, status) — v1
- ✓ File-native storage — all state in `.twining/` as JSONL/JSON — v1
- ✓ Auto-initialization of `.twining/` directory on first tool call — v1
- ✓ Conflict detection for contradictory decisions in same scope — v1
- ✓ Advisory file locking for concurrent agent access — v1
- ✓ GSD planning bridge — `.planning/` state feeds context assembly; decisions sync to planning docs — v1.1
- ✓ Git commit linking — bidirectional decision-to-commit tracking (twining_link_commit, twining_commits) — v1.1
- ✓ Serena enrichment workflow — CLAUDE.md instructions for agent-mediated code graph population — v1.1
- ✓ `twining_search_decisions` tool — find decisions by keyword/semantic search with filters — v1.1
- ✓ `twining_export` tool — dump Twining state as single markdown document with scope filtering — v1.1
- ✓ Embedded web dashboard with HTTP server alongside stdio MCP — v1.2
- ✓ Operational stats — entry counts, decision counts, graph entity/relation counts, last activity — v1.2
- ✓ Search + filter — unified text search across blackboard/decisions/graph with faceted filtering — v1.2
- ✓ Decision timeline — chronological visualization with confidence/status color-coding — v1.2
- ✓ Knowledge graph visualization — interactive force-directed graph with click-to-expand neighbors — v1.2
- ✓ Dark mode theme with localStorage persistence and system preference detection — v1.2
- ✓ Agent registry with auto-registration and explicit registration with capabilities — v1.3
- ✓ Capability-based agent discovery with scored matching (70/30 capability/liveness) — v1.3
- ✓ Typed delegation needs on blackboard with urgency levels and auto-expiry — v1.3
- ✓ Structured handoffs with auto-assembled context snapshots and acknowledgment — v1.3
- ✓ Context assembly integration for handoff results and agent suggestions — v1.3
- ✓ Agent liveness tracking via last-activity inference (active/idle/gone) — v1.3
- ✓ Dashboard Agents tab with registry, delegation, and handoff views — v1.3

### Active

<!-- No active milestone — planning next -->

(No active requirements — next milestone not yet defined)

### Out of Scope

- Multi-agent registration and capability matching (formal protocol) — future milestone
- Learned relevance weights for delegation matching — future milestone
- Cross-repo Twining state — future milestone
- Decision impact analysis across agent boundaries — future milestone
- Hook-based pending-posts/actions processing — deferred, CLAUDE.md workflows preferred over hook plumbing
- Inline editing of state from dashboard — dashboard is read-only observer; MCP tools are the write interface
- WebSocket real-time updates — polling every 3s is sufficient; WebSockets add connection management complexity
- Custom dashboard layouts — no evidence users need customization; fixed opinionated layout
- Agent-to-agent messaging — MCP has no push channel; polling blackboard is equivalent
- Forced task assignment — violates blackboard self-selection principle; MCP can't push to agents
- Capability taxonomy/ontology — free-form tags with substring matching sufficient
- Agent authentication/authorization — not needed for local-only single-user MCP server
- Heartbeat/keepalive protocol — wastes tokens; liveness inferred from last_active timestamp
- Full context serialization in handoffs — store IDs and summaries instead
- Agent orchestrator/supervisor — human + blackboard pattern already coordinates

## Context

- **Runtime:** Node.js >= 18, TypeScript
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Embeddings:** `@huggingface/transformers` v3 with `all-MiniLM-L6-v2` (local ONNX, no API calls)
- **Dashboard:** Embedded HTTP server (native `node:http`), vanilla HTML/CSS/JS, cytoscape.js for graph, vis-timeline for timeline
- **IDs:** ULID (temporally sortable)
- **Package:** `twining-mcp` on npm
- **Design spec:** `TWINING-DESIGN-SPEC.md` is the authoritative reference for all data models, tool signatures, and behavior
- **Build order:** utils → storage → engine → embeddings → dashboard → tools → server/index (bottom-up)
- **Testing:** vitest with temp directories, 444 tests across 27 files
- **Current state:** v1.3 shipped — 23 MCP tools, ~6,943 LOC production TypeScript + 3,155 LOC frontend (HTML/CSS/JS) + 8,762 LOC tests
- **Dashboard port:** Default 24282, configurable via TWINING_DASHBOARD_PORT

## Constraints

- **Lazy embeddings**: ONNX model must be lazy-loaded and fall back gracefully to keyword search if unavailable. Server must never fail to start due to embedding issues.
- **File-native**: All state in `.twining/` directory — no external databases. JSONL for append-only streams, JSON for indexed data.
- **No direct fs from engine**: All file I/O goes through storage/ layer (exception: STATE.md sync uses direct fs since it's a GSD planning file, not Twining data).
- **Structured errors**: Tool handlers return structured error responses, never throw.
- **ULID IDs**: All IDs are ULIDs for temporal sortability.
- **Token estimation**: 4 chars per token approximation for context budget management.
- **Dashboard read-only**: Web dashboard is a read-only observer; all writes go through MCP tools.
- **Dashboard stdio safety**: Dashboard HTTP output never corrupts MCP stdio transport; all logging to stderr.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Blackboard pattern over pipeline | Agents self-select into work based on visible shared state; broadcasts needs rather than routing | ✓ Good — clean separation of concerns, scales to multiple consumers |
| JSONL for blackboard, JSON for decisions/graph | Append-only stream for high-frequency writes; indexed files for random access | ✓ Good — simple and reliable |
| ONNX local embeddings via @huggingface/transformers | Zero external dependencies, works offline, no API costs; transformers v3 handles tokenization+pooling | ✓ Good — lazy-load + permanent fallback works well |
| Cosine similarity brute-force search | Sufficient for <10k entries; optimize later if needed | ✓ Good — no perf issues observed |
| `proper-lockfile` for concurrent access | Advisory file locking prevents corruption from concurrent agent writes | ✓ Good — concurrency tests pass (3.5s) |
| Human-in-the-loop conflict resolution | Flag conflicts for human review rather than auto-resolving | ✓ Good — prefix-overlap scope detection works |
| Entity upsert by name+type pair | Prevents duplicate entities, merges properties on update | ✓ Good |
| BFS depth clamped to 3 | Prevents runaway traversals in dense graphs | ✓ Good |
| Weighted context scoring (0.3/0.4/0.2/0.1) | Recency, relevance, confidence, warning boost — balanced signals | ✓ Good |
| Permanent ONNX fallback once triggered | Avoids repeated expensive init failures; keyword search is adequate fallback | ✓ Good |
| commit_hashes as string[] (not single hash) | A decision may link to multiple commits over time (initial impl + fixes) | ✓ Good |
| PlanningBridge as dual output (metadata + scored finding) | Planning state always visible as metadata; also competes fairly for token budget as scored item | ✓ Good |
| Direct fs for STATE.md sync (not file-store) | STATE.md is a GSD planning file, not Twining data | ✓ Good |
| SearchEngine as optional constructor param | Loose coupling; DecisionEngine works without search, gains search when provided | ✓ Good |
| Agent-mediated Serena workflow (CLAUDE.md) | No direct MCP-to-MCP coupling; agent orchestrates both tool sets | ✓ Good |
| Embedded HTTP server (Serena-style) | In-process daemon, vanilla HTML/JS, minimal deps; matches proven pattern from Serena MCP | ✓ Good |
| Vendored visualization libraries | Committed to git for offline/airgapped support; avoids CDN dependency | ✓ Good |
| View-mode toggles within tabs | Table/Timeline for Decisions, Table/Visual for Graph; avoids tab proliferation | ✓ Good |
| textContent for all user data rendering | XSS prevention throughout dashboard; never innerHTML for user-provided content | ✓ Good |
| Delegations as blackboard entries with structured metadata | Reuses existing blackboard infrastructure; no separate delegation queue | ✓ Good — avoids fragmenting context assembly |
| Liveness inferred from last_active timestamp | No heartbeat protocol needed; configurable thresholds (active<5min, idle<30min, gone>30min) | ✓ Good — saves tokens |
| scoreAgent: 70% capability overlap + 30% liveness | Capability match is primary signal; liveness prevents stale suggestions | ✓ Good |
| Handoff context snapshots store IDs + summaries | Keeps handoffs compact; full context available via referenced IDs | ✓ Good — avoids bloated handoffs |
| Upsert merges capabilities via union | Additive registration preserves previously declared capabilities | ✓ Good |
| JSONL index for handoff listing | Append-friendly; avoids loading every individual JSON handoff file | ✓ Good |
| Handoff/agent data outside token budget in assembly | Like planning_state, always included as metadata; doesn't compete for budget | ✓ Good |
| Substring matching for capability-to-task matching | Bidirectional includes(); simple and sufficient for free-form tags | ✓ Good |

---
*Last updated: 2026-02-17 after v1.3 milestone*
