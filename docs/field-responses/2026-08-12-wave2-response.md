# Response: handoff second wave of 2026-08-12 — D9–D13 (search-as-ranker, limb supersession, unrepairable affected_files, assemble lane, graph derivation)

**STATUS: disposition complete — investigation only; no fixes shipped yet.**
Authored 2026-08-12 by the Twining project in response to the second wave of
the `agentic-platform-design` handoff. Every section below was root-caused
against HEAD `429a2d2` (2.7.0) by two independent investigation passes per
defect, with every load-bearing claim adversarially re-verified against the
code and the key measurements re-run on this repo's own store. Nothing in
wave 2 was touched by 2.7.0 — all five items are genuinely open.

**Method note:** each defect was investigated twice independently (a dedicated
agent per defect, plus a second full workflow pass with per-claim adversarial
verification). All root-cause claims across all four code investigations came
back CONFIRMED; divergences between the two passes are folded into the
refinements below.

## Disposition table

| Item | Verdict at HEAD | Disposition |
|---|---|---|
| **D9** search is a ranker; `total_matched` is a page size | **Confirmed — your diagnosis was exactly right ("naming-and-plumbing, not architectural")** | Accepted; fix scheduled (Wave A below) |
| **D10** supersession has no limb granularity | **Confirmed, plus two amplifiers you didn't see** | Accepted; visibility fix scheduled (Wave A), write-time decomposition preferred over true partial supersession |
| **D11** `affected_files` unamendable; D7 unrepairable in place | **Confirmed — and D7 itself is NOT fixed at HEAD** | Accepted; amend tool + bulk derivation pass scheduled (Waves B/C) |
| **D12** assemble warning lane unranked / self-diluting / no aging | **Symptoms confirmed; diagnosis inverted — the lane IS ranked, recency-dominant** | Accepted with re-scope; ask (a) as specified is **rejected** (it would entrench the bug) |
| **D13** graph derivation asks | **Feature-shaped for asks 1–4; one premise correction each; one adjacent write-path defect found** | Asks accepted with corrected designs; sequencing constraint: ask 4 (marker) must land before ask 1 (derivation) |

## D9 — confirmed in full, with the mechanism

- `total_matched` is the length of the **already-truncated page**:
  `src/engine/decisions.ts:1031` (semantic path) and `:1090` (keyword
  fallback, after `slice(0, maxResults)`). The true pre-slice count is
  computed and discarded at `src/embeddings/search.ts:157-159` — the
  `SearchResults` interface simply has no total field. This mechanically
  produces your `limit: N → total_matched: N` at every N, and your filter
  nuance is also confirmed: filters narrow the corpus *before* search
  (`decisions.ts:985-999`), so the count is honest exactly when the filtered
  population fits under the page size.
- The semantic path pushes **every embedded decision with no relevance
  threshold** (`search.ts:142`). Both keyword paths gate on `score > 0`, so
  the always-returns-something pathology is exclusive to the semantic path —
  which is why it ships `fallback_mode: false` with ~0.26-floor noise.
- Lifecycle bias confirmed: the corpus is the full index (all statuses), rank
  is raw cosine, so a superseded original systematically outranks its terser
  amendment. Result rows do carry `status`; nothing weights it.

**The one-sentence workaround you asked for** (usable in your `CLAUDE.md`
today): *"Absence is not expressible with `twining_search_decisions` — it is a
relevance ranker that always returns a page; to test whether any decision
touches a subject, use the scope-filtered instrument (`twining_why` on the
governing path) and treat `total_matched` as trustworthy only when a status
filter narrows the population below the page size."*

**Planned fix (Wave A):** plumb the pre-slice count through `SearchResults`
as a real `total_matched` (keeping `returned` for page occupancy), state the
~0.26 noise floor and the absence caveat in the tool description, and add a
status-aware de-boost or flag so superseded records stop outranking their
amendments.

## D10 — confirmed, plus two amplifiers

Root cause: `Decision` is atomic with a single `status`; supersession is one
unconditional `updateStatus(target, "superseded")` (`decisions.ts:387-391`)
with no target read, no warning, and no echo in the `decide()` result. A
clause-level supersede is **unrepresentable at every layer**. The NL parser
never splits multi-part text (`record-parser.ts:188-209` — one
`ParsedDecision` per string; numbered lists feed *rejected alternatives*), so
your 8-in-1 record was recorded atomically without complaint — and the
`decisions` schema description (`record-tools.ts:252-255`) actively invites
packing structured multi-choice content into one object.

