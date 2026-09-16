# Foundation programme — execution log

Audit trail for `2026-09-15-foundation-programme-plan.md`. Append-only, in the order things happened. Four registers: **Assumptions** (A), **Discovered needs** (DN), **Decisions** (D), **Supersessions** (S). Twining decision ids are given where a record exists.

## Rulings (2026-09-15, Dave)

| RB | Ruling | Consequence |
|---|---|---|
| RB1 | parallel | CLI lane on `feat/cli-2.17` from `main`, shares the command core; ships as 2.17.0 under Dave's tag; `foundation/v3` rebases on it |
| RB2 | absorb | W2/2.17.0 and 2.17.1 plans superseded as plans of record (S1 below) |
| RB3 | "I have another computer that can be used" | C28 runs on Dave's other computer from a scripted bundle I prepare (A15) |
| RB4 | "codex installed locally" | Codex CLI 0.154.0 found via Homebrew (DN1); lane 03 tests the real host |
| RB5 | "not clear what you're asking … can switch to field machine for expensive runs after confidence" | Interpreted as A14: dev-scale trial here under Max auth; full-scale deferred to Dave's machine; reported as not-yet-run until then |
| RB6 | recommendation | Signed interactive ceremony + host-attested `human_statement` |
| RB7 | agreed | `foundation/v3`, 3.0.0-alpha.N, no tags, draft PR early, Codex work parked on `wip/codex-plugin` |

## Assumptions

- **A1–A13** — as listed in the plan §4 (unchanged).
- **A14** (2026-09-15) — RB5 interpretation: the matched trial runs at development scale on this machine under the Claude Max login (the harness supports it without an API key; cost is flat, limited by usage windows). The full 360-trial run plus corpus tiers is Dave's action on his other machine once the solution has earned it; until then the final report lists it as *not yet run*, never as passed.
- **A15** (2026-09-15) — RB3 interpretation: the second computer is Dave's other machine; C28 qualification runs from a scripted, self-contained bundle (`scripts/qualify/c28-remote/`) that he executes and whose artifacts he returns; a remote Claude Code session on that machine is an acceptable executor of the same bundle.
- **A16** (2026-09-15) — Codex host: the Homebrew Codex CLI 0.154.0 is the tested Codex version; it must be invoked through a login shell or absolute path because the non-login PATH does not carry it.

## Discovered needs

- **DN1** (2026-09-15) — Codex CLI 0.154.0 installed at `/opt/homebrew/bin/codex` (symlink dated 12:52 today). Not on the non-login PATH. Same version the package cites for the field's environment.
- **DN2** (2026-09-15) — The W2/2.17.0 and 2.17.1 plans were never committed (untracked). They commit to `main` as absorbed drafts with a superseded banner (S1).
- **DN3** (2026-09-15) — The in-flight Codex work is larger than the tracked diff: `AGENTS.md`, `docs/CODEX.md`, `docs/plans/2026-09-09-codex-plugin.md`, `plugins/`, `scripts/build-codex-plugin.mjs`, `scripts/codex-plugin/` are all untracked and belong to the parking commit.
- **DN4** (2026-09-15) — `git diff` reports `test/plugin-tool-references.test.ts` as binary; to inspect before the parking commit (likely a non-UTF-8 byte in the file).
- **DN5** (2026-09-15) — `timeout` is not available on this macOS; use the Bash tool's timeout.

## Decisions

- **D1** (2026-09-15, `01M2K97A9FTJR13S7K7QWH5YHY`) — Rulings-gated draft plan before any execution.
- **D2** (2026-09-15, `01M2K9813SSVCD2B12PXVMW69Q`) — Architecture hypothesis: immutable event log + derived projections; Git-as-protocol default; reference relay behind the same interface. Not committed until Stage 0 shows the failing case (§3.4).
- **D3–D7** (2026-09-15) — RB1/RB2/RB3-5/RB6/RB7 outcomes recorded as Twining decisions (see the session record after the rulings).

## Supersessions

- **S1** (2026-09-15) — `docs/plans/2026-09-08-2.17.0-w2-implementation.md` and `docs/plans/2026-09-08-2.17.1-implementation.md` are superseded as plans of record by the foundation programme (RB2). Their items are carried by: assemble disclosure / budget order / payload measurement → S3 (R15/R16); sync-state disclosure / createSuperseding / ingest counters / fallback diagnosability → S1 (R07/R08/R19/R20); lineage reverse scan → S1 lifecycle resolver (R05/R06); tool-description byte baseline → S2 CLI/MCP contract measurement. The files stay in the repo with a banner; nothing in them is executed as written.

