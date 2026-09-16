# Lane briefs (dispatch-ready) — foundation programme

Written by the lead while the Stage 0 slice is being built. Each brief is dispatched only after its listed prerequisites exist. Shared rules for every lane: work on `foundation/v3` (or a worktree of it), own only the listed paths, never edit `src/contracts/**` (propose diffs), single-file vitest runs, no `npm run build`, controller commits, Twining Gate 1 on the lane's scope, findings via `twining_post`.

## Lane 02 (continued) — records & exchange after the slice

Prereq: slice green on C10/C11 (both transports). Owns `src/events/**`, `src/exchange/**`, `src/migrate/**`, `test/events/**`, `test/exchange/**`, `test/migrate/**`, `test/acceptance/slice/**`.

1. Git carrier (`src/exchange/git-transport.ts`) per ADR §8.2: dedicated exchange ref `refs/heads/twining/exchange` in a worktree at `.twining/exchange/`; `publish` = stage only paths under that worktree, commit, fetch, merge (union by construction), push; `poll` = fetch + scan; receipts = commit sha per digest; never touches the user's source checkout (assert with a dirty-tree test: the user's index and working tree are byte-identical before/after sync). History movement tests: reset, force-push, rebase, cherry-pick, branch deletion → journal retains admitted set, `checkout_behind_journal` reported (C14).
2. Fault suite (C18): kill between journal→file→export→commit→push→receive→admit→project→ack; restart the process (spawn a child that dies at a named step), recover, assert no acknowledged event lost and every uncertain effect exposed.
3. Admission hardening (C17, C22, C24): truncated file, conflict markers, partially written batch, shallow checkout (absent history ≠ deletion), incompatible envelope version → quarantine with prior projection intact; cycles/dangling/cross-scope/competing corrections.
4. Migration (`twining migrate --to 3`) and rollback (`twining rollback --to 2`) per ADR §10 with manifest, id map, verify, interrupt/resume, post-rollback writes, forward recovery (C21). Fixtures: file-backed v1, sqlite+records v2, archives, provisional, superseded, malformed/conflicting exports, missing embeddings.
5. Deletion semantics (C20): tombstone/purge/forget; reconnecting old replica; backup restore.
6. Observability (R20): queue depth/age, gaps, retries, rejected, quarantined, migration state; exposed through the command core (`twining status --exchange`).

## Lane 03 — runtime integration and CLI (on the v3 contract)

Prereq: CLI lane (2.x) landed on `main` and rebased into `foundation/v3`; lane 02 EventStore available. Owns `src/cli/**`, `src/adapters/**`, `plugin/hooks/**`, `plugins/twining/**`, `scripts/build-codex-plugin.mjs`, `test/hooks/**`, `test/cli/**`, `test/adapters/**`.

1. Command core on v3: every command produces events through `EventStore.append(raw, ingress)` with ingress `mcp` or `cli`; the CLI gains `twining rule` (ceremony: TTY-only, human key, refuses under `TWINING_AGENT_CONTEXT`), `twining identity init`, `twining sync`, `twining doctor`, `twining events ls|show`.
2. Claude Code adapter (host matrix `docs/operations/hosts-claude-code-capabilities.md`): hooks that *perform* capture and injection via the CLI — SessionStart (startup/resume/clear/compact) injects the bounded working set and writes an `injected` receipt with the payload hash; UserPromptSubmit records `human_statement` (literal prompt) and injects deltas; PreCompact captures durable progress (`observation`, cursors); SubagentStart/Stop record work references + `reported_result` with finisher/stage, never completion; PreToolUse commit gate stays; PostToolUse activity marker stays; Stop/SessionEnd flush. Each hook's captures/injects/cannot-observe row is asserted in a real-host test (spawn `claude -p` in a temp project with the plugin) and the receiving-turn payload is proven by the receipt hash.
3. Codex adapter (`docs/operations/hosts-codex-capabilities.md`): same via the generated plugin; compaction re-injection rides SessionStart(resume)/UserPromptSubmit; real-host test with `zsh -lc codex …` in a temp project (RB4).
4. API/Bedrock library adapter: a small TypeScript module a coordinator embeds to produce the same events for a worker without memory tools; the parent adapter relays `reported_result`.
5. Source connector: git/GitHub observation events (`verified_observation`, `volatile: true`) for remote head, PR range, permission; requalification before consequential use.
6. Flip baseline gap tests 1, 2, 4 (provenance from the adapter's cwd); keep controls green. Cases: C06, C15, C27, plus interruption/outage.

## Lane 04 — retrieval and trust

Prereq: lane 02 projections + `query(mode: strict|lessons)`. Owns `src/retrieval/**`, `src/engine/context-assembler.ts`, decision read paths in `src/engine/decisions.ts`, `src/embeddings/**`, `src/tools/context-tools.ts`, `src/dashboard/query-routes.ts`, `test/retrieval/**`.

1. Scope-first candidate selection on every path (assemble, why, search, read-by-id, handoffs, graph neighbors, chunks, dashboard, exports, caches): authorized tenant/repo/task/attempt/revision filters before any ranking; strict mode never widens; `lessons` mode explicit and labeled with original scope/version/conditions.
2. Lifecycle resolver shared with lane 02 (current, historical, revoked, superseded, archived, provisional, inferred, contested) — no retrieval-local last-write-wins.
3. Required-facts-first packet: governing facts and consumer prerequisites first, then lessons/unresolved questions; budget over the *emitted* bytes with the DP4 tokenizer (declared version, calibrated conservative bound; exact count optional); visible incomplete result with omitted ids; action qualification refuses incomplete/stale prerequisites.
4. Explain packet: candidate/record versions, source pointers/hashes, evidence classes, freshness, ranking/index/model versions, reasons/scores/paths, omissions, token usage; emitted payload hash persisted and linked to the adapter's receipt (`selected` / `emitted` / `delivered` / `unknown`).
5. Injection defenses: rendering preserves evidence class; adversarial text in every field; recipes retrieved for inspection only.
6. Flip baseline gap tests 3, 6 (render side), 7; cases C01–C09, C12, C16, C19, C25, C26 with adversarial out-of-scope graph neighbors and cached reranker results, plus a legitimate cross-scope lesson as positive control; measured scoped-semantic vs lexical/exact comparison.

## Lane 05 — verification and operations

Prereq: none for fixtures/oracles (already started); combined system for the rest. Owns `test/acceptance/**` (except `slice/` while lane 02 builds it), `test/fixtures/**`, `scripts/qualify/**`, `docs/operations/**`, `docs/reports/**`.

1. Oracles for the remaining cases (C01–C08, C12, C13, C15, C17–C28), implementation-blind, dev + held-out variants, instruments-can-fail controls (scope filter off, trust check off, dedup off, byte preservation off must each make a negative test fail).
2. Real-topology tests: separate processes, disconnected stores, credential separation, disposable git remotes; C28 bundle for Dave's other computer (`scripts/qualify/c28-remote/`), reporting substitutes honestly.
3. Migration qualification per lane 02's tool; data-flow diagram + observed-traffic check (local embeddings, no outbound); resource measurements at 1k/10k/100k events.
4. Matched trial (RB5): harness conditions native / current Twining 2.16.1 / new Twining / structured baseline; C01–C09 × 5 variants × 2 reps at dev scale here under Max auth; full scale deferred to Dave's machine and reported as not-yet-run.
5. The matrix (`docs/reports/2026-09-foundation-matrix.md`) and final report.
