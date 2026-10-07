# Twining foundation programme — final report

**Package:** `twining-foundation-20260915` (R01–R20, C01–C28). **Plan:** `docs/plans/2026-09-15-foundation-programme-plan.md`. **Audit trail:** `docs/plans/2026-09-15-foundation-programme-log.md` (A / DN / D / S registers, DN1–DN49, D1–D62). **Row-level evidence:** `docs/reports/2026-09-foundation-matrix.md`.

Status words are the package's: **passed**, **failed**, **unavailable**, **waived-by-explicit-ruling**, **not-tested**. Nothing unavailable is reported as passed. No row is waived; no ruling waived one.

## 1. Verdict

**The adoption gates did not pass. Recommendation: do not adopt v3 at this commit; do not merge PR #49 as an adoption.**

- The record, lifecycle, admission and scope machinery is built, and at the library level it passes every executable assertion of its implementation-blind oracles: 2744 tests pass, 6 are skipped (including the real-host suites), 0 fail, 62 assertions are marked todo. Only C11 is complete. 23 cases are partial, C07, C13 and C23 have no executable case, and C28 is unavailable.
- Three go/no-go rows have **failed** parts: correctness, migration and operations, and recovery. An audit that filled the operator documentation only from executed commands found that upgrade, index rebuild, Git exchange, deletion and rollback of post-upgrade writes do not work at the command line, although their unit and acceptance tests pass (§5).
- Four go/no-go rows are **not-tested** at the model level: immediate rejection, correctness, context benefit, and most of latency. The matched trial was designed and half built, not run (§7).
- Two cases are **unavailable** on this machine: C28 (needs a second computer) and the Codex half of C15 (needs one-time interactive hook trust).

Stage 0 shows that the simpler evolution cannot meet C10, C11, C14, C16 and C22 by construction. Whether those requirements justify the foundational change now is the open question in §12. What is not yet shown is that the product built on the event log is operable, or that it helps a model more than the simpler alternatives.

## 2. Source identities

