# Response: 2026-09-04 report §3–§4 — cross-host sync, `.twining` merge conflicts, the old-Node fallback

**STATUS: LIVE — dispositions final; server 2.16.1 / plugin 1.34.1 is the next release and
carries the ingest fix and the records validator; the rest is slotted into W2 (2.17.0), a
pre-decided 2.17.1, and W4 (2.19.0); three design decisions opened, none built.**
Authored 2026-09-05 by the Twining project in response to §3 and §4 of your 2026-09-04 report.
Verdicts are against HEAD `d649ec4` = 2.16.0 / plugin 1.34.0. Every load-bearing claim carries a
`file:line`; **EXECUTED** marks claims we reproduced by running code or git in isolated
worktrees, not only by reading. Corrections below cut both ways — three of the largest are
corrections to our own docs and to work we had already promised you. Dates are absent for
anything unshipped.

**How to read this:** §1 is the one finding that reframes both items — you saw two different
failures and read them as one. §2 answers §3 (transport). §3 answers the "one-sided
supersession" record. §4 answers §4 (merge conflicts and `.gitattributes`). §5 answers the
old-Node fallback. §6 is a loss you did not report. §7 is what ships where. §8 is what we need
from you. Doc 2 ended at #8; new verification questions start at **#9**.

| Your item | Verdict | Vehicle |
|---|---|---|
| §3 decisions do not cross hosts until commit + pull | Confirmed **as designed** (git is the transport — a recorded, high-confidence decision). The silence is our defect: Gate 1 cannot tell "absent" from "not yet here" | Disclosure in W2 (§7); docs corrected now; the drain on every writing host is yours |
| §3 five decision IDs in no ref for ~5 days | Undetectable by Twining at HEAD; confirms the gap | same |
| §3 `01M088…` "one-sided supersession-link shape" | Not a defect class: it is the designed shape of a veto unless another record's `supersedes` names it; diagnostic in §3; two of our own texts corrected; the W2 lineage flag we promised you is amended before it ships | Doc 2 errata + W2 |
| §4 five aggregates with no merge strategy | Reframed: no textual strategy is safe (**EXECUTED**); frozen aggregates conflict only via a fallback writer; the real sqlite-era conflict class is same-record mutation, which your table does not list — because our own UPGRADE-v2 said records were conflict-free | Docs corrected now; W2 entity fix; W4 migrate guidance |
| §4 `.gitattributes` incomplete | Refuted: nothing is worth adding by default; `-merge` offered as an opt-in with its cost stated | docs now |
| §4 untrack → old-Node "every tool call fails with ENOENT" | Partially confirmed (16 fail / 11 work / 4 silently degraded); "the fix is Node" accepted as root cause; the remediation gaps are ours and named | 2.16.1 validator + CLI guard; 2.17.1 fallback diagnosability; DD-6/DD-11 |
| (found by us) ingest deletes rows for unreadable record files | New defect, live at 2.16.0, produced by your evict-conflicted pipeline by construction | **2.16.1** |

---

## 1. Two failures, not one

Your report attributes host B's "nothing governs this" and the old-Node host's ENOENT to the
same mechanism and implies one fix. They are different shapes, distinguishable today by one bit.

- **Host B (transport lag)** is a genuinely EMPTY sqlite read. The records host A wrote had not
  been committed, pushed, and pulled onto B. `twining_assemble` renders "No prior context
  constraints — proceed with your task." (`src/engine/context-assembler.ts:896`) and
  `twining_why` reports `total_in_scope: 0` — both honest about B's database, both silent about
  replication. No error flag.
- **The old-Node host (fallback)** is a LOUD `INTERNAL_ERROR` with the message
  `ENOENT … decisions/index.json` on every decision-touching tool — including
  `twining_assemble` and `twining_status`. **EXECUTED** (41 calls against a simulated fallback
  host — `sqliteAvailable()` mocked false, `storage.backend: sqlite`, a populated `records/`
  tree, no `decisions/index.json`):

