# Requirements → implementation → test matrix (foundation programme)

Living document. Status vocabulary is the package's: **passed** / **failed** / **unavailable** / **waived-by-explicit-ruling** / **not-tested**; plus **baseline-evidence** (gap reproduced at `d7860e0` with a positive control) and **partial** (some assertions pass, named gaps remain). Nothing unavailable is ever reported as passed.

**Last update: 2026-09-15, after the five-lane merge into `foundation/v3`.** Counts below are measured from the merged tree (`npx vitest run test/acceptance`), not copied from lane reports. `todo` counts are `it.todo` entries: assertions whose surface no lane built. They are neither passes nor failures, and the owning lane or the reason is named in each one.

Sources: package `acceptance-cases.md` coverage map; `test/contracts/`, `test/acceptance/baseline/`, `test/acceptance/oracles/` (28 cases, dev + held-out for 23), `test/acceptance/slice/`, `test/acceptance/cases/`, `test/acceptance/harness/`, plus the lanes' own suites under `test/adapters/`, `test/cli/`, `test/exchange/`, `test/migrate/`, `test/retrieval/`.

## Requirements

| R | Requirement | Min cases | Implementation | Tests | Status |
|---|---|---|---|---|---|
| R01 | Independent identities | C04 C06 C13 C24 | `src/contracts/{ids,event,scope}.ts`; `src/adapters/identity.ts` (store id ≠ repo id, host/human keys); `src/retrieval/store-identity.ts` | `test/contracts`; `test/cli/v3-verbs.test.ts` "store descriptor"; c04 13 pass / 2 todo; c24 16 pass / 3 todo; gap4 FLIPPED | passed for the identity split; **partial** overall — C13 (shared store, worktrees, submodules) has no executable case |
| R02 | Evidence envelope | C01 C04 C07 C17 C21 | `src/contracts/{event,canonical}.ts` (three distinct hashes); `src/events/event-store.ts` attachment handling | `test/contracts` "three hashes"; c17 16 pass / 3 todo; c21 37 pass / 2 UNAVAILABLE | **partial** — C07 (header/BOM/newline encodings) still has no dedicated case test |
| R03 | Evidence classes | C02 C08 C09 C12 C21 | `src/contracts/{evidence,validate}.ts` (ingress decides class); `src/cli/v3-verbs.ts` ceremony (`human_ruling` only from a signed ceremony) | `test/contracts`; c08 12 pass / 4 todo; c12 10 pass / 3 todo; `slice/c09` 16 pass / 1 todo; gap6 FLIPPED | **passed** |
| R04 | External authority | C01 C02 C03 C06 C10 | `src/contracts/records.ts` work refs; `lifecycle.ts` receipt stages; `src/adapters/` receipts per stage | c01 12 pass / 2 todo; c03 8 pass / 2 todo; `slice/c10` 12 pass / 1 todo; `test/adapters/oracles-lane03.test.ts` C06 arm | **partial** — the *social/remote* liveness half is untouched: `gap5-staleness` still reproduces |
| R05 | Lossless semantic lifecycle | C09 C11 C14 C16 C20 | `src/contracts/lifecycle.ts`; `src/events/projection.ts` reducer incl. part-level projections and the draft.3 `correctionFor` conflict rule | `slice/c09` 16/1, `slice/c11` 11/0, `slice/c14` 19/2, `slice/c16` 23/1; c20 16 pass / 3 todo; c22 14 pass / 2 todo | **passed** |
| R06 | Scoped relations | C02 C03 C09 C16 C22 | `src/contracts/scope.ts` (`scopeMatches` / `scopeGoverns` / `scopeAuthorizes`); admission scope checks in `event-store.ts` | `test/contracts` scope algebra incl. draft.3; c02 8/2; c22 cross-scope quarantine | **passed** |
| R07 | Durable writes and retries | C10 C17 C18 C23 C24 | `src/events/{db,event-store}.ts` journal keyed (id, digest), receipt log, resume | `slice/c10` 12/1; c17 16/3; c18 13 pass / 4 todo; c24 16/3 | **partial** — C23 (saturation, lost embedding/reranker) has no executable case |
| R08 | Distributed exchange state | C10 C11 C18 C19 C27 C28 | `src/contracts/delivery.ts`; `src/exchange/{fs-transport,git-transport,relay,inbox,outbox,status}.ts` | `slice/c10`, `slice/c11` both orders; `test/exchange/*`; c18 13/4; c19 12 pass / 4 todo | **partial** — C27 is lane 03's adapter arm only; C28 unavailable |
| R09 | Git or alternative transport | C11 C13 C14 C17 C20 C28 | `src/exchange/git-transport.ts` — dedicated exchange ref, verified union merges, dirty-checkout non-interference | `test/exchange/git-transport.test.ts`; `slice/c14` Git arm | **partial** — C13 and C28 not executable here |
| R10 | Automatic lifecycle capture/recall | C06 C15 C27 | `src/adapters/{claude-code,codex,library}.ts`; `plugin/hooks/hooks.json` (PreCompact + compact SessionStart) | gap1 + gap2 FLIPPED; `test/adapters/oracles-lane03.test.ts` 18 pass / 11 todo; `test/hooks/*` | **partial** — Claude Code arm tested on the real host; the Codex arm is **unavailable** (DN19) |
| R11 | Multiple backends | C15 C23 C28 | `src/core/{context,commands}.ts` + the `twining` CLI (`capabilities`); library adapter for hostless backends | `test/cli/twining.test.ts`; `oracles-lane03.test.ts` "second backend without hooks (R11)" | **partial** — the second REAL backend (Codex) is unavailable; the library path is tested |
| R12 | Source freshness | C01 C04 C14 C19 C27 | `src/retrieval/lifecycle.ts` (`freshness`, `qualifies`); `src/adapters/git-connector.ts`; revision-bound scopes | c01 (revision binding + control); `slice/c14`; gap4 FLIPPED | **partial** — `gap5-staleness` (remote/social signals) still reproduces |
| R13 | Hard scope before ranking | C04 C09 C12 C25 | `src/retrieval/select.ts` `selectCandidates` — one gate on every path (dense, lexical, graph, chunk, temporal, exact-id, cache, diagnostics, export) | gap3 FLIPPED; c25 14 pass / 3 todo; c12 10/3; `test/acceptance/cases/production-entrypoints.test.ts` 12 pass | **passed** |
| R14 | Useful recall | C03 C05 C09 C25 | `src/retrieval/{select,packet,render}.ts` — required-facts-first packet | c03 8/2; c05 10 pass / 4 todo; c25 14/3 | **partial** — recall *quality* is a trial question, not a unit one; the dev-scale trial has not run |
| R15 | Budget and coverage | C15 C26 C27 | `src/retrieval/tokenizer.ts` (proven 1 token/byte bound + calibration table), one budget currency across selection, costing and receipt | gap7 FLIPPED; c26 12 pass / 2 todo | **partial** — the tokenizer is a *proven bound*, not a calibrated table: the calibration pass has never completed (see Known gaps) |
| R16 | Explain and prove injection | C07 C10 C15 C18 C26 | `src/retrieval/{explain,receipts}.ts`; `lifecycle.ts` receipt payload; emitted-bytes hash | gap7 FLIPPED; c26 12/2; `test/retrieval/*` | **partial** |
| R17 | Instruction and permission isolation | C02 C08 C12 C25 | `src/contracts/validate.ts` (class from ingress, rulings signed); `src/retrieval/render.ts` (imperatives gated on class); `checkCredential` author-assertion binding | `test/contracts`; c08 12/4; c25 14/3; gap6 FLIPPED | **passed** |
| R18 | Data handling and access | C12 C19 C23 C24 C28 + data-flow | `src/contracts/signing.ts`; membership + chain of trust; the offline switch (`TWINING_OFFLINE` / `embeddings.offline`); `docs/operations/` data-flow | `test/contracts` signing; `test/core/offline-switch.test.ts`; c19 12/4; c12 10/3 | **partial** — C23 and C28 not executable here |
| R19 | Portability, deletion, upgrades | C14 C16 C17 C20 C21 C28 | `src/migrate/{v3-forward,v3-rollback,legacy-scan}.ts` — `migrate --to 3`, `rollback --to 2`, forward recovery, old-client refusal | c21 37 pass / 2 UNAVAILABLE; c20 16/3; c17 16/3; `test/migrate/*` | **partial** — `gap8-export-ingest` still reproduces (file-wins reverts lifecycle), a named open design decision |
| R20 | Observability and benefit | C15 C18 C23 C26 C27 C28 + trial | `src/exchange/status.ts` + `twining_exchange_status`; `twining_migrate_status`; `twining doctor`; `scripts/measure/` | `test/exchange/exchange-status.test.ts`; c18 13/4; c26 12/2 | **partial** — the *benefit* half needs the trial, which has **not been run** (A14) |

