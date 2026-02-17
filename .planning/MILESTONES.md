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