## 2026-09-15 — execution start

- **DN6** — Named teammates (split-pane agents) are unavailable in this session ("Could not determine current tmux pane/window"); the CLI lane runs as a background subagent instead. No change to ownership or reporting.
- **DN4 resolved** — the binary-flagged test file carries a deliberate `"\x00"` fixture entry; not a defect.
- **D8** — Repo mechanics executed per RB7: Codex work parked at `dedaacc` (`wip/codex-plugin`); shared base `07230e6` on `main` (plan, log, absorbed W2 drafts with banner, session records); `foundation/v3` cut from it; CLI lane worktree `.claude/worktrees/cli-2.17` on `feat/cli-2.17`.
- **D9** — Stage 0 launched as workflow `wf_f80a3b3b-ac2`: 8 worktree-isolated gap reproductions with positive controls, 5 implementation-blind oracles (C10, C11, C14, C16, C09), one steelman of the smallest evolution (§3.4), two host capability matrices (Claude Code 2.1.272, Codex 0.154.0). Reproductions run at `07230e6`, whose `src/` equals the baseline `d7860e0`.
- **D10** — CLI lane dispatched (opus) with the lead-settled design: `createTwiningContext` extracted from `createServer`; a `CommandRegistry` shared by MCP and CLI; `twining` bin with a single JSON envelope, exit codes 0/1/2, `capabilities`; offline/sandbox-safe; `STORE_UNWRITABLE` instead of silent store fallback. Controller commits; lane reports.

## 2026-09-15 — Stage 0 evidence

- **DN7** — At 13:33 `/Applications/Xcode.app` was updated (root, mtime 13:33); Apple's `/usr/bin/git` now refuses with the Xcode license prompt and `/opt/homebrew/bin/git` does not exist, so `brew` fails too. The first Stage 0 commit was lost silently (printed an empty hash) and redone. Workaround: `PATH=/Library/Developer/CommandLineTools/usr/bin:$PATH` (git 2.50.1). **Dave's action:** `sudo xcodebuild -license accept`. Until then git-spawning tests/hooks/subagents on the plain PATH fail; A11 unchanged.
- **DN8** — Steelman correction to the plan: the smallest evolution DOES satisfy C20 (tombstone records) and C21; the plan §9 and ADR §9.1 predicted C20 would fail. Corrected in ADR §9.1; the justification now rests on C10/C11/C14/C16/C22 + R05/R08.
- **DN9** — Claude Code's injectable surface is 12 of 33 events; PreCompact/PostCompact/SessionEnd cannot inject. Codex has 12 events, 5 injectable; SubagentStop/Stop/PreCompact/PostCompact cannot. Compaction recovery must ride SessionStart(compact/resume) and UserPromptSubmit (D12).
- **DN10** — Named teammates unavailable (DN6) held; both new lanes run as background subagents.
- **D11** (`01M2KCF…`, recorded) — Foundational change JUSTIFIED by the failing cases; ADR stays PROPOSED until the slice passes its oracles.
- **D12** — Compaction re-injection channel per host (see DN9).
- **D13** — Dispatched lane 02 seed (opus): EventStore over `store/events.db` + `events/<yyyy-mm>/`, fs transport + reference relay, inbox/outbox, slice tests per oracle (C10/C11 first). Owns `src/events/**`, `src/exchange/**`, `test/acceptance/slice/**`.
- **D14** — Dispatched oracle-rulings pass (opus): appendix B answers all 56 oracle open questions from the ADR, flags LEAD DECISION NEEDED and invariant/ADR conflicts; oracles themselves are never edited.
- Workflow `wf_f80a3b3b-ac2`: 16 agents, 0 errors, 1.45M tokens, 12.1 min; commit `474dfac`.

## 2026-09-15 — CLI lane (RB1) delivered