**Amplifier 1 (new):** `twining_record`'s `supersedes` is session-level and is
applied **inside the per-decision loop** (`record-tools.ts:414`). N nested
decisions ⇒ N supersede flips of the same target, `superseded_by` overwritten
each time — the back-link you would need for recovery may point at an
arbitrary one of the N. There is no per-decision `supersedes`, so the inverse
(different target per decision) is impossible.

**Amplifier 2 (new, sharper than your ask):** your ask (c) targets `why`,
which at least emits a bare `superseded_count`. **Assemble — the mandatory
Gate 1 — emits nothing**: superseded records are filtered uncounted
(`context-assembler.ts:94-96`) and the briefing prints "No active decisions
for this scope." The 2.7.0 D3 fix added `archived_excluded_count` for the
identical failure class; superseded was simply outside D3's scope.

Also found: a dangling `supersedes` id **silently no-ops**
(`decision-store.ts:107`) — a typo'd target is indistinguishable from
success; and the `override` path creates programmatic wholesale supersessions
(`decisions.ts:867-875`), so any call-time warning must handle that internal
caller too. `why`'s `superseded_count` is additionally mislabeled: it counts
superseded+overridden+archived and double-counts archived against
`archived_excluded_count`.

**Disposition on your asks:** (c) accepted — Wave A, mirroring the shipped D3
archived pattern in both `why` and assemble, plus `{id, summary,
superseded_by}` for excluded records (both call sites already hold the full
objects; it is a pure in-memory map). (b) accepted in structural form only:
warn/error when `supersedes` is combined with `decisions.length > 1`
(unambiguous, no heuristics), plus dangling-target detection; prose-based
multi-part detection is rejected (this codebase already carries a scar from
fabricating structure out of prose). (a) partial supersession is **declined
as specified** — it is a data-model change touching every `status ===
"active"` filter plus a migration for thousands of single-status records.
The substitute worth ~80% of the value: per-decision `supersedes` on the
structured decision object (which also fixes Amplifier 1) plus guidance
pushing one concretization per array element, so eight decisions supersede
independently by construction.

## D11 — confirmed; D7 is not fixed and was never tracked

- **D7 status:** unfixed at HEAD, and unknown to this repo until your
  handoff (no commit, changelog, or doc mentions it). The mechanism is
  **double-locked**: the nested structured-decision schema has no
  `affected_files` field (`record-tools.ts:190-249`; zod strips unknown keys
  silently — no error, no log, success response), and even if it passed
  through, the per-decision loop applies the session-level value *after* the
  input spread (`affected_files: args.affected_files ?? []`,
  `record-tools.ts:416`), so the session list would win anyway. The shipped
  plugin bundle carries the identical schema. Your interim guidance (use
  `twining_decide` for decisions that owe `affected_files`) remains correct —
  with the caveat that `twining_decide` is full-surface-only, and our own
  BEHAVIORS doc tells agents to attach `affected_files` in a section for a
  tool the default surface doesn't have. The docs manufacture the defect.
- **Reproduction:** this repo's own store shows **89 of 487 decisions
  (18.3%) with empty `affected_files`** — statistically identical to your
  540/3,052 (17.7%). This is the tool, not your usage. Worse: 41 of our 89
  also carry the `scope: "project"` git-inference fallback, leaving zero
  retrieval edges — effectively write-only records.
- **No amend path confirmed:** the complete decision mutation surface is
  `create` / `updateStatus` / `linkCommit`. But `updateStatus` already
  blind-assigns arbitrary `Partial<Decision>` in both backends and is
  mirror-wrapped — **D11 is a missing tool, not missing machinery.**
- Empty `affected_files` blinds more than the drift check: eleven consumers
  key on it. Hard-skipped: drift (`verify.ts:353-355`, also silently excluded
  from `decisions_checked`), staleness signal 2, all graph `decided_by`
  edges, test-coverage derivation (permanently "uncovered"), and assemble's
  FILES TO CHECK lane. Degraded: `getByScope` retrieval, `why` specificity
  ranking, keyword scoring, export, dashboard health.

