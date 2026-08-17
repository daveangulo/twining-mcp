# Read-Context Audit Remediation Plan (field report 2026-08-15)

> **For agentic workers:** This is the wave-level remediation plan. At the start of each
> wave, generate the bite-sized TDD task breakdown per `superpowers:writing-plans`
> (fresh plan doc per wave in this directory), then execute with the standing practice:
> TDD, controller commits, and adversarial review of the unreleased diff before EVERY tag.

**Goal:** Address the 2026-08-15 field read-context-quality audit — close every confirmed-open
defect, land the disclosure/honesty contract the report argues for, and answer the field with
a disposition doc — without touching the named open design decisions (file-wins precedence,
UNIQUE backstop) that must not be patched opportunistically.

**Spec / source of truth:**
- Report: `~/Downloads/2026-08-15-twining-read-context-quality-report.md` (992 lines; ask the field to commit it — it is untracked on their machine)
- Triage evidence (12 clusters, adversarially verified, file:line at HEAD 0a0aa89):
  `docs/plans/2026-08-17-read-audit-triage-evidence.txt` (digest of workflow `wf_d71c9861-95e`;
  full structured output lived in the session scratchpad)

---

## 1. Triage verdict summary

The audit machine ran **2.6.0 (npx-cached)** and **2.13.0 (plugin bundle)** concurrently.
HEAD is **2.15.0**; npm latest is **2.15.0** (verified — npm was *never* behind; report ask 0a's
premise is field-env: npx cache/registry-policy staleness).