- **D15** — CLI lane (opus, 28 min, ~320k tokens) delivered on `feat/cli-2.17`: shared command core (`src/core/*`, 39 handlers moved verbatim, MCP adapter loop), `createTwiningContext` extracted from `createServer`, `twining` bin (JSON envelope, exit 0/1/2, `capabilities`, `STORE_UNWRITABLE`, offline), docs + CHANGELOG. Full suite in the worktree 121 files / 1739 passed with the CLT git. Lane rulings recorded (`01M2KDH436…`, `01M2KDH4D8…`): plugin keeps shipping only the MCP bundle for now; nudge-per-process accepted; full-surface gate not applied in the CLI; real package version; plain-text `--version`.
- **DN11** — 20 of the lane's test failures were the Xcode git shim (DN7), none real; the lane deliberately kept its new tests git-free.
- **Next** — adversarial review of `main..feat/cli-2.17` (behavior-neutrality, CLI contract/sandbox safety, refactor quality) before any merge; the branch ships as 2.17.0 only under Dave's tag.

## 2026-09-15 — CLI review + oracle rulings

- **D16** — CLI review workflow `wf_49f1131a-59e` (29 agents, 0 errors, 17 min): neutrality lens 0 findings (19 properties identical); cli-contract lens BLOCKER (exit 134 on success with cached ONNX model — `process.exit` races onnxruntime), MAJOR (unknown flags silently ignored), 3 minors; quality lens 4 doc/count corrections + 1 nit; 3 findings refuted (STORE_UNWRITABLE doc paragraph ×1 with two refuters, embedder nit split). Confirmed items sent to the CLI lane for fix; commit after re-verification.
- **DN12** — The committed plugin bundle (`plugin/server/twining-server.mjs`) will fail the CI freshness check on `feat/cli-2.17` until `bump-plugin-version.sh` rebuilds it at release; intentionally left for the release step (Dave's tag).
- **D17** — Oracle rulings appendix B: 54 defaults stand, 12 adjusted with ADR reasons, 7 lead rulings made (recorded `01M2KDRBYZ…`, `01M2KDRC8D…`); `reinstated` kind added to contracts; ADR §2.3/§4.1/§4.3/§4.4/§12/§13 updated; commit `d862f6c`.
- **DN13** — Lead extraction defect: oracle open-question/invariant lists were not written to the oracle files in Stage 0; repaired from the journal (warning `01M2KDRCJ1…`). Lesson: extraction scripts must write every structured field, not only the prose body.

## 2026-09-15 — environment restored

- **DN7 resolved** — Dave ran `sudo xcodebuild -license accept`; `/usr/bin/git` (2.54.0) and `brew` work on the plain PATH again. The CLT-git PATH prefix is no longer required.
- **DN14** — The auto-archiver deleted git-tracked `.twining/records/posts/2026-08/*.json` files during this session (known behavior: archive prunes only posts; decisions are never pruned). The deletions are committed alongside the next records commit, as prior sessions did.
- **D18** — Pruned the eight Stage 0 reproduction worktrees (`wf_f80a3b3b-ac2-2..9`) and their branches after confirming the gap test files match what is committed on `foundation/v3`.

## 2026-09-15 — Stage 0 slice landed; ADR accepted

- **D19** — Lane 02 slice delivered (opus, 47 min, ~460k tokens): `src/events/{db,projection,event-store}.ts`, `src/exchange/{fs-transport,relay,inbox,outbox}.ts`, `test/acceptance/slice/*` — 73 oracle-derived assertions pass, 12 todo (other lanes), C10/C11 converge in both delivery orders plus reverse/shuffled, mutation-checked (class-rank off → 4 C11 failures; conflict detection off → 5).
- **D20** — ADR status → ACCEPTED (draft 2). All Stage 0 conditions met. §12 scenario corrected (the governing correction is authored by the ruling's own human principal; a class-4 correction of a class-5 ruling is contested — the slice showed the wording contradicted the mechanism). §4.3.1 admission order + `propose` role; §4.4 archived-as-flag; §7 chain of trust for human keys (C12).
- **D21** — Contracts `3.0.0-draft.2`: `local_persisted → admitted`; quarantine reasons `signer_unknown`, `no_policy_yet`; reject reason `unauthorized`; `CONFLICTING_DUPLICATE`; `corrected.by`; `parts` on `revoked`/`overridden`; per-part `scope`; ruling `parts` + `requirements`; `ProjectedRecord.evidence_class` typed. All additive; slice + contracts green after.
- **DN15** — 23 further implementation-blind oracles (C01–C08, C12, C13, C15, C17–C28) with held-out variants, fixtures, instrument-can-fail controls and open questions written to `test/acceptance/oracles/` (workflow `wf_7d1a87df-55f`, 23 agents, 0 errors, 30 min). This time every structured field was written (DN13 lesson).
- **DN16** — The slice's `projection.ts` had four `string`-vs-`EvidenceClass` type errors the lane missed (it ran tsc before its last edits); fixed at the contract level by typing `ProjectedRecord.evidence_class`.
- **DN17** — The slice builder proposed 8 contract changes; all accepted in D21 except the general chain-of-trust mechanism for human keys, which is specified in ADR §7 and implemented by lane 02 (continued).

## 2026-09-15 — Stage 1–4 lanes dispatched

- **D22** — Merged `feat/cli-2.17` into `foundation/v3` (conflict-free); fixed the CLI suite's dist dependency (bundles per suite, `5de4e00`, cherry-picked to the CLI branch as `d2e96ad`); full suite 136 files / 1872 passed / 2 skipped / 12 todo. Draft PRs: **#48** `feat/cli-2.17 → main` (2.17.0 CLI, owner tags), **#49** `foundation/v3 → main` (do-not-merge, carries S1–S4).
- **DN18** — Worktree creation with a relative path while the Bash cwd had drifted into the CLI worktree nested three lane worktrees under it; recreated at absolute paths. Rule: absolute paths for every worktree operation.
- **D23** — Five lanes dispatched as background opus agents, each in its own worktree/branch from `5de4e00`: `lane/02-exchange` (Git carrier, C14 Git arm, C18 fault suite, C17/C22/C24 admission hardening, C20 deletion, exchange observability, human-key chain of trust), `lane/02c-migration` (legacy fixtures, `migrate --to 3` / `rollback --to 2` per ADR §10, C21, part-level projections for C16/C09), `lane/03-runtime` (identity/ceremony/sync/doctor verbs, v3 write path, Claude Code + Codex adapters with real-host tests gated by TWINING_REAL_HOST, library adapter, git connector; flips gaps 1/2/4), `lane/04-retrieval` (scope-first selection on every path, resolver reuse, required-facts-first packet with the DP4 tokenizer, explain packets + receipts, injection defenses; flips gaps 3/6/7), `lane/05-verification` (acceptance harness + instrument-can-fail switchboard, oracle INDEX, C28 remote bundle, data-flow doc + traffic observation, 1k/10k/100k measurements, recovery doc skeleton). Lanes report; the lead reviews, merges and commits.

## 2026-09-15 — lane 03 delivered

- **D24** — Lane 03 (runtime) committed at `fb35c17` on `lane/03-runtime`: adapters (identity, source provenance from the producing checkout, event factory, receipts, bounded working set, host matrix renderer, Claude Code / Codex / library adapters, v3 mirror of 2.x writes, git connector), CLI verbs (`identity init`, `rule`, `events`, `sync`, `doctor`, hook verb), hooks.json gains PreCompact + compact SessionStart, gaps 1/2/4 flipped. Full suite in its worktree 1977 passed / 23 todo (one contention flake passes alone). Review workflow `wf_13132bb9-547` launched.
- **D25 (product decision, flagged for Dave)** — On v3 stores SessionStart injects ONLY the working set; the "Gate 1/Gate 2" instruction prose is dropped because oracle C15 A2-NO-PROSE forbids it and R10 requires capture without prose reminders; 2.x stores unchanged. Recorded `01M2KK17R6…`. Dave may veto.
- **DN19** — Codex real-host verification is blocked on one-time interactive hook trust (`/hooks` inside Codex); `codex exec --dangerously-bypass-hook-trust` runs the hook without filesystem effect and UserPromptSubmit never fires in exec mode. C15's second-backend half stays NOT TESTED (need `01M2KK183Q…` posted). Lane 03 rightly did not cherry-pick the parked Codex carrier (touches shared files).
- **D26** — Flush receipts are cursor-shaped; receipt schema unchanged.

## 2026-09-15 — lane 04 delivered

- **D27** — Lane 04 (retrieval) committed on `lane/04-retrieval`: scope-first gate (`scopeAuthorizes`, a third scope operation — adopt into `src/contracts/scope.ts` at merge, decision `01M2KKE0HZ…`), resolver reuse, DP4 tokenizer (proven 1 token/byte bound + a measured calibration table from one count-tokens pass, decision `01M2KKE0XE…`), required-facts-first packet, explain packets + emitted-bytes receipts, class-preserving rendering; gaps 3/6/7 flipped; C01–C05/C08/C12/C19/C25/C26 as named tests. 2097 passed / 40 todo.
- **S2** — Field-D12 mitigation (semantic-admission floor as the barrier) superseded for admission by the hard scope cut (`01M2KKE0QJ…`); the floor remains for counting.
- **DN20** — Fresh worktrees lack `src/analytics/_generated-posthog-key.ts` (pretest generates it); run `node scripts/inject-posthog-key.mjs` before tsc/vitest in any worktree. Also: assert seeds projected before scoring exclusions (three vacuous passes caught by liveness controls).
- **DN21** — `RetrievalAnnex` type lives in context-assembler.ts; move to `src/utils/types.ts` at merge.

## 2026-09-15 — lane 02c delivered

- **D28** — Lane 02c (migration) committed at `52ba50d` on `lane/02c-migration`: `migrate --to 3` (manifest, legacy created + derived lifecycle events, id map, verify, finalize, SIGKILL interrupt/resume), `rollback --to 2` (restricted view + `v3_semantics_lost` + view manifest), forward recovery, old-client refusal, `events ls|show`, `migrate-status`; part-level projections close C16 L1–L4/A3.4; C09 OQ-5 variant; C21 37 pass + 2 UNAVAILABLE (A-DEL-01, A-OLD-04). 1955 passed / 9 todo in its worktree. Review `lane02c-review` launched. Tool count now 40.
- **D29** — Ruling for lane 02b: admission capability is evaluated against the membership projected from the event's causal ANCESTORS, at first admission and on rebuild — never the latest policy (`01M2KKN9S1…`); lane 02c measured rebuild dropping an admitted event otherwise.
- **D30** — Contracts draft.3 at merge: `superseded.by` optional; post `entry_type` "decision" admitted for migration ingress only (`01M2KKN9V8…`).
- **DN22** — Tokenizer calibration pass failed with an API error (request logged, no key printed); the proven 1 token/byte bound ships; calibration is a follow-up. The tokenizer does not yet read `calibration.json`.

## 2026-09-15 — lanes 02b and 05 delivered; all five lanes committed

- **D31** — Lane 02b committed `e22fc6d` on `lane/02-exchange` (Git carrier on `refs/heads/twining/exchange`, verified union, dirty-checkout non-interference; C18 fault suite; C17/C22/C24 hardening; C20 deletion; `twining_exchange_status`; chain of trust; ancestor-membership capability; seven slice defects fixed — worst: re-projection dropped admitted events whose files vanished). Review `wf_4c05c821-c52` launched. Contract draft.3 additions accepted (`01M2KM4A4K…`); competing equal-class corrections must project as conflicted, lead fixes at merge (`01M2KM4A6N…`).
- **D32** — Lane 05 committed `1d19af5` on `lane/05-verification` (harness + switchboard: all six controls break their assertion; oracle INDEX 1230 ids, 127 unowned; C28 bundle + verifier, one-machine run 12/1/21, UNAVAILABLE until Dave runs it on the second machine; data-flow doc + traffic script; measurements 1k–16k on this machine; recovery doc skeleton).
- **DN23 (lane 02b, from lane 05)** — an event whose parent is REJECTED stays `pending_parents` forever; must terminate as `rejected:parent_rejected` (C28 A13, C18 A9). Fix at merge if the 02b review does not already carry it.
- **DN24 (performance)** — `append` p50 ≈ 0.323·n^0.5 (O(n^1.5) total); p95 crosses the 100 ms local-capture target near ~35k events on this machine; 100k tier not attempted (~3 h projected). Declared envelope for this run: ≤16k events measured, ≤~30k within target; cause undiagnosed (sharding and concurrency ruled out); the 02b review's quality lens is asked to locate it.
- **DN25** — MCP server path has no offline switch for the embedding model (`src/server.ts` builds the context without `offline`); add `TWINING_OFFLINE` / `embeddings.offline` at merge so R18's tested-local configuration exists.
- **DN26** — Ownership clarification for lane 05's INDEX: C03 is covered by lane 04 (it delivered C01–C05), C27 by lane 03 (it delivered C06/C15/C27).
- **Merge plan** — order 02b → 02c → 03 → 04 → 05 into `foundation/v3`; contracts draft.3 (scopeAuthorizes, superseded.by optional, legacy post entry_type, 02b enums, exchangeStatus/lastMalformed/lastGap); fix correctionFor conflicts + parent-rejected termination + offline switch; resolve cross-lane touches (dispatch.ts, twining.ts, commands.ts, pinned counts 40→41 with exchange_status); full suite; push; matrix.
- **D33** — Lane 03 review `wf_13132bb9-547` (55 agents, 0 errors, 22 min): 26 findings, 17 survive → 11 distinct defects sent to the lane: BLOCKER mis-quoted v3 handoff guard in the two legacy hooks (gate prose still injected on v3; the flipped gap1 test only exercised the new hook), receipts written as `projected` after a failed project, working-set cursor skipping budget-omitted records, library adapter minting `verified_observation` without a check, dropped `asserted_actor`, Codex captures stamped `claude-code`, npx rung that can only fail over the network, unchecked forwarding of CLI stdout to the host, `requalify` qualifying on an unrecorded observation, JSON-null hook payload, docs statement. Verified OK: 2.x hooks byte-identical, fail-open in every case, no user file writes, no key material in `doctor`, no double-fire.

## 2026-09-15 ~16:10 — reviews of lanes 02b/02c/04 (partial: usage limit), fix passes dispatched

- **D34** — Lane 03 review fixes committed `9e67c63` (all 11 closed; new legacy-hook-on-v3 tests). Lesson: a flipped gap test must exercise the OLD path too.
- **D35** — Reviews `wf_477a84df-fde` (lane 04), `wf_acccf5b4-39f` (02c), `wf_4c05c821-c52` (02b) completed with many refuters killed by the session usage limit (reset 18:20). Confirmed survivors sent to each lane with the review file paths; unrefuted finder results to be verified by the lanes. Key confirmed: lane 04 — assemble's getByScope path bypasses the gate (BLOCKER), lessons denial still leaks, legacyScope widens ".."/"/" scopes, reader-repo stamping, harness-only acceptance cases, `twining_why` file-match regression; lane 02c — UTF-8 corruption of attachments (BLOCKER), archived-from-provisional unmigratable (BLOCKER), overridden_by is an actor label, raw NUL byte in v3-forward.ts (BLOCKER), weak `reinstated` unpicks ruling parts (BLOCKER), part events escalate to whole record; lane 02b — lossy merge not rolled back (BLOCKER), crash-poisoned publish idempotence (BLOCKER), credentials in transport id/cursors (MAJOR), + lane 05's parent-rejected and O(n^1.5) append.
- **State for resumption:** branches lane/03-runtime `9e67c63` (reviewed+fixed, ready to merge), lane/04-retrieval `852f3dc` (fix pass running), lane/02c-migration `52ba50d` (fix pass running), lane/02-exchange `e22fc6d` (fix pass running), lane/05-verification `1d19af5` (ready). After fixes: verify each (inject-posthog-key, tsc, full suite), commit on lane, merge order 02b → 02c → 03 → 04 → 05 into foundation/v3, contracts draft.3 (scopeAuthorizes; superseded.by optional; legacy post entry_type; 02b enums; exchangeStatus/lastMalformed/lastGap; correctionFor conflicts; offline switch), full suite, push, matrix, then dev-scale trial + final report.
- **D36** — Lane 04 review fixes committed `199e010` on `lane/04-retrieval` (16 fixed; 2126 pass). `mode: lessons` withdrawn from the tool schema until membership exists (engine keeps it). Budget currency unified → 2.x briefings ~4x tighter under the proven bound; **decision pending at merge:** calibrate the tokenizer (DP4) before shipping — the calibration script fails because the whitespace-only corpus document sends an empty text block to the API (`400 text content blocks must contain non-whitespace text`); fix: skip/pad whitespace-only docs, rerun with the key injected per process.
- **D37** — Lane 02c review fixes committed on `lane/02c-migration` (11 confirmed + 5 unverified fixed; re-run-after-recovery defect found and fixed; `file-store.ts` widened to accept Buffer — shared file, additive).
- **D38** — Lane 02b review fixes committed on `lane/02-exchange` (13 fixed, 3 partially refuted); append cost now flat in corpus size (memoized admitted view); at merge: add `exchange/` to GITIGNORE_ENTRIES in src/storage/init.ts (canonical fix for the tracked-store case); keep scripts/measure/append-cost.ts. ALL FIVE LANES REVIEW-FIXED AND COMMITTED — next: merge 02b → 02c → 03 → 04 → 05 into foundation/v3.
- **D39 (dispatched)** — Merge integrator agent (opus) launched in the main checkout: merge 02b→02c→03→04→05 into foundation/v3, contracts draft.3, correctionFor conflicts, exchange/ gitignore, offline switch, calibration script fix, doc counts, matrix update; it commits, the lead pushes. Lead context nearly exhausted at dispatch.
