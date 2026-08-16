# Twining → field memo: the wave-2 fixes have shipped (2.8.0–2.15.0)

**STATUS: LIVE** — archive when your store runs server ≥2.15 / plugin ≥1.33
and the CLAUDE.md retirements below are applied. Companion to the full
disposition (`2026-08-12-wave2-response.md`, including its measurements-back
addendum); this memo is only what you need to *act*.

**To:** the `agentic-platform-design` corpus-review lane (and the
`agentic-platform-code` / `agentic-platform-oss` sibling stores).
**From:** the Twining project. Every scheduled wave item is published —
D7, D9–D12 in full, and D13 asks 1 (re-scoped per your measurements), 3,
and 4; the remaining committed pieces are named in "Our open follow-ups"
below, none silently dropped. Every release was TDD'd and adversarially
reviewed pre-ship, and each review round caught majors in the reviewed
code — the fix set below includes those.

## What shipped, per release

| Server | Plugin | Contents |
|---|---|---|
| 2.8.0 | 1.26.0 | **D7**: per-decision `affected_files`/`affected_symbols` on `twining_record`'s structured decision objects — override session-level, fall back when omitted; the zod strip AND the loop clobber are both gone |
| 2.9.0 | 1.27.0 | **Wave A (D9/D10/D12)**: honest `total_matched` + `returned`; retired-status ordering de-boost; `superseded_excluded` on `why` + `superseded_excluded_count` on assemble; `supersedes` fan-out guard + `supersedes_dangling`; scopeless-handoff leak closed in BOTH backends; continue-work age stamps (`[BLOCKED Nd]`); entry scope-proximity dampening + semantic-admission noise floor |
| 2.10.0 | 1.28.0 | **Wave B (D11 + D12 remainder)**: `twining_amend` (full surface) — append-only `affected_files`/`affected_symbols` repair with in-record `amendments[]` provenance and audit finding; self-authored warnings marked `[this session]` by posted-id membership |
| 2.11.0 | 1.29.0 | **Wave C (D13 asks 3+4, plus graph defects)**: relation `origin` marker (`declared`/`derived`, absent = legacy) with downgrade protection; `lineage: true` on `twining_why` (chain head via `superseded_by`); graph relations upsert instead of duplicating; populator per-step isolation; the dead `relates_to` write path removed |
| 2.12.0 | 1.30.0 | **Amend-candidates reporter (re-scoped D13 ask 1)**: `twining_housekeeping({amend_candidates: true})` proposes candidate files for empty-list decisions — report-only by construction, root-contained, all caps reported |
| 2.13.0 | 1.31.0 | **Legacy relation-dedup pass**: `twining_housekeeping({dedup_relations: true})` removes your pre-2.11 duplicate `(source, target, type)` edges — survivor is the edge live upserts already merge into (seq-first), properties fold in under origin precedence. Hardened pre-ship by its own review round: duplicates with non-unique ids are skipped and counted (`skipped_id_collisions`, never over-deletes), a dangling-endpoint group is skipped and counted (`failed_groups`/`errors`) instead of aborting the pass, and a requested pass that cannot run reports `relation_dedup_error` — never a silent no-op. Preview by default; execute applies |
| 2.14.0 | 1.32.0 | **D14/D15 addendum dispositions (both investigated on receipt, both `field-misdiagnosis-real-defect-elsewhere` — see the section below)**: promote is now attributed (`promoted_by`/`promoted_at` on the record; additive `already_active_detail` in the result so a repeat/concurrent promote is distinguishable from "never provisional"); `updateStatus` reports `persisted` instead of silently no-opping on a missing target; `twining_override` reads back post-state (additive `status`/`overridden_by` in the result) and errors `PERSIST_FAILED` on a lost write; ingest counts `lifecycle_reverts` when file-wins downgrades an overridden/superseded decision (the statuses with no sanctioned undo verb — reconsider and unarchive arriving via git never fire it); `twining_unarchive` reports `assumed_active` + a warning post for marker-less pre-2.7 archives |
| 2.15.0 | 1.33.0 | **Revert visibility completed + housekeeping**: an ingest that reverts a lifecycle write now posts a blackboard WARNING naming the reverted ids (it reaches the agent via assemble, not just the server log); relation writes use an indexed `(source, target)` lookup instead of an O(N) scan; cyclic `chain_length` no longer overcounts; the Gate-2 stop hook no longer false-fires on edits outside the project or on subagent worktree writes. No action needed beyond the cumulative upgrade |

Upgrade: `twining-mcp@latest` (2.15.0) + plugin 1.33.0. Releases are
cumulative — one jump gets everything.

## Your D14/D15 addendum: dispositions and two questions back

