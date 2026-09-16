# Foundation programme — handoff for the next session (written 2026-09-15 ~20:20)

Read in this order: this file → `2026-09-15-foundation-programme-plan.md` (ruled plan) → `2026-09-15-foundation-programme-log.md` (A/DN/D/S audit trail, D1–D40) → `docs/adr/2026-09-foundation-contracts.md` + appendices A/B/C → `docs/reports/2026-09-foundation-matrix.md`. Gate 1: `twining_assemble` scope `src/` — the store holds every decision and finding from this run.

## Where things are

| Branch | HEAD | State |
|---|---|---|
| `foundation/v3` | `31f8d45a` (calibration wiring `3687984a` below it) | **2 commits ahead of origin — push failed (SSH agent dropped): `git push origin foundation/v3`**. Full suite 179 files / 2711 passed / 0 failed; tsc clean. Draft PR #49 (do-not-merge). |
| `feat/cli-2.17` | `d2e96ad` | Reviewed, green; draft PR #48 → main. Ships as 2.17.0 under Dave's tag after `scripts/bump-plugin-version.sh` (rebuilds the bundle). |
| `wip/codex-plugin` | `dedaacc` | Parked Codex plugin carrier. |
| lane worktrees | `.claude/worktrees/lane-{02-exchange,02c-migration,03-runtime,04-retrieval,05-verification}`, `cli-2.17` | All merged into `foundation/v3`; safe to prune (`git worktree remove`, delete `lane/*` branches) once PRs are settled. |

## What is done

Stage 0 (baseline, contracts, oracles, steelman, slice) → ADR ACCEPTED draft 2 → contracts `3.0.0-draft.3` → five lanes built, adversarially reviewed (2 refuters/finding), fixed, merged: event log + projections + Git carrier + fault suite + migration/rollback + runtime adapters (Claude Code real-host verified) + CLI verbs + scope-first retrieval with budget/receipts + acceptance harness. Matrix: `docs/reports/2026-09-foundation-matrix.md` (rebuilt at merge — trust it over memory).

## What remains (in order)

1. Push `foundation/v3`.
2. **Dev-scale matched trial (RB5):** harness `~/code/twining-benchmark-harness`, Max auth (no key), conditions native-journals / released 2.16.1 / v3 (`foundation/v3` via `npm i -D` or link) / `file-reload-structured` baseline; C01–C09 scenarios from `test/acceptance/oracles/` (5 variants × 2 reps is the full protocol — dev scale here, full scale on Dave's machine, reported as not-yet-run until then). Feeds R20 benefit and R14 recall-quality rows.
3. **Final report** `docs/reports/2026-09-foundation-final.md`: matrix verdicts, go/no-go table (passed / failed / unavailable / waived / not-tested — never convert unavailable into passed), source identities (commits above), test commands, known limits, migration instructions (`twining migrate --to 3`, `rollback --to 2`), remaining owner decisions, strongest case for the simpler baseline.
4. Operator docs: complete `docs/operations/recovery-and-rollback.md`, `data-flow.md`, `hosts-*.md`, `docs/CLI.md`.
5. Optional second tokenizer calibration with a ≥80%-whitespace non-blank corpus doc (see finding `01M2M36YZJ…`).

## Owner (Dave) items

- Push above; merge/tag decisions for PR #48 (2.17.0) and later #49.
- `plugin/BEHAVIORS.md` is stale (41 tools) and the committed plugin bundle is stale — both are release work (`bump-plugin-version.sh`).
- Codex: one-time interactive hook trust (`/hooks`) so lane 03's Codex real-host test can run (C15 second backend is UNAVAILABLE until then).
- Run the C28 bundle on the second machine: `scripts/qualify/c28-remote/README.md`; return the tarball; verify with its verifier.
- Two named design decisions still open: file-wins precedence (baseline gap 8 still reproduces) and an owner for remote-state staleness (gap 5).
- Product decision to confirm or veto: v3 SessionStart injects only the working set, no gate prose (D25).

## Standing rules that bit us this run

Absolute paths for worktree ops; `node scripts/inject-posthog-key.mjs` before tsc/vitest in any fresh worktree; never `npm run build` in the main checkout; never two full vitest runs at once (golden-fixture/server-startup flake under contention — re-run alone); lanes run tsc LAST; extraction scripts must write every structured field; a flipped gap test must exercise the OLD path; review agents in scratch copies, never the live tree; `timeout` does not exist on this Mac.
