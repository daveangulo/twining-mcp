# Wave 1 Implementation Plan — 2.16.0 "data safety + self-identification"

> **For agentic workers:** Execute per `superpowers:executing-plans`, sequentially, one
> vitest runner at a time (never overlap suite runs on this machine). Controller commits.
> `twining_record` before every commit. Full suite once at the end, then the standing
> pre-tag adversarial review before any tag.

**Goal:** Ship the read-audit Wave 1 slice: the S0 amnesia guard + backend surfacing,
version/count self-identification, verify perf, the S-effort hygiene batch, double-render
dedupe, and the docs debt.

**Spec:** `docs/plans/2026-08-17-read-audit-remediation-plan.md` §3 Wave 1; per-item
evidence in `docs/plans/2026-08-17-read-audit-triage-evidence.txt`.

**Pre-task result (Assumption 4):** token-budget CI gate is GREEN and measures only
`plugin/skills` + `plugin/agents` markdown — `src/tools/` description edits don't touch it.

## Global constraints

- Response fields additive-only; no renames, no removals.
- No changes to `plugin/` in this wave (no plugin version bump needed pre-release; the
  committed server bundle rebuild happens at `npm version` time).
- Do not touch file-wins ingest precedence, scope matching, or assemble budget order
  (Waves 2–3 / DD-8).
- Behavior changes shipped here (discover default, backend guard) get CHANGELOG entries.

## Tasks