## Cases

Counts are from the merged tree. "todo" is `it.todo`: an assertion whose surface no lane built, with the owner named in the todo text.

| C | Case | Oracle | Test | Verdict |
|---|---|---|---|---|
| C01 | review range A vs head B | `C01.oracle.md` + held-out | `cases/c01.test.ts` 12 pass / 2 todo | **partial** |
| C02 | broad publication grant replaces narrower hold | `C02.oracle.md` + held-out | `cases/c02.test.ts` 8 pass / 2 todo | **partial** |
| C03 | three consumers, three prerequisites | `C03.oracle.md` + held-out | `cases/c03.test.ts` 8 pass / 2 todo | **partial** — owned by lane 04 (DN26), superseding lane 05's `C03.todo.md` stub |
| C04 | same display name, different revisions | `C04.oracle.md` + held-out | `cases/c04.test.ts` 13 pass / 2 todo | **partial** |
| C05 | finding recurs after accepted no-patch | `C05.oracle.md` + held-out | `cases/c05.test.ts` 10 pass / 4 todo | **partial** |
| C06 | worker returns while review pending | `C06.oracle.md` + held-out | `adapters/oracles-lane03.test.ts` C06 arm; gap2 FLIPPED | **partial** — 3 todos belong to lanes 02/04 and the qualification engine |
| C07 | header/BOM/newline encodings | `C07.oracle.md` + held-out | `test/contracts` three-hash separation only | **not-tested** as a case — no `c07.test.ts` exists |
| C09 | correction for Story A only | `C09.oracle.md` (14 inv, 12 OQ) | `slice/c09.test.ts` 16 pass / 1 todo | **partial** |
| C10 | repeat/reorder/redeliver, lost ack, correction before predecessor | `C10.oracle.md` (20 inv, 12 OQ) | `slice/c10.test.ts` 12 pass / 1 todo (injection half) | **partial** |
| C11 | disconnected incompatible successors | `C11.oracle.md` (18 inv, 10 OQ) | `slice/c11.test.ts` 11 pass, both orders + skews, mutation-checked | **passed** |
| C12 | credential claims another principal / unauthorized repo / ruling capability | `C12.oracle.md` + held-out | `cases/c12.test.ts` 10 pass / 3 todo | **partial** |
| C13 | shared store, identical paths, linked worktrees, submodule, dirty checkout | `C13.oracle.md` + held-out | `cases/C13.todo.md` stub only | **not-tested** — the stub's stated blocker (no Git carrier) is gone; it is now a coverage gap, not a dependency |
| C14 | git rewind / force-push / cherry-pick | `C14.oracle.md` (16 inv, 10 OQ) | `slice/c14.test.ts` 19 pass / 2 todo, fs + Git arms | **partial** |
| C15 | real Codex + second backend lifecycle | `C15.oracle.md` + held-out | `adapters/oracles-lane03.test.ts` C15 arm (Claude Code, real host); 5 todos to lanes 02/04 | **partial (Claude Code) / UNAVAILABLE (Codex half)** — Codex real-host verification is blocked on one-time interactive hook trust; `codex exec --dangerously-bypass-hook-trust` runs the hook without filesystem effect and UserPromptSubmit never fires in exec mode (DN19). Never reported as passed. |
| C16 | partial supersession, revocation, archival, restoration | `C16.oracle.md` (23 inv, 12 OQ) | `slice/c16.test.ts` 23 pass / 1 todo; L1–L4 + A3.4 closed by part-level projections | **partial** |
| C17 | truncated/conflicted export, shallow checkout, incompatible schema | `C17.oracle.md` + held-out | `cases/c17.test.ts` 16 pass / 3 todo | **partial** |
| C18 | kill between durable steps | `C18.oracle.md` + held-out | `cases/c18.test.ts` 13 pass / 4 todo; `test/exchange/fault-worker.ts` | **partial** |
| C19 | revoke access while offline | `C19.oracle.md` + held-out | `cases/c19.test.ts` 12 pass / 4 todo | **partial** |
| C20 | delete/retract/redact, reconnect old replica | `C20.oracle.md` + held-out | `cases/c20.test.ts` 16 pass / 3 todo | **partial** |
| C21 | migrate legacy, interrupt, roll back | `C21.oracle.md` + held-out | `cases/c21.test.ts` 37 pass / 2 todo | **partial** — the 2 are reported **UNAVAILABLE**, not passed: A-DEL-01 (emitted-bytes hash bound to host/session/turn) and A-OLD-04 (no schema-negotiating old client exists to test against) |
| C22 | cycles, dangling, cross-scope, competing corrections | `C22.oracle.md` + held-out | `cases/c22.test.ts` 14 pass / 2 todo | **partial** — INV-11 (competing corrections resolved by array order) CLOSED at the merge; the remaining 2 todos are lane 04's qualification graph and lane 05's fixture wording |
| C23 | saturation, lost embedding/reranker | `C23.oracle.md` + held-out | `cases/C23.todo.md` stub only | **not-tested** — needs a queue/backpressure surface no lane built |
| C24 | id reuse with different bytes, rename repo, rotate credential | `C24.oracle.md` + held-out | `cases/c24.test.ts` 16 pass / 3 todo | **partial** |
| C25 | out-of-scope matches in every path | `C25.oracle.md` + held-out | `cases/c25.test.ts` 14 pass / 3 todo; gap3 FLIPPED; `production-entrypoints.test.ts` | **partial** |
| C26 | required context exceeds budget | `C26.oracle.md` + held-out | `cases/c26.test.ts` 12 pass / 2 todo; gap7 FLIPPED | **partial** |
| C27 | two compactions + restart mid-review | `C27.oracle.md` + held-out | `adapters/oracles-lane03.test.ts` C27 arm; 3 todos to lanes 02/04 | **partial** — owned by lane 03 (DN26), superseding lane 05's `C27.todo.md` stub |
| C28 | multi-user/multi-computer exchange + rebuild at scale | `C28.oracle.md` + held-out | `scripts/qualify/c28-remote/` bundle + verifier; one-machine run 12 pass / 1 fail / 21 unavailable | **UNAVAILABLE** — the second computer is Dave's action (RB3/A15). The one-machine half is not the case. |

