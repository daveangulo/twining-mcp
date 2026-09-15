# `test/acceptance/cases/` — case tests no lane owns yet

Owner: lane 05. This directory holds executable tests for acceptance cases that
no other lane's brief claims, plus `*.todo.md` stubs for the ones whose
implementation dependency has not merged.

## Rules

1. **An oracle expectation is never edited to match observed behaviour.** If a
   test and an oracle disagree, the oracle wins until a written
   source/requirement reason says otherwise, and the original expectation is
   kept beside any correction (`test/acceptance/oracles/*.oracle.md`, §"Oracle-change protocol").
2. **Declare the observable mapping in the test file.** The oracles are
   implementation-blind and use their own vocabularies. The mapping from an
   oracle's abstract observables onto `EventStore`/`Transport` calls is part of
   the evidence, not a convenience — write it in the file header, as
   `test/acceptance/slice/c09.test.ts` does.
3. **Use the shared harness.** `test/acceptance/harness/` provides the fixture
   loader, the synthetic identity factory, the multi-replica scenario driver and
   the instrument-can-fail switchboard. Do not re-mint identities by hand.
4. **Every negative assertion needs a control.** Before claiming a negative
   assertion is coverage, flip the switch the oracle names and prove the
   assertion fails. `harness/switchboard.test.ts` shows the pattern; a control
   that cannot break its assertion is reported as a defect of the instrument.
5. **Unavailable is never converted into passed.** A case blocked on an unmerged
   lane stays a `.todo.md` stub with the blocker named. Do not write a test that
   passes vacuously because the feature is absent.

## Which cases live here

`docs/plans/2026-09-15-lane-briefs.md` assigns most cases to lanes 02, 03 and
04. The five below are the ones the programme has not assigned to an
implementing lane, so lane 05 carries the stub until an owner appears. See
`test/acceptance/oracles/INDEX.md` for the per-assertion ownership map.

| case | subject | blocker |
| --- | --- | --- |
| C03 | see `C03.todo.md` | lane 04's retrieval path; the brief also lists C03 under lane 04 — ownership needs the lead's ruling |
| C13 | see `C13.todo.md` | the Git carrier (`src/exchange/git-transport.ts`, ADR §8.2) is not merged |
| C23 | see `C23.todo.md` | derived-service outage and backpressure need lane 02's queue + lane 04's recall path |
| C27 | see `C27.todo.md` | the brief lists C27 under lane 03 *and* leaves it unowned here — ownership needs the lead's ruling |
| C28 | see `C28.todo.md` | two real computers; partial qualification exists in `scripts/qualify/c28-remote/` |

## Status

No executable case tests yet. The harness and its self-test are in
`test/acceptance/harness/`; the slice's case tests are in
`test/acceptance/slice/` and belong to lane 02.