### T1 — S0 guard: `hasSqliteState` size + header check
- Modify: `src/storage/backend-resolve.ts:35-40` — `twining.db` counts as sqlite state only
  when `statSync(...).size > 0` **and** the first 16 bytes are `SQLite format 3\0`.
  A 0-byte or garbage-header db falls through to the records/ clause, then legacy detection
  (a size>0 corrupt db beside nothing resolves fresh→sqlite; `openDatabase` throws and the
  factory's existing catch falls back to files with a warning — safe).
- Test: `test/backend-resolve.test.ts` — rewrite :45-48 and :94-98 to write a real header
  (`Buffer.from("SQLite format 3\0")` + padding); add regressions: 0-byte db + legacy
  content → `{files, legacy-content}`; 0-byte db alone → fresh; garbage db + legacy →
  files; 0-byte db + populated records/ → sqlite (rehydration arm stays safe).
- Note: a *valid-but-empty* sqlite db beside legacy content still selects sqlite by design —
  T2's runtime warning covers that layer.

### T2 — Backend + version surfacing
- Modify: `src/storage/backend-resolve.ts` — export `hasLegacyContent`.
- Modify: `src/storage/backend-factory.ts` — StoreSet gains
  `reason: "sqlite-state" | "legacy-content" | "fresh" | "explicit" | "fallback"` and
  `legacy_unread: boolean`. In the sqlite success path, after ingest: synchronous
  `SELECT COUNT(*) FROM decisions`; if 0 and `hasLegacyContent(twiningDir)` →
  `console.error` naming `npx twining-mcp migrate` and set `legacy_unread: true`
  (covers auto **and explicit** sqlite; empty-db gate keeps migrated repos quiet).
- Modify: `src/server.ts` — thread `{ backend, backendReason, legacyUnread, serverVersion:
  PKG_VERSION }` into `registerLifecycleTools`.
- Modify: `src/tools/lifecycle-tools.ts` — status response gains `server_version`,
  `backend`, `backend_reason`; warnings gain the stranded-legacy entry when
  `legacy_unread`; description sentence declares `provisional_decisions` the canonical
  ratify-queue count (store-wide; scoped variant = `triage counts.open.by_kind.decision`).
- Test: status-tool test asserts the three new fields; factory test asserts `reason` on
  each resolution arm and `legacy_unread` on an empty-db-beside-legacy fixture.

### T3 — Files-backend index-desync detection + repair
- Modify: `src/storage/decision-store.ts` — `countOrphanDecisionFiles()` (readdir `*.json`
  excluding `index.json`, diff vs index ids, mtime-cached).
- Modify: `src/tools/lifecycle-tools.ts` — files-backend status warning when count > 0,
  naming `twining_housekeeping({repair_index: true, execute: true})` and migrate.
- Modify: `src/engine/housekeeping.ts` + tools — `repair_index` step (execute-gated),
  reusing migrate's orphan-salvage parse (`src/migrate/forward.ts:173-204`) extracted into
  a shared helper; append under the index lock.
- Test: fixture with 2 orphan files → warning text + count; repair round-trips the same
  field mapping migrate uses; preview mode reports without writing.

### T4 — `count_semantics` on search responses
- Modify: `src/engine/decisions.ts` (searchDecisions return, both paths) +
  `src/engine/blackboard.ts` query return: `count_semantics: "pre_page_floored_v2"`.
- Test: both tools' response includes the literal; description documents it.

### T5 — Verify perf (hoist + memoize)
- Modify: `src/engine/verify.ts` — hoist the loop-invariant `getByScope(scope)` out of the
  per-file stale loop (:369); memoize per-file `git log -1` results in a `Map` for the run.
- Test: spy counts — one `getByScope` per checkDrift regardless of stale count; one git
  spawn per distinct file. Behavior-identical outputs pinned on an existing fixture.

### T6 — Hygiene batch A (commits / discover / record schema)
- `src/tools/decision-tools.ts` commits handler: malformed hash (not 7–40 hex) →
  INVALID_INPUT; on empty result, `git cat-file -e <sha>^{commit}` (cwd = projectRoot,
  3s timeout) → `commit_exists: true | false | "unknown"` + disambiguating `message`.
- `src/engine/coordination.ts` discover: with `required_capabilities` non-empty and
  `min_score` unset, exclude `capability_overlap === 0` rows; return
  `excluded_zero_overlap`; `min_score: 0` restores old behavior (schema doc updated).
- `src/tools/record-tools.ts` + `decision-tools.ts`: `reason_rejected` optional in
  alternatives; empty/whitespace `summary` rejected at zod with a named message.

### T7 — Hygiene batch B (WAL / metrics)
- StoreSet gains optional `db`; `src/engine/housekeeping.ts` execute path runs
  `PRAGMA wal_checkpoint(TRUNCATE)` (non-fatal, reports `wal_checkpointed`); `src/index.ts`
  SIGINT/SIGTERM handler closes the db after transport drain.
- `src/utils/types.ts` MetricEntry + `src/analytics/instrumented-server.ts`: optional
  `response_bytes` (Buffer.byteLength of first content text), `result_count` (first
  top-level array length, best-effort), `scope` (string args.scope only).

### T8 — Double-render dedupe
- `src/engine/context-assembler.ts:707-709` + read/query response shaping: when `detail`
  starts with `"Full summary: "` and the entry summary minus trailing `…` is a prefix of
  that full text, emit the full text once; guard on the summary match so caller-authored
  details that legitimately start with the marker pass through.
- Test: truncated-summary warning renders exactly once in the briefing; non-matching
  detail untouched.

### T9 — Docs + CHANGELOG
- `src/tools/context-tools.ts:20`: token_estimate≈max_tokens truncation signature + large
  max_tokens workaround. `src/tools/triage-tools.ts:19`: by_kind.decision sentence.
- Rewrite `docs/hooks.md` (five hooks, marker-based Stop gate, 2.15.0 edit-path filter,
  activity-marker section) + read-only audit recipe (TWINING_DISABLED scoped to no-commit
  audit sessions; note fresh-checkout boot still initializes the store until DD-6).
- CHANGELOG: backfill 2.13.0 / 2.14.0 / 2.15.0 from the ship-memo table + git log; open
  a 2.16.0-unreleased section listing this wave.

## Completion
Full suite once (single runner) → `twining_record` → final commit. Tag/release only after
the standing adversarial review of the unreleased diff — separate step, not part of this plan.