| Item | Value |
|---|---|
| Repository / branch | `daveangulo/twining-mcp`, `foundation/v3` |
| Commit described | `0f9fd985` (merge of the store-identity fix; parent `c3af1a45`) |
| Package's inspected commit | `d7860e0` (`main` is `07230e65`, whose `src/` equals it) |
| `package.json` version | `2.16.1` — the `3.0.0-alpha.N` stamp ruled in RB7 was never applied (DN38); the CLI and server report 2.16.1 |
| Contracts | `3.0.0-draft.3` (`src/contracts/`) |
| ADR | `docs/adr/2026-09-foundation-contracts.md`, ACCEPTED draft 2, appendices A–C |
| Plugin | 1.34.1 in both manifest files; the committed bundle is stale against this tree |
| Tokenizer table | `measured-claude-sonnet-4-5/2026-09-16`, corpus sha `c67d99ea…`, safety factor 1.15 |
| Hosts | Claude Code 2.1.291 (real-host capture test passed on it, 2026-10-06). The host event matrix in the docs was generated against 2.1.272 and the delta to 2.1.291 is unverified. Codex CLI 0.154.0 (adapter built, real host not verified) |
| Node / OS / git | v26.8.2; macOS 26.6.2 arm64; Apple git 2.54.0 |
| Other branches | `feat/cli-2.17` `d2e96ad4` (PR #48), `wip/codex-plugin` `dedaaccf`, `main` `07230e65` |
| Benchmark harness | `~/code/twining-benchmark-harness`, branch `foundation-trial` `f09523a` (paused trial build on `279edb6`) |
| Oracles | `test/acceptance/oracles/` — 28 cases, held-out variants for 23; sha256 over the 103 files concatenated in name order: `2df6e8e0…fc8d` |
| Package | `twining-foundation-20260915`; `SHA256SUMS.json` sha256 `0c64cd90…f85b` (all ten files verified against it at plan time) |
| Raw results | Not retained in the repository. The full-suite console log and the measurement output lived in a session scratch directory; reproduce with the commands in §10 |
| Transport | Git carrier on `refs/heads/twining/exchange` (library only, see §5), filesystem carrier, in-process reference relay |

Commits added by this session after the handoff (`9b0afafd`): `1258c30a` and `0998c093` (working-set renderer), `591fcf63` and `992a711b` (store identity), their merges `afe8f34d` and `0f9fd985`, and docs commits.

## 3. What is complete

- **Stage 0:** eight supplied gaps reproduced with positive controls; steelman of the smallest evolution; ADR accepted; vertical slice.
- **Five lanes built, adversarially reviewed, fixed and merged:** event log and projections; admission with ancestor-membership capability; filesystem and Git carriers plus reference relay; fault suite; `migrate --to 3` and `rollback --to 2`; runtime adapters for Claude Code, Codex and a library host; the `twining` CLI; scope-first retrieval with budget, explain packets and receipts; the acceptance harness with instrument-can-fail controls.
- **Six of eight baseline gaps closed** (1, 2, 3, 4, 6, 7). Gaps 5 and 8 still reproduce.
- **Fixed in this session**, each with tests that fail on the old code and independent refuters:
  - The v3 working set rendered a verified observation as a bare record id and never rendered a revision range, so a model could not see what was observed or which revision a ruling was bound to. It now renders both, drops hook bookkeeping from the packet, and passes every field through one bounded single-line normaliser so stored text cannot forge a class header.
  - Store identity readers required `repo_id` while `identity init` writes `repo_ids`. A v3 store was reported as format 2 with a path-derived id, and `migrate` after `identity init` overwrote the store's identity. Readers now accept both; migrate reuses existing ids.
- **Operator documentation** rewritten from executed commands (§9).

## 4. Go/no-go table

| Criterion (package wording, shortened) | Status | Evidence and what blocks |
|---|---|---|
| **Immediate rejection** — authority-changing error, unauthorized action attempt, cross-scope disclosure, fabricated human ruling, silent loss of an acknowledged event | **not-tested** at model level; no instance in the deterministic suite | C02, C08, C12, C25 and gap 6 tests pass. No model session was run, so attempted actions were never observed. Three operator-surface behaviours are close to this line and are reported in §5: sync reports success while exchanging nothing; a deleted journal reads as healthy and empty; and on a migrated store an MCP write is refused without the `isError` flag, so a client that checks only that flag reads a lost write as acknowledged. |
| **Correctness** — all deterministic invariants; 100% recovery of required facts; ≥95% on held-out paraphrases | deterministic: **failed** at the operator surface, **not-tested** in part; required-fact recovery and model-level: **not-tested** | No exercised library-level invariant fails. C21's lossless-migration and post-upgrade outcomes and C20's deletion outcomes do not hold through the commands (§5 items 0, 3, 4, 5). 62 todo assertions and C07, C13, C23 are not exercised. Required-fact recovery and held-out answers need the trial. |
| **Context benefit** — ≥20% lower median reconstruction tokens and time than journal recovery | **not-tested** | Trial not run. |
| **Latency** — p95 recall/injection < 1 s; p95 local durable capture < 100 ms; p95 async indexing < 30 s | local capture: **passed at the library level** only; everything else **not-tested** | `EventStore.append` p95 11.0 ms at 1,000, 4,000 and 16,000 events (§6), inside the ≤16,000 envelope declared during the run in place of the package's 10,000 and 100,000 tiers. End-to-end hook or CLI capture latency was not measured, and as installed capture does not run at all (§5 item 6b). Recall, injection, handoff-to-next-action and indexing latency were never measured. |
| **Recovery** — no missing facts after compaction/restart; full reconciliation of duplicate, reordered, interrupted and response-loss writes; no unsupported exactly-once or global-deletion claims | compaction/restart: **failed** at the adapter level (§5 item 6a), **not-tested** on a real host session; reconciliation: **passed** for the exercised library-level assertions, **failed** at the operator surface for a write made while rolled back (§5 item 4); claims: **passed** | Reconciliation evidence is the C10, C17, C18 and C24 suites and the kill-at-boundary worker; all four cases are partial, and C18's two-computer topology is substituted. The docs state at-least-once transfer and that clones and backups are not erased. |
| **Migration / operations** — lossless migration and rollback including post-upgrade records; clean export/import and index rebuild; restore/rollback within 30 minutes | **failed** | §5 items 0, 2, 3 and 4. C21's 37 library-level assertions pass; the same guarantees do not hold through the commands an operator runs. |
| **Value** — implementation size, operator work, cost; recommend the simpler baseline if it achieves the same result | reported in §11 and §12 | No measured comparison exists, so no benefit claim is made. |

## 5. Failures — reproduction, guarantee, owner

Found by the documentation audit (programme log DN46), reproduced by the doc writers and by independent re-execution. Item 1 was also confirmed from source by the lead, and item 0 by a lead run on a one-record store. Exact commands and outputs are in the operator guides: `docs/operations/recovery-and-rollback.md` (defect table K1–K26), `docs/CLI.md` (20 rows), `docs/operations/data-flow.md` and the two host docs.

| # | What happens | Smallest reproduction | Guarantee affected | Owner |
|---|---|---|---|---|
| 0 | A store finalized by `migrate --to 3` refuses every registry write from the same build: `twining post`, `record` and the MCP tools fail with `FORMAT_VERSION_TOO_NEW`. The MCP refusal carries no `isError` flag, only text. Only a store bootstrapped with `identity init` accepts writes. | Migrate a small 2.x store, then `twining post`. | R19; the upgrade yields a store the product cannot write to | lanes 02 and 03 |
| 1 | `twining sync --remote origin` never uses the Git carrier. The CLI passes positional arguments to a constructor that takes an options object; the error is swallowed and sync falls back to a private directory inside the same store, then reports success. Nothing reaches the remote. | Two clones of a bare repo, `identity init` and one post in A, `sync --remote origin` in A then B; the result names an `fs:` carrier and the remote has no exchange ref. | R08, R09; C13, C14 Git arm, C28 | lane 03 (CLI) with lane 02 |
| 1b | Over the filesystem carrier (`sync --path`), a peer's events arrive but stay quarantined `signature_required`, and no verb exists to trust a peer's key. Bytes cross replicas; records never reach `read` or `assemble`. | Two clones with separate identity homes, `sync --path <shared>` A then B; `exchange_status` → `by_reason {signature_required}`. | R08, R09, R18; C11, C14 at the operator surface | lane 02 with lane 03 |
| 2 | Nothing callable rebuilds the journal. After `.twining/store/events.db` is deleted, `events ls`, `exchange_status` and `doctor` report zero events and a healthy checkout; no command re-journals the event files. | Finalized small store, delete the file, run the three commands. | R19, go/no-go "index rebuild"; near the "silent loss" line | lane 02 |
| 3 | `migrate --to 3` does not finalize on this repository's own legacy store. Records with 1.x hook-era ids (not ULIDs) are rejected by the v3 schema and then reported missing by verify. The dry run reports no rejections. Legacy files are untouched. | Scratch copy of this repo's `.twining`, `migrate --to 3`. | R19, C21 | lane 02 (migration) |
| 3b | `migrate --to 3` on a store bootstrapped with `identity init` re-imports the 2.x mirror of every native write as a second, `legacy_unverified` record, then leaves the store read-only (item 0). | `identity init`, two posts, `migrate --to 3`, `events ls`. | R19, R07 | lane 02 (migration) |
| 4 | Rollback leaves `store.json` at format 3, so the v3 mirror keeps writing while rolled back. Forward recovery then ingests the same write again as a legacy record: one write, two records, two evidence classes. | Migrate a small store, roll back, post once, migrate again, list events. | R19 "including post-upgrade records", R07 | lane 02 (migration) with lane 03 |
| 5 | No command exposes tombstone, purge or forget: none of the 41 tools in `twining capabilities`, and no verb in `src/cli/`. | `grep -n 'tombstone\|purge\|forget' src/cli/*.ts` | R19, C20 at the operator surface | lane 03 |
| 5b | `assemble` and `why` label signed native v3 events `legacy_unverified` and tell the model they were "migrated from a 2.x store with no authorship proof". The read path still serves the 2.x projection on a v3 store. | `identity init`, one post, `twining assemble`; read `trust.evidence_class`. | R03, R17, R16 | lane 04 |
| 6 | The assemble packet reports the same repository id for every store, because the context is built without the store directory. | Assemble in two unrelated scratch stores; compare `selection.repo`. | R01, R16 | lane 04 |
| 6a | After a compaction, `SessionStart` with source `compact` injects only what is new since that session's last injection, and nothing when nothing is new. The model can come back from compaction with no working set. Shown through the hook shim with synthetic payloads; a real host session is unavailable. | `twining hook claude-code SessionStart` with `startup`, then `compact`, same session id. | R10, C27; go/no-go "no missing required facts after compaction" | lane 03 |
| 6b | As installed, the plugin's capture shim cannot find a CLI unless the project has `./node_modules/twining-mcp` or `TWINING_CLI_JS` is set, so in any other project v3 capture silently does not happen. The installed plugin 1.34.1 has no v3 hooks at all. | Run the shim with a clean environment on a v3 store. | R10 | lane 03, release |
| 7 | Smaller: one `events ls` reader calls an incomplete migration "rolled back" and `doctor` hides it; `doctor`'s hook and provenance reports depend on the directory it is run from, not `--project`; a write returns a 2.x id that `events show` cannot find; `twining dismiss` writes no v3 event; `exchange_status.migration.state` is always `unknown`; `mode: lessons` is silently ignored; `twining-mcp --help` starts the server and creates a store in the cwd. | See the operator guide's defect table (K3, K4, K12–K14, K17–K21). | R20 | lanes 02, 03, 04 |
| 8 | Gap 5: staleness uses local signals only. | `test/acceptance/baseline/gap5-staleness.test.ts` | R04, R12 | no owner assigned |
| 9 | Gap 8: file-wins ingest reverts lifecycle state on a 2.x store. | `test/acceptance/baseline/gap8-export-ingest.test.ts` | R19 on the 2.x path | open design decision |

Consolidated correction batches:

- **Batch A, exchange:** items 1 and 1b (a key-trust verb is needed before any carrier delivers records), then a real cross-clone run, then C13 and the two-machine C28.
- **Batch B, upgrade path:** items 0, 3, 3b and 4, plus a legacy-id policy for non-ULID records. The real migration of this repository's ~30 MB store took 13 to 17 minutes in two runs and did not finalize.
- **Batch C, operator surface:** items 2, 5, 5b, 6, 6a, 6b and 7 — a rebuild verb, deletion verbs, the assembler's store identity, compaction re-injection, CLI resolution for the capture shim.
- **Batch D, decisions:** items 8 and 9 need an owner ruling, not code first.

## 6. Requirements and cases

Row-level status is in the matrix. Summary at `0f9fd985`:

| | passed | failed | unavailable | not-tested | passes what exists, incomplete |
|---|---|---|---|---|---|
| Requirements (20) | R03, R05, R06, R13, R17 | R19 | Codex arm of R10; second real backend of R11; the C28 part of R08, R09, R18, R19 | benefit half of R20, recall-quality half of R14 | R01, R02, R04, R07, R08, R09, R10, R11, R12, R14, R15, R16, R18, R20 |
| Cases (28) | C11 | — | C28; Codex half of C15 | C07, C13, C23 | the other 23 |

Notes that change how the matrix should be read:

- R08 and R09 are scored from library tests. Through the CLI, Git exchange does not function (§5 item 1).
- R19 is scored failed here on the operator-surface findings (§5 items 0, 2–5). The matrix's status cell still reads partial for the library-level tests and points to the same findings.
- R10 and C27 are scored from adapter tests with synthetic payloads. As installed, plugin 1.34.1 has no v3 hooks and the shim finds no CLI (§5 item 6b), and `SessionStart` after compaction can re-inject nothing (§5 item 6a). Gap 1 is closed in the tree, not in the installed plugin.
- Claude Code real-host evidence: `test/adapters/real-host.test.ts` re-run on 2026-10-06 at `0f9fd985` against Claude Code 2.1.291 — 3 passed, 1 skipped (the Codex case). A one-shot session fires the hooks and captures the prompt; a dispatched subagent produces a work reference and a reported result; the injection receipt matches the bytes the host was handed. It does not exercise compaction or resume, and no transcript is kept. The earlier 2.1.272 run's only record was a blackboard post that the store's auto-archiver has since pruned from the tree (it remains in git history at `0f9fd985`). The suite is skipped in the default full run.
- R15: the tokenizer table is measured for three of five character classes. Whitespace is unmeasured and punctuation is clamped; both stay at the proven bound. A corpus document for the whitespace class is prepared; the run needs an API key this machine lacks.
- C28's one-machine partial run (12 passed, 1 failed, 21 unavailable) predates the fix for its one failure and was not re-run. It is not the case either way.

**Local durable capture.** `docs/reports/2026-09-resource-measurements.md` shows p95 77.8 ms at 16,000 events with cost growing as roughly the square root of corpus size. That run predates the merge-time fix that memoizes the admitted view, so its growth curve no longer describes the code. Re-measured at `0f9fd985` with `scripts/measure/append-cost.ts`:

| Events in store | append p50 | append p95 | max |
|---|---|---|---|
| 1,000 | 9.0 ms | 10.8 ms | 30.2 ms |
| 4,000 | 8.9 ms | 10.9 ms | 19.8 ms |
| 16,000 | 9.5 ms | 11.0 ms | 20.8 ms |

Cost is flat in corpus size across these tiers. Limits of this number: one developer laptop; documentation agents were running CLI commands at the same time; it times `EventStore.append` (validation, signature, journal row, event file, fsync), not a whole CLI or hook invocation; nothing above 16,000 events was run. The resource report itself was not regenerated.

## 7. The matched trial — not run

Status: **not-tested**. What exists:

- A judged design (`docs/plans/2026-09-16-dev-scale-trial-design.md`): four arms (journal, released 2.16.1, v3, exact/lexical store), floor and ceiling controls, deterministic scoring from oracle-derived required facts, forbidden claims and forbidden actions.
- In the harness repo, branch `foundation-trial`: scenario, three conditions, four seeders, scorer with offline controls, report and batch scripts, and 6 of 17 case specs (C01, C02, C04; development and held-out). It type-checks. It has not been integrated or run.

Why it stopped: the session's usage limit ended agent runs twice, and the §5 findings mean the adoption decision does not depend on the trial at this commit. Any result would also have to be re-run after the correction batches change the code under test.

The harness's LLM judge needs an API key this machine does not have; the design does not use it.

## 8. Unavailable and not-tested, in one place

- **Unavailable:** C28 (second computer; bundle and verifier at `scripts/qualify/c28-remote/`). C15 Codex half (hook trust inside Codex).
- **Not-tested:** the matched trial at any scale; C07, C13, C23; the 62 todo assertions; a real Claude Code session exercising compaction recovery (runnable here, not run); exchange over a real network (blocked by §5 item 1, not by the environment); C21 A-DEL-01 (receipt surface not wired into the case) and A-OLD-04 (no schema-negotiation surface exists); the 100,000-event tier; recall, injection and indexing latency; operator restore time against the 30-minute target (library rebuild was 7.9 s at 16,000 events in the resource report; no rebuild command exists, §5 item 2); a second tokenizer calibration.

## 9. Operator documentation

`docs/operations/recovery-and-rollback.md`, `data-flow.md`, `hosts-claude-code-capabilities.md`, `hosts-codex-capabilities.md` and `docs/CLI.md`. Each opens with a table of known defects and limits at `0f9fd985`, shows the command and trimmed output for every behavioural claim, and keeps unavailable items marked.

## 10. Commands

```sh
node scripts/inject-posthog-key.mjs     # once per fresh checkout or worktree
npx tsc --noEmit
npx vitest run                          # 181 files, 2744 passed, 6 skipped, 62 todo, 0 failed at 0f9fd985
npx vitest run test/acceptance          # oracles, cases, slice, baseline gaps, harness controls
npx tsx scripts/measure/append-cost.ts --tiers 1000,4000,16000
TWINING_REAL_HOST=1 npx vitest run test/adapters/real-host.test.ts -t "Claude Code"   # launches real claude sessions; skipped by default
```

C28 on two computers: `scripts/qualify/c28-remote/README.md`.

Never run two vitest processes at once on this machine, and never run `npm run build` in the main checkout: every session here serves this repository's `dist/` through the npm link.

**Migration.** Run it only on a copy until §5 items 0, 3 and 4 are fixed. A finalized store refuses every write from this build (item 0); only a store bootstrapped with `identity init` accepts writes.

```sh
twining-mcp migrate --to 3 --dry-run    # writes legacy/manifest.json only
twining-mcp migrate --to 3              # events, id map, verify, finalize; legacy files untouched
twining-mcp migrate-status
twining-mcp rollback --to 2             # regenerates a restricted 2.x view; events stay on disk
```

The live store in this repository has not been migrated and should not be.

## 11. Value and cost

- **Size on `foundation/v3` against `main`:** `src/` +20,123 / −3,273 lines over 95 files (72 new); `test/` +69,687 / −20 lines over 260 files.
- **Operator work added:** identity bootstrap per machine; an interactive signing ceremony for every human ruling; an explicit `sync`; a second on-disk tree; one more derived database.
- **Storage:** about 1.3 KB per event on disk (20.1 MB at 16,000 synthetic events, from the resource report). **Model and network cost:** not measured; the trial did not run.

## 12. The strongest case for the simpler baseline

The Stage 0 steelman ("record revisions", one 2.x release, an estimated 1,200–1,800 lines) closes both data-loss classes the field has actually hit: the file-wins lifecycle revert and rows deleted by absence. It adds tombstones that survive reconnect, idempotency keys and prerequisite deferral. It needs no new transport, no keys and no ceremony, and only an additive, verify-gated migration on the existing migrator. It would ship this month. The steelman also rates it as satisfying C20 and C21, the deletion and migration guarantees v3 currently fails at its operator surface. It closes gap 8 on the 2.x line that every user is still on, which v3 does not. Its ingest counters would measure how often concurrent conflicting writes actually occur, which is the question this recommendation turns on.

Against it: it fails C10, C11, C14, C16 and C22 by construction, because a record file is at once current state, history and merge unit, so a text merge decides authority before Twining reads the bytes.

That argument was about correctness under concurrent writers. This report adds a second fact: v3 adds about 16,900 net lines of `src/`, roughly 9 to 14 times the steelman's estimate, plus 69,687 lines of tests; its operator surface does not yet work for exchange, upgrade or recovery, and there is no measurement that it helps a model. If the field's pain is the incidents that have happened, the smaller evolution is the lower-risk way to stop them now, and it leaves the event log available later. If concurrent multi-writer correctness is the requirement that matters, v3 is the only design that can meet it, and the correction batches in §5 are the price of finding out.

**Recommendation:** keep `foundation/v3` as a branch and ship the CLI (PR #48) on the 2.x line as planned. Ask the field one question before investing in the correction batches: are concurrent conflicting writers a present problem or a future one. If they are not a present problem, ship the record-revisions evolution on 2.x and keep v3 parked. If they are, run batches A–C, then the trial. Adopt v3 only if the trial meets the package thresholds (≥95% held-out correctness, ≥20% lower median reconstruction tokens and time, the latency targets) with no worse authority, isolation or recovery than the strongest baseline. The owner has ruled that the trial follows the fixes (§13); this recommendation concerns whether to start the fixes.

## 13. Owner decisions and actions

- Trial scope: **ruled 2026-10-06** — the designed trial runs after the correction batches, not now (programme log D62). Open: who runs batches A–C and when.
- Whether the two pre-trial fixes made in this session stand (D51, D57). Reverting restores `9b0afafd`.
- SessionStart on v3 stores injects only the working set, with no gate prose (D25). Confirm or veto.
- File-wins precedence (gap 8) and an owner for remote staleness (gap 5).
- A policy for legacy records whose ids are not ULIDs.
- Release work: `bump-plugin-version.sh` (rebuilds the stale bundle, turns the two red CI jobs green), `plugin/BEHAVIORS.md` (documents 37 of 41 tools), the `3.0.0-alpha` version stamp.
- Merge and tag decision for PR #48 (the CLI, as 2.17.0), and later PR #49.
- Stores migrated by a pre-fix build after `identity init` keep the ids that build minted; healing them is an operator decision (D58).
- Codex hook trust (`/hooks` inside Codex), then the lane 03 real-host test.
- C28 on the second machine: `scripts/qualify/c28-remote/README.md`.
- A second tokenizer calibration with an API key: `test/fixtures/tokenizer-corpus/README.md`.
- An untracked `AGENTS.md` in the main checkout, identical to the parked Codex copy, left untouched.