**Disposition:** accepted. `twining_amend({decision_id, add_affected_files,
add_affected_symbols, reason})` — append-only, restricted to exactly those two fields (both absent
from the embed text, so no reindex; everything semantic stays immutable),
recording an in-record `amendments[]` provenance entry (house style:
`archived_from`) plus an audit-trail finding. Four invariants bound the
implementation: (1) the file backend's `updateStatus` syncs only `status` to
the index while retrieval reads `affected_files` *from the index*
(`decision-store.ts:117-128`) — a naive amend produces a half-repair worse
than today; (2) `ExportingDecisionStore` is hand-written delegation — a new
store method not added there silently stops mirroring and the next
file-wins ingest *reverts* the amendment; (3) graph relations are
append-only and never deduplicated — amend must add edges for newly-added
paths only; (4) amending retired records is allowed (factual metadata, not a
lifecycle claim). **Design question back to you:** for your 540-record
backlog, a per-record amend means 540 manual calls; see D13 ask 1 — the bulk
derivation pass covers ~90% of them from stored provenance, with
`twining_amend` as the escape hatch.

## D12 — symptoms confirmed; diagnosis inverted; one new root cause

**The lane is not unranked.** Warnings are score-sorted
(`context-assembler.ts:272`), but the score is degenerate: confidence is
hardcoded 0.5 and `warning_boost` is a constant 1.0 across all warnings
(`:241-250`), so recency and relevance are the only live differentiators —
and relevance flattens to 0.5 for scope-only matches. The lane is
newest-first in all but name, which *mechanically* promotes the caller's own
posts. At your 18 warnings the 4000-token budget never binds (~40 fit), so
sort order was the only mechanism that ran.

**Ask (a) as specified is rejected:** "rank by recency × severity" would
entrench the bug — no severity model exists (`EntryType` is a kind enum), and
recency already dominates. The accepted replacement: give blackboard entries
the same `scopeProximity` dampening decisions already get (compare `:220-221`
with `:243`), which demotes semantically-admitted off-scope warnings without
any new taxonomy; and impose a relevance floor on the semantic admission path
(top-10 by cosine currently enter regardless of score — the D9 no-threshold
defect surfacing inside assemble).

**Ask (b) accepted, but not via `agent_id`** — it is a role label, not a
session identity: 61% of our board is `"main"`, `post` and `assemble` both
default to it, and no `session_id` exists. Two signals that do work, both
free: process start time (one server process per session;
`entry.timestamp >= processStartedAt` is exact) and the 2.7.0 `origin`
marker (`narration` vs `discovery`), which assemble does not yet consume.
Mark, don't score — the lane's demonstrated value argues against hiding.

**Asks (c)/(d) accepted — trivial:** `created_at` is already carried into the
presentation layer and never printed; `handoffStore.list` already supports a
`since` filter on both backends that assemble never passes. Rendering
`[BLOCKED 15d]` is ~5 lines; an age cutoff is one argument.

**New root cause you couldn't see:** scopeless handoffs match **every scope
forever**. `scopeMatches` is bidirectional `startsWith` (`scope.ts:8`), the
store passes `e.scope ?? ""` (`handoff-store.ts:96`), and every string starts
with `""`. `createHandoff` never applies its documented `"project"` default
(`coordination.ts:303`). This — not missing decay — is the likely mechanism
for your 07-28 item surfacing in a narrow-scope call on 08-12. Two-line fix.
(Caveat: the whole continue-work lane is fed by the deprecated,
v3-removal-scheduled `twining_handoff`; fixes here are maintenance on a
doomed API, which bounds how much we will invest.)

## D13 — asks accepted with corrected designs; one adjacent defect found

**Premise corrections:**

1. **`files_changed` does not exist** anywhere in this codebase. But the
   exact changed-file list is computed on every scope-inferred record —
   `inferScopeFromGit` runs `git diff --name-only HEAD` and discards
   everything but the common prefix (`record-tools.ts:40-65`). Capturing it
   is ~5 lines and fixes the forward path with no git archaeology.
2. **"Consumer repos cannot write the graph" appears false**: graph tools
   (including `add_entity`/`add_relation`) are gated on `tools.mode`
   (default `"full"`), not `full_surface` — they should be on your default
   surface. Please confirm whether you run `tools.mode: "lite"`; the answer
   changes which asks need new tool surface at all.
