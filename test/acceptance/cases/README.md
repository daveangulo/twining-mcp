# Lane 04 acceptance cases (C01–C05, C08, C12, C19, C25, C26)

Each `cNN.test.ts` turns its oracle's assertions into named tests.

## Conformance mapping (frozen before results were seen)

The oracles are implementation-neutral and use their own vocabularies. This is
lane 04's mapping from those abstract surfaces onto this store:

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

## Scoring rules this lane follows

- An assertion whose surface this lane does not own is `it.todo("<id>: …")` with
  the owning lane named. It is never silently dropped and never scored as a pass.
- Every instrument-can-fail control named by an oracle is a test that disables
  exactly one switch and asserts the corresponding negative assertion FAILS.
  Assertions with no live control are recorded as not-tested, not as passed.
- Liveness controls (bait is reachable by a properly scoped principal) run
  first: without them the exclusion assertions are vacuous.
