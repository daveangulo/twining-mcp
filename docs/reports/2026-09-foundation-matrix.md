# Requirements → implementation → test matrix (foundation programme)

Living document. Status vocabulary is the package's: **passed** / **failed** / **unavailable** / **waived-by-explicit-ruling** / **not-tested**; plus **baseline-evidence** (gap reproduced at `d7860e0` with a positive control) and **partial** (some assertions pass, named gaps remain). Nothing unavailable is ever reported as passed. Last update: 2026-09-15 (Stage 0).

Sources: package `acceptance-cases.md` coverage map; tests under `test/contracts/`, `test/acceptance/baseline/`, `test/acceptance/oracles/` (28 cases, dev + held-out for 23), `test/acceptance/slice/`.

## Requirements

| R | Requirement | Min cases | Implementation (current) | Tests (current) | Status |
|---|---|---|---|---|---|
| R01 | Independent identities | C04 C06 C13 C24 | `src/contracts/ids.ts`, `event.ts` (producer/source), `scope.ts` (repo_id) | `test/contracts` ids/scope; baseline gap4 (provenance from store root) | partial — contracts only; store/adapters pending |
| R02 | Evidence envelope | C01 C04 C07 C17 C21 | `event.ts` attachments (3 distinct hashes), `canonical.ts` | `test/contracts` "three hashes" | partial |
| R03 | Evidence classes | C02 C08 C09 C12 C21 | `evidence.ts`, `validate.ts` (ingress decides class) | `test/contracts` rejections; baseline gap6 | partial — ceremony CLI pending |
| R04 | External authority | C01 C02 C03 C06 C10 | `records.ts` work refs; `lifecycle.ts` receipt stages | baseline gap2 (generic SubagentStop) | not-tested |
| R05 | Lossless semantic lifecycle | C09 C11 C14 C16 C20 | `lifecycle.ts`; `src/events/projection.ts` reducer (slice) | slice C09/C11/C14/C16 (95 pass, 12 todo) | partial — slice; C20 + part-level projections pending |
| R06 | Scoped relations | C02 C03 C09 C16 C22 | `scope.ts` scopeGoverns; admission pending | `test/contracts` scope algebra | partial |
| R07 | Durable writes and retries | C10 C17 C18 C23 C24 | `canonical.ts`; `src/events/event-store.ts` journal keyed (id, digest) | slice C10 (12 pass) | partial — C17/C18/C23/C24 pending |
| R08 | Distributed exchange state | C10 C11 C18 C19 C27 C28 | `delivery.ts`; `src/exchange/{fs-transport,relay,inbox,outbox}.ts` | slice C10/C11 both orders, both transports | partial — Git carrier, C18/C19/C27/C28 pending |
| R09 | Git or alternative transport | C11 C13 C14 C17 C20 C28 | ADR §8 (exchange ref + fs/relay reference); Git carrier pending | steelman appendix A | not-tested |
| R10 | Automatic lifecycle capture/recall | C06 C15 C27 | host matrices (`docs/operations/hosts-*`); adapters pending (lane 03) | baseline gap1, gap2 | baseline-evidence |
| R11 | Multiple backends | C15 C23 C28 | CLI lane (2.x) in flight; `capabilities` pending | — | not-tested |
| R12 | Source freshness | C01 C04 C14 C19 C27 | `records.ts` observation (volatile); connector pending | baseline gap4, gap5 | baseline-evidence |
| R13 | Hard scope before ranking | C04 C09 C12 C25 | `scope.ts`; retrieval pending (lane 04) | baseline gap3 (leak reproduced) | baseline-evidence |
| R14 | Useful recall | C03 C05 C09 C25 | pending (lane 04) | — | not-tested |
| R15 | Budget and coverage | C15 C26 C27 | pending (lane 04, DP4 tokenizer) | baseline gap7 | baseline-evidence |
| R16 | Explain and prove injection | C07 C10 C15 C18 C26 | `lifecycle.ts` receipt payload; explain packet pending | baseline gap7 | baseline-evidence |
| R17 | Instruction and permission isolation | C02 C08 C12 C25 | `validate.ts` (class from ingress; rulings signed) | `test/contracts` | partial |
| R18 | Data handling and access | C12 C19 C23 C24 C28 + data-flow | `signing.ts`; membership schema; docs pending | `test/contracts` signing | partial |
| R19 | Portability, deletion, upgrades | C14 C16 C17 C20 C21 C28 | ADR §10 contract; migrate/rollback pending (lane 02) | — | not-tested |
| R20 | Observability and benefit | C15 C18 C23 C26 C27 C28 + trial | pending (lanes 02/05) | — | not-tested |

## Cases

