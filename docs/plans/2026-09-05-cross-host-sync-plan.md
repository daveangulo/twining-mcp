# Cross-Host Sync Plan — field report 2026-09-04, items #3 and #4

> **For agentic workers:** triage-and-disposition plan in the pattern of
> `2026-08-23-field-response-plan.md`. Workstream A (response doc + field actions) executes
> with superpowers:executing-plans once Dave rules on §7. Workstream B items get their own
> per-release TDD breakdown before any code is written; the 2.16.1 breakdown must re-derive
> the ingest fix from the preserved scratch tests (§8), not from this prose.

**Goal:** Answer field items #3 (decisions do not cross hosts until commit+push+pull; a five-day
divergence; a "one-sided supersession" record) and #4 (merge conflicts on the autonomous merge
tier; `.gitattributes` coverage; untracked aggregates meeting the old-Node files fallback with
ENOENT) — correcting the report where it is wrong, fixing the defects it exposed on our side,
and slotting every code change into the existing release train without forking it.

**Inbound:** items §3 and §4 of the field's 2026-09-04 report (pasted by Dave; the rest of that
document was not provided and is assumed not addressed to us — §6.1 A1).

**Status:** APPROVED 2026-09-05 — Dave ruled on all six §7 items: (1) 2.16.1 go, validator IN;
(2) W2 / 2.17.1 split as decided; (3) DD-13 opens, does not build; (4) fallback policy routes
into the DD-6/DD-11 session; (5) Doc 4 sends separately after the A-batch; (6) conservative
AUTO-SAFE wording. EXECUTING: Workstream A (docs + Doc 4) then the 2.16.1 breakdown in the
same session. The physical send stays Dave's action.

**Investigation basis:** one ultracode workflow this session, `wf_daceaa5d-eee` (13 agents,
~2.0M subagent tokens, 388 tool calls): six verification lanes V1–V6 (code-executing lanes in
isolated worktrees; live tree confirmed untouched afterwards), a three-lens design panel, a
judge, and three adversarial critics (field-operator, maintainer-cost, correctness). Every
load-bearing claim below carries a `file:line` cite at HEAD `d649ec4` (= 2.16.0 / plugin
1.34.0); claims marked **EXECUTED** were reproduced by running code or git, not only read.
The critics changed six mechanisms after the judge's synthesis; §1.9 lists them so the
audit trail shows the evolution rather than a clean first draft.

---

## 0. The short version

1. **#3 and #4 are two different failures the report treats as one.** Host B's "nothing
   governs this" is a genuinely EMPTY sqlite read (records not drained/pulled) with no error
   flag. The old-Node host is a LOUD `INTERNAL_ERROR ENOENT` on every decision-touching tool.
   Upgrading Node fixes only the second. **EXECUTED** (V1): with an empty index the fallback
   host renders the same "No active decisions" text as the undrained sqlite host — only the
   error flag distinguishes them today.
2. **#3 is by design (git is the transport — recorded decision `01KWK9KTZGR2V148HJJ2CGY3ZY`,
   high confidence); the silence is ours.** No code path commits, pushes, or inspects the
   working tree for unshared records; the sync probe watches only `git rev-parse HEAD`
   (`src/storage/sync/sync-manager.ts:128-140`); no shipped doc says decisions are invisible
   elsewhere until commit+push+pull, or that the gap presents as EMPTY (V6). We owe the
   disclosure. The drain on every writing host is theirs regardless.
3. **The field's tier-A classification rests on a sentence we published that is false for
   mutations.** `docs/UPGRADE-v2.md:67` says records are "immutable ULID-named files …
   conflict-free"; FOUNDATION-PLAN D2 (`docs/FOUNDATION-PLAN.md:28`) promises mutations as
   new event records and untracked aggregates. What ships rewrites the same ULID file on every
   mutation (`src/storage/sync/record-export.ts:20-21` states it as the contract) and migrate
   leaves the aggregates tracked (`src/migrate/cli.ts:122-128` prints only `git add`). Same-record
   concurrent mutation is a real conflict class; **EXECUTED** (V5): override on A + link_commit
   on B → CONFLICT. This is our documentation failure, not their configuration error.
4. **A live data-loss defect of ours was found on the way.** Ingest DELETES the sqlite row for
   any record file it cannot parse or identify — conflict markers, 0-byte, non-string `id`,
   `id` ≠ filename stem — while the file stays on disk (`record-ingest.ts:243-245` + `:291-296`),
   contradicting its own docblock at `:19`. **EXECUTED** (V2): `{deleted:1, skipped:1}`. The
   field's evict-conflicted-entry pipeline produces exactly this trigger. Ships as **2.16.1**.
5. **"The fix is Node, not restoring the file" is right as root cause and incomplete as
   remediation.** On a pure sqlite-era clone nothing at HEAD can recreate `decisions/index.json`
   (`repairIndexDesync` returns before its `ensureFileExists` when there are zero legacy
   decision files — `src/storage/decision-store.ts:222-237` vs `:245`; **EXECUTED**), the
   documented straggler sweep `twining-mcp migrate` itself ENOENTs there
   (`src/migrate/forward.ts:127/168`), `twining_status` dies before it reaches its own
   "FELL BACK" warning (`src/tools/lifecycle-tools.ts:60` vs `:128-132`; **EXECUTED**), and
   `twining_record` passes Gate 2 while silently dropping every decision
   (`src/tools/record-tools.ts:478-484`; **EXECUTED**). Their #66 untrack is the direct cause:
   **EXECUTED** two-clone experiment — after one clone commits `git rm --cached`, a plain
   `git pull` on a clean clone deletes the working-tree file, and sqlite hosts are always clean
   for that file.
6. **"status: overridden, superseded_by: None" is the designed shape of a veto, not a broken
   link.** `override()` without a replacement writes `overridden_by` + `override_reason` only
   (`src/engine/decisions.ts:1082-1089`); nothing in the codebase ever writes `superseded_by:
   null` — "None" is their reader rendering a missing key. It is a defect only if another
   record's `supersedes` names it. Two revert-free routes to that residue exist on their
   topology (§1.6). Our own text fed the misreading (`src/tools/decision-tools.ts:423`; our
   Doc 2 `:50` wrote "null"). And the W2 lineage wording already committed to the field would
   label every pure veto `lineage_unresolved` in 2.17.0 — a correction to work in flight.
