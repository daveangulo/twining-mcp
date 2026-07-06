# Twining v2 Foundation — Implementation & Migration Plan

Companion to [DESIGN-REVIEW-2026-07.md](./DESIGN-REVIEW-2026-07.md). That document says *what* is wrong and *where* to go; this one says *how to get there* without losing a single record in any existing `.twining/` instance.

## Status (as of 2026-07-05)

| Workstream | State | Shipped in |
|---|---|---|
| W0 stop-the-bleeding (atomic writes, locked reads, pending-posts route, version-field respect) | ✅ done | server 1.21.0 |
| W1 hook hardening (sentinel Stop hook, guards, fail-open, version pin, no CLAUDE.md mutation) | ✅ done | plugin 1.10.x |
| W2.1 storage interfaces (file impl underneath, shared dashboard instances) | ✅ done | server 1.21.0 |
| W2.2 SQLite backend (opt-in `storage.backend`, node:sqlite, warn-and-fallback, multiwriter soak) | ✅ done | server 1.21.0 |
| W2.3 git sync — phase 1: per-ULID export tree + startup ingest | ✅ done | server 1.21.0 |
| W2.3 git sync — phase 2: live re-ingest on git changes + content-hash re-embedding | ✅ done | server 1.22.0 |
| W3 migration tool (`twining-mcp migrate`, files ⇄ sqlite, verify-gated) | ✅ done | server 1.23.0 |
| v2.0 cut V1–V5 (engines 22.13, backend default flip via legacy detection, config version 2, nudge + opt-in auto-migrate, upgrade docs) | ✅ implemented, in beta | 2.0.0-beta.1 (dist-tag `next`) |
| W4 repo-scoped daemon | ⬜ not started | v2.1.0 |
| W5 surface & hygiene (BEHAVIORS.md 35 tools, CI token budget, STATE.md) | ✅ ongoing, current | server 1.21.1 / plugin 1.10.1 |

Deviations from the original release map: version numbers compressed — W0/W2.1/W2.2/W2.3-phase-1 all landed in 1.21.0 rather than spreading across 1.21–1.23; hook hardening rode plugin releases independently of server versions. The v2.0 gate was **lifted 2026-07-05** (explicit go-ahead on all decision points in [superpowers/plans/2026-07-04-v2.0-prep-proposal.md](superpowers/plans/2026-07-04-v2.0-prep-proposal.md)): V1–V5 built on the `v2.0-beta` branch for `2.0.0-beta.1` under dist-tag `next`. Go-stable remains evidence-gated (field-quiet window, ≥2 external beta projects, eval comparison vs 1.23). Note the approved deviation from this plan's "Auto-migration" paragraph below: v2.0 ships a startup **nudge** with auto-migration as explicit opt-in (`TWINING_AUTO_MIGRATE=1` / `storage.auto_migrate: true`), not auto-run — full-auto remains a v2.1 option if beta feedback demands it.

## Locked-in design decisions

These were settled in review discussion; the plan below assumes them.

**D1. SQLite is the runtime store; git is the replication transport.** The database (`.twining/twining.db`, WAL mode) is a **derived, gitignored cache** — never committed. The durable, committed truth is an append-only, per-record export tree (one JSON file per record, ULID-named). This mirrors git's own design: object store = mergeable truth, index = local rebuildable artifact.