## Instrument health

| Instrument | Evidence |
|---|---|
| oracle loader + INDEX | `test/acceptance/harness/oracles.test.ts` 156 pass; INDEX carries 1230 assertion ids |
| instrument-can-fail switchboard | `test/acceptance/harness/switchboard.test.ts` 13 pass — all six controls break their assertion with the switch flipped |
| mutation checks | C11 (class-rank off → 4 failures; conflict detection off → 5); admission monotonicity (fix disabled → the new test AND C21 A-REC-10 fail); `correctionFor` (array order restored → all 3 C22 A11 tests fail) |

## Baseline reproductions (Stage 0, `d7860e0`)

Characterization tests: green while the gap exists, and **flipped** by the lane that closed it — the assertion is rewritten to assert the closed state, keeping the original defect's arithmetic in the comment. Positive controls are unchanged throughout.

| Gap | Test | State after the merge |
|---|---|---|
| 1 session-start injects instructions only; no compaction hook | `gap1-session-start.test.ts` | **FLIPPED** (lane 03) — hooks.json registers PreCompact and a compact SessionStart |
| 2 SubagentStop generic status | `gap2-subagent-stop.test.ts` | **FLIPPED** (lane 03) |
| 3 assemble admits out-of-scope semantic matches | `gap3-assemble-scope.test.ts` | **FLIPPED** (lane 04) |
| 4 provenance from store root, not producing worktree | `gap4-provenance.test.ts` | **FLIPPED** (lane 03) |
| 5 staleness local-only | `gap5-staleness.test.ts` | **still reproduces** — no lane addressed remote/social liveness signals (R04, R12) |
| 6 caller-supplied status/agent/promoter | `gap6-authority.test.ts` | **FLIPPED** (lane 04 render side + lane 03 write path) |
| 7 formatter tiers, 4-char estimate, count ≠ delivered | `gap7-formatter-budget.test.ts` | **FLIPPED** (lane 04) |
| 8 export rewrites in place; file-wins reverts lifecycle | `gap8-export-ingest.test.ts` | **still reproduces** — file-wins precedence is a named open design decision, deliberately not patched opportunistically |

