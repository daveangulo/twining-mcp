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

### Pending Todos

None.

### Blockers/Concerns

None active.

## Session Continuity

Last session: 2026-03-02
Completed: v1.4 milestone archived
Next: `/gsd:new-milestone` for next version (start with /clear for fresh context)
