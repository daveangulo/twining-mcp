# Changelog

All notable changes to Twining MCP are documented here.

## [Unreleased] — 2.16.0

Wave 1 of the 2026-08-15 field read-context-quality audit response
(plan: `docs/plans/2026-08-17-read-audit-remediation-plan.md`).

### Fixed
- **S0 silent-amnesia guard.** `twining.db` counts as sqlite state only when
  it is non-empty with the SQLite magic header. A 0-byte or garbage db
  (crash, disk-full, interrupted migration) no longer boots an empty
  database beside unread legacy v1 decisions — the field measured 3 stores
  holding 1,342 decisions reading as empty, with 12 more one zero-length
  file away.
- **The amnesia store can no longer report "Healthy".** Legacy v1 content
  the sqlite backend cannot see warns loudly at boot (covering explicit
  `backend: sqlite` too, which the auto resolver never sees) and leads
  `twining_status` warnings with the migrate instruction. Pre-tag review
  round: the check is **tier-matched** (a migrated blackboard-only store's
  forever-empty decisions table no longer cries amnesia — the trust-critical
  warning must not train agents to ignore it) and **id-precise** where the
  legacy decisions index is readable (post-flip decisions no longer mask
  unread legacy state). The reverse-stranding shape also warns: a
  sqlite→files FALLBACK boot beside a populated `records/` tree flags
  `records_unread` — the session may be reading stale legacy history.
- **Double-render dedupe (both halves).** Truncated-summary entries rendered
  the same text twice (preview + `Full summary:` superset). Deduped in the
  assemble briefing AND in twining_read/query/recent responses; the assemble
  token budget now costs the deduped form, so warnings near the boundary no
  longer degrade over text that would have fit. On-disk lossless format
  unchanged (S4-1; review ASC-2/ENG-2).
- **Verify drift performance.** Scope population hoisted out of the
  per-stale-file loop (was O(stale × population)) and `git log` memoized per
  distinct file (was one spawn per affected_file entry — minutes at field
  scale). Call counts pinned by test (S2-C).

### Added
- **Self-identification.** `twining_status` reports `server_version`,
  `backend`, and `backend_reason` — a session can finally tell which build
  and which backend serve it (S0-B). Search/query responses carry
  `count_semantics: "pre_page_floored_v2"` so `total_matched`'s generation
  is readable off the wire (S3-A ask 2).
- **Index-desync detection + repair (files backend).** Decision files
  missing from `decisions/index.json` are invisible to every read path;
  `twining_status` now warns, and
  `twining_housekeeping({repair_index: true, execute: true})` salvages
  orphans under the index lock. On sqlite the pass reports
  `index_repair_error` instead of silently succeeding. Pre-tag review round:
  salvage is shape-gated (only recognizable decisions whose id matches the
  filename; strays count in `skipped_invalid`, never modified — an
  unvalidated salvage could poison the index and crash every scope read),
  survives a fully missing `index.json`, and keeps the index in ULID order.
- **Metrics cost fields.** `metrics.jsonl` entries gain `response_bytes`,
  `result_count`, and `scope` — context cost becomes measurable across the
  install base (S4-4).
- **WAL checkpoint policy.** Housekeeping execute runs
  `wal_checkpoint(TRUNCATE)` (reported as `wal_checkpointed`); the server
  closes the db on exit/SIGINT/SIGTERM so session end checkpoints the WAL
  (S4-7).
- **twining_commits disambiguation.** Malformed SHA → `INVALID_INPUT`; empty
  results carry `commit_exists` (`true | false | "unknown"`) + message, so a
  typo no longer reads as "no recorded rationale" (S4-12). Pre-tag review
  round: lookup is now **prefix-aware in both directions** (links stored as
  7-char abbreviations vs full-SHA queries and vice versa — the exact-match
  form let the tool assert "never linked" about a linked commit), the
  existence probe uses `git rev-parse --quiet --verify` with empirically
  verified exit codes (the `cat-file -e <hash>^{commit}` form exited 128 for
  missing objects, making the "no such commit" branch unreachable), and no
  message asserts more than the lookup actually established.

### Changed
- **twining_discover** excludes zero-capability-overlap agents by default and
  reports `excluded_zero_overlap`; pass `min_score: 0` for the old roster
  behavior (S4-8). `twining_delegate`'s suggested_agents inherits the
  exclusion and now carries the same `excluded_zero_overlap` count so the
  shrink is never silent (review CS-6).
- **Shutdown is one coordinated path** (signals + stdin close): the dashboard
  stops accepting, in-flight tool steps get the bounded 3s drain the old
  dashboard-only handler provided, the db closes on `exit` (checkpointing the
  WAL), and signal exits use conventional codes 130/143 instead of 0
  (review LS-2/LS-3). Hosts that end sessions by closing stdin no longer
  leave the process alive serving only the dashboard.
- `twining_decide` alternatives' `reason_rejected` is optional, matching
  `twining_record` and the engine (review CS-2).
- **twining_record**: empty summary rejected with a repairable message;
  `reason_rejected` on alternatives is now optional, matching engine
  semantics (S4-2 residue).
- Tool descriptions: assemble documents the `token_estimate ≈ max_tokens`
  truncation signature and that `decisions_count` is a briefing selection,
  not a census; triage documents `counts.open.by_kind.decision` as the
  scoped ratify count; status declares `provisional_decisions` the canonical
  store-wide form.
