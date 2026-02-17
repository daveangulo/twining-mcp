# Milestones

## v1 Twining MCP Server (Shipped: 2026-02-17)

**Phases completed:** 3 phases, 6 plans
**Tests:** 221 passing across 16 files
**LOC:** ~3,936 production + 4,145 test = 8,081 TypeScript
**Timeline:** 2026-02-16 (~4 hours)
**Git range:** a1dfd7e..a24d0cc (27 commits)

**Key accomplishments:**
- File-native MCP server with blackboard and decision tracking over stdio, advisory locking, structured errors
- Lazy-loaded ONNX embeddings (all-MiniLM-L6-v2) with permanent keyword fallback if ONNX fails
- Token-budgeted context assembly with weighted multi-signal scoring (recency, relevance, confidence, warning boost)
- Knowledge graph with entity upsert, BFS neighbor traversal (depth 1-3), and context assembly integration
- Full decision lifecycle: trace dependency chains, reconsider, override with automatic conflict detection
- Blackboard archiver with timestamp-based partitioning, decision protection, and summary generation

**Tech debt carried forward:**
- Phase 1 missing VERIFICATION.md and SUMMARY.md (completed before those workflows existed)
- Phase 2 missing VERIFICATION.md
- writeJSONL exported from file-store.ts but unused by archiver

---

## v1.1 Integrations + Polish (Shipped: 2026-02-17)

**Phases completed:** 3 phases, 6 plans, 13 tasks
**Tests:** 274 passing across 18 files (+53 new)
**LOC:** ~5,204 production + 5,400 test = 10,604 TypeScript
**Timeline:** 2026-02-16 → 2026-02-17 (1 day)
**Git range:** fde5aa6..e25cbbe (13 code commits + 9 docs commits)
**MCP tools:** 22 (up from 18 in v1)

**Key accomplishments:**
- Bidirectional git commit linking — decisions track commits, commits queryable for decisions (twining_link_commit, twining_commits)
- GSD planning bridge — .planning/ state feeds context assembly and summarization; decisions sync back to STATE.md
- Serena enrichment workflow — CLAUDE.md documents agent-mediated knowledge graph population from code symbols
- Cross-scope decision search — twining_search_decisions with keyword/semantic search and domain/status/confidence filters
- Full state export — twining_export produces single markdown document of all Twining state with scope filtering

**Tech debt carried forward:**
- None (audit confirmed zero tech debt)

---


## v1.2 Web Dashboard (Shipped: 2026-02-17)

**Phases completed:** 4 phases, 10 plans
**Tests:** 312 passing across 20 files (+38 new)
**LOC:** ~5,673 production TypeScript + 2,799 frontend (HTML/CSS/JS) + 6,410 test
**Timeline:** 2026-02-16 → 2026-02-17 (1 day)
**Git range:** 157a3c1..05c5acf (16 feature commits, 37 total)
**MCP tools:** 22 (unchanged from v1.1)

**Key accomplishments:**
- Embedded HTTP server running alongside MCP stdio with fire-and-forget lifecycle, port retry, path traversal prevention, and graceful shutdown
- Full observability dashboard with 5 JSON API endpoints, tab navigation, sortable/paginated tables, detail inspector, and 3-second visibility-aware polling
- Unified search across blackboard, decisions, and graph with semantic/keyword fallback, faceted filtering, and cross-tab ULID navigation
- Decision timeline visualization with vis-timeline, confidence/status color-coding, and click-to-inspect detail
- Interactive knowledge graph visualization with cytoscape.js force-directed layout, entity type colors, and click-to-expand neighbors
- Dark mode theme with CSS custom properties, localStorage persistence, and system preference detection

**Tech debt carried forward:**
- None (audit confirmed zero tech debt)

---


## v1.3 Agent Coordination (Shipped: 2026-02-17)

**Phases completed:** 4 phases, 10 plans, 22 tasks
**Tests:** 444 passing across 27 files (+132 new)
**LOC:** ~6,943 production TypeScript + 3,155 frontend (HTML/CSS/JS) + 8,762 test
**Timeline:** 2026-02-16 → 2026-02-17 (2 days)
**Git range:** 977ff5c..224b81f (15 feature commits, 40 total)
**MCP tools:** 23 (up from 22 in v1.2; added twining_agents)

**Key accomplishments:**
- Agent registry with auto-registration on first tool call, explicit registration with capabilities/role/description, and OR-match capability discovery
- Coordination engine with scoreAgent (70/30 capability/liveness weighting), delegation posting with urgency-based timeouts (5min/30min/4hr), and auto-assembled context snapshots
- MCP tool surface (twining_agents for agent listing, enhanced twining_status with agent counts) and ContextAssembler integration with handoff results and capability-matched agent suggestions
- REST API endpoints for agent coordination state (/api/agents, /api/delegations, /api/handoffs) with inline liveness scoring
- Dashboard Agents tab with 3 sortable sub-views (agents/delegations/handoffs), namespaced badge styles, delegation expiry indicators, and handoff context snapshot detail panels

**Tech debt carried forward:**
- Test flake: handoff-store.test.ts timestamp ordering test (same-millisecond, not functional)
- Human verification recommended: dashboard visual appearance and dark mode for new badge styles

---

