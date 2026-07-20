---
gsd_state_version: 1.0
milestone: v1.4
milestone_name: Agent Behavior Quality
status: complete
last_updated: "2026-03-02T23:35:17.065Z"
progress:
  total_phases: 5
  completed_phases: 5
  total_plans: 12
  completed_plans: 12
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-03-02)

**Core value:** Agents share *why* decisions were made, not just *what* was done -- eliminating information silos across context windows.
**Current focus:** Planning next milestone

## Current Position

Milestone: v1.4 Agent Behavior Quality -- SHIPPED 2026-03-02
All 5 milestones complete: v1 + v1.1 + v1.2 + v1.3 + v1.4 (19 phases, 44 plans)

## Performance Metrics

**Through v1.3:**
- Total GSD plans completed: 32 (6 v1 + 6 v1.1 + 10 v1.2 + 10 v1.3)
- v1.1: ~19min (6 plans), v1.2: ~31min (10 plans), v1.3: ~31min (10 plans)

**Post-v1.3 (unplanned):** 81 commits of hardening, new tools, dashboard redesign, plugin, demo, open source prep

**v1.4:** 12 plans in ~72min total
- 15-01: 6min, 15-02: 3min, 16-01: 4min, 16-02: 5min, 16-03: 11min
- 17-01: 5min, 17-02: 3min, 18-01: 4min, 18-02: 2min
- 19-01: 10min, 19-02: 14min, 19-03: 5min

## Accumulated Context

### Decisions