3. On our authoritative store, **78 of 89 empty-`affected_files` decisions
   carry `provenance.commit_sha` (~90%)** — so retroactive derivation (ask 1)
   is the *primary* backlog mechanism, not a fallback. One trap is
   load-bearing: Gate 2 records *before* `git commit`, so the stored SHA is
   the **parent** of the work's commit. Naive derivation would mint
   confidently wrong edges at 90% coverage — strictly worse than today's 0%
   because silent. Requirements: child-commit resolution, an explicit bail
   when record→commit isn't 1:1, and a confidence signal on the inferred
   marker. Please re-run the empty-list × has-commit-ref split on your 540 —
   on the sqlite store, not any legacy mirror.

**Per-ask disposition:**

- **Ask 3 (lineage chains) — accepted, cheapest.** The exact walker already
  exists as `buildSupersededChains` (`dashboard/query-routes.ts:61-105`),
  reads only the decision store, and needs lifting into the engine behind a
  `lineage` option on `twining_why` (default surface, where Gate 1 readers
  already are).
- **Ask 4 (declared vs derived) — accepted, and sequenced FIRST.** Zero
  schema change (`Relation.properties` is free-form); copies two shipped
  precedents (`rationale_source`, `origin`) with absent = legacy/unknown.
  It must land before ask 1 or ~2,300 unmarked legacy auto-edges become
  permanently indistinguishable from newly inferred ones.
- **Ask 1 (derive edges from commit provenance) — accepted** as an opt-in,
  dry-run housekeeping pass (the `entity-scope-repair` pattern), unified with
  the D11 bulk repair: one pass derives `affected_files` *and* mints
  inferred graph edges. Blockers designed around: no relation dedup in either
  backend (idempotency key required), and **do not run `twining_prune_graph`
  before the pass** — it deletes relation-less entities, i.e. exactly the
  orphan concept nodes the pass would repair.
- **Ask 2 (what points at this) — accepted in reduced form.** For decisions,
  `twining_neighbors` is close: it needs edge-complete output (BFS currently
  emits each entity once, dropping parallel edges), a `depth` field, and
  lifecycle awareness (edges from archived/superseded decisions are
  indistinguishable from live — your "which **live** artifacts" phrasing
  walks straight into this). For *blackboard* artifacts, the honest answer is
  that posts are largely ungraphed on a stock install (`auto_populate`
  defaults false; only warnings/findings get nodes) — that half is a
  blackboard-search question, not a graph question.

**Adjacent defect found (not in your asks):** `onPost`'s `relates_to`
handling is dead code in practice — it writes `related_to` edges targeting
bare blackboard entry IDs that are never graph entities, the NOT_FOUND is
swallowed, and the failure aborts the remaining edge writes in the same call
(`graph-auto-populator.ts:159-171`). One `related_to` edge exists across
2,352 live relations. Anyone building "what points at this" on `related_to`
would be building on a no-op. Tracked as a defect, not a feature gap.

## Planned fix sequence (for your planning; not yet shipped)

- **Wave A (response-shape only, no schema changes):** D9 real
  `total_matched` + tool-description caveats; D10 superseded visibility in
  why/assemble (D3 pattern) + fan-out guard + dangling-target detection;
  D12 handoff age stamps/cutoff + scopeless-handoff default + entry
  scopeProximity/relevance floor.
- **Wave B (schema-additive):** D7 fix (per-decision `affected_files` /
  `affected_symbols` / `supersedes` on the structured object, loop clobber
  removed, persistence test); D11 `twining_amend` under the four invariants;
  D12 self-post marking (process start time + origin).
- **Wave C (derivation):** D13 ask 4 marker (with confidence vocabulary),
  then the unified D11/D13 bulk derivation pass (child-commit resolution,
  1:1 bail), diff capture at record time, lineage on `why`; `related_to`
  write-path fix and relation idempotency alongside.

## One request back, mirrored

D9's incident class ("no decision authorizes X" concluded from a ranked page)
is closed on our side only by the tool-description + count fix. Until that
ships, the workaround sentence in the D9 section above is safe to encode in
your `CLAUDE.md` verbatim. For D13 ask 1, the two measurements we need from
your store before building: (i) the empty-`affected_files` × has-commit-ref
split, and (ii) whether your surface actually lacks the graph write tools
(`tools.mode`). Both are read-only.

---

# Addendum 2026-08-12 — measurements received; ask 1 re-scoped; D7 elevated

The field repo answered both measurements same-day
(`2026-08-12-twining-wave2-measurements-back.md`). Dispositions updated:

## D13 ask 1: commit-provenance derivation is DEAD as specified — withdrawal accepted

Their store kills it three independent ways, and **this supersedes our
"derivation first" plan** (the earlier refinement was built on our store's
shape and does not survive theirs):

1. **The 1:1 bail we required fires on 96.3% of their backlog** — their 574
   empty-list decisions share only 109 distinct `commit_sha` values (one
   session recorded 56 decisions before a single commit, as normal practice).
   Net repair under our own safety rule: 21 records (3.7%), not ~90%.
2. Their better instrument (`git log --diff-filter=A` on the decision's own
   mirror file — exact, no 1:1 assumption, immune to the concurrent-session
   interleaving their repo demonstrably has) still hits two poison bands: a
   **backend-migration commit** that rewrote every pre-migration mirror file
   (162 records would derive `.mcp.json` as governing prose — confidently
   wrong and silent), and record-only commits with zero prose files (259).
   Net: 26.7%.
3. **The semantic wall no instrument fixes:** in their corpus
   `affected_files` means "the prose this decision governs"; provenance can
   only yield "files the recording session touched" — majority `analysis/`
   scratch, not `specs/`. Populated-but-wrong is worse than empty-but-honest.

**Accepted re-scope:** a `scope`→candidate-file expansion (enumerate prose
files under the decision's scope, rank by term overlap, present for
per-record **confirmation**) with `twining_amend` as the write path.
Confirmation workflow, not inference. Commit archaeology dropped.

**Consequence for the forward-path fix (capturing the discarded diff at
`record-tools.ts:48`):** it survives, but wall 3 applies to it too in
prose-governance corpora — a session's touched files are not the governed
files. Ship it as a provenance/candidate field (or clearly derived-marked),
never silently as authoritative `affected_files`. Any derivation-adjacent
pass must also detect and exclude store-migration commits.

## `total_in_scope` — confirmed as their absence instrument, now pinned

Their hard gate depends on `twining_why`'s `total_in_scope` being a real
total. **Confirmed at HEAD:** it is `matches.length` computed from the full
`getByScope` result *before* any token-budget truncation
(`decisions.ts:559`); the budget only splits presentation into
`decisions`/`more`/`omitted_count`. Budget-independence was already pinned by
tests (60 in scope under a 1-token budget); we have added a regression test
pinning the semantic half — retired records never inflate it, and
`include_superseded: true` counts all statuses
(`test/decision-engine.test.ts`, "total_in_scope counts live decisions
only…"). Two caveats their gate should encode:

1. Default semantics are **live-only** (superseded/overridden/archived are
   excluded and reported via `superseded_count` / `archived_excluded_count`)
   — correct for "does anything authorize X," but retired history requires
   `include_superseded`.
2. The instrument inherits the D7/D11 blindness: `getByScope` matches
   scope-prefix OR `affected_files` OR `affected_symbols`, so a decision
   with an empty file list and an unrelated scope (their 59 project-scoped
   empties) is invisible to it. `total_in_scope` measures **indexed
   evidence**, not ontological absence — until D7/D11 land, read it as "no
   indexed decision governs this path."

## D11 invariant note — one correction to their caution

Their warning that "our mirror is also auto-pruned" conflates tiers: per
their own D8 measurement (and our archiver's exemptions), the auto-archive
prunes only the `records/posts/` tier — **the decisions mirror is never
pruned**. `twining_amend` concerns decisions only, so mirror-prune
completeness is not a hazard for it; the live invariant remains
`ExportingDecisionStore` delegation (a missed delegation silently stops
mirroring and the next file-wins ingest reverts the amendment).

## Sequencing change: D7 ships first

Accepted. Their carrier rule ("decisions owing `affected_files` MUST use
`twining_decide`") is unfollowable on any default-surface store — including,
potentially, two of their sibling repos — because `twining_decide` is
full-surface-only. The D7 fix (per-decision `affected_files` /
`affected_symbols` on the structured object, loop clobber removed,
persistence test) is pulled ahead of the rest of Wave B as the single
highest-value item.

Also noted from their reply: their `priority_weights` are tunable
(`recency 0.3 · relevance 0.4 · confidence 0.2 · warning_boost 0.1`) — which
confirms the D12 conclusion that re-weighting cannot fix degenerate inputs;
their withdrawal of D12 ask (a) and deletion of the legacy handoff records
are acknowledged.