## Known gaps, stated plainly

1. **C28 is UNAVAILABLE.** It needs two real computers (RB3/A15). The bundle and verifier exist; the run is Dave's action. The one-machine partial run is not the case and is never reported as one.
2. **C15's Codex half is UNAVAILABLE.** Blocked on one-time interactive hook trust inside Codex (DN19). The Claude Code half is verified against the real host.
3. **C07, C13 and C23 have no executable case test.** C13's original blocker (the Git carrier) has since merged, so it is a coverage gap rather than a dependency; C23 needs a queue/backpressure surface no lane built; C07 is covered only by the contracts' three-hash separation.
4. **Gaps 5 and 8 still reproduce.** Remote/social staleness signals, and file-wins precedence on ingest. Both are deliberate: gap 8 in particular is a named open design decision, not an oversight.
5. **The tokenizer ships a proven bound, not a calibration.** `scripts/calibrate-tokenizer.mjs` aborted on a whitespace-only corpus document (the count-tokens API refuses an empty text block); the script is fixed but **has not been run** — there is no API key on this machine.
6. **The dev-scale trial has not been run** (A14), so R20's benefit half and R14's recall-quality half are open. Nothing here reports trial evidence.
7. **`plugin/BEHAVIORS.md` is stale** — its header says 35 tools, it documents 37, and it omits `twining_amend`, `twining_triage`, `twining_exchange_status` and `twining_migrate_status`. It is the eval harness's ground truth, so this matters; fixing it requires a plugin version bump and bundle rebuild, which is release work rather than merge work.
