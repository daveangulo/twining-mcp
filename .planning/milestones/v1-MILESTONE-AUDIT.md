---
milestone: v1
audited: 2026-02-17T00:20:00Z
status: tech_debt
scores:
  requirements: 38/38
  phases: 3/3
  integration: 27/27 connected (1 orphaned export)
  flows: 7/7
gaps:
  requirements: []
  integration: []
  flows: []
tech_debt:
  - phase: 01-foundation-core-data
    items:
      - "Missing VERIFICATION.md — phase was completed before verification workflow existed"
      - "Missing SUMMARY.md files — no formal execution summary"
  - phase: 02-intelligence
    items:
      - "Missing VERIFICATION.md — phase was completed before verification workflow existed"
  - phase: 03-graph-lifecycle
    items:
      - "writeJSONL exported from file-store.ts but unused — archiver uses inline fs.writeFileSync instead"
---

# v1 Milestone Audit Report

**Milestone:** Twining MCP Server v1
**Audited:** 2026-02-17
**Status:** TECH_DEBT — All requirements met, no critical blockers, accumulated procedural gaps

## Executive Summary

All 38 v1 requirements are satisfied. The test suite (221 tests across 16 files) passes completely. All 7 E2E user flows verified end-to-end. Cross-phase integration is correct with 27 exports properly wired. Two phases (1 and 2) are missing formal VERIFICATION.md files, and one orphaned export exists in Phase 3.

## Requirements Coverage

### Phase 1: Foundation + Core Data (17 requirements)

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| FOUND-01 | Auto-create `.twining/` on first tool call | ✓ Satisfied | init.ts tested, integration checker verified |
| FOUND-02 | All IDs are ULIDs | ✓ Satisfied | ids.ts with ULID generation, used throughout |
| FOUND-03 | Advisory file locking for concurrent access | ✓ Satisfied | proper-lockfile in file-store.ts, concurrency tests pass (3.5s) |
| FOUND-04 | Structured error responses, never crash | ✓ Satisfied | toolResult/toolError pattern in all tool handlers |
| FOUND-05 | Token estimation (4 chars/token) | ✓ Satisfied | tokens.ts utility used by context assembler |
| FOUND-06 | Config from `.twining/config.yml` | ✓ Satisfied | Config loading in server.ts, defaults applied |
| BLKB-01 | Post entries with type/summary/tags/scope | ✓ Satisfied | twining_post tool, BlackboardEngine.post() |
| BLKB-02 | Read entries filtered by type/tags/scope/time | ✓ Satisfied | twining_read tool, BlackboardStore.read() |
| BLKB-04 | Retrieve N most recent entries | ✓ Satisfied | twining_recent tool |
| BLKB-05 | Append-only JSONL storage | ✓ Satisfied | blackboard-store.ts uses appendJSONL |
| BLKB-06 | 10 entry types supported | ✓ Satisfied | Type union in types.ts |
| DCSN-01 | Record decision with rationale/alternatives/confidence | ✓ Satisfied | twining_decide tool, DecisionEngine.decide() |
| DCSN-02 | Retrieve decisions by scope (twining_why) | ✓ Satisfied | twining_why tool, DecisionEngine.why() |
| DCSN-06 | Decisions as JSON files with index | ✓ Satisfied | decision-store.ts with individual files + index |
| MCPI-01 | MCP SDK with Zod schemas | ✓ Satisfied | All tools use z.object() for input validation |
| MCPI-02 | stdio transport | ✓ Satisfied | StdioServerTransport in index.ts |
| MCPI-03 | Installable via npx | ✓ Satisfied | Package configured with bin entry |

**Evidence:** 221 tests pass (Phase 3 verification confirmed 192 tests from Phases 1-2). Integration checker verified all Phase 1 exports wired correctly.
**Gap:** No formal VERIFICATION.md exists for this phase.