| Result | Tools |
|---|---|
| FAIL `ENOENT … open decisions/index.json` | status, assemble, why, summarize, what_changed, recent (even without `entry_types` — `src/tools/blackboard-tools.ts:17-19`), decide, trace, commits, triage, verify, export |
| FAIL `ENOENT … lstat decisions/index.json` (lock on a missing file — `src/storage/decision-store.ts:129/175/330`: `updateStatus`, `amendMetadata`, `linkCommit`) | link_commit, amend, reconsider, override |
| WORK normally — and WRITE divergent legacy files | post, read, query, resolve, dismiss, record (summary only), add_entity, graph_query, neighbors, agents, register |
| OK but silently degraded | **record WITH decisions** — status post written, `.last-record` sentinel advanced, decision NOT persisted, only `decision_errors` says so (`src/tools/record-tools.ts:478-484`); search_decisions — empty with `fallback_mode: true`; housekeeping({}) — fully green (the decision-index reads at `src/engine/housekeeping.ts:302` and `:512` are swallowed by the catches at `:331-333` and `:544-546`); promote on an active target |

So "every tool call fails with ENOENT" is an overstatement in both directions: eleven tools work
and four pass while broken. The worst of those is Gate 2: a session on that host **passes the
commit gate while losing every decision it tried to record.**

Upgrading Node fixes the second shape only. **EXECUTED** control: give the fallback host an empty
`decisions/index.json` (`[]`) and `twining_assemble` renders the same "No active decisions for
this scope." line an empty sqlite read produces (source-read; host B's NEXT STEP line is
`:896`) — so restoring the file converts the loud failure into the
silent one.

**Classify hosts without starting Twining on the broken one** (your automation can run this;
no MCP session needed):

```sh
node --version                                                    # < 22.13 → the fallback host
test -f .twining/decisions/index.json && echo index-present || echo index-MISSING
test -d .twining/records && echo sqlite-era || echo files-era
PLUGIN_ROOT=$(dirname "$(find ~/.claude/plugins -path '*twining*/scripts/launch-server.sh' | head -1)")/..   # whichever scope is active
sh "$PLUGIN_ROOT/scripts/launch-server.sh" --probe                # runner=<pin|npx|bundled|…> node=<v>
```

On 2.16.0+ hosts `twining_status` also reports `server_version`, `backend`, `backend_reason`;
on the fallback host status itself errors — that error IS the diagnosis until 2.17.1 (§5).

---

## 2. §3 — transport: designed, undetectable at HEAD, and undocumented by us

### 2.1 What is by design

Git is the replication transport and `twining.db` is a gitignored derived cache
(FOUNDATION-PLAN D1; recorded decision, high confidence). Records reach another host only
through the `.twining/records/` mirror: ingested at server start
(`src/storage/backend-factory.ts:120-142`) and, mid-session, when `git rev-parse HEAD` changes
(`src/storage/sync/sync-manager.ts:33`, `:64-71`, `:128-140`; TTL 5 s). `git fetch` does not
move HEAD and changes nothing. A pull that moves HEAD is picked up within 5 s of the next tool
call — no restart needed. The server never commits or pushes. Your one-host hourly drain
therefore produces exactly the five-day window you measured: nothing on host A's side moves
bytes until that launchd job runs, and nothing on host B's side can see that they have not.

### 2.2 What is our defect

Nothing at HEAD can say "this host holds records no other host has" or "this host has not
fetched in N hours." No code path commits, pushes, or inspects the working tree for unshared
records (grep of `src/`; the only staleness signal is `records_unread`, and it covers the
sqlite→files fallback shape only). No shipped sentence says decisions are invisible elsewhere
until commit + push + pull, or that the gap presents as EMPTY rather than an error
(`README.md:344` and `docs/UPGRADE-v2.md:67` state the model, never the consequence; the only
text naming pull-as-arrival is a 1.22.0 changelog line). Both are corrected as of this commit:
README "How It Works" and a new UPGRADE-v2 section "Working across machines."

Two related deviations from FOUNDATION-PLAN you may have relied on: D5 says exports land in
the originating worktree; they land in the **main checkout's** tree
(`src/storage/sync/record-export.ts:63-65` + `src/utils/project-root.ts:86-91`). That is what
makes a single per-repo drain feasible — and it is where your drain must look. Annotated in the
plan, not rewritten.

### 2.3 What ships (W2 / 2.17.0) — and what it will not show