| C | Case | Oracle | Test | Verdict |
|---|---|---|---|---|
| C01 | review range A vs head B | `C01.oracle.md` + held-out | — | not-tested |
| C02 | broad publication grant replaces narrower hold | `C02.oracle.md` + held-out | — | not-tested |
| C03 | three consumers, three prerequisites | `C03.oracle.md` + held-out | — | not-tested |
| C04 | same display name, different revisions | `C04.oracle.md` + held-out | — | not-tested |
| C05 | finding recurs after accepted no-patch | `C05.oracle.md` + held-out | — | not-tested |
| C06 | worker returns while review pending | `C06.oracle.md` + held-out | baseline gap2 | baseline-evidence |
| C07 | header/BOM/newline encodings | `C07.oracle.md` + held-out | `test/contracts` three-hash separation | partial |
| C08 | injected "human approved forbidden action" | `C08.oracle.md` + held-out | `test/contracts` class-on-ingress | partial |
| C09 | correction for Story A only | `C09.oracle.md` (14 inv, 12 OQ) | `test/acceptance/slice/c09.test.ts` 13 pass / 2 todo | partial (slice) |
| C10 | repeat/reorder/redeliver, lost ack, correction before predecessor | `C10.oracle.md` (20 inv, 12 OQ) | `slice/c10.test.ts` 12 pass / 1 todo (injection half) | partial (slice) |
| C11 | disconnected incompatible successors | `C11.oracle.md` (18 inv, 10 OQ) | `slice/c11.test.ts` 11 pass, both orders + skews, mutation-checked | passed (slice scope) |
| C12 | credential claims another principal / unauthorized repo / ruling capability | `C12.oracle.md` + held-out | `test/contracts` SIGNATURE_* | partial |
| C13 | shared store, identical paths, linked worktrees, submodule, dirty checkout | `C13.oracle.md` + held-out | baseline gap4 | baseline-evidence |
| C14 | git rewind / force-push / cherry-pick | `C14.oracle.md` (16 inv, 10 OQ) | `slice/c14.test.ts` 12 pass / 3 todo (Git arm, offline label) | partial (fs arms A/B) |
| C15 | real Codex + second backend lifecycle | `C15.oracle.md` + held-out | host matrices only | unavailable (not yet run) |
| C16 | partial supersession, revocation, archival, restoration | `C16.oracle.md` (23 inv, 12 OQ) | `slice/c16.test.ts` 12 pass / 5 todo (part-level projections) | partial (slice) |
| C17 | truncated/conflicted export, shallow checkout, incompatible schema | `C17.oracle.md` + held-out | `test/contracts` ENVELOPE_VERSION_UNSUPPORTED / UNKNOWN_KIND | partial |
| C18 | kill between durable steps | `C18.oracle.md` + held-out | — | not-tested |
| C19 | revoke access while offline | `C19.oracle.md` + held-out | — | not-tested |
| C20 | delete/retract/redact, reconnect old replica | `C20.oracle.md` + held-out | steelman appendix A (smallest evolution satisfies) | not-tested |
| C21 | migrate legacy, interrupt, roll back | `C21.oracle.md` + held-out | — | not-tested |
| C22 | cycles, dangling, cross-scope, competing corrections | `C22.oracle.md` + held-out | — | not-tested |
| C23 | saturation, lost embedding/reranker | `C23.oracle.md` + held-out | — | not-tested |
| C24 | id reuse with different bytes, rename repo, rotate credential | `C24.oracle.md` + held-out | `test/contracts` (digest mismatch) | partial |
| C25 | out-of-scope matches in every path | `C25.oracle.md` + held-out | baseline gap3 | baseline-evidence |
| C26 | required context exceeds budget | `C26.oracle.md` + held-out | baseline gap7 | baseline-evidence |
| C27 | two compactions + restart mid-review | `C27.oracle.md` + held-out | — | not-tested |
| C28 | multi-user/multi-computer exchange + rebuild at scale | `C28.oracle.md` + held-out | — | unavailable (second computer per RB3) |

## Baseline reproductions (Stage 0, `d7860e0`)

| Gap | Test | Reproduced | Control |
|---|---|---|---|
| 1 session-start injects instructions only; no compaction hook | `test/acceptance/baseline/gap1-session-start.test.ts` | yes | pass |
| 2 SubagentStop generic status | `gap2-subagent-stop.test.ts` | yes | pass |
| 3 assemble admits out-of-scope semantic matches | `gap3-assemble-scope.test.ts` | yes | pass |
| 4 provenance from store root, not producing worktree | `gap4-provenance.test.ts` | yes | pass |
| 5 staleness local-only | `gap5-staleness.test.ts` | yes | pass |
| 6 caller-supplied status/agent/promoter | `gap6-authority.test.ts` | yes | pass |
| 7 formatter tiers, 4-char estimate, count ≠ delivered | `gap7-formatter-budget.test.ts` | yes | pass |
| 8 export rewrites in place; file-wins reverts lifecycle | `gap8-export-ingest.test.ts` | yes | pass |

These tests are characterization tests: they are green while the gap exists and turn red when a lane closes it. Each lane must flip its gap tests and keep the positive controls green.
