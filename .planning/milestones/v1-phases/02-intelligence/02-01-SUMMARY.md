---
phase: 02-intelligence
plan: 01
subsystem: embeddings
tags: [huggingface, transformers, onnx, cosine-similarity, embeddings, semantic-search]

requires:
  - phase: 01-core
    provides: BlackboardStore, DecisionStore, BlackboardEngine, DecisionEngine, file-store with locking
provides:
  - Lazy-loaded ONNX embedding pipeline (Embedder)
  - JSON-based embedding index manager (IndexManager)
  - Cosine similarity search with keyword fallback (SearchEngine)
  - Embedding generation hooks in BlackboardEngine.post() and DecisionEngine.decide()
  - twining_query tool for semantic search
affects: [02-02, context-assembly, search]

tech-stack:
  added: ["@huggingface/transformers"]
  patterns: [lazy-loaded-singleton, graceful-fallback, best-effort-embedding]

key-files:
  created:
    - src/embeddings/embedder.ts
    - src/embeddings/index-manager.ts
    - src/embeddings/search.ts
    - test/embedder.test.ts
    - test/index-manager.test.ts
    - test/search.test.ts
  modified:
    - src/engine/blackboard.ts
    - src/engine/decisions.ts
    - src/tools/blackboard-tools.ts
    - src/server.ts
    - src/storage/init.ts

key-decisions:
  - "Used @huggingface/transformers v3 for local ONNX embeddings (handles tokenization, pooling, normalization automatically)"
  - "Embedder is not a singleton for testing but provides getInstance() for production use"
  - "Pipeline is lazy-loaded on first embed() call, never at import or construction time"
  - "Fallback mode is permanent once triggered (ONNX init failure), but transient errors on individual embeds don't trigger fallback"
  - "Keyword search scores using log(1 + occurrences) per term divided by query term count"
  - "All new constructor parameters are optional/nullable for backward compatibility"

patterns-established:
  - "Lazy initialization with initPromise: prevents concurrent init, defers expensive work"
  - "Best-effort embedding: wrap in try/catch, never block the primary operation"
  - "Fallback search: keyword-based scoring when ONNX is unavailable"
  - "Cosine similarity via dot product for pre-normalized vectors"

requirements-completed: [EMBD-01, EMBD-02, EMBD-03, EMBD-04, BLKB-03]

duration: ~15min
completed: 2026-02-16
---

# Plan 02-01: Embeddings Layer Summary

**Lazy-loaded ONNX embedder with all-MiniLM-L6-v2, JSON embedding indexes, cosine similarity search with keyword fallback, and twining_query tool**

## Performance

- **Tasks:** 2
- **Files created:** 6
- **Files modified:** 5

## Accomplishments
- Embedder lazy-loads ONNX pipeline on first use, falls back permanently to keyword search on init failure
- IndexManager provides CRUD for JSON-based embedding indexes with proper-lockfile concurrent safety
- SearchEngine performs cosine similarity search with automatic keyword fallback
- Embedding generation hooks wired into BlackboardEngine.post() and DecisionEngine.decide() (best-effort, never blocks)
- twining_query MCP tool registered for semantic search across blackboard entries
- All 127 tests pass (40 new + 87 existing), TypeScript compiles, builds cleanly

## Files Created/Modified
- `src/embeddings/embedder.ts` - Lazy-loaded singleton ONNX embedding pipeline
- `src/embeddings/index-manager.ts` - CRUD for JSON embedding indexes with file locking
- `src/embeddings/search.ts` - Cosine similarity + keyword fallback search
- `src/engine/blackboard.ts` - Added embedding generation on post(), query() method, SearchEngine param
- `src/engine/decisions.ts` - Added embedding generation on decide()
- `src/tools/blackboard-tools.ts` - Added twining_query tool registration
- `src/server.ts` - Wired Embedder, IndexManager, SearchEngine into engines
- `src/storage/init.ts` - Added models/ to .gitignore template
- `test/embedder.test.ts` - 8 tests for Embedder class
- `test/index-manager.test.ts` - 14 tests for IndexManager
- `test/search.test.ts` - 18 tests for SearchEngine

## Decisions Made
- Used @huggingface/transformers v3 over raw onnxruntime-node (handles tokenization + pooling)
- Permanent fallback on init failure, transient errors on individual embeds return null without fallback
- Keyword scoring uses log(1 + occurrences) / query_term_count for normalized scores
- All backward compatibility maintained — no existing tests needed modification

## Deviations from Plan

### Auto-fixed Issues

**1. Test assertion fix in keyword search ordering**
- **Found during:** Task 1 (search tests)
- **Issue:** Test assumed specific ordering of equally-scored keyword results
- **Fix:** Changed assertion to check membership rather than specific ordering
- **Files modified:** test/search.test.ts
- **Verification:** All 40 tests pass

---

**Total deviations:** 1 auto-fixed (test assertion)
**Impact on plan:** Trivial test fix. No scope creep.

## Issues Encountered
None beyond the test assertion fix.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Embeddings layer complete and wired in
- SearchEngine available for context assembler (Plan 02-02)
- All stores, engines, and search components ready for context assembly

---
*Phase: 02-intelligence, Plan: 01*
*Completed: 2026-02-16*