A local-only `sync` block on `twining_status` and one line in the assemble briefing, from
`git --no-optional-locks status --porcelain --untracked-files=all -- .twining/records`, `rev-list --left-right --count
HEAD...@{u}`, and the mtime of `FETCH_HEAD`: unshared record files (uncommitted and untracked,
counted separately from unpushed commits so a host that can commit but not push is not nagged to
push), ahead/behind as of the last fetch, last-fetch age, and a short caveat (under 40 tokens; if it cannot be held that short it
becomes actionable-only, gated on fetch age) on every empty Gate 1 result: "this host reads only what has been committed and pulled — records
written elsewhere since your last pull are invisible." Honest bounds: the block describes the
**writing** host's unshared state and the **reading** host's fetch age. It cannot see host A's
undrained records from host B; `behind` is measured against the last fetch, never rendered as
"in sync." On a store with `storage.export_records: false` or a gitignored `records/` tree the
block says so and reports no counts — never 0. In your exact reported topology (B pulled recently, A's drain not yet run) the
disclosure lands on A, not on B — the caveat on B's empty result is the only thing B gets, which
is why it is unconditional.

Cost measured on a 5.1k-file records tree: ~55–70 ms warm / ~300 ms cold for the full probe (five
or six git spawns), TTL-cached and invoked only from status and assemble. It runs with
`--no-optional-locks` so it never takes `index.lock` against your drain's `git add`
(**EXECUTED**: plain `git status` does); the price is that a stat-dirty tree costs ~80–230 ms per
run instead of amortizing, which is why it never runs on the tool-dispatch path.

### 2.4 What you do, now

Run the drain on **every** host that writes, from the main checkout, with explicit paths. Not
`git add -A .twining` — on the design store that would re-track any aggregate a fallback host
recreated. Exclude `*.tmp`: the server writes each record through an atomic `<file>.<pid>.<rand>.tmp`
sibling and a commit racing a write stages it (**EXECUTED**; a gitignore entry ships in 2.16.1).
The exclude must stay anchored to the directory exactly as shown: a bare `:(exclude)*.tmp` makes
`git add` skip every untracked file on git 2.50 (**EXECUTED** — new records were never staged,
exit 0), which would turn the drain into a silent no-op for every new decision.

```sh
ROOT=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)   # the MAIN checkout, even from a linked worktree
git -C "$ROOT" pull --ff-only || exit 1                    # non-ff, no upstream, or fetch failure: do not drain
git -C "$ROOT" rev-parse -q --verify MERGE_HEAD >/dev/null && exit 1
[ -z "$(git -C "$ROOT" diff --name-only --diff-filter=U -- .twining/records)" ] || exit 1
git -C "$ROOT" add -- .twining/records ':(exclude).twining/records/*.tmp'
for f in .twining/config.yml .twining/.gitignore; do if [ -f "$ROOT/$f" ]; then git -C "$ROOT" add -- "$f"; fi; done
git -C "$ROOT" diff --cached --quiet || git -C "$ROOT" commit -qm 'twining: drain records mirror'
git -C "$ROOT" push      # only where push credentials exist — see #9 (c)
```

Interim staleness check per host until 2.17.0 (never `git diff-index --quiet` — **EXECUTED**:
5,137 false positives after an mtime-only touch):

```sh
git --no-optional-locks status --porcelain --untracked-files=all -- .twining/records | wc -l
git rev-list --left-right --count HEAD...@{u} 2>/dev/null || echo 'no upstream — cannot judge ahead/behind'
stat "$(git rev-parse --git-common-dir)/FETCH_HEAD"
```

If your drain is single-host because of EMU credential policy rather than convenience, say so
(#9 (c)): "drain on every host" is then not executable and the alternative is per-host commit with
the credentialed host pulling from the writers.

---

## 3. §3 — `01M088JCGYRWPX8EYYQNG3G5DB` and the "one-sided supersession-link shape"

### 3.1 Absent, not null; designed, not broken

Nothing in Twining writes `superseded_by: null`. `JSON.stringify` drops undefined keys
(`src/storage/decision-store.ts:135-139`, `src/storage/sqlite/sqlite-stores.ts:242-244`) and the
mirror's `stableStringify` writes absent keys as absent (`src/storage/sync/record-export.ts:45-57`).
"None" is your reader rendering a MISSING key.

Absence is the designed output of `twining_override` **without** a replacement decision:
`override()` writes `status: overridden`, `overridden_by`, `override_reason` and nothing else
(`src/engine/decisions.ts:1082-1089`; **EXECUTED** — the record's key set has no `superseded_by`).
`superseded_by` is written by exactly two paths: the supersede flip when a new decision names the
old one (`:415-422`, which also sets `status: superseded`) and housekeeping's `superseded_backfill`
(`src/engine/housekeeping.ts:529-536`). Override WITH `new_decision` therefore ends with the old
record `superseded` + `superseded_by` (**EXECUTED**) — so a record that reads `overridden` with no
pointer was not produced by that path in this store.

Two of our texts fed the misreading and are corrected: `twining_search_decisions`' description
tells agents to "follow superseded_by to the current answer" for overridden records too
(`src/tools/decision-tools.ts:423`; reworded in W2), and our own Doc 2 wrote
"`superseded_by: null`" (errata appended to that doc today).

### 3.2 When it IS a defect — and two routes that need no git revert

It is a lost link only if another record's `supersedes` names it. Two revert-free routes exist
on your topology:

- **Same-rank rewrite.** `overridden` and `superseded` both rank 2 in the ingest's lifecycle
  ladder (`src/storage/sync/record-ingest.ts:54-60`) and the revert detector fires only on a
  strict downgrade (`:272`), so a file-wins rewrite that swaps one for the other — and drops the
  pointer — is invisible to `lifecycle_reverts` by design. A zero counter is not evidence against
  it. (A `pointer_loss` counter for exactly this class ships in 2.17.1.)
- **Cross-host dangling supersede.** A successor recorded on host B while the target had not yet
  drained to B's database gets `supersedes_dangling` and never flips the target
  (`src/engine/decisions.ts:426-428`). When the target arrives later it keeps host A's status.
  Your one-host drain manufactures this shape with no revert anywhere. Grep host B's tool
  results for `supersedes_dangling`.

### 3.3 The diagnostic

```sh
jq '{status, overridden_by, override_reason, superseded_by, supersedes, timestamp}' \
  .twining/records/decisions/01M088JCGYRWPX8EYYQNG3G5DB.json
grep -l '"supersedes": "01M088JCGYRWPX8EYYQNG3G5DB"' .twining/records/decisions/*.json
```

Zero hits → a pure veto; `override_reason` says why; nothing to repair. One or more hits → a
one-sided link: `twining_housekeeping({})`, confirm `superseded_backfill.items` names it, then
`twining_housekeeping({execute: true})` with `promote_provisionals` and `archive` unset. Read the
preview's `graph_pruned` count first — execute also prunes relation-less graph entities and
unlinks their mirror files (a `backfill_only` option ships in W2 so the one-pointer repair is not a
graph write). Commit `.twining/` immediately and drain, or a later file-wins ingest eats the
pointer again. If the veto was unintended, record a new decision with `supersedes: 01M088…`; there
is no undo verb for `overridden`.

### 3.4 The W2 flag we promised you is amended before it ships

Doc 2 §3.2 said "rows where neither pointer resolves carry `lineage_unresolved: true`." As written
that would label every pure veto a lineage hole in 2.17.0. Today's `why()` cannot distinguish the
two — a pure veto and a one-sided link render byte-identical `{id, summary}` rows
(**EXECUTED**). 2.17.0 gates `lineage_unresolved` on `status: superseded` (or `archived` from
`superseded`) with no pointer either way; an overridden record WITH a reverse claimant still gets
`superseded_by_inferred`; an overridden record with no claimant gets no lineage flag, and
`override_reason` is projected where `superseded_by` would be. If your tooling treats
`superseded_by` absence on an overridden record as an error, retire that check now (#10).

---

## 4. §4 — merge conflicts, `.gitattributes`, and the sentence of ours that misled your tier

### 4.1 The conflict class your table misses — and why it is our fault

`docs/UPGRADE-v2.md:67` said records are "immutable ULID-named files … conflict-free."
FOUNDATION-PLAN D2 promised mutations as new event records and the aggregates ceasing to be
committed. Neither is what ships: every mutation rewrites the same ULID file in place —
decision status/link_commit/amend (`src/storage/sync/record-export.ts:221-247`), post resolve
(`:169-184`), entity and relation upsert (`:256-270`), handoff acknowledge (`:324-328`);
`record-export.ts:20-21` states this as the contract and `test/record-sync.test.ts:156-168`
pins it — and `migrate` leaves the aggregates tracked (`src/migrate/cli.ts:122-128` prints only
`git add`). Your chassis store's four tracked aggregates is exactly the state migrate leaves;
this repo's own store has the same shape.

**EXECUTED** merge matrix (git 2.50.1, two clones):

| Situation | Result |
|---|---|
| add/add of distinct ULID files | clean, both land (by construction — distinct paths) |
| same record, non-overlapping keys (override on A, `commit_hashes` on B) | clean, valid JSON when the edited lines are not adjacent (keys are sorted one per line); the SAME verb pair conflicts on a tiny record where the new key sorts last and rewrites the previous line's trailing comma — measured both ways |
| same record, overlapping keys (both change `status`) | CONFLICT, markers, unparseable |
| `merge=union` on a per-record file | exit 0, **invalid JSON** |
| `merge=union` on an array aggregate | exit 0, **parseable duplicate-key output, one entry silently lost** |
| `-X ours` / `-X theirs` | one side dropped without trace |
| `records/**/*.json -merge` | keeps "ours" as valid JSON, flags UU on every same-record edit — including the disjoint ones git would merge cleanly |

The highest-frequency magnet fires without any human action: entity upsert bumps `updated_at`
on every touch (`src/storage/sqlite/sqlite-stores.ts:385`) and re-exports the same file, and
graph auto-population touches entities on every decide/record. Two hosts recording in one drain
window conflict on shared entities every time. W2 makes no-op upserts byte-stable (relation
upserts already are — `sqlite-stores.ts:455-458`).

So your tier-A classification "fully autonomous for `.twining/**`" was built on a sentence we
published that is false for mutations. That is our documentation failure — UPGRADE-v2 and
FOUNDATION-PLAN (D2, D5) are corrected/annotated as of this commit — but the classification
must change today (§4.3).

### 4.2 `.gitattributes`: nothing to add

`blackboard.jsonl merge=union` is written once at fresh init (`src/storage/init.ts:124-129`),
never reconciled, and governs a file the sqlite backend never appends to — inert on your stores.
No attribute makes the aggregates mergeable (matrix above). `-merge` on records is a legitimate
choice for a pipeline that cannot guarantee marker-free eviction, at the stated cost; we document
it as opt-in and do not set it. The safe policy for frozen aggregates on a sqlite-era store is to
untrack them — **only once every host serving the store runs Node >= 22.13** (§5 explains why;
W4's migrate output will print the guarded command).

### 4.3 Tier-A rule for `.twining/**`, reclassified

- **AUTO-SAFE:** add/add of distinct ULID files under `records/**`. (Clean disjoint-key merges of
  the same record are textually valid but we have verified semantic consistency for one verb pair
  only; treat them as HUMAN until we publish the verified pairs — W2 adds the test matrix.)
- **HUMAN:** any CONFLICT under `records/**`; any modify/delete under `records/**`; any conflict in
  `decisions/index.json`, `graph/*.json`, `agents/registry.json`, `handoffs/index.jsonl`,
  `blackboard.jsonl`, `config.yml`. Never `merge=union` any JSON.
- **When evicting, never leave markers in the working tree.** `git checkout --ours -- <path> &&
  git add <path>` (resolved, keeps ours) or `git merge --abort`. A bare `checkout --ours` leaves
  the path UU and pins your hourly drain's commit until a human notices. The reason this matters
  beyond hygiene is §6.

---

## 5. §4 — the old-Node fallback host

### 5.1 "The fix is Node" — right as root cause

`src/storage/backend-factory.ts:113-117` throws when `node:sqlite` is unavailable, `:238-245`
catches and falls back to the file backend, whose `DecisionStore` reads `decisions/index.json`
on every index-driven path (`src/storage/decision-store.ts:302-320` → `readJSON` → ENOENT) and
locks it on every write. Nothing recreates the file on an existing store (`src/storage/init.ts:69-72`
returns after the gitignore reconcile). Your #66 untrack is the direct cause: **EXECUTED**
two-clone experiment — after one clone commits `git rm --cached .twining/decisions/index.json`,
a plain `git pull` on a CLEAN clone deletes the working-tree file silently (a dirty clone aborts;
a diverged one gets a modify/delete conflict your tier would evict). Sqlite hosts are always clean
for that file because HEAD never writes it. Migrate never asked for the untrack — our guidance
gap, your unguided step.

### 5.2 Incomplete as remediation — the gaps are ours

- **The one tool built to explain the fallback is in the failing set.** `twining_status` calls
  `getIndex()` at `src/tools/lifecycle-tools.ts:60`, before the warnings array is built at `:116` and the
  `records_unread` "FELL BACK … Node >= 22.13" text at `:128-132`; the catch at `:239-244` turns
  it into `INTERNAL_ERROR`. **EXECUTED**; control with an empty index renders the warning first.
- **The 2.16.0 repair path cannot recreate the file on a pure sqlite-era clone.** `repairIndexDesync`
  returns before its `ensureFileExists` when there are zero legacy decision files
  (`decision-store.ts:222-237` vs `:245`; **EXECUTED**).
- **The documented straggler sweep is unavailable there.** `twining-mcp migrate` itself ENOENTs
  on that store (`src/migrate/forward.ts:127/168`).
- **Gate 2 passes while dropping decisions** (§1).

What ships: **2.17.1** — status survives a missing index and leads with the diagnosis; the
ENOENT becomes a named `STORE_UNSERVABLE` error whose message is an explicit agent directive
("STOP — this store is sqlite-era and this host has no node:sqlite; decision data is present
but cannot be served here; do not record decisions or commit on this host"); `twining_record`
gains `decisions_requested` / `decisions_persisted` and `degraded: true`; housekeeping and
search stop reading as healthy; migrate names the remedy on that ENOENT. Be clear about the
bound: none of this stops an unattended agent by itself — Gate 2 still passes by design, because
the server must not be the reason a session cannot proceed. A hook-readable refusal is the
fallback-policy question in §7 (DD-6/DD-11), and #16 asks which shape your fleet wants.

### 5.3 What you do, now

**Primary:** upgrade Node to >= 22.13 on that host. Until then do not run Twining sessions there
against a sqlite-era store — on the design store every decision tool ENOENTs while `twining_record`
passes Gate 2 and drops every decision; on the chassis store it WRITES `decisions/index.json`,
`blackboard.jsonl` and `graph/*.json` that no sqlite host ever ingests and your drain then commits.
Set `TWINING_DISABLED=true` in the environment that launches Claude Code (launchd
`EnvironmentVariables` or the wrapper shell — **not** `settings.json`, whose `env` block does not
reach plugin MCP servers upstream); the commit gate then needs `TWINING_DISABLED=true git commit …`.

**Secondary, only if that host must run:** `mkdir -p .twining/decisions && echo '[]' >
.twining/decisions/index.json`, added to `.git/info/exclude`. Status, assemble and record work
again and status shows the FELL-BACK warning — BUT every read is EMPTY beside hundreds of records
(the amnesia shape) and the agent proceeds blind. Know that trade before choosing it. Neither
`twining_housekeeping({repair_index: true, execute: true})` nor `twining-mcp migrate` can create
the file for you on that store.

**After Node is fixed on that host:** decisions it recorded while on fallback live in legacy
`decisions/*.json`, not `records/`. Run `npx twining-mcp migrate` once on that checkout to sweep
them (the sweep needs the index present). Treat decisions attempted WITHOUT the index as lost
unless `decision_errors` was empty.

**Chassis store:** keep the aggregates tracked until every host serving it is on Node >= 22.13;
then `git rm --cached` those that are tracked and commit.

---

## 6. A loss you did not report — and the 2.16.1 fix

At 2.16.0, ingest DELETES the sqlite row for any record file it cannot parse or identify while
the file stays on disk. `readRecord()` returns null for an unparseable file
(`src/storage/sync/record-ingest.ts:81-91`), the loop skips the file before recording its id
(`:243-245`), and the deletion pass removes every db row without a file id (`:291-296`).
**EXECUTED**: conflict markers → `{deleted: 1, skipped: 1}`; 0-byte file → same; a parseable
file whose body `id` is not a string → `{deleted: 1, skipped: 0}` with no warning at all; a
parseable file whose `id` ≠ filename stem → a stray row inserted under the body id (EXECUTED) and,
by `:291-296`, the stem's row deleted. The embedding is swept as an orphan on the next reconcile; when the file is repaired
the record re-inserts as a NEW row (new `seq`, vector regenerated). The docblock at `:19` says
"Unparseable files are skipped with a warning, never deleted"; the test that pins it never seeds
a row. Only stderr counts it (`-N (N unparseable skipped)`); the blackboard shows nothing.

Your pipeline produces the trigger by construction: tier-A evicts conflicted `records/` entries,
markers stay in the working tree, and the next server start ingests the tree with no content pre-check
(`src/storage/backend-factory.ts:131-133`, gated only on `storage.export_records`) — deleting that ULID's row on every host that
ingests the tree. Presented to the agent, that is an EMPTY assemble: the same class as your
host-B symptom, from a different cause.

**2.16.1** (server) / **1.34.1** (plugin): ingest retains the row for any file it cannot read or
whose `id` does not match its filename (keyed on the filename stem for every file, before
parsing); the silent non-string-id branch is counted and warned; a mismatched body id is refused
rather than inserted. Deliberate removals still propagate — an ABSENT file still deletes. This is a
narrow, recorded exception to file-wins: an unreadable file is not a file and cannot "win";
precedence for parseable files is unchanged. Also in 2.16.1: `records/**/*.tmp` joins the
gitignore template; `twining-mcp <unknown-subcommand>` exits 2 with usage instead of starting a
stdio server (**EXECUTED** 2026-09-05: `node dist/index.js drain` against a scratch `TWINING_PROJECT`
booted the server and created a fresh `.twining/`; `src/index.ts:28-31` — the only argv[2] dispatch is
`migrate`, anything else falls through — a footgun for launchd); and a read-only `twining-mcp validate-records [--project <dir>] [--json]` that
checks every file under `records/**` (parses; `id` == stem; no markers; non-zero size) plus
`git ls-files` hygiene (`*.tmp`, `twining.db*`, and which frozen aggregates are still tracked on a
sqlite-era store), exit 0 clean / 1 findings / 2 usage — wire it into your drain before the
`git add`.

**Until 2.16.1 reaches a host**, before any session there that received the bulk drain or a
merge result:

```sh
grep -rl '^<<<<<<<' .twining/records
find .twining/records -type f -size 0
find .twining/records -name '*.json' | while read -r f; do
  jq -e --arg id "$(basename "$f" .json)" '.id == $id' "$f" >/dev/null 2>&1 || echo "$f"; done
```

Every hit deletes a row on the next ingest on that host. Repair from `git log -- <file>` and
restart. To find rows already lost: for each of the five CLAUDE.md-cited IDs, file in a ref
(`git ls-tree -r HEAD --name-only -- .twining/records/decisions | grep -c <id>`) versus row in
that host's db (Node >= 22.13: `node --input-type=module -e "import {DatabaseSync} from
'node:sqlite'; …"`, or `sqlite3` where installed). File present + row absent = that host ingested
a corrupt copy; repair and restart re-inserts it.

---

## 7. What ships where

| Release | Items |
|---|---|
| **2.16.1 / plugin 1.34.1** (next) | ingest retention (§6); `records/**/*.tmp` gitignore; CLI unknown-subcommand guard; `validate-records` |
| **W2 / 2.17.0** | `sync` block on status + assemble `Sync:` line + unconditional empty-result caveat (§2.3); `lineage_unresolved` gated to `superseded`, veto semantics, `decision-tools.ts:423` reworded (§3.4); entity no-op upserts byte-stable (§4.1); housekeeping `backfill_only`; semantic merge-matrix test for the AUTO-SAFE class |
| **2.17.1** (pre-decided follow-on) | fallback diagnosability: status survives a missing index, `STORE_UNSERVABLE` + STOP directive, `degraded` on record, honest housekeeping/search, migrate remedy text, dashboard parity (§5.2); unreadable-files blackboard warning; override read-back after supersede (the tool result currently echoes `overridden` while the store holds `superseded` — **EXECUTED**); `pointer_loss` counter (§3.2) |
| **W4 / 2.19.0** | print-only `twining-mcp sync-status`; migrate prints the Node-guarded `git rm --cached` block and the MIGRATED-README marker |
| **Design decisions, opened not built** | **DD-12** mutation & conflict model for `records/**` (status quo vs event records per D2 vs revision stamp + resolver — your #12 census is the deciding input); **DD-13** transport boundary ("server process never commits; a CLI commits only on an explicit flag" — a supported `drain --commit` lives or dies here; #9 (c)/#14 are inputs); **DD-6/DD-11** fallback policy on old Node (opt-in refuse knob that pins `git commit` closed, or a read-only records view — #16) |

Not shipping, with the evidence: a tolerant index read (turns 16 loud failures into the amnesia
shape — **EXECUTED**); `-merge` as a default; `merge=union` anywhere; auto-staging records in the
commit hook (**EXECUTED**: from a linked worktree `git add <main-checkout path>` exits 128
"outside repository"; 5 s hook timeout; welds records into the commit they describe); a
server-side periodic commit; recreating `index.json` at boot.

**Release reach.** The plugin pin does not pin the server for hosts on the npx rung
(`plugin/scripts/launch-server.sh:42` — `twining-mcp@^2.0.0` floats): those hosts pick up 2.16.1
on their next session start. Hosts on a project `node_modules` pin or the bundled rung get it only
when you update the plugin — in **both** user and project scopes — or bump the pin. `#9` asks for
the probe line so we know which you are.

---

## 8. What we need from you

Doc 2 ended at #8; these start at #9.

- **#9** (a) Per host: `node --version`; the `launch-server.sh --probe` line; `server_version` /
  `backend` / `backend_reason` from `twining_status` (2.16.0+); which store(s) it serves;
  whether it runs the tier-A automation; whether the drain runs there; and whether the old-Node
  host ever recorded decisions in the window (`decision_errors` non-empty). (b) `tools.full_surface`
  and `tools.mode` per store. (c) Why is the drain single-host — EMU credential policy or
  convenience? If credentials: which hosts can commit but not push?
- **#10** `01M088…`: the `jq` output and the reverse-grep hits; if a hit, `git log --format='%h
  %ci %s' -- <both files>` on the recording host and whether that session's response carried
  `supersedes_dangling`; was the override issued with or without `new_decision`? Does any
  downstream tool treat `superseded_by: None` as an error? Do you accept "no lineage flag on a
  claimant-less overridden record" as the 2.17.0 semantics?
- **#11** Tier-A mechanics: any `-X` strategy or custom attributes? What does eviction leave in the
  working tree — markers, `--ours`, or an aborted merge? Does a Twining session ever run on that
  checkout before resolution?
- **#12** Conflict census (DD-12's primary input): every `.twining` conflict evicted in the
  window, by path class (`records/decisions`, `records/graph/entities`, `records/graph/relations`,
  `records/posts`, each aggregate) and, for `records/**`, overlapping-key vs disjoint-key. Did the
  3,145-file drain leave any file with markers, 0 bytes, or `id` ≠ stem (the §6 scan)?
- **#13** Server stderr counts and dates for `Skipping unparseable record file`, `unparseable
  skipped`, `HEAD moved — re-ingested`, `falling back to the file backend`, `ingest file-wins
  downgraded` — or, if your automation cannot reach stderr, say so and run the 2.16.1 validator.
- **#14** `drain-twining.sh`: `git add -A .twining` or explicit paths? main checkout or worktree?
  which branch is each host's main checkout on? any sessions from linked worktrees or with
  `TWINING_PROJECT` across repos? Are npm and the plugin marketplace reachable from your network?
- **#15** For the five IDs: on host A, uncommitted / committed-unpushed / absent during the five
  days (`git log --diff-filter=A --format=%ci -- .twining/records/decisions/<id>.json`), and do
  they now exist as ROWS in every host's db?
- **#16** Fleet preference on the fallback host: an opt-in, config-committed refuse mode (pins
  `git commit` closed on that host until `TWINING_DISABLED=true`), a read-only records view
  (reads work, writes refused with a named code), or today's loud-but-writing fallback? And would
  a `Sync:` line in the assemble briefing be read by your agents, or should the empty-result
  caveat be a hard STOP marker in NEXT STEP?

---

## 9. What changed on our side

- Docs, in this commit: README "How It Works" gains the cross-machine paragraph; UPGRADE-v2 gains
  "Working across machines" and "Merging `.twining`" and its "immutable … conflict-free" sentence
  is corrected; FOUNDATION-PLAN's status table and D2/D5 carry dated PARTIAL annotations (the
  original text is preserved); Doc 2 carries a dated errata block for "`superseded_by: null`"
  and the `lineage_unresolved` wording.
- Store records: the two-failure-shapes disposition; the 2.16.1 vehicle at its true cost; the
  disclosure-first choice and the mechanisms rejected with evidence; the tolerant-index-read
  rejection; the `--no-optional-locks` probe rule; the pre-decided W2 / 2.17.1 split; DD-12,
  DD-13 and the DD-6/DD-11 question minted; the ingest retention recorded as a named exception
  to file-wins; the lineage gating amendment.
- Plan of record: `docs/plans/2026-09-05-cross-host-sync-plan.md`.

On your §3 closing note — "check both link directions on any supersession you rely on" — that is
the right rule, and the reverse grep in §3.3 is how to do it until 2.17.0 does it for you inside
`twining_why`. Retire the rule against `lineage_inferred_count` once 2.17.0 reaches you.