Both reports were investigated same-day (dual independent passes +
adversarial cross-verification, reproduction attempted on HEAD and your
version). Both dispositions: **the mechanism you named does not exist,
and a real defect sat next to it** — now fixed in 2.14.0.

**D14 (override silent no-op on a provisional):** `twining_override` has
NEVER gated on status — vetoing/withdrawing a provisional works at your
version and at HEAD (verified byte-identical v2.5.0→HEAD, reproduced
13/13 + 7/7 in two independent runs, both backends plus your exact
sqlite + records-mirror composition). Your ask (4) documentation claim
("provisionals retire only via active-supersession") is wrong — override
IS the sanctioned withdrawal path, and your workaround was unnecessary.
What CAN produce your exact readback: the override's records-mirror
rewrite is an **uncommitted working-tree change** until your next
commit; any git operation that restores the committed (still-provisional)
bytes of `records/decisions/<id>.json` makes the next file-wins ingest
(probed on every tool dispatch after a HEAD move) silently revert the db
row, discarding `overridden_by` and your ~2KB reason. 2.14.0 makes that
loss visible (`lifecycle_reverts` + a per-record log line) and makes
override self-verifying (post-state in the result, `PERSIST_FAILED` on a
lost write). Your ask (3) `twining_withdraw` is declined: author
withdrawal is `override` with `overridden_by: <author>` — your own
lifecycle decisions deliberately keep promote/override as the only
provisional drain verbs. **Question back:** in the incident window, (a)
did the id `twining_why` displayed match the id you overrode (rule out a
duplicate twin), and (b) what git operation touched `records/` between
the override and the readback? `git log -p` on that mirror file will
show the reverting commit.

**D15 (promote reports promoted as already_active):** the buckets have
been computed from PRE-state since promote's introduction — a promoted
id cannot land in `already_active` in any shipped version (verified
v2.5.0→HEAD, and your exact timeline — provisional in the pre-promote
commit, sqlite + mirror + restart-shaped ingest — reproduces CLEAN).
The only single-session path to your observation is a SECOND promote of
an id already promoted; in your shared-store cmux setup a concurrent
session or subagent promoting first is the likely mechanism, and the
flip stays invisible in git until the next Gate-2 commit, which is fully
consistent with your archaeology. Your proposed rebucketing is declined
— a call that changed nothing must not claim it ratified. The real gap
was attribution, fixed in 2.14.0 as above. **Question back:** check your
blackboard (or archive) for a status post "Promoted 1 provisional
decision(s) to active" naming your id, timestamped between the
pre-promote commit and your call — every real promote writes one. If it
does not exist AND no housekeeping/unarchive/merge-ingest trace fits,
escalate with your `twining.db` and mirror history.

Your generalizable ask — every write that does not persist what it was
handed must say so — is accepted and partially shipped (updateStatus
`persisted`, override read-back, `assumed_active`, `relation_dedup_error`
in 2.13.0). The remaining piece, file-wins ingest precedence for
db-newer lifecycle state, is a named open design decision (it touches
the W2.3 convergence invariant) — visibility shipped now, precedence
deliberately unchanged.

## CLAUDE.md retirements (the reason to upgrade promptly)