7. **No `.gitattributes` change fixes #4.** `blackboard.jsonl merge=union` is inert on a
   sqlite-era store (that file is frozen); `merge=union` on records/** yields invalid JSON and on
   an array aggregate yields PARSEABLE duplicate-key output that silently drops an entry
   (**EXECUTED**, V5). The only safe policy for frozen aggregates is untracking them — guarded
   on every host being on Node ≥ 22.13.

---

## 1. What the investigation established

### 1.1 Two failure shapes (V1, EXECUTED tool matrix — 41 calls on a simulated fallback host)

Fallback simulated by `vi.mock(sqliteAvailable → false)` with `storage.backend: sqlite`, a
populated `records/` tree, no `decisions/index.json`; `createStores` returned
`{backend:'files', reason:'fallback', legacy_unread:false, records_unread:true}`
(`src/storage/backend-factory.ts:113-117`, `:238-259`).

| Result | Tools |
|---|---|
| **FAIL** `INTERNAL_ERROR ENOENT … open decisions/index.json` | status, assemble, why, summarize, what_changed, recent (even without `entry_types` — `blackboard-tools.ts:17-19`), decide, trace, commits, triage, verify, export |
| **FAIL** `ENOENT … lstat decisions/index.json` (proper-lockfile on a missing file, `decision-store.ts:65/129/175/330`) | link_commit, amend, reconsider, override |
| **WORK normally** (and WRITE divergent legacy files) | post, read, query, resolve, dismiss, record (summary only), add_entity, graph_query, neighbors, agents, register |
| **OK but degraded/silent** | record WITH decisions (status post written, decision NOT persisted, only `decision_errors` names it); search_decisions (empty, `fallback_mode:true`, ENOENT on stderr only — `decisions.ts:1405-1407`); housekeeping({}) (fully green — every decision pass inside bare catches, `housekeeping.ts:293-295`); promote on an active target |

Only `DecisionStore.get(id)` works without the index (`:85-89`). Nothing recreates the index on
an existing store (`src/storage/init.ts:69-72` returns after gitignore reconcile); the only
recreators are `repairIndexDesync(execute)` — which no-ops with zero legacy decision files —
and `migrate --reverse`.

**Correction to carry:** "every tool call fails with ENOENT" is an overstatement; the failure
is loud in 16 places, absent in 11, and silently degraded in 4 — the last class is the worst.

### 1.2 Transport: by design, undetectable, undocumented (V3, V5, V6)

- Records arrive only via `ingestRecords` at startup (`backend-factory.ts:120-142`) and on a
  HEAD move mid-session (TTL 5 s, `sync-manager.ts:33, :64-71`). `git fetch` does not move
  HEAD. No code commits, pushes, or checks for local exports absent from every ref (grep, V5/V6).
  The only staleness signal is `records_unread`, and it covers the sqlite→files fallback only.
- Assemble renders "No prior context constraints — proceed with your task."
  (`src/engine/context-assembler.ts:896`) with no "may be unpulled/unshared" lane; assemble's
  `Status:` line is `summarize().recent_activity_summary` (`:644-659`, `:846-848`), not
  `twining_status` — a status-only block would never reach Gate 1 (V3).
- Docs: `README.md:344` and `UPGRADE-v2.md:67` state the model, never the consequence; the only
  text naming pull-as-arrival is `CHANGELOG.md:655` (V6 Q1). FOUNDATION-PLAN D5 ("exports go to
  the originating worktree") is also not what ships: exports land in the resolved MAIN
  checkout (`record-export.ts:63-65` + `src/utils/project-root.ts:86-91`) — which is what makes
  a per-repo drain feasible and where a drain must look.
- Live on this repo during V3: local `main` was 1 ahead of `origin/main` — the exact state the
  disclosure exists to surface, in the dogfood store.

### 1.3 The D2 gap and the real conflict surface (V5, EXECUTED)

- Every mutation is an in-place rewrite of the existing ULID file: decision
  updateStatus/linkCommit/amendMetadata (`record-export.ts:221-247`), post resolve (`:169-184`),
  entity upsert (`:256-262`; sqlite store bumps `updated_at` on EVERY touch,
  `src/storage/sqlite/sqlite-stores.ts:374-390`, `:385`), relation upsert (`:264-270`; byte-stable
  when properties match, `sqlite-stores.ts:455-458`), handoff acknowledge (`:324-328`); unlinks on
  dismiss/removeEntities/removeRelations. `test/record-sync.test.ts:156-168` pins the rewrite as
  intended.
- Merge matrix (git 2.50.1, two clones): default attributes, **disjoint keys far apart** (override
  on A, `commit_hashes` on B) → rc=0, valid JSON (stableStringify writes sorted keys one per line,
  `record-export.ts:45-58`); **overlapping keys** (both change `status`) → CONFLICT, markers,
  unparseable; `merge=union` per-record → invalid JSON; `merge=union` array aggregate → PARSEABLE
  duplicate-key output, one entry silently lost; `-X ours/theirs` → one side dropped without
  trace; `records/**/*.json -merge` → keeps "ours" as valid JSON, flags UU on EVERY same-record
  edit including the disjoint ones git would otherwise merge cleanly.
- Entity `updated_at` churn is the one same-record conflict class that fires WITHOUT any human
  lifecycle action (graph auto-population touches entities on decide/record).
- Migrate finalize = `setStorageBackend` + `ensureDbGitignored` (`forward.ts:242-247`); prints
  only `git add .twining/records .twining/config.yml .twining/.gitignore` (`cli.ts:122-128`).
  The chassis store's four tracked aggregates among 5,247 files is exactly the state migrate
  leaves; this repo has the same shape (`git ls-files` — index.json, graph/*.json,
  handoffs/index.jsonl tracked; agents/registry.json not).
- `.twining/.gitattributes` is written only on fresh init (`init.ts:124-129`), never reconciled,
  never touched by migrate, asserted by no test. On a sqlite-era store the ONLY Twining writer of
  the frozen aggregates is an old-Node fallback host (V5).

### 1.4 Ingest deletes rows for unreadable or mis-keyed files (V2, EXECUTED) — new defect

Detailed in blackboard warning `src/storage/sync/record-ingest.ts` (this session). Shape:
`readRecord()` null → `continue` before `fileIds.add` (`:243-245`) → deletion pass (`:291-296`)
removes the row; `{deleted:1, skipped:1}`; embedding swept by reconcile (`embedding-reconcile.ts:77-83`);
repaired file re-inserts as a NEW row (seq 1→2). Non-string `id` (`:244`) is fully silent.
Parseable body `id` ≠ stem inserts a stray row under the body id AND deletes the stem's row.
0-byte and EACCES/EIO land in the same catch. The regression test at
`test/record-sync.test.ts:539-553` never seeds a row — a false positive for the docblock.
Sync-manager never probes MERGE_HEAD (grep: zero hits); a mid-merge tree is ingested at the
next startup unconditionally (`backend-factory.ts:130-133`).

### 1.5 The fallback host cannot diagnose itself (V1, V5, EXECUTED)

- `twining_status` calls `getIndex()` at `lifecycle-tools.ts:60` before the warnings array
  (`:116`) and the `records_unread` push (`:128-132`); its catch at `:239-244` yields
  `INTERNAL_ERROR`. Control with `index.json = []`: status OK, `warnings[0]` is the exact FELL-BACK
  text, `warnings[1]` the desync warning.
- Untrack propagation: A commits `git rm --cached` → B (clean) `git pull` deletes the file
  silently; C (uncommitted local edit) aborts; D (committed edit) gets a modify/delete conflict
  which their tier-A rule would evict. Sqlite hosts never write `index.json`, so they are
  always the clean case.
- Restoring `[]` by hand makes the host read as EMPTY beside hundreds of records — the S0
  amnesia shape the 2.16.0 guard exists to prevent (control run rendered "No active decisions").

### 1.6 Override and lineage semantics (V4, EXECUTED on the files backend)

- Q1: `override(id, reason)` without `newDecision` writes `status: overridden`, `overridden_by`
  (default `human`), `override_reason`; `superseded_by` is absent, never null (`decisions.ts:1082-1089`;
  serializers drop undefined: `decision-store.ts:135-139`, `sqlite-stores.ts:242-244`,
  `record-export.ts:45-57`).
- Q2: override WITH `newDecision` ends with the OLD record `superseded` + `superseded_by` (the
  decide() supersede flip at `:415-422` overwrites `overridden`), `overridden_by`/`override_reason`
  retained. **Defect:** the D14 read-back at `:1096`/`:1121` runs BEFORE decide() at
  `:1126-1137`, so the tool result echoes `status:'overridden'` while the store holds
  `superseded`; `test/decision-engine.test.ts:901-918` never asserts the old record.
- Q3: two revert-free routes to `overridden` + no pointer while a claimant exists: (a) same-rank
  file-wins rewrite (overridden↔superseded both rank 2, `record-ingest.ts:54-60`, strict `<` at
  `:272` — `lifecycle_reverts` is blind by design); (b) cross-host `supersedes_dangling`: a
  successor recorded on host B before the target drained there never flips the target
  (`decisions.ts:426-428`); when the target arrives it keeps host A's status.
- Q4: housekeeping step 9 backfills an overridden target that a claimant points at, status-
  preserving (`housekeeping.ts:517-536`); preview `fixed` equals execute's.
- Q5: today's `why()` rows for a pure veto and a one-sided link are byte-identical `{id, summary}`
  (`decisions.ts:686-702`); the committed W2 wording (Doc 2 `:266` "rows where neither pointer
  resolves carry lineage_unresolved: true") would flag every pure veto.
- `decision-tools.ts:423` tells agents to "follow superseded_by" for overridden records too —
  note `twining_search_decisions` is full-surface only, so whether this text ever reached the
  field's agents depends on their `tools.full_surface` (asked in §3.4).

### 1.7 Sync disclosure — feasible, with four hazards (V3 EXECUTED; correctness + maintainer critics EXECUTED)

Costs on a 5.1k-file records tree, medians of 5: `status --porcelain -uall -- .twining/records`
14.8 ms warm / 232 ms cold; `rev-parse @{u}` 7.9 ms; `rev-list --left-right --count HEAD...@{u}`
8.5 ms; `log -1 -- .twining/records` 9.5 ms; one combined `rev-parse HEAD --abbrev-ref HEAD
--is-shallow-repository --git-common-dir` 7.8 ms (argument ORDER matters — reversed prints the
branch twice); `stat FETCH_HEAD` 0.0015 ms. Spawn cost dominates.

Hazards that change the design:
1. **`git status` rewrites `.git/index`** (stat-refresh) and therefore takes `index.lock` — a
   concurrent `git add` fails rc=128 "index.lock: File exists" (maintainer critic EXECUTED).
   Fix: `git --no-optional-locks status …` (global option BEFORE the subcommand;
   `GIT_OPTIONAL_LOCKS=0` equivalent) — output accurate, index never rewritten (EXECUTED).
   Consequence: the refresh never amortizes (~80–230 ms per call), so the probe must be
   TTL-cached and called only from `twining_status` and the assemble path, never the
   per-dispatch wrapper.
2. **`git diff-index --quiet HEAD` is NOT a substitute**: 5,137 false "M" after an mtime-only
   touch (EXECUTED). Pin with a regression test.
3. **`git push` changes ahead/behind with HEAD and FETCH_HEAD unchanged** (EXECUTED: `1 0` → `0 0`).
   A cache keyed on HEAD sha + FETCH_HEAD mtime serves a stale "unpushed" warning after every
   drain. Fix: include the upstream sha in the key, or simply recompute on the 5 s TTL.
4. **A gitignored records tree** (`record-ingest.ts:15-16` names it as supported) yields 0
   porcelain lines → would render "0 unshared" on a store where nothing is ever shared
   (EXECUTED). Fix: `git check-ignore -q .twining/records` → `records_tracked:false`, counts
   null, explicit warning. Likewise `storage.export_records:false` (no mirror, no manager —
   `backend-factory.ts:117-125`, `:220-229`) → emit `sync:{export_records:false}` and nothing else.

Also: FETCH_HEAD is absent on a fresh clone or a push-only clone (EXECUTED) — null must read as
"unknown", not "never fetched", when HEAD == @{u}; in a linked worktree FETCH_HEAD is per-worktree
and absent — read `<git-common-dir>/FETCH_HEAD`; a worktree-local store (`TWINING_WORKTREE_LOCAL`
or `--project` at a worktree) has no upstream by construction — suppress, don't warn. `behind` is
measured against the last fetch: never render `behind=0` as "in sync". **Framing correction from
the correctness critic:** in the field's exact reported topology (host B pulled recently, host A's
drain not yet run) host B has fetch age < 1 h and `behind=0` → the disclosure lands on host A
("N unshared records"), not on host B. The assemble caveat on an empty result must therefore be
unconditional-but-short, not gated on fetch age.

### 1.8 Transport mechanisms ruled in and out (V6, EXECUTED)

- **Hook auto-staging is structurally impossible** from a linked worktree or a `TWINING_PROJECT`
  store: the hook binds `MAIN_ROOT/.twining` (`plugin/hooks/pre-commit-hook.sh:85-93`) while its
  git cwd is the worktree — `git add --dry-run <main path>` → exit 128 "outside repository".
  Also: 5 s PreToolUse timeout vs thousand-file stages; welds records into the commit they
  describe; fires only for Bash-tool commits.
- **Server-side periodic commit**: races the agent's index; two servers on one store
  (`UPGRADE-v2.md:94`) would double-commit; no repo-wide "server never commits" decision exists
  (every such statement is migrate-scoped — `cli.ts:10`, `README.md:370`), so a committing CLI
  is unprecedented but not contra-decision → that boundary is a decision to record (DD-13).
- **`twining-mcp drain` / `sync-status` today fall through `src/index.ts:28-31` and START A STDIO
  SERVER** — the only argv[2] dispatch is `migrate` (EXECUTED: `runMigrateCli(['drain'])` → exit 2,
  but `twining-mcp drain` itself boots a server). A footgun for any launchd job.
- Git post-commit hook (`docs/hooks.md:34-45` pattern): unversioned, per-host, cwd-in-worktree
  trap unless it shells to `git -C <main>`. Documented option, never plugin-installed.
- `git add .twining/records` **stages atomic-write temp files** `<file>.<pid>.<rand>.tmp`
  (`src/storage/file-store.ts:62-65`; correctness critic EXECUTED) — no gitignore entry covers
  them (`init.ts:20-33`).

### 1.9 Release mechanics and what the critics changed

- **A 2.16.1 point release IS a plugin change by construction**: `npm version` runs
  `build:plugin && git add plugin/server` (`package.json:21`); the plugin launcher execs the
  committed bundle first (`plugin/scripts/launch-server.sh:7-13`); CI fails any `plugin/` diff
  without a bump in BOTH version files (`.github/workflows/ci.yml:14-49`). No 2.x point release
  exists (`git tag`) — the precedents are v1.21.1 and v1.24.1. `git log 6a7728d..HEAD -- src
  test plugin` is empty, so 2.16.1 would carry nothing but its own items.
- **The plugin pin does not pin the server** for npx-rung hosts (`launch-server.sh:42`
  `PKG_SPEC="twining-mcp@^2.0.0"`): server version floats per host unless rung 0b (project
  `node_modules`) or rung 4 (bundled) applies. Whether a release reaches the field depends on
  their launcher rung — asked in §3.4 (`sh launch-server.sh --probe` prints `runner=…`).
- **Tool descriptions are not measured** by the token-budget gate
  (`scripts/measure-plugin-tokens.sh:24` counts skills/agents only). Description growth from
  this plan is unmeasured; §4.6 adds a measurement.
- Critic-driven changes to the judge's synthesis: (i) ingest retention keyed on
  `dbRows.has(stem)` for EVERY file (not a ULID-shape gate on unparseable files only) so the
  parseable-but-`id`≠stem case is covered; (ii) `--no-optional-locks` + off-dispatch-path caching;
  (iii) upstream sha in the cache key; (iv) `check-ignore` / `export_records:false` gating;
  (v) the J-2 error-translation must not hide the duck-typed `repairIndexDesync`
  (`housekeeping.ts:590-602`, `lifecycle-tools.ts:137-143`) and status's catch must propagate
  `TwiningError` codes; (vi) the records validator moves from W4 to 2.16.1 because it is the one
  deliverable the field can wire into their drain next week; W2 vs 2.17.1 is pre-split, not
  slid at tag time.

---

## 2. Dispositions

| Inbound item | Disposition | Vehicle |
|---|---|---|
| #3 decisions do not cross hosts until commit+pull | Confirmed as designed (D1, `01KWK9KTZGR2V148HJJ2CGY3ZY`); the silence is our defect — Gate 1 cannot distinguish "absent" from "not yet here" | Disclosure: W2 (§4.2 J-3); docs now (§4.5 J-7); drain-on-every-host is theirs (§3.2) |
| #3 five IDs in no ref for 5 days | Undetectable by Twining at HEAD; confirms the transport gap | Same |
| #3 `01M088…` "one-sided supersession-link shape" | Refuted as a defect class: designed veto shape unless a claimant exists; diagnostic supplied; our texts corrected; W2 lineage gating amended before it ships | Doc 4 + W2 (§4.2 J-5) |
| #4 five aggregates without merge strategy | Reframed: no textual strategy is safe (EXECUTED); frozen aggregates conflict only via a fallback writer; the REAL sqlite-era conflict class is same-record mutation, which their table misses | Docs now (J-7); migrate guidance W4 (J-8); entity churn fix W2 (J-6) |
| #4 `.gitattributes` incomplete | Refuted: nothing worth adding by default; `-merge` offered as opt-in recipe with its cost stated | J-7 |
| #4 tier-A "fully autonomous for .twining/**" | Unsafe on the shipped model; caused by our UPGRADE-v2 sentence; conflict-class contract published | J-7 (conservative AUTO-SAFE = add/add only until the semantic matrix test lands) |
| #4 untrack → old-Node ENOENT "every tool call" | Partially confirmed (16/11/4); root cause "Node" accepted; remediation incomplete on our side (status dies, record drops decisions, repair/migrate cannot recreate) | 2.16.1 validator + argv guard (§4.1); 2.17.1 fallback diagnosability (§4.3 J-2); DD-6/DD-11 fallback policy (§4.7) |
| (found) ingest deletes rows for unreadable files | New defect, live at 2.16.0, produced by their pipeline by construction | **2.16.1** (§4.1 J-1) |
| (found) `git add .twining/records` stages `*.tmp` | Hygiene gap | 2.16.1 gitignore entry + field pathspec |
| (found) entity `updated_at` bump on no-op upsert | Highest-frequency same-record conflict; fires without human action | W2 (J-6) |
| (found) override read-back stale with `new_decision` | D14 self-verification is wrong for that path | 2.17.1 (J-5c) |
| (found) `twining-mcp <unknown>` starts a server | Footgun for launchd jobs | 2.16.1 argv guard |

---

## 3. Workstream A — the response (Doc 4) and the field's actions

Doc 4 = `docs/field-responses/2026-09-05-cross-host-sync-response.md`. Written from §1 only
(verified findings; no unverified root cause). Same register as Doc 3: verdict per item, what we
verified, what we correct, what ships where, what we need from them. Wave names, no dates for
unshipped work. Verification questions continue from **#9**.

### 3.1 Doc 4 content spec (order matters)

1. **Two failures, not one** — the §1.1 matrix and the empty-vs-error discriminator, with the
   no-MCP-session host classifier (§3.2 item 1) so a fleet job can separate them.
2. **#3 transport** — designed (D1), undetectable at HEAD (§1.2), our disclosure gap (J-3) and
   what it will and will not show (host A sees "unshared"; host B sees fetch age, never remote
   truth); the drain must run on every writing host; the `*.tmp` staging hazard and the
   exact pathspec; worktree exports land in the main checkout.
3. **#3 lineage** — veto semantics with cites; absent-not-null; the two revert-free routes;
   the exact diagnostic (§3.2 item 7); our two text corrections owed (`decision-tools.ts:423`,
   Doc 2 `:50`); the W2 gating amendment (`lineage_unresolved` only for `superseded`, plus
   `archived_from === 'superseded'`).
4. **#4 conflicts** — the executed merge matrix; D2/D5 marked partially implemented on our side;
   the conflict-class contract (§3.3); why no attribute helps; the opt-in `-merge` recipe with
   its stated cost; untrack guidance guarded on Node ≥ 22.13 on every host; entity churn fix
   (J-6) as the one class that fires without human action.
5. **#4 fallback host** — 16/11/4 correction; "fix is Node" accepted; the remediation gaps we
   own (status dies, record drops decisions, repair/migrate cannot recreate) and their vehicles;
   the `[]` stopgap offered SECONDARY with the amnesia trade stated verbatim; primary advice is
   not to run Twining there against a sqlite-era store until Node is fixed; where to set
   `TWINING_DISABLED` (launching environment, not `settings.json` — upstream env routing to
   plugin MCP servers is broken, memory).
6. **The hidden loss they did not report** — §1.4, with the validator (2.16.1) as the
   stderr-free way to find affected files, and the interim scan (§3.2 item 5).
7. **What ships where** — the §4 table, plus the release-reach caveat: npx-rung hosts float to
   the new server automatically; pinned/bundled hosts need the plugin update in BOTH scopes.
8. **What we need from you** — §3.4.

### 3.2 Field actions now (written for a launchd-driven fleet; every command is executable without an MCP session)

1. **Classify hosts without starting Twining on the broken one:**
   ```sh
   node --version                                   # < 22.13 → the #4 host
   test -f .twining/decisions/index.json && echo index-present || echo index-MISSING
   test -d .twining/records && echo sqlite-era || echo files-era
   sh "$PLUGIN_ROOT/scripts/launch-server.sh" --probe   # runner=<pin|npx|bundled…> node=<v>
   ```
   On 2.16.0+ hosts `twining_status` adds `server_version`/`backend`/`backend_reason`; on the
   #4 host status itself errors with `ENOENT … decisions/index.json` — that error IS the
   diagnosis until 2.17.1.
2. **#4 host:** upgrade Node ≥ 22.13. Until then do not run Twining sessions there against a
   sqlite-era store: `export TWINING_DISABLED=true` in the environment that launches Claude Code
   (launchd `EnvironmentVariables` or the wrapper shell — NOT `settings.json`); the commit gate
   then needs `TWINING_DISABLED=true git commit …`. Secondary, only if the host must run:
   `mkdir -p .twining/decisions && echo '[]' > .twining/decisions/index.json` and add the path
   to `.git/info/exclude` — status/assemble/record work again and status shows the FELL-BACK
   warning, BUT reads are EMPTY beside hundreds of records (amnesia) and the agent proceeds
   blind. After Node is fixed: decisions it recorded on fallback live in legacy
   `decisions/*.json` — run `npx twining-mcp migrate` once on that checkout to sweep them (needs
   the index present); treat decisions attempted WITHOUT the index as lost unless
   `decision_errors` was empty.
3. **#3 transport — drain on EVERY writing host, from the MAIN checkout:**
   ```sh
   ROOT=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)   # the MAIN checkout, even from a linked worktree
   git -C "$ROOT" pull --ff-only || exit 1                    # non-ff, no upstream, or fetch failure: do not drain
   git -C "$ROOT" rev-parse -q --verify MERGE_HEAD >/dev/null && exit 1
   [ -z "$(git -C "$ROOT" diff --name-only --diff-filter=U -- .twining/records)" ] || exit 1
   git -C "$ROOT" add -- .twining/records ':(exclude).twining/records/*.tmp'
   for f in .twining/config.yml .twining/.gitignore; do if [ -f "$ROOT/$f" ]; then git -C "$ROOT" add -- "$f"; fi; done
   git -C "$ROOT" diff --cached --quiet || git -C "$ROOT" commit -qm 'twining: drain records mirror'
   git -C "$ROOT" push   # only on hosts that hold push credentials — see question #9 (c)
   ```
   Not `git add -A .twining` (re-tracks aggregates a fallback host recreated). A pull that
   moves HEAD is re-ingested within 5 s of the next tool call; `git fetch` alone changes nothing.
4. **Interim staleness check per host (until 2.17.0):**
   `git --no-optional-locks status --porcelain --untracked-files=all -- .twining/records | wc -l`
   (records no other host can see), `git rev-list --left-right --count HEAD...@{u}` (unpushed /
   unpulled), `stat .git/FETCH_HEAD` (last fetch). Never `git diff-index --quiet` (false positives
   after any mtime touch).
5. **Before any session on a host that received the bulk drain or a merge result, scan ALL kinds:**
   ```sh
   grep -rl '^<<<<<<<' .twining/records
   find .twining/records -type f -size 0
   find .twining/records -name '*.json' | while read -r f; do
     jq -e --arg id "$(basename "$f" .json)" '.id == $id' "$f" >/dev/null 2>&1 || echo "$f"; done
   ```
   At 2.16.0 each hit DELETES that ULID's sqlite row on the next ingest on that host while the
   file stays on disk. Repair from `git log -- <file>` and restart. 2.16.1 stops the deletion
   and ships this scan as `twining-mcp validate-records`.
6. **Tier-A rule for `.twining/**`, reclassified:** AUTO-SAFE = add/add of distinct ULID files
   under `records/**`. HUMAN = any CONFLICT under `records/**`, any modify/delete under
   `records/**`, and ANY conflict in `decisions/index.json`, `graph/*.json`,
   `agents/registry.json`, `handoffs/index.jsonl`, `blackboard.jsonl`, `config.yml`. Never
   `merge=union` any JSON. When evicting, never leave markers in the working tree:
   `git checkout --ours -- <path> && git add <path>` (marks resolved, keeps ours) or
   `git merge --abort` — a bare `checkout --ours` leaves the path UU and pins the drain's
   commit. If the pipeline cannot guarantee marker-free eviction, add
   `records/**/*.json -merge` to `.twining/.gitattributes` (keeps ours as valid JSON, flags UU on
   every same-record edit including the disjoint ones git would merge cleanly — your trade).
7. **`01M088JCGYRWPX8EYYQNG3G5DB`:**
   ```sh
   jq '{status, overridden_by, override_reason, superseded_by, supersedes, timestamp}' \
     .twining/records/decisions/01M088JCGYRWPX8EYYQNG3G5DB.json
   grep -l '"supersedes": "01M088JCGYRWPX8EYYQNG3G5DB"' .twining/records/decisions/*.json
   ```
   Zero hits → pure veto, nothing to repair. Hits → one-sided link: `twining_housekeeping({})`,
   confirm `superseded_backfill.items` names it, then `twining_housekeeping({execute:true})` with
   `promote_provisionals`/`archive` unset — read the preview's `graph_pruned` count first (execute
   also prunes relation-less entities and unlinks their mirror files; a `backfill_only` option
   ships in W2) — commit `.twining/` immediately and drain. If the veto was unintended, record a
   new decision with `supersedes: 01M088…`; there is no undo verb for overridden. Also grep host
   B's tool results for `supersedes_dangling`.
8. **Chassis store:** keep the aggregates tracked until EVERY host serving it is on Node ≥ 22.13;
   then `git rm --cached` those that are tracked (`decisions/index.json`, `graph/entities.json`,
   `graph/relations.json`, `agents/registry.json`, `blackboard.jsonl`, `handoffs/index.jsonl`).
   Leave the `merge=union` line.
9. **Five CLAUDE.md-cited IDs, per host:** in a ref (`git ls-tree -r HEAD --name-only --
   .twining/records/decisions | grep -c <id>`) AND a row in that host's db (Node ≥ 22.13:
   `node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; …"`; or `sqlite3`
   where installed). File present + row absent = that host ingested a corrupt copy.
10. **After every bulk drain, on every host:** `twining_housekeeping({})` preview → read
    `superseded_backfill` and `lifecycle_reverts`; commit `.twining/` before the next drain.

### 3.3 Conflict-class contract (goes into UPGRADE-v2 / TWINING-REFERENCE via J-7)

Grounded in the executed matrix. **Conservative wording until the semantic matrix test lands
(§4.2):** clean 3-way merges of disjoint-key same-record edits are textually valid JSON but are
NOT yet verified semantically consistent across all verb pairs (only override + link_commit was
executed) — treat them as HUMAN until we publish the matrix; the conservative rule costs the
field nothing they do not already do.

### 3.4 Verification questions (continue from #8)

- **#9** Per host: `node --version`; `launch-server.sh --probe` line (runner rung — decides
  whether 2.16.1/2.17.x reach it automatically); `server_version`/`backend`/`backend_reason`;
  store(s) served; tier-A runner?; drain runs here?; `tools.full_surface`/`tools.mode` per store;
  did the old-Node host ever record decisions in the window (`decision_errors` non-empty)?
- **#9 (c)** Why is the drain single-host — EMU credential policy (one licensed machine identity)
  or convenience? If credentials: which hosts can commit but not push? (Determines whether
  "drain on every host" is executable and whether J-3 must separate uncommitted from unpushed.)
- **#10** `01M088…`: the jq output and the reverse-grep hit list; if a hit, `git log
  --format='%h %ci %s' -- <both files>` on the recording host and whether that session's response
  carried `supersedes_dangling`; was the override issued with or without `new_decision`? Does any
  downstream tooling treat `superseded_by: None` as an error? Would you accept 2.17.0 emitting NO
  lineage flag for a claimant-less overridden record?
- **#11** Tier-A mechanics: any `-X` strategy or custom attributes? What does eviction leave in
  the working tree — markers, `--ours`, or an aborted merge? Does a Twining session ever run on
  that checkout before resolution?
- **#12** Conflict census (DD-12's primary input): every `.twining` conflict evicted in the
  window, by path class (`records/decisions`, `records/graph/entities`, `records/graph/relations`,
  `records/posts`, each aggregate) and, for `records/**`, overlapping-key vs disjoint-key. Did the
  3,145-file drain leave any file with markers, 0 bytes, or `id` ≠ stem (the §3.2.5 scan)?
- **#13** Server stderr counts and dates for `Skipping unparseable record file`,
  `unparseable skipped`, `HEAD moved — re-ingested`, `falling back to the file backend`,
  `ingest file-wins downgraded` — or, if stderr is unreachable from your automation, say so
  and run the 2.16.1 validator instead.
- **#14** drain-twining.sh: `git add -A .twining` or explicit paths? main checkout or worktree?
  which branch is each host's main checkout on? any sessions from linked worktrees or with
  `TWINING_PROJECT` across repos? Is npm / the plugin marketplace reachable from your network
  (decides whether the bundled rung is your effective pin)?
- **#15** For the five IDs: on host A, uncommitted / committed-unpushed / absent during the
  five days (`git log --diff-filter=A --format=%ci -- .twining/records/decisions/<id>.json`),
  and do they now exist as ROWS in every host's db?
- **#16** Fleet preference: an opt-in `storage.on_sqlite_unavailable: refuse` (pins `git commit`
  closed on that host until `TWINING_DISABLED=true`) vs a read-only records view (reads work,
  writes refused with a named code) vs today's loud-but-writing fallback? And: would a `Sync:`
  line in the assemble briefing be read by your agents, or should the empty-result caveat be a
  hard STOP marker in NEXT STEP?

### 3.5 Corrections we owe in our own artifacts

- `docs/field-responses/2026-08-23-wave2-verification-response.md:50` "superseded_by: null" →
  "absent" (dated erratum, append-only).
- `docs/field-responses/2026-08-23-wave2-verification-response.md:266` — the `lineage_unresolved`
  wording is amended by J-5 before it ships; erratum points at Doc 4.
- `docs/UPGRADE-v2.md:67` "immutable … conflict-free" — corrected by J-7.
- `docs/FOUNDATION-PLAN.md` D2 (`:28`) and D5 (`:34`) — dated PARTIAL annotations pointing at
  DD-12 (annotate, never overwrite — supersession discipline).
- `src/storage/sync/record-ingest.ts:5-20` header still claims conflict-free union merges —
  rewritten with 2.16.1.

---

## 4. Workstream B — release-train insertions

Each release gets its own TDD breakdown before code. Pre-tag adversarial review before every tag
(8 consecutive majors caught) is unchanged. All response fields additive and optional-spread. The
W2 / 2.17.1 split is **decided here**, not slid at tag time (maintainer critic: four slide
clauses under review pressure is how the false-positive history happened).

### 4.1 **2.16.1 / plugin 1.34.1** — "records-tree data safety" (point release; precedents v1.21.1, v1.24.1)

Honest cost: server bump + `scripts/bump-plugin-version.sh patch` (both version files + bundle
rebuild) + CHANGELOG + pre-tag review + field plugin update in both scopes. Justification: S-effort,
data-loss class, live field trigger (their eviction pipeline), and `main` carries no other
unreleased code. Dave rules go/no-go (§7.1).

- **J-1 ingest retention** (S): in `record-ingest.ts`, for EVERY file compute
  `stem = path.basename(filePath, '.json')`; `if (dbRows.has(stem)) fileIds.add(stem)` BEFORE
  parsing. Then: unparseable / non-string `id` → `stats.skipped++` + the existing console.error
  (the `:244` branch gains both); parseable with `record.id !== stem` → `skipped++`, warn
  "id/filename mismatch", do NOT insert/update under the body id. Deliberate removals still
  propagate (absence → delete; `dismiss`/`removeEntities` unlink the file). No ULID validator
  needed (if one is wanted, re-export `isValid` from the `ulid` dependency rather than a regex).
  Tests: seed rows for stem AND a mismatched body id; assert `deleted===0`, no stray row,
  `skipped` counts; 0-byte; conflict markers; repaired file → `updated===1`, seq unchanged;
  rewrite `test/record-sync.test.ts:539-553` to seed a row. The two whole-object `toEqual`
  assertions on `IngestStats` (`:269-276`, `:522-529`) are untouched because J-1 adds no field.
  Rewrite the module header (`:5-20`). **Decision record (DD-8 evidence fold, not a code
  comment):** "an unreadable or mis-keyed file is not a file and cannot win; DD-8 precedence for
  parseable files is unchanged" — see §6.6.
- **`records/**/*.tmp` in `GITIGNORE_ENTRIES`** (`init.ts:20-33`; reconciled additively on next
  boot) — closes the staged-temp-file hazard.
- **argv guard** (S): in `src/index.ts:28-31`, a non-flag `argv[2]` that is not a known
  subcommand prints usage and exits 2 instead of starting a stdio server. Test against every
  invocation shape in `plugin/scripts/launch-server.sh` (all pass flags, never a positional) —
  decision criterion §6.3.
- **`twining-mcp validate-records [--project <dir>] [--json]`** (S; the field-operator critic's
  one "wire it in next week" item): read-only sibling of `migrate` (dynamic import; root via
  `resolveProjectRoot` exactly as `cli.ts:20-24` so the worktree redirect applies; every git op
  `git -C <root>`). Checks, all kinds under `records/**`: parses; `id` == filename stem; no
  conflict markers; non-zero size; plus `git ls-files` shows no `*.tmp`, no `twining.db*`, and —
  on a sqlite-era store — lists which frozen aggregates are still tracked (informational, with
  the Node guard sentence). Exit 0 clean / 1 findings / 2 usage; machine-readable JSON. Never
  writes. Runs under `TWINING_DISABLED` (dispatch precedes the exit at `index.ts:34`). Dave may
  strike this from 2.16.1 to keep the point release minimal (§7.1) — then it ships in W2.

### 4.2 **W2 / 2.17.0** riders (read-path honesty — exact thematic fit)

- **J-3 sync-state disclosure** (M): `src/utils/git-sync-state.ts` mirroring `safeGit`
  (`src/utils/provenance.ts:32-44`; `execFileSync`, timeout 1500, stderr ignored, whole probe
  try/catch → null). Calls: combined `git rev-parse HEAD --abbrev-ref HEAD
  --is-shallow-repository --git-common-dir` (order pinned by a unit test); `rev-parse
  --abbrev-ref --symbolic-full-name @{u}`; `rev-parse @{u}` (cache key); `rev-list --left-right
  --count HEAD...@{u}`; `git --no-optional-locks status --porcelain --untracked-files=all --
  .twining/records` (XY parse: `??` untracked vs modified); `log -1 --format=%cI --
  .twining/records`; `check-ignore -q .twining/records`; `fs.stat(<common-dir>/FETCH_HEAD)`.
  Shape (all nullable, additive): `{is_git, branch, detached, upstream, ahead, behind,
  uncommitted_records, untracked_records, records_tracked, export_records, last_records_commit,
  last_fetch_at, last_fetch_age_hours, shallow, probed_at}`. Cache: module-level TTL map keyed by
  projectRoot (5 s), recompute when HEAD sha, upstream sha, or FETCH_HEAD mtime changes — shared
  by all backends; invoked ONLY from `twining_status` and the assemble path, never the dispatch
  wrapper. Gating: `export_records:false` → `sync:{export_records:false}` only; `records_tracked
  false` → counts null + warning "records tree is not tracked — nothing here is replicated";
  worktree-local store with no upstream → "worktree branch — sync judged on the main checkout",
  not a warning; FETCH_HEAD null with HEAD==@{u} → unknown, no warning. Surfaces: `twining_status`
  result (`lifecycle-tools.ts:218-238`) + warnings after the S0 block (`:121-132`) ONLY for
  actionable states, with uncommitted and unpushed reported SEPARATELY (commit-only hosts must
  not be nagged to push); assemble quickRef (`context-assembler.ts:846-848`) ONE line, rendered
  only when actionable; the `:896` empty sentence gains an unconditional short suffix: "this
  host reads only what has been committed and pulled — records written elsewhere since your
  last pull (Xh ago) are invisible." `sync.probe: false` config honours the read-only audit
  recipe. Tests: parser vs captured porcelain; error strings ("no upstream configured", "not a
  git repository", detached "HEAD"); index mtime unchanged after the probe; the
  `diff-index` false-positive pinned as a never-regress test; push changes ahead with HEAD
  unchanged. Tool descriptions state the block describes the STORE's repo (main checkout after
  the worktree redirect), not the caller's branch.
- **J-5a/b lineage gating + text** (S; amends the committed B1 bundle before it is written):
  `lineage_unresolved := (status==='superseded' || (status==='archived' && archived_from===
  'superseded')) && no forward pointer && no reverse claimant`; overridden WITH a claimant →
  `superseded_by_inferred` (parity with backfill, which preserves status); overridden WITHOUT
  a claimant → no lineage flag (or `lineage_terminal:'vetoed'`); project
  `overridden_by`/`override_reason` wherever `superseded_by` is projected. T10 (pure veto → no
  flag), T11 (overridden + claimant → inferred), T12 (archived-from-superseded) join T1–T9.
  Shorten `decision-tools.ts:423` (do not append): "superseded records carry superseded_by;
  overridden records terminate the chain by design (reversal without replacement) — read
  override_reason." Drop the "likely origin" attribution unless #9 confirms full_surface.
- **J-6 entity no-op upsert byte-stability** (S, own commit, changelogged: `updated_at` now
  means "last property change"): `sqlite-stores.ts` addEntity — `assertWritable` FIRST (keeps
  FORMAT_VERSION_TOO_NEW semantics), load existing, merge, `if stableStringify(merged) ===
  stableStringify(existing.properties) return existing` (no UPDATE, no bump); parity in
  `src/storage/graph-store.ts:76-93`; `ExportingGraphStore.addEntity` skips the mirror rewrite
  when bytes are identical (mandatory once J-3 runs `git status` — every auto-populate would
  otherwise make the probe cold). Rename the sqlite test titled "bumping updated_at"; add a
  byte-stability test on the mirror file. Grep: no runtime reader of `updated_at` outside the
  stores/export/types (dashboard tests reference it — confirm at TDD time).
- **housekeeping `backfill_only`** (S): run step 9 without graph prune / metrics rotate / dedupe,
  so the field's one-pointer repair is not a destructive graph write.
- **Semantic merge-matrix test** (S): two exporters + real `git merge` over verb pairs
  (override+link_commit, promote+amend, archive_stale+link_commit, reconsider+amend, resolve+
  resolve) asserting valid JSON AND semantic consistency where git merges cleanly — the evidence
  that lets J-7's AUTO-SAFE class widen beyond add/add.
- (if struck from 2.16.1) `validate-records`.

### 4.3 **2.17.1** (pre-decided split; W2 stays digestible)

- **J-2 fallback diagnosability** (M, not S): (a) `lifecycle-tools.ts:60` — compute
  `index: DecisionIndexEntry[] | null` once in try/catch and branch at ALL FOUR use sites
  (`:60-65`, `:77-80`, `:158-163`); on failure counts → null, `decision_index_error`, and a
  warning FIRST ("Decision index unreadable — every decision-touching tool will fail until fixed;
  if backend_reason is fallback the fix is Node >= 22.13"), then the S0 block renders
  `backend`/`backend_reason`/`records_unread` on the same response; update the description at
  `:47`; the catch at `:239-244` gains `if (e instanceof TwiningError) return toolError(e.message,
  e.code)`. (b) ENOENT translation implemented INSIDE `DecisionStore` (constructor option
  `unservableReason`) or via a Proxy that forwards unknown members — never an interface-only
  wrapper, which would hide the duck-typed `repairIndexDesync` (`housekeeping.ts:590-602`,
  `lifecycle-tools.ts:137-143`) and regress the one working recovery path. Match
  `err.code === 'ENOENT' && err.path?.endsWith('decisions/index.json')`; never intercept
  `FORMAT_VERSION_TOO_NEW`. Code `STORE_UNSERVABLE`; message is an explicit AGENT DIRECTIVE in
  the NEXT-STEP style: "STOP — this store is sqlite-era (.twining/records/ present) and this host
  has no node:sqlite (Node >= 22.13 required). Decision data is present but cannot be served
  here. Do not record decisions or commit on this host; escalate." State plainly in Doc 4 that
  this does not stop an unattended agent by itself — a hook-readable refusal sentinel is
  DD-6/DD-11. (c) fallback stderr line names `decisions/index.json` and whether it exists.
  (d) `twining_record` gains `decisions_requested`/`decisions_persisted` and `degraded:true`
  when persisted==0 && requested>0 — counting only errors from the decide() catch
  (`record-tools.ts:478-484`), not the full_surface config refusal at `:444-449`
  (`degraded_reason: 'store'|'config'`); Gate 2 still passes (standing principle). (e)
  housekeeping `decision_pass_errors`, search_decisions `store_error:true`. (f) `migrate/cli.ts:67-69`
  prints the remedy on ENOENT for the index. (g) assemble quickRef `Backend: files (FELL BACK —
  .twining/records/ unread)` via a `setServerIdentity()` setter (not a 9th ctor param — six test
  constructions). (h) dashboard status route parity (`src/dashboard/api-routes.ts:366-367`,
  `:383-386` — another reads-as-healthy surface). Tests: fallback fixture → status OK with the
  warning first; chassis fixture (index present, records present, sqlite mocked unavailable)
  still exposes `repairIndexDesync` and still emits the desync warning; control unchanged.
- **J-1b unreadable-files blackboard warning** (S): `stats.unreadable_retained` + ONE deduped
  warning per ingest per kind (reuse the lifecycle_reverts txn-dedupe at `record-ingest.ts:300-388`,
  `isReadOnly` guard at `:313`), capped at 10 filenames. Update BOTH whole-object `toEqual`
  literals in `test/record-sync.test.ts` in the same commit.
- **J-5c override read-back** (S): read back after decide() when `newDecision` is given (or
  return pre/post status); add the missing assertion that the old record ends `superseded` +
  `superseded_by` with `overridden_by`/`override_reason` retained; changelog the echoed status
  change (`overridden:true` unchanged).
- **`pointer_loss` ingest counter** (S): db had `superseded_by`, file lacks it, same rank — no
  precedence change; DD-8 boundary in the commit. Update the `toEqual` literals.

### 4.4 **W4 / 2.19.0** riders

- **J-4 `twining-mcp sync-status`** (S once J-3's module exists): print-only, reuses the module;
  first item to drop if W4 crowds.
- **J-8 migrate untrack guidance** (S): `cli.ts:122-128` gains a forward-only block, printed
  unconditionally (migrate never spawns git): "Optional, ONLY once every host serving this store
  runs Node >= 22.13: git rm --cached <those of decisions/index.json, graph/entities.json,
  graph/relations.json, agents/registry.json, blackboard.jsonl, handoffs/index.jsonl that are
  tracked> — frozen v1 aggregates the sqlite backend never writes; a host that falls back to the
  files backend still needs decisions/index.json." The already-scheduled MIGRATED-README marker
  (plan `:166-168`) carries the same sentence; `UPGRADE-v2.md:37` mirrors it. Never added to
  `GITIGNORE_ENTRIES`.
- Tool-description byte measurement added to `scripts/measure-plugin-tokens.sh` (a `node -e` over
  `registerTool` descriptions) — closes the gate gap §1.9 exposed; baseline recorded before the
  first J-item description edit.

### 4.5 **Docs now** (ride the field-response commit; no release)

**J-7:** README after `:344` + UPGRADE-v2 after `:67`: records exist only on the writing host
until `.twining/records` is committed AND pushed; another host sees them after a pull that moves
HEAD (re-ingest within 5 s) or a restart; `git fetch` alone changes nothing; until then
assemble/why return EMPTY, not an error; the server never commits or pushes; in a linked worktree
exports land in the MAIN checkout's tree. `UPGRADE-v2.md:67` "immutable … conflict-free" →
"record CREATES are conflict-free by filename; MUTATIONS rewrite the same file and can conflict
when two hosts mutate the same record between syncs." FOUNDATION-PLAN status table + dated
annotations on D2 and D5 pointing at DD-12. "Conflict classes in .twining" section = §3.3 with
the executed matrix, the never-union rule, the `-merge` opt-in recipe and its cost, the drain
pathspec with `:(exclude).twining/records/*.tmp`. Docs-site spec page "Worktrees, monorepos, multi-machine"
(`docs/superpowers/specs/2026-09-01-docs-site-design.md:132`) absorbs this as a unit.

### 4.6 Rejected (recorded so they are not re-proposed)

| Id | Rejected | Why |
|---|---|---|
| R-1 | Tolerant index read (`getIndex()` → `[]` when absent) | Converts a LOUD failure on 16 tools into a quiet EMPTY — the fail-toward-quiet class the read audit indicted and the S0 guard exists to prevent; **EXECUTED** control produced "No active decisions" beside hundreds of records. J-2's named error keeps the signal loud and carries the fix |
| R-2 | MERGE_HEAD probe skipping ingest mid-merge | No named failure survives J-1; eviction leaves markers long after MERGE_HEAD is gone; a long-lived conflicted tree would freeze the db |
| R-3 | `records/**/*.json -merge` as a Twining default | **EXECUTED**: regresses every legitimately clean disjoint-key merge to a human conflict, to buy protection J-1 provides at ingest. Opt-in recipe only |
| R-4 | `merge=union` on records/aggregates; custom JSON merge driver | **EXECUTED** corruption / silent loss; drivers are per-host unversioned config needing DD-12's undecidable rules |
| R-5 | Auto-stage records in the PreToolUse commit hook | **EXECUTED** exit 128 from a worktree; 5 s timeout; welds records into the commit they describe |
| R-6 | Server-side periodic commit | Races the agent's index; double-commit with two servers; any committing path is DD-13 |
| R-7 | Recreate `index.json` at boot / in the store constructor | Contradicts `init.ts:68-72`; writes into a deliberately untracked tree; same amnesia as R-1 |
| R-8 | `twining_record` toolError when all decisions fail | Blocks the commit gate on a host whose blackboard writes are fine; refusal semantics are DD-11 |
| R-9 | Fetch inside the sync probe | Network + credentials inside a tool call; assemble hangs on a dead remote |
| R-10 | Aggregates in `GITIGNORE_ENTRIES` | gitignore cannot untrack; would hide the fallback host's divergent writes; reconcile is backend-agnostic |
| R-11 | `overridden_by_decision` forward link | A veto has nothing to point at; override-with-replacement already ends `superseded` |
| R-12 | Full read/write records backend | L effort for a host class `engines >=22.13` disowns; no multi-process arbiter without a db; files backend scheduled for v3 removal. Read-only variant is DD-6 |
| R-13 | Refuse to serve a v2 store on fallback by default | Violates the owner-approved warn-and-fallback decision (`01KWT0FEW6ETY4GD1G3C273Z3Y`); opt-in form is DD-6/DD-11 |
| R-14 | Publishing a deterministic-resolver rule table now | Partial by construction (no mutation timestamp; rank-2 ties; provisional/active after reconsider) — invites widening tier-A on rules Twining cannot stand behind. Input to DD-12 |

### 4.7 Design decisions (named, scheduled, never patched inside waves)

- **DD-12 — mutation & conflict model for `records/**`**: status quo (in-place per-ULID rewrite +
  documented classes + ingest resilience; recommended default) vs event-sourced mutations per D2
  (config version 3; redefines DD-8's "file"; touches export/ingest/sync/migrate/backfill/
  lifecycle_reverts) vs revision stamp + resolver (undecidable ties). Inputs: #12 census after
  J-7 has been in force one drain cycle; whether J-6 removes the entity class; DD-8 evidence
  fold. Own design session after W4. Panel disagreement preserved: L2 holds event-sourcing is the
  only true fix; L3 holds status quo.
- **DD-13 — transport boundary**: does Twining ever commit/push for the operator? Proposed line:
  "the server PROCESS never commits; a CLI commits only on an explicit flag." Design space bounded
  by V6: temp index (`GIT_INDEX_FILE`) so the agent's staging area is never swept in; CAS
  `update-ref`; refuse on detached/MERGE_HEAD/unmerged/validator failure; `git -C <store-root>`;
  push needs credentials Twining does not hold; the receiving side still needs a HEAD-moving
  pull. Inputs: #9 (c), #14; whether J-3 + drain-on-every-host closes the window over one cycle.
  Earliest W5+. J-4 is the natural home if ruled yes.
- **DD-6 / DD-11 (joint) — fallback policy for v2 stores on a host without node:sqlite**:
  read-only records view (M; 5,191 files / 3.2 MB → 344 ms cold; third read model) vs opt-in
  `storage.on_sqlite_unavailable: files|refuse` (pins Gate 2 closed — commit denial;
  `pre-commit-hook.sh:106-130` fails open only when `.last-record` is absent) vs write-seam
  index creation (makes the fallback host a WRITER of divergent legacy files on a store whose
  config says sqlite) vs status quo + J-2. Hidden cost of any refuse/hook protocol: a five-file
  mirrored hook edit + plugin bump. Input: #16. Conservative default until ruled: J-2 honesty
  only.

---

## 5. Sequencing

1. **Now:** Dave reviews this plan; rulings §7.
2. **Docs + Doc 4 batch:** J-7 docs, Doc 4, errata (§3.5), store records, memory — one commit;
   send is Dave's action. Doc 4 rides with the still-pending A-batch send or the next one
   (§7.5). Doc 4 tells the field that 2.16.1 is imminent so the docs-only correction is not read
   as "not fixing".
3. **2.16.1 breakdown → TDD → pre-tag review → tag + plugin 1.34.1** (both scopes updated here).
   F3 delta note.
4. **W2 breakdown** (existing scope + §4.2) → 2.17.0 → **2.17.1** (§4.3) → **W3** (unchanged) →
   **W4** (+§4.4) → **W5**.
5. DD-12 / DD-13 / DD-6+11 design sessions after W4, or earlier if #12/#16 arrive with force.

---

## 6. Plan discipline

### 6.1 Assumptions (unconfirmed by Dave — challenge at review)

- **A1** Only items #3 and #4 of the field's 2026-09-04 document are addressed to us; the rest
  (§1, §2 — their §4.2.2, PRE-9, probe 2, `classify-tier.sh`, ALLGREEN, #66, #134) belongs to
  their own design repo and is cited only as context.
- **A2** Both field stores are sqlite-era (`records/` present — the 3,145-file drain implies
  it). The chassis store's backend is unknown (asked, #9). If it is on the FILES backend, the
  aggregate conflicts are live writes and the fix for #4 becomes "migrate", changing §3.2.8.
- **A3** An old-Node host exists or existed in their fleet (their ENOENT statement reads as
  measured). If hypothetical, J-2 keeps its vehicle and loses urgency; nothing else changes.
- **A4** The read-audit release train (W2 → W3 → W4 → W5) remains the train of record; the
  A-batch (F2 + Doc 2 + Doc 3) is still unsent; send mechanics unchanged (commit to main, Dave
  pastes the wrapper on the field machine).
- **A5** The field runs the plugin; their launcher rung is unknown (#9). Under rung 1 (npx)
  the server floats to 2.16.1 on the next session; under rung 0b/4 it does not until they act.
- **A6** Their drain uses `git add` of records paths, from the main checkout (asked, #14). If it
  uses `-A .twining` from a worktree, §3.2.3 is the correction they need most.
- **A7** A 2.x point release is acceptable to Dave at its true cost (§4.1). No 2.x precedent
  exists; v1.21.1/v1.24.1 are the precedents.

### 6.2 What we don't know that would change the approach

- Why the drain is single-host (#9 (c)). If EMU credentials confine push to one machine, "drain on
  every host" is not executable; the alternative is per-host commit + the credentialed host
  pulling from writers (or per-host branches on an internal remote), and J-3 must never nag a
  commit-only host to push.
- What eviction leaves in the working tree (#11) — decides whether V2's deletion actually fired
  on host B, and whether R-2 should be reconsidered.
- The conflict census (#12) — the DD-12 input; if overlapping-key lifecycle conflicts are rare,
  status quo wins by default.
- Whether any host still runs old Node (#9) — J-2's urgency only.
- Whether the field's agents read the assemble `Sync:` line at all (#16) — decides one line vs a
  STOP marker.

### 6.3 Decision points we will hit without Dave, with criteria

- **2.16.1 scope:** validator in unless Dave strikes it (§7.1). Criterion at breakdown time: if
  the validator's tests exceed the retention fix's tests in count, it moves to W2 — the point
  release must stay recognisably a data-safety fix.
- **argv guard safety:** ship only if every invocation in `launch-server.sh` and the README
  passes flags, never a positional (`grep -n 'twining-mcp\|server.bundle\|dist/index.js'`);
  otherwise restrict the guard to a known-bad list (`drain`, `sync-status`, `validate-records`,
  `help`).
- **J-3 assemble caveat wording:** unconditional short suffix on every empty result (correctness
  critic) unless the W2 breakdown measures it at > 40 tokens; then actionable-only with the
  `expected_drain_hours` config as the fallback.
- **J-7 AUTO-SAFE class:** add/add only until the semantic matrix test (§4.2) is green; then
  widen to "clean 3-way merges of the verified verb pairs" by name — never "any clean merge".
- **W2 crowding:** the split in §4.3 is already decided; nothing further slides. If W2 itself
  overflows, the lineage gating (J-5a) and the empty-result caveat are the two items that must
  not move (both correct work already committed to the field).
- **Any unanticipated point:** lower-risk action, decision recorded at the moment with rationale
  (standing instruction).

### 6.4 Failure modes and recovery

| Risk | Recovery |
|---|---|
| J-3 probe holds `index.lock` against the field's drain or the agent's `git add` | `--no-optional-locks` (EXECUTED safe) + a test asserting `.git/index` mtime unchanged; probe off the dispatch path |
| J-1 retention keeps a stale row for a deliberately corrupted file | Bounded: absence still deletes; a repaired file applies file-wins normally; the J-1b warning names the file |
| 2.16.1 never reaches a pinned/bundled fleet | Doc 4 states the reach rule per rung; §3.2.1 asks for the probe line; plugin update in both scopes is the field's step |
| Tool-description growth blows the field's MCP budget unmeasured | §4.4 measurement lands before the first description edit; every new field optional-spread; `Sync:` line actionable-only |
| J-2 translation hides `repairIndexDesync` | Subclass/Proxy, plus the chassis-fixture test in §4.3 |
| Field reads the docs-only J-7 as "not fixing" | Doc 4 pairs it with 2.16.1's date-free "imminent" and the §4 table |
| A field report from a stale-pin host contradicts Doc 4 | Ask for the probe line first (their own §1 advice, restated) |
| Verify agents mutate the live tree during the 2.16.1 review | Standing rule: `isolation: worktree` + `git status` after every workflow (held this session — tree clean) |
| Machine-sleep kills workflow agents mid-run | Journal-cached resume; per-release breakdowns are fresh sessions |

### 6.5 Strongest alternative, and why not

**Operational-only response:** ship J-1 (retention) and J-7 (docs) and nothing else, on the
grounds that both field failures have operational root causes the field already accepts — #3 is a
one-host drain against a design whose transport is git (D1, working as intended); #4 is an
operator untracking a file the files fallback needs on an EOL Node host the project disowns
(`package.json:50-52`) — and that additive warnings land in status responses the field
demonstrably does not read (they missed the stderr fallback line and the `-N unparseable`
counts). Cheaper, forks nothing, spends no design decisions. The plan beats it on four verified,
S-sized points each closing a gap the alternative leaves open: (1) the fallback host cannot
diagnose itself in-band — status dies before it reaches its own warning, and Gate 2 keeps passing
while dropping decisions (EXECUTED); (2) Gate 1 cannot distinguish "absent" from "not yet here",
so the operational fix is unfalsifiable from inside Twining without J-3; (3) entity `updated_at`
churn conflicts fire every drain window without human action — ten lines remove the
highest-frequency magnet; (4) the W2 lineage item as already committed to the field would flag
every veto in 2.17.0 — J-5 is a correction to work in flight, not new scope.

**Structural-first** (implement DD-12 event sourcing and a committing drain now): rejected —
neither field failure is caused by in-place rewrites; it re-opens DD-8 by construction; it forks
the release train. Survives as DD-12/DD-13 with the field's census as the deciding input.

### 6.6 Decisions to record in the store at execution time

- Ingest retention as a narrow DD-8 exception ("unreadable or mis-keyed ≠ absent"; parseable
  precedence unchanged) — evidence fold, not a patch.
- 2.16.1 point release at true cost (plugin 1.34.1), precedents named.
- W2 / 2.17.1 split decided at plan time.
- `--no-optional-locks` probe, off the dispatch path, TTL-cached by projectRoot.
- Tolerant index read rejected (R-1) with the executed control as evidence.
- `-merge` attribute opt-in only (R-3) with the executed matrix.
- Records validator in 2.16.1 (or W2 if struck) — field-operator ground.
- DD-12, DD-13, DD-6/DD-11 joint question minted.
- Conservative AUTO-SAFE wording until the semantic matrix test.

---

## 7. Rulings requested from Dave

1. **2.16.1 / plugin 1.34.1 go/no-go** at its true cost (both version files, bundle rebuild,
   pre-tag review, field plugin update in both scopes). Sub-ruling: validator IN (recommended —
   the one thing the field can wire in next week) or OUT (minimal point release).
2. **W2 / 2.17.1 split** as pre-decided in §4.2–4.3 (recommended), or fold 2.17.1 into W2.
3. **DD-13 boundary** — open the design with the line "server process never commits; CLI commits
   only on an explicit flag" (recommended: opens, does not build), or close it (disclosure-only,
   drain stays the field's script).
4. **DD-6/DD-11 joint question** — route the fallback-policy options (refuse knob / read-only
   records view) into the existing DD-6/DD-11 design session (recommended), or mint a separate
   DD.
5. **Doc 4 send** — ride with the still-pending A-batch (one send, longer read) or a separate
   send after the A-batch lands (recommended: the A-batch is time-sensitive and already gated;
   Doc 4's §3.2 actions are urgent enough to justify a second send within days).
6. **J-7 AUTO-SAFE wording** conservative (add/add only until the matrix test) — recommended —
   or publish "clean disjoint-key merges are safe" on the one executed pair.

---

## 8. Provenance and artifacts

- Workflow `wf_daceaa5d-eee` (13 agents; journal at
  `~/.claude/projects/-Users-dave-code-twining-mcp/0e4d0a1f-…/subagents/workflows/wf_daceaa5d-eee/journal.jsonl`);
  full result in the session task output; per-lane/lens/judge/critique JSON split into the session
  scratchpad.
- Preserved scratch repro tests (worktrees removed after copying):
  `scratchpad/repro-tests/scratch-lane-v1-absent-index{,-2}.test.ts` (V1 fallback matrix,
  two-clone untrack experiment) and `scratch-v2-unparseable-ingest.test.ts` (V2 deletion,
  4 cases) — the 2.16.1 breakdown re-derives its tests from these, not from prose. V3 timing
  scripts (`time_git*.py`), V5 git experiments (`gitexp*.sh`), judge's `nomerge-attr.sh`, and
  the critics' `lockprobe*.sh` / `gitcorr.sh` also live in the scratchpad.
- Blackboard posts this session: D2-vs-implementation finding (`src/storage/sync/`); ingest
  row-deletion warning (`src/storage/sync/record-ingest.ts`).
- Live tree verified clean after the workflow (only this session's `.twining/records/posts/`
  files untracked).