| Verdict | Items |
|---|---|
| **FIXED at HEAD** (mostly 2.9.0/D9, 2.15.0 hooks) | honest `total_matched`/`returned` + pre-slice filtered counts (S3-A, S2-D mechanism), lifecycle rank deboost (S3-C ranking half), archived-search visibility, hook activity-marker path filter (S2-E), stop-hook fail-open inventory |
| **FIELD_ENV_ONLY** | npm "lag" (0a publish half) — their npx resolved a stale 2.6.0; plugin upgrade alone does NOT move rung-1 sessions until their registry window passes — must be said in the memo |
| **OPEN — confirmed at HEAD** | entire S0 amnesia cluster; entire assemble cluster (disclosure, budget starvation, false-empty sentence, fabricated-scope, token_estimate, double-render); entire scope-semantics cluster; verify perf + honesty; payload contracts; ~10 S-effort hygiene items |
| **DESIGN_DECISION_OPEN** | verify content-hash drift signal; bundle embeddings; PKG_SPEC pin; agent_id identity model; record INVALID_INPUT rate (needs field data); read-only mode (full form) |
| **ALREADY_TRACKED** | neighbors reduced form (widen to include `limit` + dedup), file-wins precedence (fold S4-9 evidence in), graph fate (answer with investment record, don't re-litigate) |

Two challenger downgrades the plan honors: **ASM-disclosure is OPEN** (nothing of the ask
shipped — the 2.7/2.9 exclusion counts are a different axis) and **QUAL-lifecycle-rank is
PARTIAL** (deboost shipped, but the report's two *cheaper preferred* remedies —
`superseded_by` on rows, `exclude_status` — are open).

Local reproductions on this repo's own store during planning: S1-A budget starvation
(`decisions_count: 0`, 24 warnings), S4-1 double-render, S4-2 INVALID_INPUT class.
The report's thesis (uniform fail-toward-quiet) is confirmed live, on us.

## 2. Assumptions (challenge at review; revisit if execution contradicts)

1. **Field stores are rescuable today without our fix**: deleting the 0-byte `twining.db`
   (report arm B) or running `twining-mcp migrate` (arm C) recovers all three amnesia stores.
   Our guard fix prevents recurrence; the response doc instructs the field action first.
2. **Sending anything to the field is Dave's call** — plan prepares memo edits + response doc;
   no send happens without explicit go.
3. **Behavior changes in minor versions are acceptable** when changelogged and memo'd
   (established practice through 2.7–2.15). No semver-major is triggered by this plan.
4. **Token-budget CI gate** is assumed re-baselined by 2.15.0's budget work. Several waves
   edit tool descriptions — verify gate state before the first description edit; if red,
   re-baseline is a Wave 1 pre-task, not a silent skip.
5. **Handoff surface stays deprecated (#33)** — S1-D fixes are render-side suppression only;
   no investment in joins on a tier scheduled for v3 removal.
6. **The `.twining` store on this repo remains the dogfood proving ground** — scope-matcher
   dry-run comparisons run here before release.

## 3. Wave plan

Four releases, ordered by blast radius of the defect class, each with its own pre-tag
adversarial review (that review has caught majors 7 consecutive times — it is load-bearing).

### Wave 1 — 2.16.0 "data safety + self-identification" (all S-effort, ship fast)

The two properties that protect the field immediately: stores can't silently read empty,
and a session can tell what's serving it.

| Item | Change | Where |
|---|---|---|
| S0-guard | `hasSqliteState`: require size>0 **and** 16-byte `SQLite format 3\0` header; ambiguous → files (docblock rule). **Rewrite the tests that enshrine the bug** (`test/backend-resolve.test.ts:45-46, 94-98`) + regression: 0-byte db + legacy content → `{files, legacy-content}` | `src/storage/backend-resolve.ts:36` |
| S0-surface | StoreSet gains `reason` + `legacy_content_unread`; stderr warning when sqlite selected (auto **or explicit**) with empty db + `hasLegacyContent()`; `twining_status` gains `backend`, `backend_reason`, and a warnings entry for stranded legacy content | `src/storage/backend-factory.ts:49-79`, `src/tools/lifecycle-tools.ts:167` |
| S0-index-desync | Files-backend desync detection (dir scan vs index, mtime-cached), surfaced as status warning; repair stays behind `twining_housekeeping({repair_index:true, execute:true})` reusing migrate's salvage | `src/storage/decision-store.ts:193`, `src/migrate/forward.ts:173` (extract shared helper) |
| DIST-version | `server_version` in `twining_status` (+ assemble status line). Unblocks the memo's verification step, which currently references a field that doesn't exist | `src/server.ts` (PKG_VERSION), `src/tools/lifecycle-tools.ts` |
| CNT-schema-version | `count_semantics: "pre_page_floored_v2"` on `search_decisions` + `twining_query` responses | `src/engine/decisions.ts:1319-1334`, `src/tools/blackboard-tools.ts` |
| VER-perf | Hoist loop-invariant `getByScope` out of the per-file drift loop (reuse verify()'s line-81 fetch); memoize per-file `git log` in a Map | `src/engine/verify.ts:356-369` |
| Cheap batch | `commits`: `commit_exists` via `git cat-file -e` (3-state, best-effort); `discover`: default-exclude zero-overlap + `excluded_zero_overlap` count; WAL: `wal_checkpoint(TRUNCATE)` in housekeeping execute + SIGTERM close; metrics: `response_bytes`/`result_count`/`scope` on MetricEntry; record: `reason_rejected` optional + named empty-summary zod message | `decision-tools.ts`, `coordination.ts:164`, `db.ts`/`index.ts`, `instrumented-server.ts:55`, `record-tools.ts:228` |
| S4-1 | Render-time `Full summary:` dedupe (guarded prefix-match against summary) in assemble + read | `src/engine/context-assembler.ts:707-709`, blackboard-tools |
| Docs | T2-19 truncation-signature line in assemble description; T2-16: document `counts.open.by_kind.decision` as the scoped ratify count in triage's description + declare `status.provisional_decisions` the canonical store-wide form in status's description (challenger note: TRIAGE-SPEC's "ratify-lane" label at line 460 refers to `irreversible`, a different counter — don't cite it); **rewrite `docs/hooks.md`** (still documents pre-1.16 mtime design, says four hooks — plausibly caused the audit's misdiagnosis) + read-only audit recipe (TWINING_DISABLED-scoped); **CHANGELOG backfill 2.13.0–2.15.0** (currently tagless releases have no entries) | `context-tools.ts:20`, `triage-tools.ts:19`, `lifecycle-tools.ts:33`, `docs/hooks.md`, `CHANGELOG.md` |

### Wave 2 — 2.17.0 "read-path honesty" (assemble + search truth-telling)

The report's thesis class: every instrument that fails toward "nothing to do."

- **ASM-disclosure**: `decisions_in_scope` (population already computed and dropped at
  `context-assembler.ts:112-115`), `decisions_omitted`, `truncated` — aligned on why's
  predicate so S1-B can't recur. Then **ASM-false-empty**: the "No active decisions" sentence
  only when population verified 0; otherwise "N in-scope decisions did not fit the budget —
  call twining_why."
- **ASM-budget-order**: reserved decisions floor (DD-9 below decides size; default proposal
  15–20%). Warning-first was deliberate — this is a rebalance with a decision record, not a bug fix.
- **ASM-population**: document `decisions_count` as "surfaced, not census" in the description
  (additive doc, no rename — external consumers key on the name).
- **S2B-token-estimate**: measure the serialized payload at the tool layer (assemble + why);
  `max_tokens` bounds the whole payload; why's `more[]` charged against budget. One shrink
  pass + `truncated: true`, no oscillation loop.
- **Search-quality batch** (same two mapping sites in `decisions.ts`): project `superseded_by`
  onto rows (also fixes the description that already tells readers to "follow superseded_by");
  `status` accepts array or `exclude_status`; configurable `search.relevance_floor` (default
  0.3 unchanged) + `top_relevance` echo — note HEAD's 0.3 floor is *below* the report's
  plausible-absent class (0.337), which is the argument for configurable;
  `blackboard_matches_excluded` count on search_decisions (share the embedded query vector);
  query-tier fixes: `decisions_total_matched`/`decisions_returned` (currently discarded at
  `blackboard-tools.ts:163-172`), `decisions_excluded_by_filter: true` instead of bare `[]`,
  optional status/domain/confidence passthrough. Ride-along wart fix: a status filter
  matching zero candidates currently short-circuits with `fallback_mode: true`
  (`decisions.ts:1301-1303`), mislabeling "no candidates" as keyword fallback.
- **Exact-match mode (rider, 2026-08-17 design discussion)**: `mode: "semantic" | "exact"` on
  `search_decisions` + `twining_query`, promoting the existing keyword path (`search.ts:266` —
  currently naive substring TF, fallback-only) to a first-class option with per-mode honest
  counts: exact mode's zero means zero, a deterministic existence instrument for ULIDs, code
  identifiers, and error strings (the audit's flagged untested class — and the report itself
  observed keyword mode's empty result is more honest than semantic mode's confident wrong rows).
  `above_threshold`/`top_relevance` semantics apply to semantic mode only.
- **T3-21**: `affected_files`/`affected_symbols` on why (full rows + ids drill-down; off the
  compact `more` rows). Closes "the divergence discipline keys on a field no read tool returns."
- **S1D-ack**: suppress/collapse acknowledged handoffs in continue-work (render-side; no
  mutation of `results[i]`); stop rendering bare `[BLOCKED]` without age context.
- **QUAL-mirror annotation**: `legacy_mirror: true` on entry_type "decision" posts in query's
  posts tier + housekeeping preview count (annotation only; challenger note: label means
  "legacy-era decision entry," not strictly "auto-mirror").

### Wave 3 — 2.18.0 "scope semantics" (the one deliberate behavior-change release)

Isolated on purpose: biggest matching-behavior change, deserves clean field bisection.

- **SCOPE-segment-boundary**: rewrite `scopeMatches` (`src/utils/scope.ts:7-9`) to
  segment-boundary semantics (`a === b || a.startsWith(b + '/') || b.startsWith(a + '/')`,
  trailing-slash normalization, exact-match for non-path scopes); convert the four inline
  bidirectional copies in `context-assembler.ts` to the shared helper so the fix lands
  everywhere (~10 call sites). Preserves ancestor inheritance (the report's own "do not fix" half).
- **SCOPE-matched-via**: `matched_via: exact|descendant|ancestor|affected_files` per row +
  `directly_scoped_count` on why — cheap, `whySpecificity` (`decisions.ts:149-164`) already
  computes the tiers and discards them.
- **SCOPE-dot-slash**: `normalizeScope` at every tool boundary AND at write time; empty-scope
  policy unified (assemble rejects `''` like why — behavior break, changelog it).
- **S1C-fabricated-scope**: `scope_resolved: false` labeled notice (never a hard error —
  virtual scopes are legitimate first-touch cases); needs projectRoot plumbed into the assembler.
- **S1F**: echo resolved store identity in every response via the `toolResult` seam
  (`src/utils/errors.ts:7`) — one edit point, all ~20 tools; short key to bound token cost.
  (Per-call `project` parameter route explicitly NOT taken — reopens store lifecycle/locking.)
- **Docs**: T3-20 per-tool scope-semantics page + S3F cost-note ("narrowing bounds relevance,
  not cost") — written after the matcher change so it's written once.

### Wave 4 — 2.19.0 "payload contracts + verify bounding"

- **Shared disclosure shape** (`total`, `returned`, `truncated`, `omitted_count`) in
  `utils/types.ts`, threaded through read, recent, **query**, graph_query, neighbors,
  what_changed, export, verify (challenger caught query's decisions-tier silent truncation —
  it is in the list). `graph_query` is one line (`graph.ts:179` computes then discards the total).
- **PAY-read/recent**: default per-entry `detail` truncation (reuse triage's collapse helper)
  + `ids:` full-fetch escape hatch in the same release; changelog-flagged behavior change.
- **PAY-export**: `sections`/`limit`/`max_tokens` knobs; **full-by-default** (handoff
  completeness) with loud truncation banner when a budget binds.
- **PAY-neighbors**: `limit` + truncated + drop the duplicated `decision_summary` from the
  relation projection (tool layer only; check dashboard consumers first) — widen the tracked
  D13 reduced-form item to absorb this.
- **VER honesty**: `skip_reason` (skip must name its unmet precondition — the
  empty-window-passes-as-success failure in the checker), `clean_count` +
  `skipped_no_affected_files` + basis string, `max_items`/`since`/`detail:"summary"` caps,
  wire or remove the dead `fail_on` param, publish expected cost in the description.
- **S3D-prose-vs-fields**: one audit pass of every prose string in `src/tools/` +
  `formatForLLM` against sibling fields; sentences generated FROM fields (single source).
- **HYG-archive visibility**: archive stats in status/housekeeping preview; fix the
  compactor's `isArchiverLoopJunk` signature eating legitimate roll markers (adjacent defect
  found in challenge); MIGRATED-README marker for dead v1 artifacts (zero-risk half of HYG-dead-artifacts).
- **S4-14 half (a)**: move `.gitignore` reconciliation off the pure-read startup path onto the
  write seam — ordered before first write (the #44 casualty is the regression to guard).

### Design decisions — named, scheduled, NOT patched inside waves

| ID | Decision | Input needed | Vehicle |
|---|---|---|---|
| DD-1 | Verify non-temporal drift signal (content hash at record time) + partial-results protocol | decide together with tracked diff-capture follow-up | own design session |
| DD-2 | Bundle embeddings: project-local `createRequire` fallback vs status quo (ship-dep infeasible: onnxruntime native binaries) | none — stakes reduced by DD-10: the bundle gains a first-class FTS5 keyword mode instead of a degraded fallback | own decision record |
| DD-3 | PKG_SPEC exact-pin at plugin release vs floating `^2.0.0` (availability-vs-freshness; pin = right version in keyword mode under age policies) | none | own decision record |
| DD-4 | agent_id identity model (normalize + derive per-process default vs deprecate for joins) | none | own design session |
| DD-5 | record INVALID_INPUT residual rate | **field's error_code+message distribution from metrics.jsonl** — add as verification question #3 in the response doc | after field data |
| DD-6 | Full read-only mode (`TWINING_READ_ONLY`: skip init side effects, metrics, sqlite readOnly open) | none | after Wave 4 half (a) |
| DD-7 | Archive retrieval surface (`include_archived` read) | none | with DD-1 or standalone |
| DD-8 | File-wins precedence | already named — fold the report's S4-9 evidence (11-day phantom, hand-repair direction) into it | existing named decision |
| DD-9 | Assemble decisions-floor size | Wave 2 execution; criterion: warning-dense dogfood scope surfaces ≥3 decisions at default budget while retaining ≥60% of warning content | decision record in Wave 2 |
| DD-10 | "Retrieval v2": FTS5+BM25 index over decisions/posts (verified available in `node:sqlite`, zero new deps — works in the plugin bundle), RRF-fused `hybrid` search mode, sibling-session clustering + record-kind weighting (report S3-B fix asks c/d). Pattern borrowed right-sized from zilliztech/claude-context: the hybrid BM25+dense fusion transfers; the vector-DB/Merkle/AST infrastructure does not at our 10³–10⁴-record in-memory scale. JS BM25 fallback (~100 lines) for the files backend | Wave 2 first — fused-score disclosure depends on configurable floor + `top_relevance` semantics | own design spec |

**Explicitly deferred — embedding-model swap** (bge-small / EmbeddingGemma class). Rationale:
a swap invalidates every field-calibrated threshold (the report's own warning that thresholds
rot when the model changes), forces re-embedding migrations across all field stores, grows the
download, and the *measured* row-level failures (sibling crowding, authority-below-consequence,
narrow separation band) are fusion/diversity/calibration problems, not model problems.
Reconsider only when all three hold: Wave 2's configurable `relevance_floor` has shipped;
a per-store embedding-model tag + re-embed migration is designed; a benchmark-harness eval
shows a band-separation gain on real store data. Recorded here so it is not patched
opportunistically inside DD-10 or any wave.

### Field communication track (sequenced with Dave's go)

1. **F1 — send the wave-2 ship memo first, essentially unchanged** (fix the stale line 183:
   sqlite relation-lookup index shipped in 2.15.0). Its upgrade instruction resolves the
   report's whole 2.6.0-observed class. Add one caveat: under a registry age policy, plugin
   upgrade alone does not move rung-1 (npx) sessions — the report's own one-call self-test
   (`twining_amend` present → 2.13-class) distinguishes, until `server_version` ships.
2. **F2 — separate response/disposition doc** for this report
   (`docs/field-responses/2026-08-17-read-audit-response.md`, pattern of
   `2026-08-12-wave2-response.md`): per-finding disposition table from the triage; corrections
   we owe them (their limit-clamping measurement was right *for 2.6.0* and the mechanism they
   "could not reproduce" IS ≥2.9.0 behavior — their retired instrument was retired against the
   wrong build; the S3-A "regression window / 1.30→1.31 diff" theory is wrong — nothing
   regressed, two builds served concurrent sessions); **immediate field actions**: migrate or
   de-arm the 3 amnesia stores (delete 0-byte db or run `twining-mcp migrate`) — do not wait
   for 2.16.0 — sweep the 12 latent stores; commit the report file; their §7 field-CLAUDE.md
   correction list with our confirmations (why is prefix-match not scope-exact — confirmed in
   source; `status.provisional_decisions` + `triage counts.open.by_kind.decision` as the
   ratify derivations — endorsed and being documented); verification questions: the existing
   two from the memo + DD-5's error distribution ask.
3. **F3** — after each wave ships: one-paragraph delta note through the same channel.

## 4. Decision points during execution (criteria pre-set)

- **Matcher strictness (Wave 3)**: after rewrite, run a dry-run comparison on this repo's
  store (per-tool populations before/after for the 15 most-queried scopes). Criterion: no
  decision becomes unreachable from every query form it previously matched *except* via the
  bare-word/single-char class being removed. If load-bearing matches disappear → add
  write-side scope normalization repair to housekeeping in the same release; a config
  compatibility flag only as last resort (records the report's warning against split semantics).
- **read/recent truncation default (Wave 4)**: if the ids escape hatch can't land in the same
  release, do NOT flip the default — disclosure fields only.
- **Any unanticipated decision point**: take the lower-risk action, record decision + rationale
  in Twining at the moment it's made (standing instruction).

## 5. Risks and recovery

| Risk | Recovery |
|---|---|
| S0 guard flips live-amnesia stores to files backend mid-session ("decisions suddenly reappear") | Intended rescue; memo announces it; migrate nudge fires on the flip |
| Matcher change hides sloppy-scope matches in field stores | Dry-run + memo note + housekeeping normalization repair; revert path is a one-file revert of `scope.ts` |
| Tool-description edits trip the token-budget CI gate | Verify gate state first (Assumption 4); re-baseline as a visible pre-task if red |
| Additive response fields churn exact-shape tests broadly | Keep every field additive-only; per-wave test sweep is part of the wave, not after it |
| Wave 2/3 both touch assemble → merge friction | Waves are strictly sequential releases; no parallel wave execution |
| Concurrent vitest runs corrupt results on this machine | Standing rule: never overlap suite runs; single runner per wave |

## 6. Strongest alternatives considered

1. **One mega-release (everything in 2.16.0).** Rejected: pre-tag adversarial review has
   caught majors seven consecutive times and cannot digest a 40-item diff at that quality;
   the field loses bisection ability; Wave 1's urgency (live data-loss class) must not wait
   on Wave 4 design work.
2. **Fix Tier-0 only, answer the rest in docs.** Rejected: triage confirmed the
   fail-toward-quiet class live at HEAD on our own store — assemble/scope/verify defects are
   not 2.6.0 artifacts, and the report's compounding argument (six of seven defects fail the
   same direction) is the strongest finding in it.
3. **Fold the audit response into the wave-2 memo.** Rejected (triage MEMO-vehicle):
   the memo is styled final with a clean archive condition, and its upgrade step is itself
   the fix for the report's biggest class — send it first, respond separately.
