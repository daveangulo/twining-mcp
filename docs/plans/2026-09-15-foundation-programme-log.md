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
