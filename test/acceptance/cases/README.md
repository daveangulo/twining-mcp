# `test/acceptance/cases/` — executable acceptance cases

Each `cNN.test.ts` turns its oracle's assertions into named tests. The directory
was opened by lane 04 (C01–C05, C08, C12, C19, C25, C26) and by lane 05 (the
cases no lane's brief claimed); lanes 02b and 02c added C17, C18, C20, C21, C22
and C24 on top. A `CNN.todo.md` stub means the case is still blocked — a stub is
never converted into a passing test.

## Rules

1. **An oracle expectation is never edited to match observed behaviour.** If a
   test and an oracle disagree, the oracle wins until a written
   source/requirement reason says otherwise, and the original expectation is
   kept beside any correction (`test/acceptance/oracles/*.oracle.md`,
   §"Oracle-change protocol").
2. **Declare the observable mapping in the test file.** The oracles are
   implementation-blind and use their own vocabularies. The mapping from an
   oracle's abstract observables onto `EventStore`/`Transport` calls is part of
   the evidence, not a convenience — write it in the file header, as
   `test/acceptance/slice/c09.test.ts` and `cases/c21.test.ts` do.
3. **Use the shared harness.** `test/acceptance/harness/` provides the fixture
   loader, the synthetic identity factory, the multi-replica scenario driver and
   the instrument-can-fail switchboard; `cases/harness.ts` wraps the slice
   harness in lane 04's scope gate. Do not re-mint identities by hand.
4. **Every negative assertion needs a control.** Before claiming a negative
   assertion is coverage, flip the switch the oracle names and prove the
   assertion fails. `harness/switchboard.test.ts` shows the pattern; a control
   that cannot break its assertion is reported as a defect of the instrument.
5. **Unavailable is never converted into passed.** A case blocked on something
   that does not exist stays a `.todo.md` stub with the blocker named, and an
   assertion whose surface this lane does not own is `it.todo("<id>: …")` with
   the owning lane named — never silently dropped, never scored as a pass.
6. **Liveness controls run first.** Bait must be shown reachable by a properly
   scoped principal before any exclusion assertion means anything; three
   vacuous passes were caught this way.
7. **A fixture must cite the policy it is judged under.** ADR §4.3.1 — a
   membership is a causal ancestor of anything it authorizes — so deliver a
   policy and the events it grants with `deliverUnderPolicy()`, not with a bare
   `deliver()` of both. A fixture that forgets is quarantined `no_policy_yet`
   and every assertion over it becomes vacuous.

## Conformance mapping (frozen before results were seen)

Lane 04's mapping from the oracles' abstract surfaces onto this store:

| Oracle surface | This store |
| --- | --- |
| `EVENTS` / event log | `EventStore.events()` over admitted envelopes (`src/events/event-store.ts`) |
| `CURRENT` / current applicable view | `EventStore.query()` filtered through `selectCandidates` (`src/retrieval/select.ts`) |
| `HISTORY` / historical view | `EventStore.history()` + `projectionAsOf()` |
| `DELIVERY` / receipts | `src/retrieval/receipts.ts` — `selected` / `emitted` / `delivered` / `unknown` |
| `retrieve(principal, …, mode, paths)` | `selectCandidates` + the caller's ranking; `paths` are the caller's, the gate is shared |
| `qualify(action, evidence)` | `src/retrieval/lifecycle.ts` `qualifies()`, delegating to `projection.ts` `currentUseClaim()` |
| `explain(query_id, viewer)` / `operator_diag` | `src/retrieval/explain.ts` `explainFor` / `explainOperator` |
| freshness `live \| stale \| unknown` | `src/retrieval/lifecycle.ts` `freshness()` |
| `mode` `strict` / `cross_scope_lessons` | `RetrievalMode` `"strict"` / `"lessons"` |

## Still blocked

`test/acceptance/oracles/INDEX.md` carries the per-assertion ownership map.
Ownership questions the lead settled at merge: **C03 belongs to lane 04**
(which delivered C01–C05) and **C27 to lane 03** (which delivered C06/C15/C27),
so those two stubs are superseded by the lanes' own coverage rather than by a
new owner.

| case | subject | blocker |
| --- | --- | --- |
| C13 | see `C13.todo.md` | written before the Git carrier merged; `src/exchange/git-transport.ts` now exists, so this stub is a coverage gap rather than a dependency |
| C23 | see `C23.todo.md` | derived-service outage and backpressure — needs a queue surface neither lane built |
| C28 | see `C28.todo.md` | two real computers; the one-machine half runs from `scripts/qualify/c28-remote/`, the second machine is Dave's action and stays UNAVAILABLE until then |
