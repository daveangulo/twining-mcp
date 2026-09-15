# Twining foundation programme — plan of record

**Status:** RULED 2026-09-15 (Dave: RB1 parallel · RB2 absorb · RB3 other computer · RB4 Codex installed locally · RB5 dev-scale here, full-scale deferred to Dave's machine · RB6 recommendation · RB7 agreed). Executing. Audit trail: `2026-09-15-foundation-programme-log.md`.

**Package:** `~/Downloads/twining-foundation-20260915/` — checksums verified against `SHA256SUMS.json` (all ten files match). The package's shared contract is `requirements.md` (R01–R20), `acceptance-cases.md` (C01–C28 + coverage map + trial + go/no-go), and `source-evidence.md` (seven gaps observed at `d7860e0`). `00-lead.md` is the entry point; `01`–`05` are lanes.

**Settled by the package, not re-asked here:** foundational format changes are in scope; breaking APIs are permitted; lossless migration AND rollback (including post-upgrade writes) are required; Git is a candidate transport, not a requirement; isolated synthetic data only; no deployment into an existing programme; the team's existing release authority stands.

---

## 0. The short version

1. **Baseline is green and the gaps are real at source.** `main` = `d7860e0` (the package's inspected commit), server 2.16.1, plugin 1.34.1, Claude Code 2.1.272, Node 25.8.1; full suite 119 files / 1725 passed / 2 skipped. All seven `source-evidence.md` rows are present at HEAD by direct reading (§1.3). None is refuted. Runtime reproduction with positive controls is the first execution task, not a reason to delay the plan.
2. **One foundational change is justified; the rest is layered evolution.** In-place mutation of exported records (the shipped DD-12 model) cannot satisfy R05/R07/R14 or C14/C16/C20/C21 — the failing case is already measured (file-wins lifecycle revert; one-sided supersession; rewind silently revoking). The proposal is an **immutable event log with derived projections**, and everything else (identity envelope, evidence classes, delivery state, strict scope, budget/receipts, host adapters) layers on it. Stage 0 must still run the required alternatives analysis and show the failing case before this is committed (§3).
3. **Git stays the default transport, evolved into a protocol; a non-Git relay is built behind the same interface as a reference, not deployed.** Strongest objection and flip conditions in §3.3.
4. **The in-flight CLI is not a distraction; it is the host-adapter vehicle** (R10/R11: hooks and MCP-less agents call the CLI). Its scheduling relative to the field's urgent MCP-whitelist need is ruling RB1.
5. **Programme runs as five stages on a long-lived branch, no tags, no publish, no field sends by me.** Stage gates are evidence checks I run; the only stops for Dave are the outward/irreversible actions listed in §11.
6. **Seven rulings are needed before execution** (§10). Everything else is a decision point with a stated criterion (§6) or a conservative fallback (§7).

---

## 1. Baseline established (this session)

### 1.1 Pinned identities

| Item | Value |
|---|---|
| Repository | `daveangulo/twining-mcp`, branch `main`, HEAD `d7860e0` (matches `source-evidence.md`) |
| Server / plugin | `package.json` 2.16.1; plugin 1.34.1 (`.claude-plugin/marketplace.json`, `plugin/.claude-plugin/plugin.json`) |
| Hosts on this machine | Claude Code 2.1.272 (real host, primary); Codex CLI **not on PATH**; ChatGPT.app carries a bundled Codex runtime (`~/.cache/codex-runtimes/…/runtime.json` bundleVersion 26.909.12148, node 24.19); `~/.codex/auth.json` present |
| Node | v25.8.1 (engines `>=22.13.0`); `node:sqlite` available |
| Test baseline | `npx vitest run`: 119 files, 1725 passed, 2 skipped, 16.9 s (2026-09-15 12:30) |
| Benchmark harness | `~/code/twining-benchmark-harness` — conditions `baseline`, `claude-md-only`, `shared-markdown`, `file-reload-{generic,structured}`, `persistent-history`, `twining-{lite,default,full}`; dual-rubric LLM judge; needs `ANTHROPIC_API_KEY` or Max auth |
| Working tree | Uncommitted in-flight Codex-plugin work (`.github/workflows/ci.yml`, `README.md`, `package.json`, `scripts/build-plugin-bundle.mjs`, `scripts/bump-plugin-version.sh`, `test/plugin-tool-references.test.ts`, untracked `plugins/twining/`) + ~110 untracked `.twining/records/` files from sessions 09-06 → 09-09 |

### 1.2 In-flight work this programme touches

- **Codex plugin port** (`docs/plans/2026-09-09-codex-plugin.md`, generated `plugins/twining/`, uncommitted): complete per its plan; CI drift check added. Reused by lane 03 as the Codex hook carrier.
- **CLI-vs-MCP assessment** (blackboard 01M23W4P…, 01M23Y66…, 01M2424E…, 2026-09-09): motivation confirmed by Dave — the field org is imposing a corporate-wide MCP whitelist; a `twining` CLI would let Twining run in Codex without whitelisting; **urgent**. Research established: Codex shell commands run inside the sandbox (no network by default; a linked worktree's main checkout is not writable), MCP servers run outside it; a plugin cannot put a command on PATH; enterprise `requirements.toml` allowlists match name + exact command. No assessment document was written; the work stopped at research.
- **W2 / 2.17.0 and 2.17.1 plans** (`docs/plans/2026-09-08-*.md`, drafted, unexecuted): assemble disclosure, budget order, payload measurement, sync-state disclosure, lineage reverse scan, `createSuperseding`, fallback diagnosability, ingest counters. Most items are subsumed by R07/R08/R15/R16/R19 (ruling RB2).
- **Named open design decisions** from prior plans this programme must rule or supersede: DD-8 file-wins precedence, DD-12 mutation/conflict model, DD-13 who commits, DD-6/DD-11 fallback policy, DD-10 retrieval v2. The July decision `01KWK9KTZGR2V148HJJ2CGY3ZY` ("SQLite runtime store, git is the replication transport, server never commits") is the prior art the transport analysis engages.

### 1.3 Supplied gaps — status at source (reproduction with controls is Stage 0 task B1)

| # | Observation | Status at `d7860e0` | Where |
|---|---|---|---|
| 1 | SessionStart injects instructions, not the working set; no compaction hook | **Confirmed** | `plugin/hooks/hooks.json` (5 events, no PreCompact / `compact` matcher); `session-start-context.sh:140` emits gate prose only |
| 2 | SubagentStop queues a generic status | **Confirmed** | `subagent-stop-hook.sh:82` — `"Subagent completed: <label>"`, no finisher/review state |
| 3 | Assemble unions scope-prefix matches with semantic matches over the whole active/provisional set | **Confirmed** | `context-assembler.ts:130–170`; no tenant/repo/attempt filter before ranking |
| 4 | Provenance = branch/sha of the configured project root | **Confirmed** | `utils/provenance.ts`; `decisions.ts:399` passes `this.projectRoot`, which for a linked worktree is the main checkout (FOUNDATION-PLAN D5 annotation) |
| 5 | Staleness = local path/branch signals only | **Confirmed** | `engine/staleness.ts:1–22` |
| 6 | Creation accepts `status` and caller `agent_id`; promotion attribution caller-supplied | **Confirmed** | `decisions.ts:256–313`, `:1146–1207` (`promoted_by: promotedBy ?? "main"`) |
| 7 | Formatter shows 3 full + 2 summary decisions; 4-char token estimate; response reports counts, not the delivered set | **Confirmed** | `context-assembler.ts:749–787`; `utils/tokens.ts`; `context-tools.ts:44–60` |
| 8 | Export rewrites the same file on mutation; ingest is ID-idempotent + file-wins; HEAD movement triggers sync; unreadable-file guards exist | **Confirmed**, guards present (2.16.1) | `record-export.ts:20–21`, `record-ingest.ts:1–21`, `sync-manager.ts` |

### 1.4 Existing features that already satisfy (parts of) requirements — preserve as regression coverage

- Decision records with rationale, alternatives, `depends_on`, `supersedes`/`superseded_by`, `overridden_by`, `promoted_by/at`, `archived_from`, append-only `amendments` (R05 partial; C16 partial).
- SQLite derived cache + deterministic per-record export tree; ingest never deletes for unreadable/mis-keyed files; deletion only per existing kind directory (R07/R09/R19 partial; C17 partial).
- `FORMAT_VERSION_TOO_NEW` read-only mode for old clients; verify-gated `migrate` that never deletes legacy files (R19 partial; C21 partial).
- Hooks: fail-open doctrine, sentinel + per-session marker gates, pending-posts dead-letter, edit-path filter (R10 partial).
- Opt-in telemetry; local embeddings with keyword fallback (R18 partial).
- Blackboard `resolve`/`relates_to` resolution; lineage walk; `lifecycle_reverts` warning (R05/R20 partial).

---

## 2. Programme shape

Five stages, mapped to the package's lanes. Each stage ends with an evidence gate I run (tests + the stage's acceptance cases green, records written). Stages 1–3 run as bounded lanes with one writer per owned path set; the lead (this session) owns shared schemas and cross-lane changes.

| Stage | Lane(s) | Delivers | Exit evidence |
|---|---|---|---|
| **S0 Foundation** | 01 (+05 oracle definition) | Baseline report; gap reproduction with positive controls; ADR with the three-way transport analysis over identical failure cases; versioned schemas (identity, evidence envelope, lifecycle events, delivery state) with fixtures + negative fixtures; state-transition tables; **vertical slice** (two identified writers, two stores, offline conflict, both delivery orders, retry, lost ack, rebuild from durable evidence); migration/rollback contract; lane ownership map | Slice passes an oracle written by the verification lane *before* the slice exists; C10/C11/C14/C16 deterministic invariants pass in the slice |
| **S1 Records & exchange** | 02 | Event log + projections; identity/evidence validation on every ingress (MCP, CLI, file/Git import, repair utilities); explicit lifecycle transitions incl. partial supersession, competing successors, corrections-before-predecessors; outbox/inbox with per-event delivery state and cursors; Git transport protocol (topology, non-interference, identity across rewrites, admission, history movement, receipts, retention, deletion); reference relay behind the same interface; fault-injection suite at every durable boundary | C10–C14, C16–C18, C20–C24 pass; kill-at-every-boundary tests pass with restart, not just disconnect |
| **S2 Runtime & CLI** | 03 | `twining` CLI (versioned JSON contract, capability discovery, exit codes, offline/sandbox-safe); Claude Code adapter that *performs* capture and bounded injection (SessionStart startup/resume/compact, UserPromptSubmit, PreCompact, PreToolUse, PostToolUse, SubagentStart/Stop, Stop, SessionEnd); Codex adapter via the generated plugin; API/Bedrock library adapter; source-observation connector (git/GitHub); diagnostics (`twining doctor`); enable/disable that is honest | C15 (Claude real host; Codex per RB4), C27; the "no prose reminder" demonstration with receiving-turn receipts |
| **S3 Retrieval & trust** | 04 | Hard authorization scope before any ranking on every path (assemble, why, search, read-by-id, handoffs, graph neighbors, chunks, diagnostics, exports, caches); strict vs explicit lessons mode; lifecycle resolver shared with S1; required-facts-first budget over the *emitted* envelope with a declared tokenizer; explain packets; emitted-bytes hash + receipt linkage; injection defenses enforced at ingress/action APIs | C01–C09, C12, C19, C25, C26 pass incl. adversarial out-of-scope neighbors and cached reranker results, with a legitimate cross-scope lesson as positive control |
| **S4 Verification, migration, trial** | 05 | Independent fixtures (dev + held-out); instruments-can-fail controls; migration manifest → migrate → verify → interrupt/rollback → forward recovery on file-backed, sqlite/export, archived, provisional, superseded, malformed fixtures; export/import into a clean install; corpus tiers 1k/10k/100k; data-flow diagram + observed-traffic check; matched trial (4 conditions × 90 trials + C27 long sessions + C28 real topology); requirements×cases matrix; final report | Go/no-go table filled with passed / failed / unavailable / waived / not-tested; nothing unavailable reported as passed |

The verification lane's oracle work starts in S0 so expected outcomes are fixed before implementation can shape them (05-verification §"Test design").

**Ownership map (paths, one writer each; the lead owns `src/contracts/**` and any cross-lane change):**

| Lane | Owns |
|---|---|
| 01 / lead | `src/contracts/**` (schemas, state tables, validators), `docs/adr/**`, `docs/plans/2026-09-15-*` |
| 02 | `src/storage/**`, `src/events/**`, `src/exchange/**`, `src/migrate/**`, `test/exchange/**`, `test/migrate/**` |
| 03 | `src/cli/**`, `src/adapters/**`, `plugin/hooks/**`, `plugins/twining/**`, `scripts/build-codex-plugin.mjs`, `test/hooks/**`, `test/cli/**` |
| 04 | `src/engine/context-assembler.ts`, `src/engine/decisions.ts` (read paths), `src/embeddings/**`, `src/retrieval/**`, `src/tools/context-tools.ts`, `src/dashboard/query-routes.ts`, `test/retrieval/**` |
| 05 | `test/acceptance/**`, `test/fixtures/**`, `scripts/qualify/**`, `docs/operations/**`, `docs/reports/**` |

---

## 3. Architecture direction (hypothesis; Stage 0 settles it)

### 3.1 What is a record (proposed)

- **Event** = immutable, append-only unit. `event_id` (ULID), `producer` (authenticated principal + host + session/turn), `asserted_actor` (caller string, recorded as asserted), `scope`, `parents` (causal), `payload` (canonical JSON), `payload_digest` (sha256 over canonical bytes), `evidence_class`, `schema_version`. Never rewritten. Kinds: `created`, `superseded`, `overridden`, `promoted`, `reconsidered`, `archived`, `restored`, `resolved`, `acknowledged`, `amended`, `commit_linked`, `revoked`, `retracted`, `tombstoned`, `receipt`, `ruling`, `observation`.
- **Source evidence** = original bytes (or a content-addressed attachment) + `source_uri`, anchor, `source_kind`, hash algorithm/hash/encoding, git object identity or base/head where applicable, author, observer, observed/effective time. A record's canonical-JSON digest, an original file's hash, and a rendered output's hash are three different values and are stored as three fields.
- **Projection** = derived current view (decision status, resolved flags, entity merge) computed by a deterministic reducer with the documented authority rule; lives in sqlite; rebuildable from events; never committed.
- Today's decision/post/entity/relation/handoff records become `created` events plus derived lifecycle events at migration; original bytes retained with their hash; evidence class `legacy_unverified`; legacy `active` never becomes `human_ruling`.

### 3.2 Identity, authority, scope (proposed)

- **Principals:** human, agent/service, host/installation. Host keys (Ed25519 via `node:crypto`, zero new native deps) minted once per installation under `~/.twining/identity/`, outside any repo. Repository identity is a minted `repo_id` stored in the store, not derived from URL or path; worktree identity = `repo_id` + worktree token; producing worktree/revision captured from the adapter's cwd, never from the store root. Work definitions, assignments, attempts and jobs are reference records Twining stores and never grants.
- **Evidence classes:** `human_ruling` (signed by a human-principal key through an interactive ceremony the model cannot invoke), `human_statement` (host-attested literal prompt text, unverified authority), `verified_observation`, `reported_result`, `model_inference`, `proposal`, `question`, `legacy_unverified`. Rendering preserves the class; `MUST`/`active`/headings confer nothing.
- **Scope algebra:** tenant → project(`repo_id`) → path → task/attempt → consumer, with revision ranges and time. Relations validated against the author's authorized scope at ingress; cross-scope, cyclic, dangling → rejected or quarantined with a visible record. Strict mode never widens; lessons mode is explicit.
- **Trust boundary stated honestly:** a local process running as the same OS user can read unprotected key files. The guarantee is "not forgeable through Twining's ingress APIs and not forgeable by imported records," not "unforgeable by local root."

### 3.3 Exchange (proposed) and the required alternatives

Three candidates evaluated in Stage 0 over the same cases (disconnected writers, late revocation, retry after lost ack, competing corrections, dirty worktrees, incompatible clients, deletion, rollback):

1. **Evolve the current per-record export + file-wins ingest** with a revision stamp and conflict files. Cheapest. Fails C14/C16/C20 by construction: a rewrite is the only copy; rewind = silent revoke; file-wins is a last-writer rule dressed as a merge.
2. **Immutable event exchange over Git** (proposed default): one file per event, never rewritten → merges are set-union by construction; the server never runs git (decision `01KWK9KTZGR2V148HJJ2CGY3ZY` preserved); an explicit `twining sync` publishes; receipts are events; admission validates before projection; the local journal retains admitted events so a checkout rewind is a *replica view* change, not a revocation. Strongest objection: freshness is bounded by commit/push/pull cadence, receipts arrive asynchronously, and repo-level access is coarse for per-record confidentiality.
3. **Authenticated relay** (append-only HTTP log, token auth, offline outbox, Git export). Best freshness/revocation. Costs a service, credentials, operator burden; conflicts with "no new provider" unless self-hosted. Built as an in-process reference implementation behind the same `Transport` interface so the delivery state machine and fault suite run against both; **not deployed**.

**Flip conditions for the default:** if the fault suite shows lost-ack reconciliation over Git needs a live counterpart, or the field needs sub-minute cross-user propagation or per-record confidentiality, recommend the relay for live exchange with Git as export/audit. Convergence is safe for set-union of events and for lifecycle transitions with a single authorized author; "conflict requiring an authorized resolution" is the correct result for concurrent equally-authoritative successors and competing corrections.

### 3.4 Smaller-evolution stress test (required before committing)

Stage 0 must answer: can the current design plus a revision stamp, a PreCompact hook, producing-worktree provenance, a strict-scope filter and assemble disclosure satisfy the same guarantees? Expected answer: no, with the failing case C14/C16/C20 + the already-measured file-wins revert. If the expected answer is wrong, the smaller evolution is preferred and this plan is revised (recorded as a supersession, not a quiet edit).

---

## 4. Assumptions (initial set — challenge at plan time)

- **A1** The package is the authoritative scope; its three contract files govern; the field's private repositories, conversations and store are out of bounds; all fixtures are synthetic.
- **A2** `main` at `d7860e0` is the base. The in-flight Codex-plugin diff is complete per its plan and can be parked on its own branch without loss.
- **A3** Release authority stays with Dave: I never push a `v*` tag (tags trigger Publish), never `npm publish`, never update plugin scopes, never send anything to the field, never file issues.
- **A4** Node ≥ 22.13 stays the floor; zero new native dependencies (`node:crypto` Ed25519, `node:sqlite`).
- **A5** This machine is one "computer." A second independent computer is not available to me unless RB3 provides one; a container is a reported substitute, not a pass.
- **A6** Claude Code 2.1.272 is the primary real host for R10/C15. Codex is secondary and depends on RB4.
- **A7** The benchmark harness is reusable for the matched trial with new scenarios for C01–C09 and a `twining-v3` condition; its auth is per RB5.
- **A8** The field's CLI need is urgent and shares the transport-agnostic command core with lane 03; its schedule is RB1.
- **A9** The 2.x line remains field-supported for hotfixes; v3 lands on a branch and is merged by Dave.
- **A10** Migration is never run against this repo's live `.twining/` store; only scratch copies. Live migration is Dave's action.
- **A11** The running MCP server for every session on this machine is this repo's `dist/` via the npm link. I do **not** run `npm run build` in the main checkout during the programme (builds happen in worktrees/scratch), so v3 server code never silently serves v2 stores here.
- **A12** Never run two vitest suites concurrently on this machine (documented lock/timeout artifact).
- **A13** Workflows use worktree isolation for any code-executing agent, short prompts, no effort override, and the inline-review fallback when the stall detector fires (memory `feedback_workflow_stall_review_fallback`).

## 5. Unknowns that would change the approach — and what was fetched

| Unknown | Status after this session |
|---|---|
| Is the package's inspected commit our HEAD? | Yes (`d7860e0`). |
| Are the seven gaps still present? | Yes at source (§1.3); runtime reproduction is task B1. |
| What is the in-flight CLI? | A field-driven MCP-whitelist workaround; assessment stopped at research 2026-09-09; no design doc. |
| Is Codex runnable here? | CLI absent; desktop runtime present; auth present. Needs RB4. |
| Is a second computer available? | Not on this machine. Needs RB3. |
| Can the matched trial run? | Harness exists; auth/budget need RB5. |
| Which prior decisions constrain the redesign? | Read via `twining_why` on `src/storage/sync/`, `src/engine/decisions.ts`, `src/engine/context-assembler.ts`, `plugin/hooks/` (145/193/172/65 in scope); the load-bearing ones are listed in §1.2. |
| Claude Code hook events available for capture/injection | To be verified in the real host in S2 (SessionStart matchers, PreCompact, UserPromptSubmit, SubagentStart, SessionEnd); documented set is assumed, tested before relied on. |

## 6. Decision points I will make without Dave (criterion stated)

| DP | Decision | Criterion |
|---|---|---|
| DP1 | Canonicalization for digests | Deterministic across Node versions; reuse the existing recursively-sorted-key serializer; sha256; UTF-8; NFC not applied (bytes are bytes). |
| DP2 | Event file layout | One file per event, month-sharded, never rewritten; set-union merge; `.gitattributes` not required. |
| DP3 | Projection engine | sqlite, derived only; a "drop db, rebuild from events, identical projection" test is mandatory. |
| DP4 | Tokenizer for R15 | Conservative calibrated estimator with declared version, calibrated against the Anthropic count-tokens API on a fixture corpus so the bound never undercounts; exact API count as an optional mode. |
| DP5 | Transport interface | Git default, in-process relay reference; both run the same fault suite. |
| DP6 | Signing | Ed25519 via `node:crypto`; keys under `~/.twining/identity/` mode 0600; signature covers canonical bytes + digest. |
| DP7 | Legacy mapping | Every legacy record → `created` event with retained bytes; status fields → derived lifecycle events flagged `derived_from_legacy_snapshot`; evidence class `legacy_unverified`; ID mapping table persisted. |
| DP8 | CLI surface | Subcommands mirror MCP tool names 1:1; `--json`; exit 0/1/2; `--schema-version`; capability discovery; no network; store resolved from cwd with an explicit `--project`. |
| DP9 | Which Claude hooks to add | Only events verified in the real host here; every adapter publishes a captures/injects/cannot-observe matrix. |
| DP10 | Corpus tiers | 1k / 10k / 100k synthetic events as the declared envelope; report separately. |

## 7. Fallback for unanticipated decision points

Take the lower-risk action, record the decision with full rationale (what, alternatives, why, what would invalidate it) at the moment it is made, and continue. Hard stops only for: a discovered need that invalidates a load-bearing assumption above; material scope expansion; or an action that would do real damage (live-store migration, irreversible publication, data loss). A requirement I cannot meet becomes an explicit unresolved-limitation row in the matrix, never a silent narrowing.

## 8. Where this can go wrong — and recovery

| Risk | Recovery |
|---|---|
| Workflow stall detector kills review agents (24/24 on 2026-09-07) | Short prompts, inherit effort, split lenses; salvage executed evidence and finish inline. |
| Review/verify subagents mutate the live tree (twice before) | Worktree isolation for code-executing agents; `git diff` of reviewed files after every workflow. |
| Concurrent vitest runs produce lock/timeout artifacts | Serialize; single files during TDD; full suite once per stage gate. |
| v3 server code served to v2 stores via the npm link | A11; plus v3 refuses to serve a v2 store without explicit migrate (config version gate, already the 2.x pattern). |
| Migration corrupts a real store | A10; manifest-before/verify-after; interrupted-migration tests; rollback demonstrated on fixtures before any real use. |
| Scope explosion across five lanes | Stage gates with named exit evidence; one writer per path; lead owns shared schemas. |
| Codex sandbox breaks a CLI path (no network, main checkout unwritable) | CLI is offline-capable, writes only under cwd's store, never redirects a worktree to main without an explicit flag. |
| Plugin token-budget CI gate turns red from new hooks/skills | Measure before/after; re-baseline is Dave's decision, flagged, not silently applied. |
| Matched trial contaminates arms | Fresh stores/sessions per arm, randomized order, held-out wording, model/effort/tools fixed. |

## 9. Strongest alternative to this plan

**Do not do the foundation.** Ship the CLI, execute W2/2.17.x, and add four targeted fixes (producing-worktree provenance, PreCompact capture, a strict-scope filter, assemble disclosure). Materially cheaper and closes gaps 1, 3, 4, 7 partially. It does not close R03 (evidence classes), R05/R07/R08 (lossless lifecycle, stable identity + digest, delivery state), or C14/C16/C20/C21, and the non-negotiables (silent acknowledged-data loss, authority-changing errors) are exactly where the current model has already failed in the field. Stage 0 keeps this alternative alive by requiring the failing case before committing (§3.4); if the failing case does not materialize, this alternative wins and the plan is superseded.

---

## 10. Rulings needed from Dave

**RB1 — CLI scheduling.** *Decision:* when the field-urgent `twining` CLI ships relative to the programme. *Options:* (a) CLI first on the 2.x line as 2.17.0 — extract the transport-agnostic command core, thin CLI mirroring the MCP tools, ship, then the foundation rebases on it; (b) CLI inside S2 on the v3 contract — field waits for S0–S2; (c) both in parallel — core extraction in S0 is shared, CLI lane runs beside S0/S1, ships from `main`. *Recommendation:* (c), medium confidence — the core extraction is needed by both, the field is unblocked early, and v3 host adapters get their vehicle. *Unblocks:* the field's Codex path; lane 03 design. *Delay cost:* the field stays MCP-whitelist-blocked in Codex.

**RB2 — W2 / 2.17.x plans.** *Decision:* absorb into the programme (record a supersession of the two drafted plans) or execute first. *Options:* absorb (2 fewer 2.x trains; their mechanisms are replaced by S1/S3/S4 work) vs. ship first (field gets the read-path honesty items sooner; the foundation rewrites them). *Recommendation:* absorb, high confidence; the only carve-out would be an item the field marks urgent. *Unblocks:* S0 start on a stable base. *Delay cost:* none if absorbed.

**RB3 — Second computer for C28 and real multi-computer qualification.** *Options:* (a) a scripted qualification bundle you run on your other machine and return artifacts from; (b) a remote/cloud Claude Code session as the second replica; (c) container substitute, reported as a substitute (result stays "unverified" for the multi-computer claim). *Recommendation:* (b) if available, else (a); medium confidence. *Unblocks:* C28, R08/R09 verdicts. *Delay cost:* multi-computer claims remain unverified.

**RB4 — Codex host.** *Decision:* may I install the Codex CLI on this machine and run it in isolated synthetic projects using your existing Codex auth (OpenAI model calls, cost, synthetic data only)? *Options:* yes; no → Codex adapter is built to the documented contract and reported "unverified in real host" (not a pass); or you run a scripted check on a Codex host and return the evidence. *Recommendation:* yes, medium confidence. *Unblocks:* C15 second-backend evidence, lane 03 completion. *Delay cost:* R10/R11 verdicts for Codex are unverified.

**RB5 — Matched trial budget and model.** *Decision:* auth method (API key injected per process, or Max), the fixed receiving model (recommend `claude-sonnet-5`, one effort setting, for the 360 base trials; optional `claude-opus-5` subset), and a cost ceiling. Rough cost at API rates: 360 sessions × ~$1–3 ≈ $0.4–1.1k plus long-session C27 and corpus-tier runs. *Recommendation:* Max auth if the harness supports it, sonnet-5, ceiling stated by you; medium confidence. *Unblocks:* R20 benefit verdict, go/no-go "context benefit" row. *Delay cost:* adoption cannot be recommended without it (the package forbids feature-count adoption).

**RB6 — Human-ruling ceremony.** *Decision:* how an authenticated human ruling is produced. *Options:* (i) interactive signed CLI ceremony (`twining rule …`, TTY required, human key outside the repo; the model cannot invoke it) — strong, but a coordinator cannot mint rulings from chat; (ii) host-attested literal human prompt captured as `human_statement` (unverified authority) that only (i) can upgrade; (iii) trust a caller-supplied actor field — rejected by R03. *Recommendation:* (i) + (ii), high confidence on the boundary, medium on ergonomics. *Unblocks:* R03/R17 design, C02/C08/C12 oracles. *Delay cost:* S0 schemas cannot be finalized.

**RB7 — Delivery form and version.** *Decision:* one long-lived branch `foundation/v3` with a draft PR opened early (CI runs on push; `git push` prompts you) and per-stage commits, versioned `3.0.0-alpha.N` in `package.json` on the branch, no tags; the in-flight Codex work parked on `wip/codex-plugin` first. *Alternative:* per-stage PRs to `main` behind a feature flag (more merges, earlier field exposure). *Recommendation:* long-lived branch, high confidence. *Unblocks:* everything. *Delay cost:* none.

---

## 11. Execution mechanics (once ruled)

- Gate 1 before each lane (`twining_assemble` on the lane's scope, `twining_why` on files to modify); Gate 2 (`twining_record`) before every commit; findings/warnings via `twining_post` as encountered; `.twining/` records committed alongside source in the same commit.
- Investigation and review run as workflows (understand → design panel → implement → adversarial verify), code-executing agents in worktrees; controller commits (never subagents).
- Stops for Dave only: tags, publish, plugin scope updates, field sends, issue filing, live-store migration, second-machine actions, anything beyond the RB4/RB5 authorizations.
- Audit trail lives in `docs/plans/2026-09-15-foundation-programme-log.md` (assumptions, discovered needs, decisions, supersessions, in the order made) plus the Twining store.

## 12. Package deliverables → where they will live

| Deliverable | Location |
|---|---|
| Requirements-to-implementation/test matrix (every R and C) | `docs/reports/2026-09-foundation-matrix.md` |
| Architecture/contract decision record | `docs/adr/2026-09-foundation-contracts.md` |
| Schemas, validators, fixtures | `src/contracts/**`, `test/fixtures/contracts/**` |
| Host adapters + stable interfaces | `src/adapters/**`, `src/cli/**`, `docs/operations/hosts.md` |
| Synthetic fault suite + measured comparison | `test/acceptance/**`, `scripts/qualify/**`, `docs/reports/2026-09-trial.md` |
| Operator/user documentation | `docs/operations/**` (setup, automation boundaries, scope, data flow, troubleshooting, upgrades, recovery, rollback) |
| Final report | `docs/reports/2026-09-foundation-final.md` |
