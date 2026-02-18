# Gap Closure Plan — Architecture Review Findings

Decision: 01KHQ0ZRG9Q5ZFJVAG0DHCWD4A

## Priority 1: Data Integrity

### 1A. Lock individual decision files (CQ1)
**Files:** `src/storage/decision-store.ts`
**What:** `updateStatus` and `linkCommit` both read/overwrite `decisions/{id}.json` without locking. The index.json IS locked, but the individual file is not.
**Fix:** Wrap the individual file read-write in both methods with `proper-lockfile` (same pattern already used for index). Lock the individual file BEFORE the index lock to maintain consistent lock ordering.
**Tests:** Add concurrent-write test that spawns two parallel updateStatus calls on the same decision.

### 1B. Fix blackboard read ordering (CQ4)
**Files:** `src/storage/blackboard-store.ts`
**What:** `read()` with `limit` uses `entries.slice(0, limit)` — returns oldest entries. Should return newest.
**Fix:** Change to `entries.slice(-limit)` (or reverse-sort then slice, depending on desired output order). Also reverse the output of `recent()` so most recent entry is first.
**Tests:** Update existing tests; add test confirming limit returns most-recent entries.

## Priority 2: Spec Compliance (Core Behavior)

### 2A. twining_post decision handling (D1 + CQ5)
**Files:** `src/engine/blackboard.ts`, `src/tools/blackboard-tools.ts`
**What:** Spec §4.1 says posting with `entry_type: "decision"` should create a Decision record. Currently it just appends a plain JSONL entry.
**Approach:** Rather than making `twining_post` auto-create full decisions (which would require injecting DecisionEngine into BlackboardEngine and demanding rationale fields), the better approach is to **reject** `entry_type: "decision"` in `twining_post` and return an error directing the agent to use `twining_decide`. This is cleaner and prevents the divergent-record problem the reviewer identified.
**Tests:** Test that posting with `entry_type: "decision"` returns a structured error with guidance.

### 2B. twining_decide auto-populates knowledge graph (D2)
**Files:** `src/engine/decisions.ts`, `src/server.ts`
**What:** Spec §4.2 line 389 requires creating graph entities for `affected_files` and `affected_symbols` with `decided_by` relations.
**Fix:** Inject `GraphEngine` into `DecisionEngine`. At the end of `decide()`, after persisting the decision:
1. For each `affected_file`: upsert a `file` entity, add `decided_by` relation to decision ID
2. For each `affected_symbol`: upsert a `function`/`class` entity, add `decided_by` relation
**Tests:** Test that `decide()` with affected_files/symbols creates corresponding graph entities and relations.

## Priority 3: Performance

### 3A. Reduce redundant loads in context assembly (CQ3)
**Files:** `src/engine/context-assembler.ts`
**What:** `assemble()` calls `blackboardStore.read()` 3 times and `decisionStore.getIndex()` 2 times.
**Fix:** Load each dataset once at the top of `assemble()`, pass the loaded data to subsequent operations. Specifically:
- Load blackboard entries once: `const allEntries = await this.blackboardStore.read()`
- Load decision index once: `const allIndex = await this.decisionStore.getIndex()`
- Filter scope/semantic from these cached arrays
**Tests:** Existing tests should still pass; add a test that mocks store methods and asserts each is called at most once.

## Priority 4: Dead Code / Housekeeping

### 4A. Expose or remove CoordinationEngine from tool surface (CQ2)
**Files:** `src/tools/coordination-tools.ts`, `src/server.ts`
**What:** `CoordinationEngine` is constructed and injected but never used in any tool handler. Handoff/delegation APIs have no MCP surface.
**Approach:** Since coordination was an intentional v1.3 addition, expose the existing engine methods as MCP tools rather than removing them. Add tools for:
- `twining_delegate` — find best agent for a task (uses `CoordinationEngine.findBestAgent`)
- `twining_handoff` — create/acknowledge handoffs
Or alternatively, if we want to keep the surface minimal for now, just remove the unused `coordinationEngine` parameter from `registerCoordinationTools` and the construction from `createServer`, and document handoff/delegation as planned-but-unexposed.
**Decision needed:** Expose or defer? (Recommend: expose — the code is tested and ready)

### 4B. Fix version skew (CQ6)
**Files:** `src/server.ts`, `package.json`
**What:** Server reports `version: "1.0.0"`, package.json says `1.2.0-alpha.1`.
**Fix:** Read version from package.json at build time or import it, or at minimum sync the hardcoded string.

### 4C. Document embedding runtime choice (D7)
**Files:** `TWINING-DESIGN-SPEC.md` or `README.md`
**What:** Spec says onnxruntime-node, code uses @huggingface/transformers.
**Fix:** Add a note in the spec or README documenting the intentional divergence and rationale (better cross-platform support, WASM fallback).

## Priority 5: Documentation

### 5A. Enhance CLAUDE.md with Twining agent checklist (D4)
**Files:** `CLAUDE.md`
**What:** Spec §8.1-8.3 describes a Twining integration checklist for agent-facing docs. Current CLAUDE.md covers build conventions and Serena workflow but not the full checklist.
**Fix:** Add a "Twining Usage" section covering: when to post vs decide, scope conventions, tag taxonomy, context assembly usage pattern.

## Out of Scope (Intentionally Deferred)

- **Pending hook queues (D3)** — Already deferred in PROJECT.md. Spec acknowledges pattern needs redesign.
- **Phase-2/3 scope expansion (D5, D6)** — These were intentional milestone additions, not scope creep.
- **Dashboard opt-out (CQ7)** — Already implemented via env vars. Could improve discoverability in docs (covered by 5A).