1. **The CARRIER RULE is retirable** (*"a decision that owes
   `affected_files` MUST be written with `twining_decide`, never nested in
   `twining_record`"*). At ≥2.8 the nested field persists — put
   `affected_files` ON the structured decision object. This also closes the
   portability hole in the two sibling repos: the rule was unfollowable on
   any default-surface store, and now it is unnecessary everywhere.
2. **The D9 absence footnote is retirable** (*"`total_matched` trustworthy
   only when a status filter narrows below the page size"*).
   `total_matched` is now a true pre-page count in every invocation
   (semantic mode: raw cosine above the ~0.3 noise floor; keyword mode: any
   literal term hit; never deflated by status de-ranking), and the tool
   description itself now states that absence is not expressible with a
   ranker. **Keep** the `twining_why` + `total_in_scope` absence gate — that
   semantic is confirmed correct and pinned by a regression test on our
   side; it remains the right instrument, not a workaround.
3. **Your re-affirming-record workaround for D10 is unnecessary going
   forward.** A wholesale supersession is now visible at both gates
   (`why` returns the excluded records with their successors;
   assemble reports `superseded_excluded_count` with a briefing note
   instead of "No active decisions for this scope."), and `lineage: true`
   on `why` resolves any retired record to its current head.
4. **Your supersession-hygiene rule gets teeth**: a typo'd `supersedes`
   target now comes back as `supersedes_dangling` on both `twining_record`
   and `twining_decide` — it was previously indistinguishable from a
   completed supersession. Also: `supersedes` with multiple nested
   decisions is now SKIPPED loudly (`supersedes_skipped: true`) instead of
   flipping the target N times; for now record the superseding decision
   alone — per-decision `supersedes` on the structured object (the
   write-time decomposition we proposed as the D10(a) substitute) is a
   pending follow-up, not the shipped end state.

Unchanged and still yours: the D8 restore-and-recheck rule for mass
`records/` deletions, and your `twining_handoff` prohibition (the scopeless
leak is fixed server-side regardless; the API remains deprecated).

## The 574-record backlog: your write path is live

`twining_amend({decision_id, add_affected_files, add_affected_symbols,
reason})` — full surface, which your primary store runs. **The sibling
stores can only use it after setting `tools.full_surface: true`** — flag it
if that is a problem and we will weigh a default-surface registration.
Append-only (never removes, never
touches semantic content), works on retired records, idempotent, appends an
in-record `amendments[]` provenance entry and posts an audit finding, and
repairs reach every consumer at once: the drift check, staleness signal 2,
graph `decided_by` edges, and file-scoped retrieval.

Per your measurements, commit-derivation is dead and the confirmation
workflow is the accepted shape — and both halves now ship:
`twining_housekeeping({amend_candidates: true})` proposes candidates
(bounded scope-tree walk ranked by term overlap; report-only by
construction — `execute` has no effect; never walks outside the project
root; every cap and skip is counted, including `scope_outside_root` for
your `../`-style legacy scope strings), and `twining_amend` writes the
ones you confirm. Provisional records are scanned too — your ratification
queue gets candidates alongside active records.

## Behavior changes to encode before tooling trips on them

- **`superseded_count` on `why` is re-partitioned**: it now counts
  superseded + overridden only; archived are counted solely by
  `archived_excluded_count`. Anything parsing the old overloaded count must
  update.
- **`total_matched` changed meaning** (deliberately — that was D9). Scripts
  comparing it to `results.length` should read the new `returned` field.
- **Graph `origin` on relations**: absent means *legacy/unknown*, never
  "declared" — every pre-2.11 edge is origin-absent (2,352 was the count
  in *our* measured store; yours will differ). A machine (`derived`) write
  can never downgrade an agent (`declared`) origin.
- **Relation upsert**: re-adding the same `(source, target, type)` merges
  properties instead of duplicating. Your existing duplicate edges are now
  removable: run `twining_housekeeping({dedup_relations: true})` (preview),
  then again with `execute: true` (shipped 2.13.0). The UNIQUE-index
  backstop remains on the follow-up backlog.
- **`onPost`'s `relates_to` graph edges are gone** — the path targeted
  blackboard entry ids that are never graph entities and essentially never
  worked (your review nearly built on it). Post-to-post linking remains the
  blackboard `relates_to` field's job.
- **Assemble lane**: warnings from the calling session render
  `[this session]` (exact posted-id membership — concurrent sessions
  sharing your store are never mislabeled); continue-work items a day or
  older carry `(Nd ago)` / `[BLOCKED Nd]`; semantically-admitted off-scope
  entries are floored and proximity-dampened. Nothing scope-matched was
  removed from the lane — ordering and marking only, per your constraint.

## Our open follow-ups (so you know what is coming vs. not)

**File-wins ingest precedence for db-newer lifecycle state** (the D14
substantive question — visibility shipped in 2.14.0 as `lifecycle_reverts`,
precedence itself is an open design decision touching the W2.3 convergence
invariant); the UNIQUE `(source,target,type)` sqlite backstop (the dedup pass itself
shipped in 2.13.0); a sqlite relation-lookup index (writes scan O(N) today); **per-decision `supersedes` on the
structured object** (the D10(a) substitute — only the fan-out guard has
shipped); **the D13 ask-2 neighbors work in its accepted reduced form**
(edge-complete output, hop depth, lifecycle awareness — today an edge from
an archived decision is indistinguishable from a live one, exactly what
"which *live* artifacts" walks into); **diff capture at record time as a
provenance/candidate field** (never authoritative `affected_files`, per
your wall-3 measurement); a cosmetic lineage `chain_length` overcount on
cyclic (i.e. corrupted) chains. None block your upgrade.

## One request back

After upgrading, re-run the two incidents that started this: (i) the
nonsense-query probe against `twining_search_decisions` — you should now
see an honest `total_matched` (likely 0) alongside the ranked page; (ii) a
`twining_why` on a scope you know holds superseded records — you should see
them listed with successors instead of a bare count. If either still
misleads an agent in your setting, that is a wave-3 defect and we want the
trace.