### Phase 2: Intelligence (9 requirements)

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| EMBD-01 | Local ONNX embeddings (all-MiniLM-L6-v2, 384d) | ✓ Satisfied | embedder.ts with @huggingface/transformers |
| EMBD-02 | Lazy-loaded on first use | ✓ Satisfied | Pipeline loaded in first embed() call, never at import |
| EMBD-03 | Graceful fallback if ONNX fails | ✓ Satisfied | Permanent fallback to keyword search, 8 embedder tests |
| EMBD-04 | Embeddings for every entry and decision | ✓ Satisfied | Hooks in BlackboardEngine.post() and DecisionEngine.decide() |
| BLKB-03 | Semantic search by natural language | ✓ Satisfied | twining_query tool, cosine similarity + keyword fallback |
| CTXA-01 | Token-budgeted context packages | ✓ Satisfied | twining_assemble with weighted scoring |
| CTXA-02 | High-level project summary | ✓ Satisfied | twining_summarize tool |
| CTXA-03 | What changed since timestamp | ✓ Satisfied | twining_what_changed tool |
| CTXA-04 | Weighted scoring (recency/relevance/confidence/warning) | ✓ Satisfied | ContextAssembler scoring formula verified |

**Evidence:** Plan summaries confirm all 9 requirements completed. 40 embedding tests + 32 context tests pass. Integration checker verified Phase 2 → Phase 3 wiring.
**Gap:** No formal VERIFICATION.md exists for this phase.

### Phase 3: Graph + Lifecycle (12 requirements)

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| GRPH-01 | Add entities (8 types) | ✓ Satisfied | GraphStore.addEntity with upsert, twining_add_entity |
| GRPH-02 | Add relationships (8 types) | ✓ Satisfied | GraphStore.addRelation with entity resolution |
| GRPH-03 | Neighbors traversal (configurable depth) | ✓ Satisfied | BFS depth 1-3, cycle protection, twining_neighbors |
| GRPH-04 | Query entities by name/properties | ✓ Satisfied | Case-insensitive substring, twining_graph_query |
| DCSN-03 | Trace dependency chain | ✓ Satisfied | BFS upstream/downstream/both, twining_trace |
| DCSN-04 | Flag for reconsideration | ✓ Satisfied | active→provisional with warnings, twining_reconsider |
| DCSN-05 | Human override with reason | ✓ Satisfied | Override with optional replacement, twining_override |
| DCSN-07 | Conflict detection | ✓ Satisfied | Same domain + prefix-overlap scope detection |
| LIFE-01 | Archive old blackboard entries | ✓ Satisfied | Timestamp-based partitioning, twining_archive |
| LIFE-02 | Archive generates summary finding | ✓ Satisfied | Template-based summary posted to blackboard |
| LIFE-03 | Decisions never archived | ✓ Satisfied | Decision protection in partition logic |
| LIFE-04 | Health/status check | ✓ Satisfied | Enhanced twining_status with graph counts + warnings |

**Evidence:** Formal VERIFICATION.md: PASSED, 6/6 success criteria, all 12 requirements verified with code line references.

## Cross-Phase Integration

### Wiring Status

| Connection | From → To | Status |
|------------|-----------|--------|
| BlackboardEngine → Embedder | Phase 1 → Phase 2 | ✓ Connected |
| BlackboardEngine → IndexManager | Phase 1 → Phase 2 | ✓ Connected |
| DecisionEngine → Embedder | Phase 1 → Phase 2 | ✓ Connected |
| DecisionEngine → IndexManager | Phase 1 → Phase 2 | ✓ Connected |
| BlackboardEngine → SearchEngine | Phase 1 → Phase 2 | ✓ Connected |
| ContextAssembler → GraphEngine.query() | Phase 2 → Phase 3 | ✓ Connected |
| ContextAssembler → GraphEngine.neighbors() | Phase 2 → Phase 3 | ✓ Connected |
| ContextAssembler → SearchEngine | Phase 2 → Phase 3 | ✓ Connected |
| GraphStore → file-store | Phase 3 → Phase 1 | ✓ Connected |
| Archiver → BlackboardStore | Phase 3 → Phase 1 | ✓ Connected |
| Archiver → BlackboardEngine | Phase 3 → Phase 1 | ✓ Connected |
| Archiver → IndexManager | Phase 3 → Phase 2 | ✓ Connected |
| DecisionEngine.trace/reconsider/override | Phase 3 extends Phase 1 | ✓ Connected |
| Server wiring | All phases → server.ts | ✓ Connected |

