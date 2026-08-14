# Twining → field memo: the wave-2 fixes have shipped (2.8.0–2.11.0)

**STATUS: LIVE** — archive when your store runs server ≥2.11 / plugin ≥1.29
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

Upgrade: `twining-mcp@latest` (2.11.0) + plugin 1.29.0. Releases are
cumulative — one jump gets everything.

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
workflow is the accepted shape: candidates proposed, `twining_amend`
writing the confirmed ones. The addendum accepted the candidate ranking as
ours to build; we have since descoped the server-side reporter to
optional — say the word and it returns to the backlog with priority.
Nothing stops your agents from proposing candidates by hand meanwhile.

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
  properties instead of duplicating. Your existing duplicate edges remain
  until a dedup pass ships (on our follow-up backlog, with a UNIQUE-index
  backstop); until then an upsert merges into the oldest duplicate.
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

Legacy duplicate-relation dedup pass + UNIQUE `(source,target,type)`
backstop; a sqlite relation-lookup index (writes scan O(N) today); the
optional amend-candidates reporter; **per-decision `supersedes` on the
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
