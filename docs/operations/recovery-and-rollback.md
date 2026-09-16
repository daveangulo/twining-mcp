# Recovery and rollback — operator guide

Owner: lane 05 (verification and operations). **SKELETON — 2026-09-15.**

Sections marked **TODO** are blocked on a lane that has not shipped the
capability yet; each says which lane and what has to exist before the section
can be written from evidence rather than from intention. Nothing in this
document describes behaviour that has been demonstrated unless it says so.

> **Standing rule for this document.** Do not fill a TODO from a design
> document, an ADR or a code reading. Fill it from a run: the command, its
> output, and the artifact it produced. A recovery procedure that has never
> been executed is a hypothesis.

---

## 1. Setup

**TODO — lane 03** (`src/cli/**`, `plugin/hooks/**`).

Needs: `twining identity init`, `twining doctor`, the Claude Code and Codex
adapters, and the v3 store bootstrap path. Until those land there is no
supported installation sequence to document for v3.

What is already true and can be written now:

- The durable truth is `.twining/events/**` — immutable event files. Everything
  else under `.twining/` is derived and droppable.
- `events.db` is deliberately a **separate file** from `twining.db` so it can be
  deleted and rebuilt without touching v2 state (`src/events/db.ts`).
- The v3 store requires **node ≥ 22.13** (`node:sqlite`, no native dependency).

## 2. Automation boundaries — what runs without a human

**TODO — lane 03.**

Needs: the host capability matrices (`docs/operations/hosts-claude-code-capabilities.md`,
`docs/operations/hosts-codex-capabilities.md`) re-verified against the real
hosts, plus each adapter's declared captures / injects / cannot-observe rows
proven by a real-host test.

Already recorded (Stage 0, medium confidence, **needs re-verification in the
real host before it is relied on**): on both Claude Code and Codex the
compaction hooks are **observe-only**; re-injection rides `SessionStart` (with
the compact/resume source) and `UserPromptSubmit`. Compaction outcomes are not
an injection channel.

## 3. Scope behaviour — what an operator sees at each scope

**TODO — lane 04** (`src/retrieval/**`, `src/engine/context-assembler.ts`).

Needs: scope-first candidate selection on every read path, the `strict` vs
`lessons` mode distinction surfaced to the operator, and the explain packet.

Already true at the contract level: a scope is a tuple
`{tenant, repo, path, task, attempt, consumer, revision, global}`;
`scopeMatches` (retrieval) is bidirectional on `path` while `scopeGoverns`
(authority) is unidirectional; path matching is on segment boundaries, so
`src/auth` never matches `src/authz` (`src/contracts/scope.ts`).

## 4. Data flow

Complete. See [`data-flow.md`](./data-flow.md) for the component diagram, every
outbound destination, the first-use model download and its (currently missing)
off switch, and what the observed-traffic script can and cannot prove.

Two findings there bear directly on recovery planning:

- **F-OFFLINE** — the MCP server path has no way to disable the Hugging Face
  model download. An air-gapped recovery will attempt it and fall back to
  keyword search only after the fetch fails.
- **F-NO-NETWORK-EXCHANGE** — the v3 exchange has no network transport at this
  commit, so no recovery procedure involving a remote has been exercised.

## 5. Troubleshooting

**PARTIAL.** What can be written from the current code:

| symptom | what to look at | why |
| --- | --- | --- |
| A record is missing from the current view | `store.journalRows()` — find the event id and read its `state` and `reason` | Nothing is ever dropped. An event is `received`, `pending_parents`, `admitted`, `projected`, `quarantined` or `rejected`, and the reason is on the row. |
| An event never settles | its `state` is `pending_parents` and `pending_on` names ids that will never arrive | **Known defect F-PENDING (lane 02):** when a causal parent is *rejected*, the dependent event waits forever instead of terminating in a refusal. Reproduced by `scripts/qualify/c28-remote` (assertion A13). There is no operator remedy today. |
| The same id arrived with different bytes | `journalRows()` shows two rows for one id; the `canonical` row is untouched and the second is `rejected` / `conflicting_duplicate` | Both byte streams are retained as evidence (ADR §1.2, R07). |
| The derived index looks wrong | `store.rebuild()` then compare `projectionDigest()` | Rebuild is deterministic; a digest that changes across a rebuild is a defect, not a fix. |
| The checkout is behind the journal | `store.checkoutStatus()` returns `checkout_behind_journal` with the missing ids | — |