- `docs/hooks.md` rewritten: it still described the pre-1.16 mtime Stop
  gate and omitted the activity-marker hook entirely (plausibly the source
  of the field audit's S2-E misdiagnosis); adds a read-only audit recipe.

## [2.15.0] - 2026-08-16

*(Backfilled 2026-08-17 — 2.13.0–2.15.0 shipped tag-only; the wave-2 ship
memo table was their only release log until this entry.)*

### Added
- **Revert-warning surface**: file-wins ingest lifecycle reverts now post a
  scoped blackboard warning — one per distinct reverted-decision scope,
  (scope, detail)-deduped with resolved-exclusion, transaction-wrapped with
  a compensating delete on mirror-write failure.
- Sqlite relation-lookup index for the (source, target, type) upsert path.

### Fixed
- **Plugin 1.33.0: activity-marker edit-path filter.** The Gate-2 marker
  stamps only for edits under the canonicalized project root (or the
  session's linked worktree) — out-of-tree scratch writes no longer block
  read-only sessions. Hook paths canonicalized through the nearest existing
  ancestor; worktree-hosted `TWINING_PROJECT` sessions stamp correctly.
- Cyclic lineage `chain_length` overcount.
- Tool-description token-budget re-baseline.

## [2.14.0] - 2026-08-16

Field D14/D15 addendum dispositions (both field-misdiagnosis with a real
defect elsewhere; see `docs/field-responses/`).

### Added
- **Promote attribution**: `promoted_by`/`promoted_at` stamped on ratify;
  `already_active_detail` names the earlier actor on double-promote.
- **Ingest revert visibility**: `lifecycle_reverts` counter (armed only for
  overridden/superseded downgrades — sanctioned flows don't false-alarm),
  per-record server log.
- Unarchive `assumed_active` + warning when the pre-archive status is
  unknown.

### Fixed
- **Persist-honest lifecycle writes**: `updateStatus` returns `{persisted}`,
  checked at all six call sites — a lost write can no longer report success
  (D14's affirmative-on-no-op shape).
- Override read-back is race-tolerant: `PERSIST_FAILED` only when the write
  did not persist; a concurrent status flip is echoed honestly.

## [2.13.0] - 2026-08-14

### Added
- **Legacy relation-dedup pass**:
  `twining_housekeeping({dedup_relations: true})` folds duplicate
  (source, target, type) graph relations left from before the 2.11 upsert —
  survivor is the edge live upserts merge into, properties folded under
  origin precedence. Review round added the id-collision guard
  (`skipped_id_collisions`), per-group isolation (`failed_groups`/`errors`),
  `relation_dedup_error`, and capture-before-delete mirror unlink.

## [2.12.0] - 2026-08-13

### Added
- **Amend-candidates reporter (re-scoped field D13 ask 1).**
  `twining_housekeeping({amend_candidates: true})` reports candidate
  `affected_files` for active decisions whose list is empty: a bounded walk
  of the decision's scope tree ranked by term overlap with its summary and
  rationale. Report-only by construction — `execute` has no effect; the
  sole write path is per-record `twining_amend` confirmation, because the
  field measured populated-but-wrong lists as worse than honest emptiness.
  Caps (50 decisions/run, 500 files/scope, 5 candidates each) are always
  reported, never silent; `project`-scoped decisions are skipped with a
  count.

## [2.11.0] - 2026-08-13

Wave C of the second field-defect wave — the knowledge-graph half of the
D13 asks, plus two graph defects the investigation surfaced. Full
disposition: `docs/field-responses/2026-08-12-wave2-response.md`.

### Added
- **Relation provenance marker (D13 ask 4).** Every graph relation now
  carries `properties.origin`: `"declared"` for agent-typed edges
  (`twining_add_relation`; a caller-supplied origin wins), `"derived"` for
  all auto-populated edges, absent means legacy/unknown — the same
  absence semantics as `rationale_source` and blackboard `origin`.
  Sequenced before any future derivation pass so inferred edges can never
  masquerade as declared ones.
- **`lineage: true` on `twining_why` (D13 ask 3).** Excluded superseded/
  overridden records gain `lineage_head` `{id, summary, chain_length}` by
  walking `superseded_by` to the terminal record — "what is the current
  answer", not "what ranks highest". Cycle-guarded and depth-capped;
  off by default.

### Fixed
- **Graph relations upsert instead of appending (both backends).**
  Re-adding the same `(source, target, type)` now merges properties and
  returns the existing edge — re-recording a decision duplicated every
  `decided_by` edge, and no derivation or repair pass could ever be
  idempotent. Existing duplicates in field stores are unaffected (a
  cleanup pass is a candidate follow-up).
- **One failed edge no longer aborts the rest of graph population.**
  `onDecide`'s depends_on/supersedes/commit edge groups are individually
  isolated — a `NOT_FOUND` on a pre-graph or pruned concept previously
  killed every subsequent edge in the call. `onPost`'s speculative
  `relates_to` loop is removed outright: it targeted blackboard entry ids
  that are never graph entities (1 coincidental edge across 2,352 in the
  measured store), and post-to-post linking is the blackboard
  `relates_to` field's job.

## [2.10.0] - 2026-08-13

Wave B of the second field-defect wave (D11, D12 remainder) — the
schema-additive half. Full disposition:
`docs/field-responses/2026-08-12-wave2-response.md`.

### Added
- **`twining_amend` (full surface): append-only metadata repair (D11).** No
  tool could edit a written record's `affected_files`/`affected_symbols` —
  the two fields the drift check, staleness signal 2, all graph `decided_by`
  edges, test-coverage derivation, and file-scoped retrieval key on — so a
  record written empty (the D7 class; 17-18% of both measured stores) was
  permanently invisible to eleven consumers, repairable only by a redundant
  second record. `twining_amend` adds entries (never removes, never touches
  semantic content), appends an in-record `amendments[]` provenance trail,
  posts an audit finding, works on retired records, and keeps every backend
  consistent: the file backend rewrites the index entry retrieval reads
  from, the sqlite mirror re-exports so file-wins ingest propagates rather
  than reverts, and graph edges are minted for newly added paths only
  (relations never deduplicate).
- **Self-authored warnings are marked in assemble's lane (D12).** In a long
  session the warning lane fills with the caller's own posts — and
  `agent_id` cannot distinguish them (it is a role label; "main" on most
  entries). The server process is one-per-session, so entries newer than
  process start are the caller's: they now carry `self_authored: true` and
  render a `[this session]` suffix. Marked, never hidden or re-scored — a
  session that lost context genuinely wants its own trail.

## [2.9.0] - 2026-08-13

Wave A of the second field-defect wave (D9, D10, D12) — response-shape fixes
only, no schema or store changes. Full disposition:
`docs/field-responses/2026-08-12-wave2-response.md`. Every change below was
adversarially reviewed pre-release; the review itself contributed five fixes,
including one that made the D12 handoff fix reach the default (sqlite)
backend at all.

### Fixed
- **`twining_search_decisions` reports an honest `total_matched` (D9).** It
  was the length of the already-truncated page — `limit: N` returned
  `total_matched: N` at every N, so raising the limit "to check the total"
  confirmed the artifact, and one field agent published a false "no decision
  authorizes X" claim on the strength of it. `total_matched` is now a true
  pre-page match count: raw cosine above the ~0.3 noise floor in semantic
  mode, any literal term hit in keyword mode — membership is always tested
  on raw scores. A new `returned` field carries the page size. The tool
  description now states the noise floor, that absence is not expressible
  with a ranker (use `twining_why` + `total_in_scope`), and the count
  semantics.
- **Retired decisions no longer outrank their own amendments (D9).**
  Relevance ranking was raw similarity over all statuses, and an original
  states the thing more plainly than its correction — the field measured a
  superseded record at rank 1 above the decision that changed it. Superseded,
  overridden, and archived decisions now carry a 0.75 ordering de-boost
  (never applied to negative scores, never affecting `total_matched`).
- **Superseded decisions are visible as exclusions at both context gates
  (D10).** `twining_why` hid them behind a bare, overloaded
  `superseded_count`; assemble — the mandatory Gate 1 — dropped them with no
  count at all and printed "No active decisions for this scope." after a
  wholesale supersession of a multi-part record. `why` now returns
  `superseded_excluded` (id, summary, successor; capped at 20), assemble
  reports `superseded_excluded_count` with a briefing note (mirroring D3's
  archived pattern), and both exclusion classes render even in
  exclusion-only and budget-exhausted briefings. `superseded_count` now
  counts superseded + overridden only — archived are counted solely by
  `archived_excluded_count`, ending the double-count.
- **`twining_record`'s `supersedes` no longer fans out or fails silently
  (D10).** The session-level id was applied inside the per-decision loop — N
  decisions flipped the same target N times, overwriting `superseded_by`
  each time, so the back-link pointed at an arbitrary one of the N. With
  multiple decisions the supersession is now SKIPPED and reported
  (`supersedes_skipped`); with none recorded, likewise. A target id that
  does not exist is reported as `supersedes_dangling` on both
  `twining_record` and `twining_decide` — a typo'd id was previously
  indistinguishable from a completed supersession.
- **Scopeless handoffs no longer match every scope (D12).** `scopeMatches`
  is bidirectional prefix and every string starts with `""`, so a handoff
  persisted without a scope surfaced in every scoped assemble forever — the
  field's 15-day-old `[BLOCKED]` fossil. `createHandoff` now applies its
  documented `"project"` default, and both backends' list filters read
  legacy scopeless records as `"project"` (the sqlite side was caught by the
  pre-release review — the file-backend fix alone would have missed the
  default backend).
- **The assemble warning lane resists self-post and off-scope dilution
  (D12).** The lane was recency-dominant in all but name (confidence and
  warning boost are constants), so the caller's own newest posts
  systematically outranked cross-session signal. Entries now get the same
  scope-proximity dampening decisions have always had, and semantic-only
  admission requires relevance above the shared noise floor — scope-matched
  entries are never floored, and nothing the lane previously surfaced is
  hidden, only re-ordered.
- **Continue-work items carry their age (D12).** Handoffs a day or older
  render `(Nd ago)` and blocked results `[BLOCKED Nd]` — a two-week-old
  blocked item is no longer indistinguishable from this morning's.

## [2.8.0] - 2026-08-12

Field-defect release, pulled ahead of the rest of the wave-2 plan at the
field's request: their binding carrier rule ("decisions owing `affected_files`
MUST use `twining_decide`") is unfollowable on any default-surface store,
because `twining_decide` is full-surface-only. Details and the full wave-2
disposition: `docs/field-responses/2026-08-12-wave2-response.md`.

### Fixed
- **`twining_record` no longer silently drops `affected_files` /
  `affected_symbols` on structured decision objects (field D7).** The defect
  was double-locked: the nested decision schema had no such fields, so zod
  stripped the keys with no error and a success response; and the dispatch
  loop then applied the session-level list unconditionally after the input
  spread, so the value could not have survived anyway. Six field records in
  one day passed a path and stored `affected_files: []` — and because no tool
  can amend a written record's metadata (field D11, fix scheduled), every
  occurrence was a permanent orphan. Both structured decision fields now
  exist per-decision: they **override** the session-level lists for that
  decision and **fall back** to them when omitted (same precedence as
  `assumptions`/`constraints`; NL string decisions keep the session-level
  lists). Empty `affected_files` blinds eleven consumers — the drift check,
  staleness signal 2, all graph `decided_by` edges, test-coverage derivation,
  assemble's FILES TO CHECK lane, and file-scoped retrieval among them — so
  the drop was a retrieval defect, not a cosmetic one.

## [2.7.0] - 2026-08-06

Field-defect release. A cross-repo handoff from a 3,052-decision field
deployment reported five defects in the coordination lane, staleness checker,
and triage enumeration (D1–D5); all five were verified at HEAD and fixed.
Details: `docs/field-responses/2026-08-06-handoff-response.md`.

### Added
- **Persisted blackboard lifecycle (D2).** Entries can now carry
  `status: "resolved"` with `resolved_at`/`resolved_by`/`resolution_note`;
  absent means open, so every existing record is unaffected. The new
  **`twining_resolve`** tool ships on the **default surface** — the everyday,
  record-preserving exit from the open lane that was missing: the only
  discoverable exit used to be `twining_dismiss`, which hard-deletes, so agents
  correctly declined to use it on substantive items and the open lane grew
  monotonically (177→320 in three days in the field). The resolution predicate
  is now the union of explicit status and the existing `relates_to`
  back-reference, honored uniformly by triage, assemble, the archiver, and the
  auto-archive trigger — and unlike a back-reference, explicit status survives
  its resolver being archived. `twining_record` gains **`resolves: [ids]`** to
  close items at the natural "I handled this" moment.
- **`origin: "narration" | "discovery"` on blackboard entries (D1).**
  `twining_record` stamped the identical `session-record` tag on its status
  post and its findings fan-out, leaving consumers one tag that conflated what
  a session *did* with what it *found* — the field measured an 89% false noise
  floor built on that inference (real: ~12%). Findings now carry tag
  `session-finding` + `origin: "discovery"`; the status post keeps
  `session-record` + `origin: "narration"`. Absent origin means unknown.
- **`open_after` keyset cursor on `twining_triage` (D5).** The open lane is
  unbounded by design but was capped at 200 per delivery with no paging — the
  field's 320-item lane left the 120 *newest* items unreachable. A truncated
  open bucket now returns `open_cursor`; pass it back as `open_after` to page.
  Keyset on the contractual `(timestamp, id)` sort key, so paging is skip-free
  under concurrent lane drain. TRIAGE-SPEC §11.7's revisit trigger fired.
- **Count-based archive retention (D4).** `archive.retain_recent` (default 200)
  keeps the newest K non-exempt entries on the board through any sweep,
  including the 500-entry auto-archive. Count-based, not age-based — the #35
  outage proved an age cutoff cannot bound a same-hour burst. `twining_archive`
  gains an explicit `retain` parameter (legacy calls unchanged).
- **`twining_unarchive` (D3)** — restores archived decisions to `active`; the
  undo that made a bad staleness sweep practically irreversible before.
- **`archived_excluded_count` on assemble and why (D3)** — a scope whose
  decisions were archived away now reads "N archived excluded", never the
  indistinguishable "no decisions exist". The assemble briefing names the
  recovery tool when the count is non-zero.

### Fixed (pre-release adversarial review of this release's own diff — 18 confirmed findings, all addressed)
- **`twining_record`'s `resolves[]` raced the auto-archive its own status post could trigger** — resolution stamps were lost or targets falsely reported not found on boards at the archive threshold (reproduced 4/4). Resolution now persists *before* the status post; resolve failures degrade to `resolve_errors` in the response instead of aborting Gate 2 after the post landed.
- **`twining_archive_stale` hard-deleted blackboard entries with no tombstone** while claiming items "remain on disk" and pointing at an undo that only restores decisions. It now tombstones every blackboard dismissal and states exactly what is recoverable by which path — as do the dismissal tombstones now written by the housekeeping dedup pass, the last path that deleted without one.
- **`twining_unarchive` forced restored decisions to `active`**, silently ratifying provisionals and resurrecting superseded decisions as authoritative. Archiving now remembers `archived_from`; restore returns each decision to its pre-archive status.
- **Housekeeping dedup deleted resolution audits**: a resolved entry colliding with a same-text repost lost its `resolved_by`/note (or, reversed, an open obligation was silently deleted). Entries carrying lifecycle stamps are no longer dedup candidates in either role.
- **Three surfaces disagreed on the archive partition cutoff** (#35-class counted-but-never-archived drift): the auto-archive trigger counted future-stamped entries its fired sweep then excluded (clock skew / git-synced stores — reproduced executable); `twining_status` counted them while its recommended housekeeping sweep excluded them; and the documented commit-hook archive path bypassed retention entirely. All sweeps now share `NO_AGE_CUTOFF` + the configured retention, and archive filenames are dated by run day (the sentinel no longer creates an ever-growing `9999-12-31` file).
- **Blackboard entries could never be flagged stale**: with no `affected_files` field their signal ceiling was 0.88, below the 0.95 threshold — the checker's false-positive fix had overcorrected into a structural false negative. Two independent structural signals now corroborate to 0.95 (still never 1.0). The moved-not-gone basename inference also now requires a *unique* basename, so a deleted subsystem's `index.ts` no longer reads as "moved" because unrelated `index.ts` files survive.
- **Staleness scoring produced false positives at a uniform 1.0 (D3).** All
  three signals were structurally wrong in the field (584 candidates, every
  sampled one false): compound scopes (`"specs/ + rfcs/"`, `"spec.md §2.7"`)
  were stat'd as one filesystem path; git-mv'd files read as deleted; normal
  post-merge branch deletion scored as content rot. Scopes are now split and
  probed per segment; `affected_files` consult a one-shot `git ls-files`
  basename index (moved ≠ gone); scores are capped (`scope_path_missing` 0.8,
  `branch_gone` 0.4, file proportion ≤0.95) and combine by noisy-or, so **no
  heuristic — alone or combined — can emit 1.0**. `twining_archive_stale` warns
  on batches above max(20, 5% of live decisions).
- **`twining_dismiss` silently discarded its `reason`** (documented "logged but
  not stored"; it was neither). Dismissals now append a tombstone with the
  entry, reason, and dismisser to `.twining/archive/`.
- **Auto-archive trigger and sweep could drift (#35 class).** The trigger count
  now calls the *same* `partitionArchivable` function the sweep executes, so a
  counted-but-never-archived class — the mechanism of the original feedback
  loop — is structurally impossible.

### Changed
- **`twining_housekeeping`'s archive pass is now opt-in (`archive: true`,
  previously default-on) (D4).** The pass takes no age cutoff, so
  `housekeeping({execute: true})` archived the *entire* live board as a side
  effect of any maintenance call — the safe `compact_archives` repair and the
  destructive sweep shared one flag. The 2.6.0 `archive: false` workaround is
  obsolete; repairs now run safely with plain `execute: true`.
- **Unresolved questions join the archive exemption (#40 widened, D4).** Triage
  counts open questions as obligations, but the archiver swept them by age —
  the field's 371-archived/319-kept split. With D2, *resolved* questions drain.
- **Explicitly resolved needs/warnings are archivable (D2).** The #40 exemption
  protects *open* obligations; a resolved item is handled history and now
  drains on sweeps.

## Plugin [1.24.1] - 2026-08-04

### Fixed
- **The 1.24.0 unset-root guard broke every plugin session.** Claude Code interpolates plugin config strings before `sh` sees them, and its interpolator only understands the bare `${CLAUDE_PLUGIN_ROOT}` form — the guard's `${CLAUDE_PLUGIN_ROOT:-}` was unrecognized and replaced with the **empty string**, so `[ -z "" ]` exited 78 before the launcher ever ran, in the same command string where the exec's bare reference substituted correctly. Deterministic: every session, every project, every user of 1.24.0. The guard now uses the bare form everywhere; a test bans any other `${...}` expression in `plugin/.mcp.json` and replays the interpolation end-to-end. The guard's purpose survives — outside a plugin context it still exits 78 naming the cause.
- **Login-PATH recovery could lose node.** The launcher *replaced* PATH with the `sh -lc` login PATH; a node whose dir is added only by the interactive rc (`~/.zshrc` adding `~/.local/bin`) is invisible to a login `sh`, so when Claude Code spawned with a minimal environment, recovery produced a node-less PATH and exit 127 ("Node.js was not found on PATH") even though node was resolvable the whole time. The login PATH now merges ahead of the inherited PATH instead of replacing it (login-first, so resolution is unchanged wherever it previously worked), and if node is still unresolvable the launcher appends well-known install dirs that exist (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, volta/asdf/mise shims — probed with globbing disabled, so metacharacters in `$HOME` cannot match sibling directories).
- **The SessionStart hook's availability probe ran the launcher through `sh -lc`**, re-imposing exactly the replace-PATH semantics the launcher fix removes — a non-passthrough `~/.profile` could make the probe report the server absent (false warning) while the real `sh -c` spawn succeeds. The hook now spawns the launcher directly, restoring probe/spawn parity.

## [2.6.0] - 2026-08-03

Deep-review release. A multi-agent structural and defect review of the whole
product, validated against a 2,323-decision field project, then fixed. Details:
`docs/FIELD-VALIDATION.md`.

### Fixed
- **Assemble presented decisions in store order, not score order.** The weighted ranking (recency, relevance, confidence, graph reachability) decided only *which* items fit the token budget; the loop that built the briefing then iterated the **unsorted** array. So the `CRITICAL` tier rendered the three *oldest* scope-matched decisions and collapsed the highest-scoring ones into `+N more`. In a field project's busiest scope only ~14% of relevant decisions fit the budget at all, which made *which* 14% surfaced close to everything.
- **Resolved needs and warnings resurfaced forever** as `REMAINING WORK` and `STOP` directives. Assemble ignored the `relates_to` resolution predicate that the archiver and triage already shared. Resolved obligations are now dropped before scoring, so they also stop consuming budget. Resolution is computed from the full live board, since the resolving entry is usually posted against a different scope.
- **Warnings that exceeded the token budget vanished, and the briefing then said "No prior context constraints — proceed".** Warnings now degrade to summary-only rather than disappearing; anything that cannot fit even so increments `warnings_omitted`, which suppresses both false all-clear paths.
- **`twining_why` surfaced overridden and archived decisions** in the full-detail tier, presenting an explicitly reversed choice as a live constraint. Only `superseded` was excluded before.
- **Record ingest deleted unmirrored rows when `export_records` was off.** With mirroring disabled the `records/` tree is a stale partial snapshot and the database is the only complete state, but ingest ran unconditionally at every server start and on every HEAD move — deletion-propagating every row whose file was absent. Both call sites are now gated, and a stale tree is reported at startup.
- **`migrate --reverse` wiped the file backend** when `export_records` was off and no `twining.db` existed: it created an empty database and exported that over the live store, exiting 0.
- **The NL decision parser fabricated rejected-alternative reasons.** Every alternative extracted from a natural-language decision string was stored with `reason_rejected: "Not chosen"` — a tautology in the field that should hold the why-not, on 217 of 217 NL-derived alternatives in this project's own store. `reason_rejected` is now optional and omitted when the prose never stated one. Two patterns were deleted as unsalvageable after measurement: bare `not` in the rejection set (87% noise; the narrower appositive replacement measured *worse* on real data) and `" as "` as a rationale separator (it cut "Adopted the bundled server as the default" into a rationale of "the default"). A negated-choice veto fixes the worst class — "Chose NOT to prefer the bundled server **over npx**" used to store `npx`, the option that was *kept*, as rejected. The labelled form (`Alternative rejected: X — reason`) now yields a real option and a real reason; it is the only construction in prose that states a why-not.
- **Graph entity scope was last-writer-wins.** The auto-populator stamps file and symbol entities with the scope of the decision that touched them, and upsert overwrote — so a file touched from two scopes kept only the most recent, and the committed entity record was rewritten on every flip. Measured here: of 242 file entities carrying a scope, only 132 had a name starting with it. `scope` now accumulates as a sorted, capped set; sorting makes the bytes deterministic so ordering alone stops churning the store.

### Added
- **`twining_housekeeping({ archive: false })`** skips the blackboard archive pass while other passes run. The documented `compact_archives` repair path needed `execute: true`, but step 1 archives with *no cutoff* — so the sanctioned way to reclaim archive junk first swept the caller's entire live board.
- **`twining_housekeeping({ repair_entity_scopes: true })`** recomputes graph entity scopes from their `decided_by` relations, recovering scopes the overwrite destroyed. Dry-run by default; unions rather than replaces, so a hand-written scope with no relation backing it is never dropped.
- **`rationale_source`** on stored decisions marks whether a rationale was authored or echoed from the summary. Stamped at both sites — the structured builder owns most laundering in practice, so a parser-only marker would have missed three quarters of it. An absent marker means *unknown*, never *authored*.
- **`warnings_omitted`** on assembled context, so a truncated briefing can never claim there are no constraints.
- **`scripts/field-probe.mjs`** — read-only measurement of a real `.twining/` store against 14 pre-registered hypotheses with falsification thresholds fixed before first run. Zero dependencies.
- **`scripts/compact-archives-standalone.mjs`** — reclaims pre-1.24.0 archive-loop junk without a server, an MCP tool, or a release, for repos that cannot take one. Reclaimed 3.57 GB in a field project.

### Changed
- **Documentation corrected against actual tool registration.** The surface tables in `README.md` and `docs/TWINING-REFERENCE.md` were inverted: the reference listed seven full-surface-only tools as "always registered" — so an agent following it called tools that do not exist — and omitted seven real default tools. A test now asserts the classification so it cannot silently invert again. The README also claimed hooks enforce both gates; Gate 2 is hook-enforced, Gate 1 is instruction-only.

## Plugin [1.24.0] - 2026-08-03

### Fixed
- **Plugin agent definitions launched with no Twining tools at all.** `twining-aware-worker` and `twining-coordinator` declared `tools:` allowlists of bare names (`twining_assemble`, …), but MCP tools are namespaced at runtime (`mcp__plugin_twining_twining__twining_assemble` under a plugin install, `mcp__twining__*` standalone). Every entry matched nothing and was dropped silently — taking `ToolSearch` with it, so the agents could not even discover the tools. Reproduced live: the spawned agent's entire toolset was `Read, Write, Edit, Bash`. Both allowlists are removed; because the correct prefix depends on install mode, hardcoding one would break the other.
- **The launcher exec'd away its own fallback.** `resolve_runner` commits to the npx rung on `npx --version` alone, then `exec npx -y twining-mcp` — replacing the shell. When the registry refuses the package (a `minimumReleaseAge` policy, auth, proxy, offline), the launch died and the dependency-free bundled server one rung below was never reached. A field project lost Twining entirely this way while `--probe` reported `runner=npx`. The three network rungs now run as children and fall through to the bundle when they die inside a grace window; a server that actually served and then exited is never restarted, since its client handshake is spent.
- **An unset `CLAUDE_PLUGIN_ROOT`** produced `exec /scripts/launch-server.sh: not found`, indistinguishable from a broken install. It now names the cause and exits 78.

### Changed
- **The auto-invocable `twining-decide` skill was broken end-to-end on every default install** — `decide`, `override`/`reconsider`, the "REQUIRED" `link_commit`, and `promote` are all full-surface-only, so the core decision-recording workflow silently failed. Rewritten around `twining_record`, which is default-surface and reaches the same store. Seven more skills and the export command now state the `full_surface` requirement and give a working fallback.

## [2.5.0] - 2026-07-23

### Added
- **Creation-time provisional decisions** (closes the TRIAGE-SPEC §9 provisional-at-creation gap; field-requested): `twining_decide` accepts `status: "active" | "provisional"` (default `active`) and `twining_record` accepts per-decision `status` on structured decision objects. A decision born `provisional` lands directly in the triage `open` lane awaiting `twining_promote`/`twining_override` — no more decide-then-reconsider two-step, and no stray reconsider companion warning. Only the two live states are creatable; the enum is enforced in the engine (not just the tool schema), so superseded/overridden/archived stay lifecycle outcomes through every caller. Both field descriptions carry the `promote_provisionals` warning inline — that housekeeping flag bulk-promotes >7-day provisionals with no per-item review; leave it off if provisional is your ratification queue.
- **Review-hardened semantics** (from the pre-merge adversarial review): `status: "provisional"` + `supersedes` is rejected — supersession commits at creation, so the combination would retire the incumbent before ratification (veto would strand the scope with no live decision). Provisional minting via `twining_record` requires `tools.full_surface: true` — the drain tools are full-surface, and the default surface must not create provisionals it cannot ratify or veto. Pending provisionals now participate in decide()'s conflict detection (they are live constraints), and `twining_what_changed` no longer mislabels born-provisional decisions as "reconsidered".

## Plugin [1.21.0] - 2026-07-23

### Added
- **Dashboard Triage tab ships to plugin installs**: bundled server rebuilt with the new Triage view (see 2.4.0), the raw-file route, and repo-info remote link derivation. No hook or launcher changes.

## [2.4.0] - 2026-07-23

### Added
- **`twining_triage` — a project-wide triage read-model** (spec: `docs/TRIAGE-SPEC.md`). One engine core (`buildTriage`, `src/engine/triage.ts`) behind three surfaces: a `full_surface`-gated MCP tool, `GET /api/triage`, and a dashboard **Triage** tab (the primary surface). Two buckets keyed on exit semantics: `open` (unwindowed — provisional decisions awaiting `twining_promote`/`twining_override`, plus needs/questions/warnings unresolved per the #40 `relates_to` convention, delegation expiry honored) and `recent` (windowed, `since`-cursorable — newly active decisions incl. the disagree-and-commit audit material, and `artifact` posts). Optional `for_agent` excludes an agent's own outbound posts; `counts` are pre-truncation with per-kind breakdowns and truncation-proof `irreversible` tallies. The tool surface carries a pre-declared 8-week field-data promotion/removal test (spec §6.1).
- **Shared engine helpers extracted**: `computeResolvedIds` (`src/engine/resolution.ts`) is now the single #40 resolution predicate consumed by the archiver, auto-archive, and triage; `scopeMatches` (`src/utils/scope.ts`) unifies the six store scope filters across both backends. Behavior-preserving.
- **Dashboard: read-only raw-file route** (`GET /api/raw?path=` — root-jailed, dotted segments denied, symlink containment, always `text/plain` + `nosniff`) and `GET /api/repo-info` for render-time remote doc links; repo-relative paths and `http(s)` URLs linkify in triage rows and detail panels; `needs-human` tag band and filter toggle in Open items.

### Changed
- **Bundled server refresh**: `plugin/server/twining-server.mjs` rebuilt to include the migrate CLI's canonical root resolution (see 2.3.0) — `twining-mcp migrate` run through the bundled server honors `TWINING_PROJECT` and the linked-worktree redirect. No hook or launcher changes.

## Plugin [1.20.0] - 2026-07-22

### Changed
- **All hooks are worktree-aware and honor `TWINING_PROJECT`**. The five hooks that locate `.twining` (session-start, pre-commit, and the other cwd-walking hooks) now share one mirrored resolution block: `TWINING_PROJECT` wins if set (previously server-only), and when the resolved root is a linked git worktree (`.git` is a `gitdir:` file pointing into `.git/worktrees/`) the hooks redirect to the main checkout's `.twining` — matching server 2.3.0, so the commit/stop gates read the same store the server writes. A linked-worktree root is always a walk boundary: with `TWINING_WORKTREE_LOCAL=true` (opt-out), or when the main checkout has no `.twining`, the hooks bind the worktree's own store (or fail open) instead of walking up past the worktree — a nested worktree (`git worktree add ./wts/feat`) never gates against the main checkout's or an ancestor's store the server isn't writing to. The pre-commit hook's record sentinel now resolves against the shared store (`$TWINING_DIR/.last-record` instead of a cwd-relative path), so a record in any worktree satisfies the gate exactly as it does for multiple sessions in one directory. Requires server >= 2.3 for server-side worktree resolution (older servers keep worktree-local stores; hooks and server then disagree only if you commit from a worktree — update both).

## Plugin [1.19.0] - 2026-07-22

### Added
- **Launcher ladder gains a project-pin rung and a plugin-bundled fallback server**. `launch-server.sh` now resolves, in order: `TWINING_SERVER_JS` override (names any server entry point, exec'd directly with `node`) > project pin (`./node_modules/twining-mcp/dist/index.js`, relative to the project root — `npm i -D twining-mcp` lets a project hold its server version independent of plugin updates; outranks every npm rung and the plugin's own copy) > `npx` > npm-prefix `npx-cli.js` > global `twining-mcp` > **plugin-bundled dependency-free server** (a committed single-file esbuild bundle at `plugin/server/twining-server.mjs`, run directly with `node`; requires Node >= 22). The bundled rung means node-only environments — Debian/Ubuntu `nodejs`, Alpine, AL2023 without `nodejs-npm`, nix `nodejs-slim` — now get a fully working server with no npm, no npx, and no network. Semantic search degrades to keyword mode on that rung, announced with a one-line stderr notice; `npm i -D twining-mcp` in the project restores full mode (and moves resolution to the pin rung). The exit-127 diagnostic is now reachable only with no Node at all or Node too old for the bundle, and the SessionStart `--probe` contract extends to `runner=<override|pin|npx|npm-prefix|global|bundled|none>`.

## [2.3.0] - 2026-07-22

### Added
- **`dist/server.bundle.mjs` ships in the npm tarball** — the dependency-free single-file server bundle built by `scripts/build-plugin-bundle.mjs`, byte-identical to the copy the plugin commits at `plugin/server/twining-server.mjs`. `node node_modules/twining-mcp/dist/server.bundle.mjs` is a supported direct launch when npm/npx availability or startup cost matters. Externalized dependencies degrade gracefully at runtime: semantic search falls back to keyword mode without `@huggingface/transformers`, telemetry no-ops without `posthog-node`, and dashboard auto-open is skipped without `open`.
- **Server version is baked into the bundle at build time** (`__TWINING_VERSION__` esbuild define), so the relocated single-file server reports the correct version without a `package.json` beside it.
- **`twining-mcp migrate` uses the canonical root resolution**. The migrate CLI previously derived its own project root (cwd + its own `--project` parse); it now defaults through the same resolver as the server, so `TWINING_PROJECT` and the linked-worktree redirect apply to migrations too — a migrate run inside a worktree targets the store the server actually uses. Explicit `--project` still wins verbatim.
- **Worktree-aware project-root resolution**. When the cwd-default project root is a linked git worktree — its `.git` is a `gitdir:` file whose target contains a `/.git/worktrees/` segment — the server resolves to the **main checkout's** root, so agent teammates spawned into worktrees (`claude-teams --worktree`) share one coordination store instead of forking it (teammate records were invisible to the main session). Applies only when the root comes from cwd: `--project` and `TWINING_PROJECT` are never redirected. `TWINING_WORKTREE_LOCAL=true` opts out and keeps a worktree-local store. Submodules (`gitdir:` into `.git/modules/`) are unaffected; resolution never throws and falls back to cwd if the main root doesn't exist. Shared-store gate semantics are identical to multiple sessions in one directory (one `.last-record` sentinel). Companion plugin release 1.20.0 mirrors the resolution in all hooks.

## Plugin [1.18.0] - 2026-07-22

### Changed
- **Bundled server launches through `scripts/launch-server.sh` instead of bare `npx`**. The script (execed via `sh -lc`) walks a fallback ladder: `npx` from the login-shell `PATH` > npm's `npx-cli.js` resolved relative to the `node` binary (`<node bin>/../lib/node_modules/npm/bin/npx-cli.js`) > a global `twining-mcp` install; if every rung fails it exits 127 with distro-specific guidance on stderr instead of failing silently. Broken version-manager shims and off-PATH-npm installs now self-heal; only a distro Node genuinely without npm (Debian/Ubuntu `nodejs`, Alpine, AL2023 without `nodejs-npm`, nix `nodejs-slim`) still needs a manual npm install. The SessionStart hook probes the same script (`--probe`) and now distinguishes three states — server available / Node present but npm missing / no Node — with the latter two surfacing the `TWINING_DISABLED=true git commit ...` escape hatch, since the commit gate still applies in initialized checkouts.

## [2.2.0] - 2026-07-21

### Added
- **`TWINING_PROJECT` env var for shared stores** (#46). Project-root resolution is now `--project <arg>` > `$TWINING_PROJECT` > cwd; relative env values resolve against the server's cwd. A fleet of sibling repos can share one coordination store with a single version-agnostic `{ "env": { "TWINING_PROJECT": "…" } }` line in `.claude/settings.json` — replacing the per-repo `.mcp.json` override + exact-command `deniedMcpServers` block, which matched the launch command verbatim (version string included) and silently went inert on every plugin bump, leaving two servers split-braining writes across two stores.

## Plugin [1.17.0] - 2026-07-21

### Changed
- **Bundled server launch drops the explicit `--project .`** (#46) — cwd default is behavior-identical when `TWINING_PROJECT` is unset, and the explicit arg would have permanently shadowed the env var for exactly the server it exists to redirect. Requires server >= 2.2 for `TWINING_PROJECT` to take effect (older servers just use cwd, same as before).

## Plugin [1.16.0] - 2026-07-21

### Fixed
- **Stop-hook recording gate is now marker-based — the recurring false-block loop is fixed** (#43). The 1.10.0–1.15.x gate compared the record sentinel against the newest mtime of dirty working-tree files: a leaky proxy that a field diagnosis proved false-blocks on (1) concurrent agent worktrees bumping untracked-directory mtimes after you record — an unwinnable race, (2) touch/checkout/formatter mtime bumps with no recordable work, (3) hundreds of untracked `.claude/` dirs inflating the dirty set, and (4) the alphabetical `head -200` cap hiding real work while surfacing noise (false ALLOW and false BLOCK from the same state). New design: a PostToolUse hook (`Edit|Write|MultiEdit|NotebookEdit`) writes epoch-seconds to `.twining/.sessions/<session_id>` on every successful file edit; the stop hook blocks only when *this session's* marker is newer than `.last-record`. No git scan, no mtime scan; other sessions' activity can never block yours. Fail-open preserved: no marker (read-only session, Bash-only edits, missing session_id, pre-1.16 session) always allows — Bash-driven edits are still gated at commit by the pre-commit hook. Session-start prunes markers older than 7 days. The marker contract is plugin-internal (the npm server never reads it), so no new hook/server version-skew surface.

## Plugin [1.15.0] - 2026-07-21

### Changed
- **Handoff guidance rewritten around the committed-doc pattern** (#33). Field data showed zero calls to the structured `twining_handoff`/`twining_acknowledge` tools across three repos, while the heaviest repo accumulated 40+ rich committed markdown handoff docs doing the job. The `twining-handoff` skill now teaches: write a handoff doc, commit it, post an `artifact` entry pointing at it (plus `need` entries for open obligations — those survive archive sweeps, #40). The `twining-dispatch` skill's post-dispatch handoff/acknowledge steps are replaced with a `status` post under the subagent's agent_id; its minimal protocol drops explicit registration since writes now auto-register (#32). BEHAVIORS.md GEN-04 and the handoff/dispatch workflow tables updated to match.

## Plugin [1.14.0] - 2026-07-20

### Added
- **`twining-semantic-review` skill** (#16). Opt-in, user-invoked LLM-judged staleness review: the session's own model scores entries 0–1 with written reasons for "references a concept the project has moved past" (dead sprints, retired codenames) — the class deterministic `staleness_review` can't see. No server-side model client, no API key: the judging model is the agent running the skill. Human-in-the-loop always — candidates ≥0.7 are presented for confirmation, then archived via `twining_archive_stale` with per-item reasons in the audit trail. Never auto-invoked, never a side effect of other work.

## [2.1.0] - 2026-07-21

Closes the v2.1 milestone: seven issues from field diagnostics of live projects, all fixed with the field-verified root cause rather than the assumed one. Server changes below; companion plugin releases 1.14.0–1.16.0 (semantic review skill, handoff deprecation, marker-based stop gate).

### Added
- `twining_archive_stale` accepts an optional `reasons` map (id → rationale); per-item reasons are recorded in the audit-trail finding so a future reviewer can spot and reverse bad archival calls (#16).
- **Registry auto-touch on writes** (#32). Every `twining_post`, `twining_decide`, and `twining_record` now upserts its `agent_id` into the agent registry (best-effort, never fails the write), so `agents/registry.json` reflects who actually worked on the project instead of staying empty. `agent_id: "unknown"` is skipped — a shared record for identity-less callers would be noise (same rule as the subagent-stop hook's silence). Liveness stays derived (active/idle/gone from `last_active`); historical participants are never expunged and `twining_agents` includes gone agents by default, so a parallel wave leaves a queryable record.
- **Dashboard single-instance guard** (#42). Before binding, the server probes the configured port range for a dashboard already serving the *same* project (via `/api/health`'s `projectRoot`); if found, the second instance skips its dashboard and stays MCP-only — no more dual dashboards from plugin-bundled + project-pinned server pairs. A different project's dashboard on the port still triggers the existing next-port retry.

### Deprecated
- `twining_handoff` and `twining_acknowledge` are deprecated, scheduled for removal in v3 (#33) — zero field calls; real handoffs are committed markdown docs. Tool descriptions now steer to the committed-doc + `artifact`-pointer pattern (see plugin 1.15.0 notes).

### Fixed
- **Existing stores get missing `.twining/.gitignore` entries reconciled at startup** (#44). Entries added in later releases (`.last-record`, `pending-*.jsonl`, `.sessions/`, sqlite files) never reached stores initialized before them — one field store carried 137 commits of `.last-record` churn, and a fresh clone inherited a stale committed sentinel (guaranteed false stop-block under the pre-1.16 mtime gate). Reconcile is additive only: missing canonical entries are appended; user lines are never removed or reordered. Note: gitignore does not untrack an already-tracked file — stores that committed `.last-record` should run `git rm --cached .twining/.last-record` once.
- **Pending-queue drain dead-letters failures instead of losing them** (#45). A queued post whose `post()` rejected (invalid entry_type from a foreign/older hook, empty summary — anything but the length case special-cased in 1.24.0) or whose line failed to parse was logged "skipping" and then deleted with the swap file — permanently lost. Such lines now land in `pending-posts.dead.jsonl` / `pending-actions.dead.jsonl` next to the queue, carrying the raw line, the error, and a timestamp — inspectable and re-queueable by hand. If the dead-letter write itself fails, the swap file is left in place for a future drain rather than deleted with unprocessed lines inside.

### Changed
- **Archive passes no longer sweep unresolved needs/warnings** (#40). Age-based archiving (explicit `twining_archive`, auto-archive, and the housekeeping archive pass) now exempts `need`/`warning` entries unless they are resolved — a need/warning counts as resolved when a later entry back-references it via `relates_to`. Open obligations matter more as they age, not less; the 2026-07-20 field run archived a same-day open need that had to be manually reposted. Override with `keep_open_needs_warnings: false` to force a full sweep; results report `kept_open_count`. The auto-archive threshold counts only archivable entries, so exempt needs/warnings can never permanently arm the trigger (same class of bug as the decision-count archive loop).
- **Housekeeping preview counts are now binding** (#39). Preview previously skipped the archive pass entirely (reporting `archived.count: 0`) and computed dedup/dangling-warnings on pre-archive state, so its numbers didn't survive contact with execute (field run: preview 44 dedups / 0 archived, execute 0 dedups / 185 archived). Preview now computes the archive partition via the new side-effect-free `Archiver.plan()` and runs every downstream pass on the simulated post-archive state — same pipeline semantics as execute, same counts on the same state.
- **`twining_why` output is now bounded** (#41). Previously it returned every scope-matching decision with full rationale — unbounded, superseded included — which reached ~350KB on mature projects and made agents skip reading it, defeating Gate 1. Now: matches are ranked by scope specificity (exact scope/file/symbol > scoped under the query > broad ancestor), then status, then recency; full rationale is returned only for the ranked prefix fitting `max_tokens` (default 4000, matching assemble); the next ≤50 decisions come back as one-liners in `more` with `truncated: true` and `omitted_count` beyond that. Superseded decisions are excluded by default (`include_superseded: true` to opt in; `superseded_count` always reported). New `ids: [...]` drill-down returns full detail — including `context` and full `alternatives`, which the scope path never carried — for exactly the requested decisions, so truncation never strands information. Worst-case response on this repo's 170-decision store: ~48KB → ~27KB hard-bounded, tunable down via `max_tokens`.

## Plugin [1.13.0] - 2026-07-20

### Changed
- **Bundled server spawns through a login shell** (`"command": "sh", "args": ["-lc", "exec npx -y twining-mcp@^2.0.0 --project ."]`). Sessions spawned with a minimal environment — agent-team teammates (cmux split panes), GUI-launched apps — lack the `PATH` entry holding `npx`, so the bare-`npx` server silently failed to spawn there; the login shell rebuilds `PATH` from the user's profile. This removes the last reason for per-project `.mcp.json` + `deniedMcpServers` workarounds on POSIX. Supersedes the 1.11.2-era decision to only warn via the SessionStart hook: that chose Windows safety over POSIX robustness, but the per-repo workaround proved an ongoing field cost while no Windows plugin users have materialized. **Windows regression, documented:** `sh` does not resolve there, so Windows users lose the bundled server and instead add a one-line project `.mcp.json` with the bare `npx` command (hooks, skills, and gates are unaffected; Windows never had the minimal-PATH problem).
- SessionStart hook's server-availability detection now mirrors the new spawn method (`sh -lc 'command -v npx'`): it warns only when even a login shell cannot find `npx` — previously it would have false-positived in exactly the minimal-PATH sessions the wrapper now fixes.
- This repo drops its own beta-era workaround pair (`.mcp.json` login-shell pin + exact-command deny + the `mcp-deny-sync` CI job that policed their lockstep, all superseded within hours of introduction) and dogfoods the plugin's bundled server.

## Plugin [1.12.0] - 2026-07-20

### Changed
- **Bundled server pin bumped `^1.20.0` → `^2.0.0`** now that v2.0.0 is stable on `latest`. This closes the dual-server version-skew hazard hit during the beta: a project-level `.mcp.json` pinning a 2.x server alongside the plugin's 1.x server registers two servers against the same `.twining/`, avoidable only by a brittle exact-command `deniedMcpServers` entry — and once a project migrates to format `version: 2`, the plugin's 1.x server goes read-only. Supersedes the original plan to hold the pin for a quiet week after stable: 2.0.0 is code-identical to beta.3, which had 11 days of soak, so the wait bought no additional signal against a demonstrated field cost.
- New CI job `mcp-deny-sync` (`scripts/check-mcp-deny-sync.mjs`) fails when this repo's `deniedMcpServers` workaround drifts from the plugin's bundled server command — the deny matches by exact command array, so every future pin bump must update both or dual servers silently return.

## [2.0.0] - 2026-07-20

v2 stable — the first release on dist-tag `latest` since 1.24.1. Identical code to 2.0.0-beta.3; this section is the rollup of the beta line (beta.1–beta.3 below). Upgrade guide: [docs/UPGRADE-v2.md](docs/UPGRADE-v2.md).

The two things to know before upgrading:

- **Node floor is 22.13** (`engines.node: ">=22.13.0"`, for `node:sqlite`). Soft: npm warns, and on older Node the server still boots — sqlite-backed projects fall back to the file backend with a loud stderr warning.
- **Nothing migrates implicitly.** Existing file-backend projects keep working unchanged and get a one-line nudge; the sqlite flip only happens through the verify-gated `npx twining-mcp migrate` (escape hatch: `migrate --reverse`). Migrate's finalize stamps `version: 2`, which turns 1.21–1.24 clients read-only on that project — upgrade teammates first. Fresh projects start on sqlite.

Stable gates behind this cut: two-week field soak across beta.1–beta.3 with zero new issue classes, eval parity with the pre-v2 baseline (synthetic 0.8909, holdout 42/42), and a reverse+re-forward migration round-trip exercised on a copy of this repo's live production state (all record counts byte-verified identical).

## [2.0.0-beta.3] - 2026-07-09 (dist-tag `next`)

The dashboard scale redesign: every dashboard surface now stays responsive at 5k+ blackboard entries and 5k+ decisions (verified against a seeded 5k/5k fixture, `npm run seed:scale`).

### Changed
- **Server-side query layer.** The dashboard HTTP server gains real API endpoints (compact index with delta polling via `since`, graph neighborhood/entities, status counts, health report) instead of shipping the full dataset to the browser on every poll. The client keeps a compact index (~200 KB gzipped at 5k+5k) and detects missed changes by count-mismatch, triggering a single full refetch.
- **Virtualized faceted lists.** Blackboard and Decisions tabs render through windowed virtual lists with facet filters — DOM cost is now O(viewport), not O(dataset).
- **Canvas density timeline.** vis-timeline is removed (dependency deleted); the timeline is a canvas density view with epoch-aligned bucketing, zoom/fit controls, and domain filters.
- **Graph drill-down explorer.** The render-everything graph view is replaced by an aggregated meta-graph overview plus an ego-network explorer capped at ~200 nodes (cytoscape retained for layout).
- **Scope as first-class navigation.** Scope breadcrumb drill-down across tabs, plus shareable hash routing for deep links.

### Added
- **Health panel** in the Insights tab: staleness scoring and probe cards over the decision index.
- Deterministic 5k/5k seed fixture (`npm run seed:scale`) for scale verification.

## [2.0.0-beta.2] - 2026-07-06 (dist-tag `next`)

The v2.0 issue-burndown beta: the four field-findings issues milestoned for v2.0 (#30, #31, #34, #35), built as four parallel agent work streams coordinating through Twining itself. Closes out the design work deferred from 1.24.0; the remaining field findings (#16, #32, #33) are milestoned v2.1.

### Changed
- **Decisions are no longer cross-posted to the blackboard** — they live only in the decision store (#30). Every `decide` (and `override`) previously mirrored an entry that `twining_assemble` filtered out on read: 1,412 dead entries in the heaviest field repo, ~1 MB read and discarded per assemble. `twining_query` and `twining_recent` now read the decision store directly, returning matches in a sibling `decisions` array marked `type: "decision"` — which also makes overridden and superseded decisions searchable, something the mirrors never were. Legacy mirror entries already on disk are untouched; the assembler's filter and the archiver's `keep_decisions` handling remain as legacy-data defense.
- **`twining_handoff` / `twining_acknowledge` are deprecated** (#33). Field analysis found zero calls across three heavy-use repos, while the same repos accumulated 40+ rich, git-committed markdown handoff documents doing the job the API was designed for. Both tools keep working throughout v2.x; the redesign-vs-v3-removal decision is the #33 design pass, informed by the W4 agent-identity work (#32).

### Fixed
- **Partial `priority_weights` no longer silently discarded** (#34). A config listing a subset of weights summing to 1.0 deep-merged with defaults (adding `graph_reachability` 0.35), tripped the sum check, and threw away ALL user weights — the user's config looked applied but never was (this repo's own config hit it on every run). User sets summing to ~1.0 are now taken as complete (missing keys become 0); any other shape is merged and rescaled proportionally to 1.0; full defaults only on genuinely invalid input (negative/non-numeric/all-zero). Every warning now states what was provided, what was done, and the final effective weights.
- **Superseded decisions now point at their replacement** (#31). `supersedes` was one-directional: the retired decision's status flipped but no back-link was written, so nothing led from a superseded decision to what replaced it. Superseding now writes `superseded_by` onto the retired decision (both backends), `twining_why` surfaces it, and the status flip happens after the replacement is created — a failed create no longer strands the old decision retired with no successor.

### Added
- **Archive compaction repair pass** in `twining_housekeeping` (`compact_archives: true`) for repos damaged by the pre-1.24.0 auto-archive feedback loop (#35). Streams `.twining/archive/*.jsonl` line-by-line (bounded memory, ~1 GB/s — the 3.0 GB field repo repairs in seconds) and drops only entries matching the archiver's own six-field summary signature ("Archive: N entries archived" findings — one field repo held 7,595,308 of them). Preview reports per-file junk/survivor counts and reclaimable bytes; `execute: true` compacts atomically, deletes archive files left empty, and posts an audit-trail finding. Corrupt lines and all agent-authored entries are always preserved. Backend-agnostic — also the cleanup path after `migrate`, which leaves `archive/` untouched.
- **`superseded_by` backfill pass** in `twining_housekeeping` (#31): scans decisions carrying `supersedes` links and repairs historical one-directional links — preview reports, execute applies, dangling targets are counted and skipped, idempotent.

## Plugin [1.11.1] - 2026-07-06

### Changed
- BEHAVIORS.md updated for the server v2.0 contract: decisions are no longer cross-posted to the blackboard; `keep_decisions` guidance now framed as legacy-data defense.

## [2.0.0-beta.1] - 2026-07-05 (dist-tag `next`)

The v2.0 cut: the sqlite backend becomes the default — safely. Published under the npm dist-tag `next`; unpinned installs stay on 1.x until stable. Upgrade guide: [docs/UPGRADE-v2.md](docs/UPGRADE-v2.md).

### Breaking
- Node floor is now `engines.node: ">=22.13.0"` (soft: npm warns; older Node still boots via the file-backend fallback, with a warning). CI matrix is Node 22/24.
- `SUPPORTED_CONFIG_VERSION` is 2. `twining-mcp migrate` finalize now stamps `version: 2` into `config.yml`, turning 1.21–1.24 clients read-only on migrated projects (the W0.4 mixed-team lockout). `migrate --reverse` restores `version: 1`, re-enabling 1.x clients.

### Changed
- Default `storage.backend` is now `auto`, resolved by legacy detection: sqlite state (twining.db or records/) → sqlite; legacy content with no sqlite state → files plus a one-line `migrate` nudge; fresh project → sqlite; anything ambiguous/unreadable → files (safe). Existing projects never flip implicitly — only through the verify-gated `twining-mcp migrate`.
- Fresh `.twining/` init stamps an explicit `storage.backend` into config.yml (sqlite when node:sqlite is available, files otherwise) and the matching format version — the choice is visible and committed, never re-derived per machine.

### Added
- Opt-in startup auto-migration for legacy projects: `TWINING_AUTO_MIGRATE=1` or `storage.auto_migrate: true`. Default remains nudge-only; an explicit `storage.backend` disables it.
- Publish workflow: prerelease versions route to npm dist-tag `next` (stable to `latest`), GitHub releases are marked prerelease, and a tag↔package.json version guard fails mismatched tags before publish.
- `docs/UPGRADE-v2.md`: Node floor and fallback-divergence caveat, the backend resolution rule, migrate/reverse walkthrough, the `version: 2` mixed-team contract, and the D3 read-time contradiction contract.

## [1.24.1] - 2026-07-04

### Changed
- Schema descriptions on `twining_record` (summary, findings) and `twining_post` (summary) now tell agents to lead with the most important information — the embedding model's ~256-token window means the opening of the text dominates similarity ranking. Informed by a retrieval A/B on this repo's own corpus (`scripts/retrieval-ab.mjs`, new): semantic vs keyword retrieval produced **zero identical assemble briefings** across ten realistic tasks (mean Jaccard 0.43), with keyword-fallback briefings consistently 2–4× sparser — retrieval mode materially shapes what agents see, and front-loading is the cheap lever on it.

## [1.24.0] - 2026-07-04

Field-findings release. A usage analysis across three heavy-use repos (2,317 tool calls, 2,713 decisions, 3.9 GB of blackboard archives) surfaced defects that were costing every session; this release fixes the actively-bleeding ones. The findings that need design work are tracked in issues #30–#35.

### Fixed
- **Auto-archive feedback loop.** Past ~500 decisions, every `twining_post` triggered an archive pass (decision cross-posts counted toward the threshold but are never archived), and the archiver's own "Archive: N entries archived" summary re-armed the trigger — one field repo accumulated 7.6M junk findings / 3.0 GB. The trigger now counts only archivable entries, and the archiver's summary can never re-trigger. Existing junk archives are safe to delete (see #35 for planned repair tooling).
- **`twining_record` no longer rejects over-length summaries.** The most-called tool failed ~38% of field calls with INVALID_INPUT because its status post enforced an undocumented 200-character cap. Summaries (and findings) are now truncated with the full text preserved in the entry detail; the schema documents the cap; the response notes the truncation. Direct `twining_post` keeps strict validation.
- **No more silent finding loss.** Findings in `twining_record` were posted inside a bare catch — an over-length finding vanished while the call reported success. Failures now surface in the response (`finding_errors`), and over-length findings are truncated instead of dropped.
- **Pending-post queue drains continuously.** `pending-posts.jsonl` (the hooks' drop box) only drained at server startup, stranding posts for days. It now drains every 60 seconds with loss-proof swap semantics: concurrent drains can at worst duplicate a post, never lose one.
- **`depends_on` links validated at write time.** 49% of dependency links in the heaviest field repo pointed at nonexistent decision IDs, corrupting trace/graph walks. Unknown IDs are now dropped at decide time and reported in the tool response ("ignored N unknown depends_on id(s)"). Retroactive cleanup: #31 territory.
- **`twining-mcp migrate` salvages index-orphaned decisions.** One field repo has 109 decision files missing from decisions/index.json (historical write-path desync); index-driven migration would have silently excluded them while verification passed. Forward migration now enumerates decision files by directory scan, salvages orphans (counted + noted), and a subsequent reverse migration regenerates the index — healing the desync.

## Plugin [1.11.0] - 2026-07-04

### Fixed
- SubagentStop hook no longer posts content-free "Subagent completed: unknown-subagent" noise — field data showed that was 100% of its output. It now tries `agent_type`, `agent_name`, then `description` from the hook payload and stays silent when none is present.

## [1.23.0] - 2026-07-03

`twining-mcp migrate` — W3 of the v2 foundation plan (`docs/FOUNDATION-PLAN.md`). CLI-only; no MCP tool-surface, plugin, or file-backend behavior changes.

### Added
- **`twining-mcp migrate [--project <dir>] [--dry-run] [--check] [--reverse]`.** Moves an existing file-backend `.twining/` to the opt-in sqlite backend, and back. Not a special importer: forward migration writes the per-ULID `records/` export tree from the file stores and runs the ordinary ingest, so every parsing and safety rule is the shipped W2.2/W2.3 one. Verified before finalizing — every record readable from the source backend must exist byte-identically in the target or the tool exits 1 without touching config.yml. Idempotent: re-running picks up straggler writes made to the legacy files by stale clients. Legacy files are never modified or deleted (config.yml is the one exception — edited to flip `storage.backend`, first-wins backup at `config.yml.pre-migrate.bak`); finalize also heals legacy `.twining/.gitignore` files that predate the `twining.db*` ignore lines. `--reverse` regenerates the full file-backend layout from the sqlite read model so nobody is locked in (overwritten layout backed up to `pre-reverse-backup/`; the now-frozen `records/` tree comes with a printed warning). Guards refuse the destructive edge cases outright: re-running forward against a sqlite project with `export_records: false`, reversing an already-reversed project, and incompatible flag combos (`--reverse --check`, `--dry-run --check`). Embeddings are not migrated — the sqlite backend rebuilds them by content hash on first start (1.22.0). `config.version` stays 1: the format-v2 flip ships with v2.0, not here. Acceptance: migrating this repo's own committed `.twining/` (160 decisions, 296 blackboard entries, 347 graph entities — including pre-provenance records from before 1.19) verifies diff-clean, double-migration is a no-op, and the reverse round-trip holds.

## [1.22.0] - 2026-07-03

Live git sync for the sqlite backend — W2.3 phase 2 of the v2 foundation plan (`docs/FOUNDATION-PLAN.md`). Sqlite-backend-only; no tool-surface, plugin, or file-backend changes.

### Added
- **Live re-ingest on git changes.** Phase 1 converged the database to the committed `.twining/records/` tree only at startup, so a branch switch, pull, or merge mid-session left the running server stale until restart. A TTL-throttled probe now runs before every tool call: when the repo's HEAD sha has moved since the last ingest, the export tree is re-ingested (idempotent upsert-by-ULID, same deletion guards as startup). Switching branches or pulling a colleague's records is visible to the very next `twining_assemble` — no restart. The probe costs one `git rev-parse` (~1ms) per 5-second window and does nothing while idle or outside a git repo.
- **Content-hash re-embedding.** Schema v2 (`PRAGMA user_version = 2`, automatic idempotent migration) adds `embeddings.content_hash` — sha256 of the exact text a record was embedded as. After any ingest that changes records (and once at startup, closing a phase-1 gap where ingested records never got vectors), an asynchronous reconcile pass converges the embeddings table: records without vectors are embedded, records whose embed text changed are re-embedded, orphaned vectors are deleted, and pre-v2 rows get their hash backfilled without a model call. Pulled decision *status* changes leave embed text unchanged, so the common ingest update costs zero model calls. Without the model (fallback mode) cleanup and backfill still run; search keeps its keyword fallback for not-yet-embedded records.
- Canonical embed-text module (`src/embeddings/embed-text.ts`) — the summary/detail and summary/rationale/context derivations previously duplicated across the blackboard engine, decision engine, and search fallback now have one definition, shared with the reconciler's hashing.

### Fixed
- Multiwriter soak flake: on fast machines the sqlite writer children finished all ops before the crash-injection `SIGKILL` could land, failing the "killed mid-stream" assertion (reproduced on `main`). The victim writer now gets an op budget it cannot finish before the kill.

## [1.21.1] - 2026-07-03

### Changed
- **`@huggingface/transformers` is now an `optionalDependency`.** Its transitive `onnxruntime-node` downloads platform binaries in a postinstall script, which fails in network-restricted environments and previously killed the entire `npx twining-mcp` install. As an optional dependency npm skips the failed subtree and the server installs cleanly; the embedder already loads the package lazily inside a try/catch and degrades to keyword search when it is absent. `package-lock.json` regenerated (also heals its version field, stale since 1.8.2).
- CI now enforces the plugin token budget (`scripts/measure-plugin-tokens.sh --ci`) — which immediately caught the plugin 44 bytes over its +20% cap; the SessionStart gates text was tightened to restore headroom.
- Doc reconciliation (review finding D1/D3): `BEHAVIORS.md` now documents all 35 tools (added `twining_record` — the Gate 2 headline tool the evals score against — plus `twining_housekeeping` and `twining_archive_stale`); `STATE.md` refreshed from its 1.17-era snapshot; fixed the "3 mandatory gates" comment in `src/instructions.ts`.

## Plugin [1.10.1] - 2026-07-03

### Changed
- SessionStart gates context tightened (~200 bytes) to restore token-budget headroom; BEHAVIORS.md covers the full 35-tool surface.

## [1.21.0] - 2026-07-02

Storage-safety release — phase W0 of the v2 foundation plan (`docs/FOUNDATION-PLAN.md`). No tool-surface or data-format changes.

### Added
- **Format version gate.** The server now reads `config.yml`'s `version` field at startup. If the on-disk format is newer than this release supports, the server logs a clear upgrade message and enters read-only mode: all reads keep working, all writes refuse with `FORMAT_VERSION_TOO_NEW`. This protects projects migrated by a future Twining release from being silently diverged by a stale client, and must be in the installed base before any format change ships.
- `.twining/.gitattributes` (`blackboard.jsonl merge=union`) is created on init so branches that both append blackboard entries union-merge instead of conflicting.
- **Opt-in SQLite backend (W2.2 phase 1).** Set `storage.backend: sqlite` in `.twining/config.yml` to store blackboard, decisions, graph, agents, handoffs, and embedding vectors in a single `.twining/twining.db` (WAL mode, `busy_timeout`, `PRAGMA user_version` schema versioning, vectors as float64 BLOBs). Behavior-parity port: ordering, filters, upsert rules, error codes, and defaults match the file backend exactly, verified by a dedicated parity suite including a cross-backend same-sequence comparison. Built on `node:sqlite` — zero native dependencies; requires Node >= 22.13, and when unavailable the server logs a warning and falls back to the file backend rather than failing to boot. Default remains `files`; the git export/ingest sync layer, migration tool, and default flip land with v2.0.
- `Archiver` now reads and removes blackboard entries through the store interface (`read()` + targeted `dismiss()`) instead of rewriting `blackboard.jsonl` directly — required for backend-agnostic archiving, and removal is now targeted by ID rather than a wholesale rewrite.
- **Git sync layer for the sqlite backend (W2.3 phase 1).** `twining.db` is a gitignored local cache, so on its own the sqlite backend couldn't ride git between users, branches, or worktrees. Every write is now mirrored into a committable per-record export tree (`.twining/records/`: month-sharded `posts/`, `decisions/`, `graph/entities/`, `graph/relations/`, `handoffs/`; one deterministic sorted-key JSON file per ULID), and on startup the database converges to the tree: insert missing records, update where the file differs (the committed tree wins), delete rows whose file is gone. Two branches' trees union-merge in git with zero conflicts (distinct ULID filenames), so ingest after a merge yields the union of both branches' records. Guards: no `records/` directory means skip entirely (never treat "no tree" as "delete all"), deletion only applies per existing kind directory, unparseable files are skipped, and ingest failure is non-fatal. Opt out with `storage.export_records: false`. Agents (liveness churn) and embeddings (rebuildable) are deliberately not exported. The gitignore template now covers `twining.db*`.
- **Multiwriter soak test (W2.2 acceptance)** — real writer processes hammer one shared store per backend, with a mid-stream `SIGKILL`, a concurrent torn-read poller, and an ack-vs-store audit (an op is acknowledged only after commit, so a lost acknowledged write is always a bug). Runs against both backends in the normal suite; scale up with `SOAK_SCALE=10`. The soak found and fixed three real cross-process bugs on its first runs:
  - *File backend, lost update on initialization:* `if (!exists) write(...)` pre-creates raced across processes — writer B's initializer could clobber data writer A had already committed. All creation paths now use exclusive create (`O_EXCL` via `ensureFileExists`), which is atomic.
  - *SQLite backend, lost update on contended upserts:* WAL serializes statements, not read-modify-write pairs — two processes could both `SELECT` the same row and the second `UPDATE` clobbered the first's merge. All read-modify-write cycles (`addEntity` upsert, `updateStatus`, `linkCommit`, agent `upsert`/`touch`, `acknowledge`) now run inside `BEGIN IMMEDIATE` transactions.
  - *File backend, crash-recovery gap:* the lock retry budget (~4.5s cumulative) was shorter than the stale-lock threshold (10s), so a process killed while holding a lock made waiting sessions throw `ELOCKED` before they were allowed to steal the dead lock. The retry budget is now ~24s (> stale), and the five duplicated lock-option blocks were unified onto one exported `LOCK_OPTIONS`.
- **Record quality nudge (#18).** `twining_record` responds with a one-shot `quality_nudge` when a substantial record (≥5 affected files or ≥2 decisions) contains zero findings — asking once whether anything surprising, fragile, or ruled-out is worth recording. Deliberately once per session: repeated nagging is what produces checkbox-quality records in the first place. The `findings` schema description now spells out what belongs there (surprises, dead ends, fragile spots — anything not visible from the diff).

### Changed
- **Storage backend interfaces (W2.1).** Engines, tools, and the dashboard now type against `src/storage/interfaces.ts` (`IBlackboardStore`, `IDecisionStore`, `IGraphStore`, `IAgentStore`, `IHandoffStore`, `IIndexManager`, `IMetricsStore`) instead of the concrete file-backed classes, which `implement` them. Pure extraction — every interface mirrors its class verbatim — but it is the seam the SQLite backend (FOUNDATION-PLAN W2.2) plugs into.
- **Dashboard shares the server's instances.** `createApiHandler`/`startDashboard` accept an optional `DashboardDeps` bag that `src/index.ts` fills from `createServer`'s wiring, so the dashboard reads through the same stores, caches, and embedder as the tool layer instead of constructing a parallel stack (including its own second embedding model). Standalone mode (no deps — tests, demo scripts) constructs its own instances exactly as before.
- `DecisionEngine` no longer constructs its own `GraphAutoPopulator` from a passed `GraphEngine`; the populator is injected by `createServer`. Wiring-only change — decision-side population remains unconditionally on as before (unifying it behind `config.graph.auto_populate` would be a behavior change and is deferred).

### Fixed
- **Atomic writes everywhere.** All whole-file writes (graph `entities.json`/`relations.json`, `decisions/*.json` + `decisions/index.json`, embedding indexes, agent registry, handoffs, blackboard rewrites) now go through a temp-file + rename pattern. Previously a process killed mid-write could truncate a JSON store and make the entire dataset unreadable; now readers observe either the old or the new content, never a torn file. `readJSON` additionally retries once on a parse failure to tolerate files last written by older releases.
- The `.twining/.gitignore` template now covers all local runtime state (`metrics.jsonl`, `pending-posts.jsonl`, `pending-actions.jsonl`, `.last-record`, `.last-known-branches.json`), matching what the README has claimed since 1.18. This repo's own tracked `metrics.jsonl`/`pending-posts.jsonl` were untracked accordingly.

## Plugin [1.10.0] - 2026-07-02

Hook-hardening release — phase W1 of the v2 foundation plan. Closes the transcript-grepping bug class (#11/#13 lineage) everywhere, ends CLAUDE.md mutation (#9), and gives every hook uniform guards.

### Changed
- **Stop hook is transcript-free.** It now compares the `.twining/.last-record` sentinel against the newest mtime of dirty working-tree files instead of grepping the session transcript for tool-call strings — the same sentinel pattern the pre-commit hook adopted in 1.9.1, applied to the remaining gate. Prose mentioning `twining_record` can no longer satisfy the gate, transcript format drift can no longer break it, and a record made before the final edit no longer false-blocks a fully-recorded session. It also honors `stop_hook_active` (a continuation after a block is never re-blocked) and only fires in projects with a `.twining/` directory — previously it blocked session exit in every repo when the plugin was installed globally.
- **`ensure-claude-md-gates.sh` removed.** The plugin no longer writes to the project's `CLAUDE.md` (issue #9's root cause). The lifecycle-gate guidance is delivered by `session-start-context.sh` via `additionalContext` — same content in the model's context, zero file mutation, works on resume. The `.twining/.no-claude-md-gates` opt-out flag is obsolete.
- **Every gate fails open when it can't be satisfied.** Pre-commit: when no record sentinel exists in the checkout (fresh clone, npm outage, server never booted), the hook allows the commit with a visible warning instead of denying — the record tools aren't reachable, so denying would lock the user out of committing entirely. Stop hook: same rule. Normal gating resumes after the first successful record.
- **Server version pinned in `.mcp.json`** to `twining-mcp@^1.20.0`. The plugin previously resolved the unpinned latest on every session start, which would have silently auto-adopted a future 2.x server (and its on-disk format migration) under an old plugin. Major-version adoption is now an explicit plugin update.
- SessionStart context injection is scoped to twining-managed projects (`.twining/` present), consistent with the other hooks.
- Stop-hook block message now asks for findings, warnings, and surprises explicitly — not just a summary (part of the #18 fix; see the server-side nudge above).

## Plugin [1.9.2] - 2026-07-02

### Fixed
- SubagentStop hook no longer appends directly to `blackboard.jsonl`. A raw bash append can't take the store's file lock, so a concurrent server write could interleave and corrupt lines. The hook now queues its status entry in `pending-posts.jsonl` — the drop box the server drains through the locked store path on next startup.

## [1.20.0] - 2026-05-05

Closes #7 (deterministic portion). The LLM-judged semantic-content review piece is tracked in #16.

### Added
- **Provenance stamping** on all blackboard entries and decisions. `BlackboardEngine.post()` and `DecisionEngine.decide()` now capture `{ recorded_at, branch?, commit_sha? }` synchronously at write time via `git rev-parse`. Stored as the optional `provenance` field on each entry / decision. Detached-HEAD and non-git directories are tolerated (fields omitted).
- **Staleness detection** in `twining_housekeeping`. Pass `staleness_review: true` to scan blackboard entries and active decisions for three deterministic orphan signals: scope path no longer exists on disk, affected files no longer on disk (proportionally scored), or originating branch has been deleted. Items scoring at or above the configurable threshold (`housekeeping.staleness_threshold` in `config.yml`, default `0.95`) are returned as candidates. Branch-gone is automatically neutralized when branch enumeration fails (non-git project) so the signal never false-flags.
- **Branch-merge sweep** in `twining_housekeeping`. Pass `merge_sweep: true` to track the local branch set across runs (snapshot stored in `.twining/.last-known-branches.json`) and surface entries / decisions whose `provenance.branch` was deleted between calls — typically post-merge cleanup. First call records the initial snapshot and returns no candidates. Preview passes (`execute=false`) leave the snapshot untouched so deletions stay visible across multiple previews. Returns candidate IDs only; pass them to `twining_archive_stale` to act. When run alongside `staleness_review`, branch-gone duplicates are removed from the staleness list (merge_sweep is the more specific signal).
- **`twining_archive_stale` tool** — accepts an array of IDs (typically the candidate list from `staleness_review` or `merge_sweep`) and archives them with provenance preserved. Decisions move to a new `archived` status (excluded from `twining_assemble` / `twining_why`); blackboard entries are dismissed. A finding is posted to the audit trail summarizing what was archived and why. Supports first-pass GC (#7) without deleting anything irreversibly.

### Changed
- `DecisionStatus` gains `archived` as a valid value alongside `active | provisional | superseded | overridden`. Decisions in `archived` status are excluded from `twining_assemble`, `twining_why`, and verification queries; they remain on disk with provenance intact.
- `ValueStats.decision_lifecycle` gains an `archived` bucket so analytics totals reconcile after archival.

## Plugin [1.9.1] - 2026-05-05

Plugin-only release. The npm package stays at 1.19.0 — server protocol is unchanged.

### Fixed
- Pre-commit hook no longer false-blocks commits in same-turn record→commit batches (#11 Bug 1) or when commands contain the substring `git commit` inside heredocs/pipelines (#11 Bug 2). The bash regex extracting the command from hook input also no longer truncates on escaped quotes (#13). And the hook no longer counts assistant prose, failed-attempt command bodies, or heredoc message bodies that mention `git commit` as if they were real commits.
- Replaced the JSONL-transcript scan with a synchronous sentinel file. `twining_record`, `twining_post`, and `twining_decide` write `.twining/.last-record` (unix timestamp) on every successful call. The hook compares it against `git log -1 --format=%ct HEAD`. Sentinel writes complete before the tool returns, so transcript flush latency no longer matters.
- Replaced the bash-regex JSON parser with `node -e` (node is already a hard dep), and replaced substring `grep 'git commit'` with argv-tokenized matching: `argv[0]=='git' && argv[1]=='commit'` after stripping pipes / `&&` / `;`.
- Hook silently allows commits in repos without a `.twining/` directory (so the global plugin install doesn't break unrelated repos).

## [1.19.0] - 2026-04-29

### Added
- `TWINING_DISABLED` env var (#10). Set `TWINING_DISABLED=true` (e.g. in `.claude/settings.json` `env` block) to disable Twining for a project — the MCP server exits cleanly before registering tools, so no Twining tools appear in Claude's list. Use case: per-project opt-out without uninstalling the plugin globally. Restart Claude Code to re-enable.

### Plugin v1.9.0
- Fixed: `SessionStart:resume` hook crash (#8). The `prompt`-type SessionStart hook was failing with "ToolUseContext is required for prompt hooks" on session resume. Replaced with a `command`-type hook (`session-start-context.sh`) that emits the gate reminder via `additionalContext` JSON; works on both startup and resume.
- Fixed: `ensure-claude-md-gates.sh` no longer re-stomps `CLAUDE.md` (#9). The hook now searches for the "Twining Lifecycle Gates" marker in `~/.claude/CLAUDE.md`, project `CLAUDE.md`, project `CLAUDE.local.md`, and `.claude/CLAUDE.local.md`, skipping the append if the marker is found anywhere. An explicit opt-out flag `.twining/.no-claude-md-gates` silences the hook regardless of marker location.
- Added: `TWINING_DISABLED=true` causes all hook scripts (`pre-commit-hook.sh`, `stop-hook.sh`, `subagent-stop-hook.sh`, `ensure-claude-md-gates.sh`, and the new `session-start-context.sh`) to no-op silently. Pairs with the server-side gate above.

## [1.18.0] - 2026-04-24

### Fixed
- `twining_record` rationale truncation — content past the second split separator in a natural-language decision string was being silently dropped by `text.split(regex, 2)`. Parser now preserves the full remainder as rationale. There was never a per-field character cap on decision summary or rationale; the behavior was always a parser artifact.
- `twining_record` rejected-alternatives undercount — `REJECTION_PATTERNS` used `text.match()` without the `/g` flag, so only one match per pattern was captured. Multiple explicit rejections in a single decision are now all detected via `matchAll` plus new patterns for numbered lists (`(1) ... (2) ... (3) ...`) and labelled phrasings (`Alternative rejected: X` / `Rejected: X`).
- `twining_record` silent failure when `decisions_created: []` but the decision file was on disk. Root cause: `DecisionEngine.decide` cross-posted the unbounded decision summary to the blackboard, which enforces a 200-char limit and threw after the decision JSON was already written. Summary is now sliced for the cross-post and the call is wrapped in try/catch so post-write failures no longer propagate.

### Added
- Structured-object variant on `twining_record.decisions` — each item can now be either a natural-language string (existing behavior) or a structured object: `{ summary, rationale?, context?, domain?, alternatives?: [{ option, reason_rejected, pros?, cons? }], assumptions?, constraints?, confidence? }`. Structured objects bypass the NL parser entirely for exact round-trip — recommended for long multi-paragraph rationales or when you need ≥2 explicit rejected alternatives preserved verbatim.
- Explicit rationale markers in the NL parser — `Rationale:`, `Why:`, `Reason:`, `Because:` now win over heuristic split words like "as" / "since" / "because", avoiding mid-sentence misfires on long decisions.
- `decision_errors` field in the `twining_record` response — per-decision persistence errors are now surfaced instead of being silently swallowed.

### Plugin v1.8.0 (no change)
No plugin-side changes required. The plugin consumes `twining-mcp` via `npx -y twining-mcp --project .` without a version pin, so plugin users pick up the fix on the next resolve after `1.18.0` is published to npm.

## [1.17.0] - 2026-04-06

### Added
- `twining_record` tool — unified recording that accepts natural language summary, decisions, findings, assumptions, constraints, and affected files in one call. Decisions are parsed into structured records automatically ("Chose X over Y — reason" extracts rationale and rejected alternatives). Scope auto-inferred from git diff when omitted.
- `twining_housekeeping` tool — periodic store maintenance: archives old entries, removes duplicates, surfaces stale provisionals and dangling warnings, prunes orphaned graph entities, rotates old metrics. Dry-run by default.
- `PreToolUse` hook on `git commit` — blocks commits until `twining_record` is called, enforcing decision capture at the natural checkpoint
- Natural language decision parser (`record-parser.ts`) — extracts summary, rationale, rejected alternatives, and domain from freeform sentences

### Changed
- Lifecycle simplified from 3 gates to 2: Gate 1 (assemble) + Gate 2 (record). Gate 2 replaces the old decide+post+verify ceremony with a single `twining_record` call.
- Stop hook rewritten — blocks session exit when code changes lack recording, asks for one action: "call twining_record"
- MCP server instructions condensed — 2 gates, 4 core tools listed instead of full tool group taxonomy

### Plugin v1.8.0
- SessionStart prompt updated: "Two gates: assemble FIRST, record LAST"
- PreToolUse hook added for git commit enforcement
- Stop hook blocks with single-action message instead of 3-step checklist
- CLAUDE.md gates: Gate 2 is now "Record (BEFORE committing or ending)"
- Housekeeping recommendation added for long sessions

## [1.16.0] - 2026-04-05

### Added
- `--version` / `-v` CLI flag — prints version and exits before starting MCP server
- Decision tiering in assemble output — top 3 CRITICAL (full detail), next 2 CONTEXT (summary), rest omitted with count
- Scope-distance weighting in assemble scoring — exact/child scope = 1.0, parent = 0.7, grandparent+ = 0.4
- YOUR NEXT STEP directive at end of assemble briefing — explicit first-action guidance
- `full_surface` config wired to tool registration — 15 rarely-used tools hidden by default, 17 remain

### Changed
- Gate 3 changed from mandatory `twining_verify` to mandatory `twining_post` status entry
- Default verify checks reduced from 5 to 3 (excludes test_coverage and constraints)
- Verify auto-post finding only fires on failures, not on pass/skip
- Stop hook changed from blocking to approve-with-systemMessage reminder
- Conflict detection tightened to same-or-narrower scope only (broad decisions no longer trigger false conflicts)
- Conflict response softened from warning to finding; new decisions stay active instead of provisional
- Assemble tool returns briefing + metadata only (no duplicate raw JSON)
- Auto-orient instruction strengthened to imperative first-call requirement
- Improved tool descriptions for ToolSearch discoverability

### Plugin v1.7.0
- CLAUDE.md gates updated: Gate 3 is now "Status & Handoff"
- BEHAVIORS.md: VERIFY-01 changed from MUST to SHOULD
- Stop hook: approve-with-reminder instead of blocking
- SessionStart prompt: imperative assemble-first instruction
- Verify skill: marked as recommended for complex tasks, not required

## [1.8.1] - 2026-02-28

### Fixed
- Dashboard auto-open now targets the correct project when multiple instances run

## [1.8.0] - 2026-02-28

### Added
- `twining_register` tool and subagent dispatch integration for Claude Code plugin
- Blackboard Stream View — alternate card-based visualization with time groups and thread lines
- Graph toolbar with type filters and hover effects
- Search bar redesign with toggle chips and search icon

### Fixed
- Timeline zoom stuck bug — replaced `overflow:auto` with `overflow:hidden` and added zoom controls
- Stop hook now tracks per-commit Twining coverage via line-number comparison

## [1.7.1] - 2026-02-28

### Added
- Plugin release automation with version bump script and CI enforcement
- Self-hosted GitHub marketplace for plugin distribution

### Fixed
- Skip ONNX embedding init in tests to eliminate 30s timeouts
- Replace prompt-type Stop hook with command-type for reliable JSON validation
- Dashboard UI redesign and 3 bug fixes

## [1.7.0] - 2026-02-27

### Added
- Claude Code plugin with skills, hooks, agents, and MCP server instructions
- CI/CD badge and documentation in README

## [1.6.5] - 2026-02-26

### Added
- CI and publish GitHub Actions workflows with Node 18/20/22 matrix
- npm publish with provenance attestations and auto-generated GitHub Releases
- Build-time PostHog API key injection (no more hardcoded secrets)

### Fixed
- Removed hardcoded PostHog API key from source code

## [1.6.0] - 2026-02-26

### Added
- `twining_promote` tool — promote provisional decisions to active
- `twining_prune_graph` tool — remove orphaned graph entities
- `twining_dismiss` tool — targeted blackboard entry removal

### Fixed
- PostHog telemetry YAML config format

## [1.5.0] - 2026-02-26

### Added
- Three-layer usage analytics: value stats, tool metrics, opt-in PostHog telemetry
- Project name in dashboard title with GitHub icon link

## [1.4.2] - 2026-02-20

### Added
- 5 remaining design spec gaps implemented
- P0-P2 verification and rigor capabilities in integration guides

### Fixed
- Critical and high-severity issues from deep code review
- Flaky handoff sort test

## [1.4.1] - 2026-02-19

### Added
- Dashboard UI polish with improved visualizations and activity tracking

## [1.4.0] - 2026-02-19

### Added
- `twining_verify` tool — drift detection and constraint checking
- Integration tests for full tool-to-engine flows
- Context assembly caching and tracking
- Federation design document
- 4 new coordination tools from architecture gap closure
- Claude Code Review and PR Assistant GitHub Actions

### Fixed
- 9 gaps from architecture review closed

## [1.3.0] - 2026-02-17

### Added
- Agent coordination: `twining_agents`, `twining_discover`, `twining_delegate`, `twining_handoff`, `twining_acknowledge`
- AgentStore and HandoffStore with liveness tracking
- Delegation posting with urgency-based expiry and agent matching
- Context assembly integration with handoff results and agent suggestions
- Dashboard Agents tab with delegations and handoffs views

## [1.2.0] - 2026-02-17

### Added
- Embedded web dashboard with HTTP server on port 24282
- Operational stats, scope filtering, and polling-based updates
- Search and filter with `/api/search` endpoint
- Decision timeline visualization (vis-timeline)
- Knowledge graph visualization (cytoscape.js) with click-to-expand
- Dark mode with system preference detection

## [1.1.0] - 2026-02-16

### Added
- Git commit linking: `twining_link_commit`, `twining_commits`
- `twining_search_decisions` — keyword search with domain/confidence filters
- `twining_export` — full state export as markdown
- GSD planning bridge for STATE.md sync
- Serena knowledge graph enrichment workflow

## [1.0.0] - 2026-02-16

### Added
- Core blackboard engine with JSONL-backed storage and advisory file locking
- Decision engine with conflict detection, trace, reconsider, and override
- Knowledge graph with BFS traversal and entity upsert
- Embeddings layer with lazy ONNX loading and keyword fallback
- Context assembly with token budgets
- 23 MCP tools across blackboard, decisions, context, graph, and lifecycle
- Archiver for state cleanup

[1.8.1]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.8.1
[1.8.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.8.0
[1.7.1]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.7.1
[1.7.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.7.0
[1.6.5]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.6.5
[1.6.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.6.0
[1.5.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.5.0
[1.4.2]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.4.2
[1.4.1]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.4.1
[1.4.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.4.0
[1.3.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.3
[1.2.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.2
[1.1.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.1
[1.0.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1