All v1.4 decisions archived in PROJECT.md Key Decisions table with outcomes.
- No git tag for v1.4 — plugin-only milestones don't get npm release tags
- Enforce mandatory agent registration and handoff in plugin v1.1.5
- Auto-populate knowledge graph from tool calls via GraphAutoPopulator
- Replace computeGraphConnectivity with computeGraphReachability using typed BFS and adaptive weight fallback
- Reduce default tool surface from 32 to 16 via full_surface config flag
- Assemble output includes structured markdown briefing and inline status summary
- Graph auto-population disabled by default (opt-in via graph.auto_populate config)
- Coordination effectiveness test suite using real stores with temp dirs, no mocking
- Reorder formatForLLM: warnings first, then handoffs, then decisions, then needs, then findings
- Enrich handoff data in AssembledContext to include individual results for detailed checklists
- Filter redundant findings that substantially overlap with decision summaries in formatForLLM
- Empty-state short-circuit in formatForLLM returns terse one-liner when no content exists
- Bug-investigation resolution scorer penalizes redundant re-fixes when Agent A already completed the work
- Add assumptions field to Decision type for assumption-based validation in assemble output
- Add FILES TO CHECK BEFORE WRITING section to formatForLLM output
- Assumption validation in assembler: check findings/warnings/decisions against decision assumptions
- Include constraints and rejected alternatives in assembled decision output for pattern propagation
- Sprint-simulation scenario: 12-session sprint with requirement change for long-horizon coordination testing
- Filter out entry_type "decision" blackboard entries in assembler to prevent type confusion
- Add SessionStart command hook to inject Twining Lifecycle Gates into project CLAUDE.md
- Remove fullSurface tool gate — all 34 MCP tools always registered
- Layered instruction architecture: CLAUDE.md as authority, lean SessionStart prompt, third-person skill descriptions
- SQLite is the runtime store and git is the replication transport — twining.db is a gitignored derived cache, the committed truth is a per-record export tree
- Ship the SQLite backend opt-in (storage.backend config, warn-and-fallback) on node:sqlite instead of bumping engines or adding better-sqlite3
- Extract storage interfaces (src/storage/interfaces.ts) and type engines against them, because private fields make the concrete class types nominal
- All hook gates are sentinel-based and fail open when unsatisfiable — no transcript grepping anywhere, and a fresh clone or dead server never blocks commits or session exit
- Deliver lifecycle gates via SessionStart additionalContext and delete ensure-claude-md-gates.sh — the plugin never mutates user files
- Format version gate ships and soaks before any format change: config version newer than the release puts the server in read-only mode (FORMAT_VERSION_TOO_NEW) instead of silently diverging
- Cross-process write-safety fixes from the multiwriter soak: exclusive-create (O_EXCL) for all file pre-creates, BEGIN IMMEDIATE around every sqlite read-modify-write, and lock retry budget (~24s) raised past the stale threshold (10s)
- Export tree excludes agents and embeddings, and ingest never deletes without the corresponding kind directory present
- Moved @huggingface/transformers to optionalDependencies — the embedder already degrades to keyword search when the import fails
- Widened the behaviors-parser MUST-count band to 8–16 instead of demoting the new tools' MUST rules to SHOULD
- Committed the chore(release): v1.21.1 version bump directly to main instead of via PR
- Folded the stray hook-generated blackboard entry (subagent-stop noise from the CI watch task) into the release commit rather than discarding it
- Chose lazy TTL-gated git-HEAD probe on tool dispatch over fs.watch on .twining/records/ for live re-ingest
- Chose a new sync-manager module reusing branch-watcher's snapshot-and-diff pattern instead of literally extending src/engine/branch-watcher.ts
- Chose hash-based re-embedding (embeddings.content_hash column, schema v2) with NULL-hash backfill-without-re-embed
- Chose a full converge pass (reconcileEmbeddings: orphan delete, NULL-hash backfill, embed missing, re-embed mismatched) over threading changed-ID deltas out of ingest
- Made the probe synchronous before tool dispatch (not fire-and-forget)
- Model inference never runs inside a transaction and all reconcile writes are single upsert/delete statements
- Fixed the multiwriter-soak crash-tolerance flake by giving the victim writer an unfinishable op budget (VICTIM_OPS = OPS*100)
- W3 1.x migrate leaves config.version at 1 and only flips storage.backend
- Migration verify uses subset-containment (source ⊆ target) rather than set equality
- No legacy-v1/ full backup in the 1.x migrate
- Reverse migration leaves records/ and twining.db in place but prints a FROZEN warning with remediation commands
- config.yml backup is first-wins (.pre-migrate.bak never overwritten)
- Forward migrate refuses to run when config is sqlite with export_records explicitly false
- Migration finalize idempotently appends twining.db* lines to .twining/.gitignore
- Reverse under export_records:false SKIPS ingest and exports from the database alone
- pre-reverse-backup/ is deliberately LAST-WINS (unlike config-edit's first-wins .pre-migrate.bak): it means 'what this run is about to overwrite', which is what makes a mistaken second reverse recoverable.
- Incompatible CLI flag combos are rejected at parse time (exit 2) rather than reinterpreted
- Judged reverse --dry-run's twining.db mutation (ingestRecords runs before the dryRun early-return in reverse.ts) a non-blocking Low rather than a merge blocker
- Proposed (pending Dave's approval): the v2 backend default flip must use a legacy-detection resolution rule
- Proposed (pending approval): recommend startup NUDGE over FOUNDATION-PLAN's auto-migration
- Proposed (pending approval): v2.0.0-beta ships under npm dist-tag next, never latest
- Auto-archive trigger counts only archivable entries (excludes decision cross-posts and archive-tagged summaries) and the archiver's summary post carries _skipAutoArchive
- twining_record truncates over-length summaries/findings (full text preserved in detail) instead of rejecting
- Subagent-stop hook posts nothing when agent identity is unknown
- migrateForward enumerates decisions by directory scan unioned with the index
- depends_on validation surfaces via an additive optional dropped_depends_on field on decide()'s existing return
- Pending drain uses per-drain unique swap files with claim-by-rename recovery
- Migrate this repo's own .twining to sqlite as user zero of the shipped tool on live state
- Approved (Dave, 2026-07-05): all recommended v2.0 prep options — startup nudge, soft engines>=22.13 with warn-and-fallback, beta on dist-tag next, evidence-gated stable timing, version-2 stamp at migrate finalize
- Implemented the v2 default backend flip as an "auto" sentinel in DEFAULT_CONFIG resolved at createStores time, not a blind default change
- DEVIATION from proposal: fresh init stamps backend by sqliteAvailable() (sqlite/version-2 when available, files/version-1 otherwise) instead of stamping sqlite unconditionally
- migrate --reverse now restores config version to 1 (forward finalize stamps 2)
- Publish workflow gained a tag-vs-package.json version guard and prerelease GH-release marking alongside the dist-tag routing; checkout/setup-node bumped to v5
- Dogfood the v2 beta via the project .mcp.json pin (twining-mcp@next), NOT the plugin pin and NOT a version-2 config stamp yet
- Chose to close #19 (Serena port fight) as already-implemented
- Chose to close #18 (hook lets Claude slack on findings) as addressed-by-guidance rather than keep open
- Chose to deprecate twining_handoff/twining_acknowledge in v2.0 rather than redesign or remove now
- Chose to put the deprecation note only in server docs (README.md, docs/TWINING-REFERENCE.md, docs/UPGRADE-v2.md), not plugin/BEHAVIORS.md or plugin skills
- Chose worktree-isolated named teammates (weights-34, crosspost-30, supersede-31, archive-35) sharing one Twining blackboard with distinct agent_ids
- Chose to resolve priority_weights from the raw parsed YAML (parsed.context_assembly.priority_weights) rather than the deep-merged config
- Chose rule order: user keys summing to 1.0 ±0.01 treated as a complete set (missing keys zeroed) before any merge; otherwise merge over defaults and rescale proportionally to sum 1.0; full-default fallback reserved for genuinely invalid input (negative, non-numeric, all-zero, or priority_weights not a mapping)
- Chose to rewrite this repo's .twining/config.yml priority_weights as the five explicit default values (0.2/0.2/0.15/0.1/0.35) rather than keeping the four legacy values with an explicit graph_reachability: 0
- Chose a new sibling test file test/config-priority-weights.test.ts over extending test/config-version-gate.test.ts
- Removed the override() decision-type blackboard post along with decide()'s cross-post — both write entry_type "decision" mirrors that assemble filters out
- twining_query/twining_recent merge decisions as a sibling `decisions` array (items marked type:"decision") rather than interleaving into results/entries
- Merge logic lives in the blackboard-tools handlers, with decisionEngine + decisionStore passed via the options object; no new methods on DecisionEngine
- Kept the _internal blackboard post flag and the assemble/auto-archive entry_type "decision" exclusions as legacy-data defenses
- Back-link rides the existing updateStatus(id, status, extra) path — no IDecisionStore interface change, no sqlite schema column
- Moved the supersede status flip in DecisionEngine.decide from before create to after create, writing status and superseded_by in one updateStatus call; conflict scan now excludes the supersede target
- Housekeeping backfill preserves the target's current status — it writes only the missing superseded_by pointer, never flips active/archived/overridden to superseded
- Backfill pass runs by default (no opt-in flag), preview-reports / execute-applies like dedup; dangling supersedes targets are counted and skipped; newest supersessor wins when several point at one target
- why() emits superseded_by only when set (spread-conditional) rather than always-present nullable
- Junk signature requires all six archiver-stamped fields: entry_type finding, summary /^Archive: \d+ entries archived$/, tags including "archive", scope "project", agent_id "main", detail /^Archive summary: \d+ entries archived\./
- compact_archives is an opt-in housekeeping flag (like staleness_review/merge_sweep), not part of the default pass
- Compactor is a standalone module (src/engine/archive-compactor.ts) with ~15-line wiring into HousekeepingEngine.run — chose modularity over inlining because teammate supersede-31 is concurrently adding another housekeeping pass and merge conflicts must stay trivial
- Audit-trail finding is posted from the tool layer (housekeeping-tools.ts) with _skipAutoArchive, mirroring twining_archive_stale, rather than from the engine
- Execute mode streams survivors to a lazily-created same-directory temp file then renames atomically; files with zero junk are never rewritten; files that were already empty are not deleted
- Compaction scans every *.jsonl under .twining/archive/ regardless of filename
- Chose patch-based integration (git apply --3way of each worktree's diff onto main) over committing in worktrees and merging
- Chose a single 2.0.0-beta.2 changelog section framing the release as the v2.0 issue-burndown beta
- Chose to add a pretest npm hook running inject-posthog-key.mjs
- Chose to draft a short delta reply on the existing salesforce thread rather than re-send full enrollment
- Chose Lanny.Ripple@gmail.com as the external-tester recipient
- Chose disabledMcpjsonServers in shared .claude/settings.json over disabling the plugin or env-var version switching in plugin/.mcp.json
- Chose to amend beta enrollment instructions (Gmail draft + UPGRADE-v2.md) with a mandatory plugin step rather than relying on testers to notice the dual server
- Chose checked-in deniedMcpServers serverCommand deny over per-user /mcp disable or the ineffective disabledMcpjsonServers key
- Chose sh -lc login-shell wrapper in .mcp.json (`sh -lc "exec npx -y twining-mcp@next --project ."`) over absolute npx path, cmux-level PATH fix, or re-enabling the plugin's bundled server
- Chose SessionStart-hook detection (warn loudly + suppress gates when npx is unresolvable) over changing plugin/.mcp.json to the sh -lc wrapper
- Rescoped the plugin token budget to count only context-loaded files (skills + agents), baseline 30514 = skills+agents at the original v1.4 tuning commit cd0497b, same +20% cap — approved by Dave over rebase-to-today, comment-trimming, and reverting the hook warning
- Chose to require a server-side query layer (pagination, scope/type/time filters, aggregation endpoints) as the foundation of any dashboard scale redesign over pure client-side fixes
- Recommended scale-native redesign of timeline/graph/lists (canvas density timeline, aggregated meta-graph + ego-network explorer capped ~200 nodes, server-windowed virtual lists, new Health panel, scope as first-class drill-down) over (a) conservative retrofit of vis-timeline/cytoscape which both lack aggregation modes and would stay mediocre, and (b) full framework rewrite which touches all 7 tabs to fix 3 and adds a build toolchain to a zero-config npm package. Not yet user-approved
- Chose client-side compact index (~200KB gzipped at 5k+5k, delta polling via since param with count-mismatch full refetch) over fully server-windowed queries
- Chose to keep vanilla JS split into native ES modules over adding a build step
- Chose to delete vis-timeline but retain cytoscape
- Chose Health as a section in the Insights tab over an 8th tab
- Added .playwright-mcp/ to .gitignore
- Resolved spec 1.1 delta-polling decision point: decision status flips are detected by comparing per-status decision counts (from /api/index total_counts vs client-held counts) triggering a single full refetch
- Chose transitional coexistence of legacy app.js and new ES modules (main.js mounts new views per tab, window.__twiningStore bridge, legacy renderers deleted task-by-task) over a big-bang module conversion of the 3454-line app.js
- Plan includes full code for server endpoints and pins module contracts/algorithms (round-robin neighborhood selection, virtualization math, count-mismatch refetch) for frontend components rather than dumping complete UI code into the plan
- Seed fixture writes through the concrete store classes (the one allowed direct-class use, as dev tooling) with deterministic mulberry32 PRNG and post-hoc timestamp spread over 18 months with bursts
- Chose a feature branch (dashboard-scale-redesign) over committing the redesign directly to main
- Chose controller-commits with working-tree review packages over subagent commits
- Accepted implementer's deviation from the plan's http-server.ts wiring snippet: `handled ? true : apiHandler(req,res)` instead of `handled ? undefined : ...`
- Resolved review finding on total_counts.decisions shape: keep server emitting open-ended per-status counts (archived is real and reachable via twining_archive) and fix the PLAN's documented contract instead
- Resolved review finding on delta requests re-reading the full store: deliberately deferred
- Accepted implementer judgment: /api/graph/entities sort is a fixed degree-desc/name-asc default and the sort query param is ignored rather than switchable
- Accepted reviewer-flagged behavior as-is: depth-1 nodes never visited by the depth-2 walk emit no overflow entry
- Core neighborhood algorithm confirmed correct by reviewer hand-trace of both fixtures
- Accepted implementer judgment: health-report staleness scores decisions only
- Accepted implementer judgment: health-report composes scoreItem/buildProbes over decision INDEX entries instead of calling auditStaleness()
- Chose union-of-keys generic status-count comparison in the store's validation (countsMatch iterates the union of local and server decision-status keys)
- Documented a known blind spot rather than engineering around it: a superseded→archived flip with no other project activity is invisible to /api/status counts, so the store catches it on the next real change via post-merge count validation
- Fixed a discovered edge in virtualization during browser verification: filtering while scrolled deep left scrollTop beyond the shrunken content, rendering an empty window
- Kept renderBlackboardDetail in app.js (not yet moved) because navigateToId cross-links still render from legacy state
- main.js runs its own 5s /api/status poll for store delta detection rather than intercepting app.js's fetchStatus
- Preserved renderDecisions' hidden side effect (timeline refresh on fresh data) by moving it into fetchDecisions when deleting the function
- Reused app.js's renderDecisionDetail for the new list's detail panel via the classic-script window bridge instead of porting ~180 lines now
- Chose epoch-multiple bucket alignment with fixed 30d/365d month/year approximations over calendar-exact bucketing
- Kept the existing toolbar/legend/chips DOM ids (timeline-zoom-in/out/fit/today, timeline-legend, timeline-domain-filters) so the HTML shell and its styling carried over unchanged
- Lozenge lane layout uses first-fit lane assignment with label-width-aware collision (measureText) rather than vis-timeline-style stacking
- Removed the fetchDecisions→timeline sync side effect entirely
- Committed Tasks 12 and 13 as one commit rather than the plan's two
- Graph table detail panel shows name/type/degree + 'Explore in graph' button instead of the old properties JSON
- Overview meta-graph drops self-loop type edges (file→file etc.)
- Scope changes propagate two ways during the transition: setFilter({scope}) on module views and state.globalScope+refreshData() for legacy applyGlobalScope consumers (Search, Agents)
- Kept paginate/renderPagination/sortData/applyGlobalScope in app.js
- Deferred the Blackboard Stream view rework (still O(dataset) DOM)
- Fixed the final-review findings inline rather than dispatching a fix subagent
- navigateToId cross-links now resolve through the index store (blackboard/decision rows) with graph-entity fallback into the ego explorer
- Ledger corrected: Task 16's 'filter param sanitized' claim was inaccurate at the time (only internal keys were stripped on WRITE); the read-side allowlist now actually exists in router.js.
- Took R1-R3 + race guard immediately instead of deferring
- Unknown-id resolution probes /api/graph/neighborhood with limit=1 before navigating
- Exercised the reverse-migrate stable gate on a scratchpad copy of this repo's live sqlite state instead of the live store or an external project
- Judged the external-tester gate satisfied only weakly and proceeded anyway on Dave's explicit direction ('soak complete, no errors surfaced, continue with plan')
- Chose a rollup [2.0.0] changelog section leading with the Node floor and migrate contract, plus a backfilled [2.0.0-beta.3] section (which had never been written), over rewriting the beta sections into one
- Left this repo's .mcp.json twining-mcp@next pin and the plugin server pin untouched at stable cut

### Pending Todos

None.

### Blockers/Concerns

None active.

## Session Continuity

Last session: 2026-03-02
Completed: v1.4 milestone archived
Next: `/gsd:new-milestone` for next version (start with /clear for fresh context)