**TODO — lane 02** for the alert/diagnostic surface R20 requires: queue depth
and age, gaps, retries, rejected records, quarantined records, index freshness
lag, scope denials and migration state, exposed through
`twining status --exchange`. None of that exists yet, so an operator today has
only the raw journal.

**TODO — log hygiene.** R20 requires that logs expose neither credentials nor
inaccessible memory. Not yet audited; needs the lane 03 CLI and lane 04
retrieval logging to exist before an audit means anything.

## 6. Upgrades

**TODO — lane 02** (`src/migrate/**`).

Needs: `twining migrate --to 3` with manifest, id map, verify, interrupt/resume,
dry-run diagnostics, idempotent rerun, schema negotiation and old-client
refusal behaviour (ADR §10, case C21).

The qualification plan lane 05 will run against it, once it exists:

1. Capture a manifest of original bytes, identities and relationships **before**
   migration, over representative file-backed v1, SQLite/export-backed v2,
   archives, provisional and superseded records, malformed and conflicting
   exports, records with missing historical metadata, and records with no
   embeddings.
2. After migration verify, field by field on named records: lossless recoverable
   meaning, byte-identical source bytes, stable and injective identity mapping,
   and **explicit legacy uncertainty**.
3. Assert the three things that must never happen: no invented provenance, no
   conversion of a legacy `active` flag into an authenticated human ruling, and
   no discarded original evidence because a derived index was inconvenient to
   rebuild.
4. Interrupt the migration at each durable step, resume, and assert idempotent
   rerun.
5. Preserve dirty/unpublished work across the whole sequence.

## 7. Recovery

**PARTIAL.** What is demonstrated today:

- **Losing the derived database is recoverable.** `rm .twining/events.db*` then
  `store.rebuild()` replays every event file and returns a projection digest.
  The C28 bundle exercises this end to end (`rebuild` phase): store-C is created
  empty, fed only store-A's durable event files, and reaches a **byte-identical
  projection digest** (assertions A18/A19/A20).
- **Recovery time** is the `rebuild` column in
  [`../reports/2026-09-resource-measurements.md`](../reports/2026-09-resource-measurements.md).

**TODO — lane 02** for the rest: crash at each durable boundary with an actual
process kill (C18), backup consistency across source/outbox/index state,
credential rotation, source-access revocation, deletion and tombstone behaviour
(C20), retention, and export/import into a clean installation on a second
computer (C28 with a real two-machine topology).

## 8. Rollback — including writes made after the upgrade

**TODO — lane 02.** This is the section the package is most insistent about, so
the requirement is written out here now and the evidence is filled in later.

A rollback is only lossless if **writes made after the migration survive it**.
The bar, restated so it cannot be softened later:

1. A database backup that silently loses every post-upgrade record is **not**
   lossless rollback.
2. An unsupported semantic downgrade must be **visible**, must preserve the new
   records intact, and must prevent old clients from corrupting them.
3. The retained records must be **inspectable and re-importable**. An archive
   that cannot be read or replayed forward does not qualify.
4. Functionality unavailable during rollback is reported **separately** from
   data preservation. "You cannot use feature X while rolled back" is an
   acceptable answer; "feature X's records are gone" is not.

The shape the ADR proposes — a versioned retained event archive plus an explicit
restricted legacy view — satisfies (1)–(3) on paper. Lane 05 will not report it
as satisfying them until it has demonstrated: a rollback, an inspection of the
retained archive, and a lossless forward recovery back to v3 with the
post-upgrade records intact.

## 9. Erasure limits — what cannot be deleted

**PARTIAL.** The honest statement, which does not depend on any lane:

- Twining can tombstone a record and exclude it from every current view, and it
  can purge local bytes.
- It **cannot** erase anything from a git clone somebody else already has, from
  a backup, from a mirror, or from a host's own transcript. Any promise of
  global deletion would be false.
- C28 A16 makes this explicit: no report, receipt field, doc string or
  diagnostic may claim global erasure from clones or backups. Retention and
  clone limits are stated instead.

**TODO — lane 02** (case C20) for the demonstrated behaviour: tombstone, purge
and forget semantics; what a reconnecting stale replica does with a
pre-tombstone copy; and what a backup restore resurrects.