**Total:** 27 exports connected, 0 missing connections

### Orphaned Export

| Export | File | Reason |
|--------|------|--------|
| writeJSONL | src/storage/file-store.ts | Created for archiver but archiver uses inline fs.writeFileSync instead |

## E2E Flow Verification

| # | Flow | Status | Steps Verified |
|---|------|--------|----------------|
| 1 | Blackboard Post → Embed → Search | ✓ Complete | post → append → embed → index → query → cosine search |
| 2 | Decision Record → Embed → Why → Trace | ✓ Complete | decide → store → embed → index → why → trace BFS |
| 3 | Decision Lifecycle | ✓ Complete | decide → reconsider → override (with conflict detection) |
| 4 | Context Assembly | ✓ Complete | assemble → decisions + blackboard + graph → weighted scoring → token budget |
| 5 | Graph Integration | ✓ Complete | add_entity → add_relation → neighbors → context assembler |
| 6 | Archive Flow | ✓ Complete | post → archive → partition → decision protection → summary |
| 7 | Status Check | ✓ Complete | graph counts + stale provisionals + archive threshold + orphans |

## Test Suite

| Test File | Tests | Domain |
|-----------|-------|--------|
| blackboard-store.test.ts | 10 | Storage |
| blackboard-engine.test.ts | 11 | Engine |
| decision-store.test.ts | 9 | Storage |
| decision-engine.test.ts | 33 | Engine |
| graph-store.test.ts | 18 | Storage |
| graph-engine.test.ts | 15 | Engine |
| context-assembler.test.ts | 20 | Engine |
| archiver.test.ts | 8 | Engine |
| embedder.test.ts | 8 | Embeddings |
| index-manager.test.ts | 14 | Embeddings |
| search.test.ts | 18 | Embeddings |
| context-tools.test.ts | 12 | Tools |
| tools.test.ts | 9 | Tools |
| file-store.test.ts | 12 | Storage |
| init.test.ts | 4 | Storage |
| integration.test.ts | 4 | Integration |
| **Total** | **221** | |

**Pass rate:** 221/221 (100%)
**Duration:** 3.95s

## MCP Tools Inventory

| Tool | Category | Phase |
|------|----------|-------|
| twining_post | Blackboard | 1 |
| twining_read | Blackboard | 1 |
| twining_recent | Blackboard | 1 |
| twining_query | Blackboard | 2 |
| twining_decide | Decisions | 1 |
| twining_why | Decisions | 1 |
| twining_trace | Decisions | 3 |
| twining_reconsider | Decisions | 3 |
| twining_override | Decisions | 3 |
| twining_assemble | Context | 2 |
| twining_summarize | Context | 2 |
| twining_what_changed | Context | 2 |
| twining_add_entity | Graph | 3 |
| twining_add_relation | Graph | 3 |
| twining_neighbors | Graph | 3 |
| twining_graph_query | Graph | 3 |
| twining_status | Lifecycle | 1 (enhanced in 3) |
| twining_archive | Lifecycle | 3 |

**Total:** 18 MCP tools

## Tech Debt Summary

| Phase | Item | Severity |
|-------|------|----------|
| 01-foundation-core-data | Missing VERIFICATION.md | Low (tests pass, integration verified) |
| 01-foundation-core-data | Missing SUMMARY.md files | Low (procedural gap only) |
| 02-intelligence | Missing VERIFICATION.md | Low (summaries exist, tests pass) |
| 03-graph-lifecycle | writeJSONL exported but unused | Low (dead export, no functional impact) |

**Total:** 4 items across 3 phases (all low severity)

---
*Audited: 2026-02-17*
*Test suite: 221/221 passing*
*Integration checker: all flows complete*