**D2. Multi-user sync = set-union merge by construction.** Records are immutable events with ULIDs (already true today — `src/utils/ids.ts` uses `ulid`) and provenance (agent, branch, timestamp — added by PR #15). Two users on two branches produce records with distinct filenames; a git merge is "both sets of files land," conflict-free. Mutations (status changes, supersede, dismiss) are modeled as new event records referencing the prior ULID, not in-place edits — which is how `reconsider`/`override` already think. The three conflict magnets in today's layout (`decisions/index.json`, `graph/entities.json`, `graph/relations.json`) cease to exist as committed files; indexes become `SELECT`s.

**D3. Contradiction handling moves from merge time to read time.** Union merge means contradictory decisions from two branches coexist, labeled by provenance. `twining_assemble` and housekeeping surface them (the #17 branch-merge sweep already walks merged branches); the staleness flow archives losers. This is correct blackboard semantics — both decisions *were* made — but it is an explicit contract change and must be documented.

**D4. Daemon is scoped to the repository, not the worktree or session.** Keyed on `git rev-parse --git-common-dir`, so all worktrees share one daemon: one SQLite handle, one embedding model, one dashboard (bound to port 0, OS-assigned — ends the #19 port-range fights). Stdio MCP entry stays per session as a thin shim; if the daemon can't spawn, the shim runs standalone (today's mode) as fallback.

**D5. Worktree visibility is a labeled feature with an off switch.** One shared DB, records tagged `branch` + `worktree`. `twining_assemble` defaults to current-branch + merged-history records, with sibling-branch records visible and labeled "in-flight on branch X." Config `coordination.cross_worktree: true` (default) — `false` reproduces today's isolation. Exports are always written into the originating worktree's checkout only; the daemon never dirties a worktree it isn't serving.

**D6. Driver: `node:sqlite`, engines `>=22.13`.** As of this writing (July 2026) Node 18 and 20 are both past end-of-life; `node:sqlite` is stable in 22.13+. Zero new native dependencies — critical because the server ships via `npx -y` where a native-module build step (`better-sqlite3`) would add cold-start failure modes on machines without toolchains. If a hard requirement for Node 18/20 support surfaces, `better-sqlite3` is the fallback; the `StorageBackend` interface (W1 below) keeps that swappable.

**D7. Hooks harden first, independently.** The hook fixes (sentinel Stop hook, `.twining/` guards, fail-open, no CLAUDE.md mutation) don't depend on the storage change and address every field-reported bug class. They ship as 1.x releases before any format change.

---

## Workstreams

### W0 — Stop the bleeding (release: v1.21.x)

Small, shippable this week, and **prerequisite for safe migration later**:

1. **Atomic writes**: change `writeJSON`/`writeJSONL` in `src/storage/file-store.ts` to write `<file>.tmp` + `fs.renameSync`. Apply the same pattern to the direct `writeFileSync` call sites in `graph-store.ts`, `decision-store.ts`, `index-manager.ts`, `agent-store.ts`.
2. **Locked reads** for whole-file JSON stores (or read-retry-on-parse-failure, which composes with atomic rename: a reader can never see a torn file once writes are rename-based).
3. **SubagentStop hook writes through `pending-posts.jsonl`** (already consumed by `PendingProcessor`, `src/server.ts:171-178`) instead of raw-appending to `blackboard.jsonl`.
4. **Teach 1.x to respect the version field.** `config.ts` writes `version: 1` but nothing reads it (review finding A6). Add: on startup, if `config.version > 1`, log a clear "this project was migrated to a newer Twining format — please update" and refuse writes (reads OK). *This is the linchpin of the mixed-team migration story below — it must soak in the field before v2 ships.*
5. Hygiene: add `metrics.jsonl` + `pending-posts.jsonl` to `.twining/.gitignore` template (`src/storage/init.ts:58`) to match README; ship a `.gitattributes` recommendation (`.twining/blackboard.jsonl merge=union`) as an interim merge-conflict fix for teams committing state today.

**Acceptance:** kill -9 crash-injection test mid-write leaves every store loadable; concurrent 4-process writer test produces no torn reads; old/new version-refusal test passes.

### W1 — Hook hardening (release: v1.22.x)

1. Rewrite `plugin/hooks/stop-hook.sh` on the sentinel pattern: compare `.twining/.last-record` mtime/content against session-start time (hook input provides the session), zero transcript grepping. Delete the `grep -n 'twining_record\|...'` logic (`stop-hook.sh:24-38`).
2. Guard **every** hook on `.twining/` existence + uniform `TWINING_DISABLED` handling (Stop hook currently has neither).
3. **Fail open on server-down**: pre-commit gate allows the commit with a one-line warning if the sentinel is absent *and* the server never wrote one this session (fresh clone / npm outage — review finding B3).
4. Pin the server version in `plugin/.mcp.json` (`npx -y twining-mcp@X.Y.Z`); bump in lockstep with plugin releases so the pair ships tested together.
5. Delete `ensure-claude-md-gates.sh`; deliver the gates block via the SessionStart hook's `additionalContext` output (mechanism already used by `session-start-context.sh`). Closes #9 permanently.
6. Move the #18 quality lever into `twining_record`'s schema prompts (ask for findings/warnings/surprises explicitly; server returns a one-shot deterministic nudge when a large diff records zero findings).

**Acceptance:** existing hook test suite (`test/hooks/*`) rewritten to the new contracts; a session in a non-Twining repo triggers zero hook interventions; fresh-clone first commit succeeds offline.

### W2 — Storage foundation (release: v2.0.0)

**W2.1 Extract a `StorageBackend` interface.** Today's stores (`BlackboardStore`, `DecisionStore`, `GraphStore`, `AgentStore`, `HandoffStore`, `IndexManager`, `MetricsStore`) are concrete classes wired in `src/server.ts:58-236` and — a review finding — re-instantiated independently in `src/dashboard/api-routes.ts`. Extract their public methods into interfaces, make engines depend on the interfaces, and fix the dashboard to share the server's instances. **Ship this refactor with the file backend still underneath** so it's a pure, testable no-op release. This is also the moment to fix the setter-injection cycles (`setArchiver`/`setAssemblyChecker`) since the wiring is being touched.

**W2.2 SQLite backend.** Schema v1 (`PRAGMA user_version = 1`):

```sql
records(            -- unified event store: posts, decisions, handoffs, status events
  id TEXT PRIMARY KEY,          -- ULID
  kind TEXT NOT NULL,           -- 'post' | 'decision' | 'handoff' | 'dismiss' | 'status_change' | ...
  refers_to TEXT,               -- prior record ULID for supersede/dismiss/status events
  scope TEXT, entry_type TEXT, summary TEXT, body JSON,
  agent_id TEXT, branch TEXT, worktree TEXT, session_id TEXT,
  created_at TEXT NOT NULL, content_hash TEXT NOT NULL
);
entities(id TEXT PRIMARY KEY, name TEXT, type TEXT, body JSON, provenance ...);
relations(id TEXT PRIMARY KEY, source_id TEXT, target_id TEXT, type TEXT, provenance ...);
embeddings(record_id TEXT PRIMARY KEY, content_hash TEXT, model TEXT, vector BLOB);
agents(...); metrics(...);
-- indexes on (kind, scope), (branch), (created_at), (content_hash)
```

Current *state* views (active decisions, live blackboard) are SQL views/queries folding the event stream — `decisions/index.json` and every N+1 read in `ContextAssembler.assemble` collapse into single indexed queries. Embedding vectors: 384 floats as a BLOB (~1.5KB vs ~6-8KB JSON today); linear scan in SQL is fine to ~50k records, with `sqlite-vec` as a later opt-in for ANN. WAL mode + `busy_timeout`; document the NFS caveat (WAL requires a local filesystem; fall back to `journal_mode=DELETE` when `.twining` is detected on a network mount).

**W2.3 Git sync layer (export/ingest).** Committed tree:

```
.twining/
  config.yml                      # committed (version: 2)
  records/
    decisions/<ulid>.json         # same shape as today's decision files
    posts/<yyyy-mm>/<ulid>.json   # sharded by month to keep directories sane
    graph/<ulid>.json             # entities and relations as records
    handoffs/<ulid>.json
  twining.db, *.db-wal, *.db-shm  # gitignored
```

- **Export**: on every write, the backend also writes the record's JSON file into the *originating worktree's* checkout (deterministic serialization, sorted keys). Export is derived-from-DB and idempotent, so a lost write is self-healing on the next `twining_housekeeping`.
- **Ingest**: upsert-by-ULID from `records/` into the DB. Triggered on server start, on branch-change detection (the existing `branch-watcher`), and after merge/pull (post-merge detection via the same watcher). Idempotent: re-ingest is free. Re-embed only records whose `content_hash` is missing from `embeddings`.
- Teams that don't want state in git add `records/` to gitignore and lose nothing locally.

**Acceptance:** full existing store/engine/integration suites pass against **both** backends (parameterized); 4-process concurrent read/write soak passes; clone→ingest→identical-assemble-output property test; merge-two-branches-union test; benchmark: assemble on a 5k-record corpus ≥10× faster than file backend.

### W3 — Migration tool & rollout (ships inside v2.0.0)

**CLI:** `npx twining-mcp migrate [--project <dir>] [--dry-run] [--check] [--keep-legacy]`

Steps (idempotent; every step re-runnable):

1. **Detect** legacy layout (`blackboard.jsonl` / `decisions/index.json` present, `config.version < 2`).
2. **Back up**: copy the entire legacy `.twining/` to `.twining/legacy-v1/` before touching anything. Never deleted by the tool; `--keep-legacy` (default true for one release) leaves originals in place too.
3. **Parse with salvage**: JSONL lines that fail to parse are skipped-and-logged (matching today's `readJSONL` behavior); truncated whole-file JSON (the corruption mode W0 eliminates going forward) gets a best-effort recovery pass (trailing-fragment trim) with per-file report. Nothing parseable is dropped.
4. **Transform**: legacy records → event records. Decisions keep their ULIDs and file shape (their per-file layout survives nearly unchanged). Blackboard entries become `posts/` records. `entities.json`/`relations.json` arrays explode into per-record files with freshly minted ULIDs (they have none today — the only ID minting in the migration). Statuses (`superseded`, `dismissed`) synthesize the corresponding event records so the event-stream views reproduce today's state exactly.
5. **Build DB** by ingesting the new export tree (same code path as W2.3 — the migration is "write export tree, then ordinary ingest," not a special importer).
6. **Verify**: run a read-model diff — active decisions, blackboard entries, entity/relation counts, and a sample `twining_assemble` output compared old-store vs new-store. Refuse to finalize on mismatch. `--check` runs only this verification.
7. **Finalize**: set `config.version: 2`, update `.twining/.gitignore`, print the git commands to commit the new tree (never auto-commits). Embeddings are **not** migrated — rebuilt lazily by content hash (they were gitignored and per-clone anyway).

**Auto-migration:** v2 server, on encountering a legacy layout, runs the same pipeline automatically at startup (it's additive and backed up), posts a `migration` record to the blackboard, and tells the user what to commit. `--dry-run` output is what the server logs first.

**Mixed-version team rollout (the reason W0.4 exists):**

- v1.21+ clients on a repo where a teammate has migrated see `version: 2` and cleanly refuse writes with an upgrade message — no silent divergence, reads still work.
- Clients older than 1.21 don't check the version (today's behavior). Mitigation is sequencing and time: W0/W1 ship weeks before v2, the plugin pins its server version (W1.4) so plugin updates pull the version-aware server, and the migration's printed instructions tell the migrating user to have teammates update first. Residual risk: a stale pre-1.21 client writes to the frozen legacy files after migration; because migration never deletes legacy files during the `--keep-legacy` window, a re-run of `migrate` picks up those stragglers (idempotent upsert by content, new ULIDs only for genuinely new entries).
- One minor v2.0.x series keeps legacy-read + re-migrate support; v2.2 drops legacy write-detection; the code path is deleted in v3.

**Acceptance:** migrating this repo's own committed `.twining/` (131 decisions, 95KB blackboard, populated graph — the best available real fixture) produces a verified, diff-clean read model; migration corpus tests include synthetically truncated/corrupt files; double-migration is a no-op; post-migration straggler re-run test passes.

### W4 — Repo-scoped daemon (release: v2.1.0)

1. Shim/daemon split: stdio entry (`src/index.ts`) becomes a client that connects to a unix socket (Windows: named pipe) at a path derived from the git common dir hash; `.twining/daemon.json` records pid/socket/port + liveness token. First shim to find no live daemon spawns one (detached) and connects; on spawn failure, run embedded (today's mode).
2. Daemon owns: the DB handle (single writer — even WAL contention disappears), one `Embedder` with a real batch queue (fixes sequential `embedBatch`), one dashboard on port 0 (fixes #19; dashboard shows project name + worktree list, closing the #2 lineage properly), the assembly log (making the assemble-before-decide gate real across sessions — review finding C3), and the pending processor.
3. Worktree semantics per D5: shim handshake declares its worktree + branch; writes are tagged; exports route to the declaring worktree's checkout; `coordination.cross_worktree` config governs assemble visibility.
4. Idle shutdown (no connected shims + N minutes) so daemons don't accumulate; version handshake — a shim newer than the daemon triggers daemon retirement and respawn.

**Acceptance:** two sessions in two worktrees see each other's labeled posts (and don't when the flag is off); model loads once across N sessions (RSS test); daemon crash mid-session → shims degrade to embedded mode without user-visible failure; no port collisions with a Serena instance occupying 24282-24287.

### W5 — Surface & hygiene (parallel, ongoing)

Reconcile BEHAVIORS.md/STATE.md/README to the shipped tool surface (including `twining_record`); fix the "3 gates" comment in `src/instructions.ts`; wire `measure-plugin-tokens.sh --ci` and an eval smoke (non-LLM scorers at minimum) into `.github/workflows/ci.yml`; unify error codes into an exported enum; update `TWINING-DESIGN-SPEC.md` sections 2 (architecture), 5 (embeddings), 6 (archive) to the v2 model.

---

## Sequencing & release map

| Order | Workstream | Release | Depends on | Risk gate before proceeding |
|---|---|---|---|---|
| 1 | W0 stop-the-bleeding | v1.21 | — | crash-injection suite green |
| 2 | W1 hook hardening | v1.22 | — | field-quiet: no new hook issues for ~2 weeks |
| 3 | W2.1 backend interface (file impl) | v1.23 | — | zero behavior diff (full suite + evals) |
| 4 | W2.2/2.3 SQLite + git sync + W3 migrate | v2.0.0 (beta first) | W0.4 soaked in field | self-migration of this repo; beta dogfood on ≥2 real projects |
| 5 | W4 daemon | v2.1.0 | v2.0 stable | multi-worktree + degradation tests |
| 6 | W5 hygiene | continuous | — | — |

The order is deliberate: everything before v2.0.0 is invisible to users except as bug fixes, and W0.4 (version-field respect) must be in the installed base *before* any format change ships — it is what turns "mixed team versions" from silent corruption into a clean upgrade prompt.

## Testing strategy

- **Backend parity**: the existing store/engine/integration suites run parameterized over `file` and `sqlite` backends for the whole v2.0 cycle; the file backend isn't deleted until v3.
- **Crash & concurrency**: kill -9 injection mid-write per store; 4-process writer soak; torn-read detector.
- **Migration corpus**: this repo's own `.twining/` as the golden fixture, plus synthetic corpora (empty, huge, corrupt-line, truncated-file, pre-provenance records from <1.19).
- **Property tests**: export→ingest round-trip identity; union-merge commutativity (merge A→B ≡ B→A record sets).
- **Worktree e2e**: scripted two-worktree scenario in the coordination suite.
- **Evals**: run the existing LLM-judged coordination evals against v2 before the beta→stable cut (and get them into CI per W5, so this comparison is cheap next time).

## Risks

| Risk | Mitigation |
|---|---|
| `node:sqlite` requires Node ≥22.13; some users pin older Node | 18/20 are EOL; `StorageBackend` keeps a `better-sqlite3` fallback possible; document clearly in v2 release notes |
| WAL on network filesystems | detect + fall back to rollback journal; document |
| Pre-1.21 clients writing legacy files post-migration | W0.4 sequencing + `--keep-legacy` window + idempotent re-migrate |
| Export tree = many small files in git | monthly sharding for posts; decisions already work this way at 131 files with no pain; housekeeping archive flow prunes |
| Read-time contradiction surfacing (D3) confuses users | provenance labels in assemble output; housekeeping surfaces cross-branch conflicts explicitly; document the contract change |
| Daemon lifecycle bugs (stale socket, version skew) | liveness token + version handshake + always-available embedded fallback |

## Explicitly out of scope

Semantic staleness review (#16) stays skill-driven per its own issue discussion; no server-side model client. No change to the MCP tool contract — all 35 tools keep their schemas; lite mode stays the default. No federation/cross-repo work (docs/FEDERATION_DESIGN.md) until the single-repo foundation is done.
