# Changelog

All notable changes to Twining MCP are documented here.

## Plugin [1.14.0] - 2026-07-20

### Added
- **`twining-semantic-review` skill** (#16). Opt-in, user-invoked LLM-judged staleness review: the session's own model scores entries 0–1 with written reasons for "references a concept the project has moved past" (dead sprints, retired codenames) — the class deterministic `staleness_review` can't see. No server-side model client, no API key: the judging model is the agent running the skill. Human-in-the-loop always — candidates ≥0.7 are presented for confirmation, then archived via `twining_archive_stale` with per-item reasons in the audit trail. Never auto-invoked, never a side effect of other work.

## [Unreleased]

### Added
- `twining_archive_stale` accepts an optional `reasons` map (id → rationale); per-item reasons are recorded in the audit-trail finding so a future reviewer can spot and reverse bad archival calls (#16).

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
