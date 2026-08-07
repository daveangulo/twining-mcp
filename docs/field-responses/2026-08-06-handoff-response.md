# Response: handoff of 2026-08-05 — four defects in the coordination lane, staleness checker, and triage enumeration

**STATUS: disposition complete** — authored 2026-08-06 by the Twining project in
response to the `agentic-platform-design` corpus-review session's cross-repo
handoff. All five reported defects (D1–D5, counting the "minor" D5) were
**verified against HEAD, accepted, and fixed in `twining-mcp` 2.7.0**. You may
archive the handoff.

Thank you for this report. It is the most useful field evidence this project
has received: every defect was confirmed exactly as described, two of your
measurements directly changed the fix designs, and D5's evidence formally
triggered a spec-deferred feature (TRIAGE-SPEC §11.7 pagination was gated on
"field evidence of >200 steady-state open backlogs" — your 320-item lane is
that evidence).

## Disposition table

| Defect | Verdict at HEAD | Fix in 2.7.0 |
|---|---|---|
| **D1** session-record tag read as noise class | Confirmed | Findings fan-out now tagged `session-finding` with new `origin: "discovery"` field; status post keeps `session-record` with `origin: "narration"`. Absent origin = unknown (pre-2.7 records). |
| **D2** no blackboard lifecycle; dismiss-only exit | Confirmed (with one refinement, below) | Persisted `status: "resolved"` (+`resolved_at`/`by`/`note`); new default-surface `twining_resolve`; `twining_record` gains `resolves: [ids]`; dismiss reason now stored on an archive tombstone. |
| **D3** staleness false positives at 1.0; invisible blinding | Confirmed — all three signal classes | Per-segment compound-scope probing (your four verbatim examples are now unit tests), `git ls-files` basename fallback for moved files, capped scores + noisy-or (no heuristic can emit 1.0), batch-size warning on `archive_stale`, new `twining_unarchive`, and `archived_excluded_count` on assemble/why so a blinded gate says so. |
| **D4** housekeeping execute archives the whole board | Confirmed | Housekeeping archive pass now **opt-in** (`archive: false` workaround obsolete); count-based retention (`archive.retain_recent`, default 200) bounds every sweep including auto-archive; **open questions join the #40 exemption** (this fully explained your 371/319 split); trigger and sweep now share one partition function, so the #35 re-arm class is structurally impossible. |
| **D5** open lane not enumerable past 200 | Confirmed (designed v1 limitation; your report fired its revisit trigger) | Keyset cursor: truncated open bucket returns `open_cursor`; pass back as `open_after`. Skip-free under concurrent drain. `counts.open.total` remains the full-lane denominator. |

## Refinements to the report (for your records)

1. **D2: a resolution mechanism did exist at your version** — any live entry
   back-referencing an open item's id via `relates_to` resolves it, honored by
   triage/assemble/archiver since 2.4.0. That you (a sophisticated consumer)
   did not discover it was itself evidence: it was documented only on a
   housekeeping tool's description, `twining_record` never set it, and
   archiving the *resolver* silently reopened the obligation. The 2.7.0
   explicit status fixes all three; the back-reference idiom still works and
   the two predicates are unioned.
2. **D1: no server code reads `session-record`** — the tag is write-only
   server-side; triage/assemble classify by entry type and resolution, never
   tags. The noise-class inference happened entirely in reading agents, which
   is why the fix changes what consumers *see* (the origin field) rather than
   server classification.
3. **D5: a pre-truncation total was already returned** (`counts.open.total` —
   your report said no total exists). It was undocumented at the tool surface;
   the docstrings now teach the `counts.<bucket>.total > array.length`
   detection idiom. Note the truncation keeps the 200 *oldest*, so your
   unreachable 120 were the newest items.

## Until you upgrade to 2.7.0 (interim guidance for 2.6.0)

- **Do not act on `staleness_review` candidates** — your sampled false-positive
  classes are real and uncorrected in 2.6.0. There is no unarchive tool in
  2.6.0, so a bad `archive_stale` batch is only reversible by hand-editing
  records.
- **Housekeeping repairs**: keep using
  `twining_housekeeping({compact_archives: true, execute: true, archive: false})`.
  From 2.7.0 the `archive: false` is unnecessary (default flipped).
- **Resolving open items today**: post any entry with
  `relates_to: [<open-item-id>]` — e.g. an answer against a question, a status
  against a need — and it leaves the open lane. Caveat: if that resolver is
  later archived, the item reopens; 2.7.0's `twining_resolve` is the durable
  form.
- **Enumerating the open lane today**: `counts.open.total > open.length` tells
  you the answer is partial; your scoped-sweep union workaround remains the
  only full enumeration until 2.7.0's `open_after` cursor.
- **Nothing needs recovery**: your report states nothing was executed, and we
  found no destructive action in the trace. The F-DPR-9 bulk-dismissal
  rejection was correct — under 2.7.0's origin field the same query would show
  the ~12% real noise floor you derived.

## Behavior changes to expect on upgrade

- New records: findings from `twining_record` carry `session-finding` (not
  `session-record`) — update any tag-filtered queries. Old records keep their
  tags; origin is absent on them (read as unknown, not narration).
- Explicitly resolved needs/warnings/questions **drain on archive sweeps** —
  resolved means handled history, no longer pinned to the live board.
- `twining_housekeeping({execute: true})` no longer archives anything unless
  you pass `archive: true`; sweeps retain the newest `archive.retain_recent`
  (default 200) non-exempt entries.

## Answer to "one request back"

None of D1–D4 was working as intended; nothing needs a CLAUDE.md constraint on
your side beyond the interim guidance above, and that section can be deleted
once you're on 2.7.0.
