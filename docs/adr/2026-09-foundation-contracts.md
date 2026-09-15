# ADR: Twining v3 foundation contracts — identity, evidence, lifecycle, exchange

**Status:** PROPOSED (draft 1, 2026-09-15). Becomes ACCEPTED only after Stage 0 evidence: the reproduced gaps with controls, the independent oracles for C09/C10/C11/C14/C16, the smaller-evolution steelman (§9.1), and the vertical slice (§12) — all recorded in `docs/plans/2026-09-15-foundation-programme-log.md`.
**Owner:** lead (lane 01). **Consumers:** lanes 02–05. **Contract version:** `3.0.0-draft.1` (`src/contracts/`).
**Plan of record:** `docs/plans/2026-09-15-foundation-programme-plan.md`. **Package:** `twining-foundation-20260915` (R01–R20, C01–C28).

---

## 0. Decision in one paragraph

Twining's durable truth becomes an **append-only log of immutable, digest-identified, principal-attributed events**; every current view (a decision's status, a resolved post, a merged entity) is a **deterministic projection** rebuilt from admitted events under an explicit authority rule. Exchange between processes, users and computers is a **delivery state machine over events** — persisted, exported, transferred, received, admitted, projected, injected, acknowledged — with Git as the default carrier (a dedicated exchange ref, never the user's source checkout) and a `Transport` interface that a reference relay also implements. Authority is an **evidence class on the event**, never a caller-supplied field: only a human-run signing ceremony produces a ruling; everything a model writes is at most a proposal, inference or reported result. Legacy v2 records migrate losslessly into `created` events with their original bytes retained and their authority marked `legacy_unverified`; rollback regenerates a restricted v2 view while the event log stays intact.

What this does **not** change: SQLite stays the local runtime store (now a projection + journal); the server never runs git; MCP tool names and the CLI command names are the same surface; Node ≥ 22.13 and zero native dependencies hold.

---

## 1. Q1 — What is a record?

### 1.1 Vocabulary

| Term | Meaning | Mutable? |
|---|---|---|
| **Event** | One immutable, self-describing unit written by one producer. The only thing that is ever stored durably or exchanged. | No |
| **Record** | The logical thing an event lineage is about (a decision, a post, an entity, a relation, a handoff, a work reference, a principal, a policy). Identified by the ULID of its `created` event. | Only through further events |
| **Source evidence** | Original bytes from outside Twining (a file, a CLI rendering, a PR body) plus their identity. Stored as content-addressed attachments. | No |
| **Assertion** | An event *about* a source (an `observation`) — what a collector or model claims it saw, with the collector's identity and time. | No |
| **Ruling** | A human-authorized statement (`evidence_class: human_ruling`). | No (revocable by another ruling) |
| **Derived summary** | Model-produced text about other records (`model_inference`). Useful, never authoritative. | No |
| **Lifecycle event** | An event whose payload changes a record's applicable state (`superseded`, `promoted`, …). | No |
| **Projection** | Derived current view in SQLite, rebuilt from admitted events. | Yes — derived only, never exchanged |
| **Version** | Of a record: the event id of the latest admitted event affecting it on this replica, plus `version_digest` = digest over the projected record. Two replicas with the same admitted set produce the same version. | — |

### 1.2 Event envelope (`3.0.0-draft.1`)

```json
{
  "v": 3,
  "id": "01M2K...ULID",
  "kind": "created",
  "record": { "type": "decision", "id": "01M2K...ULID-of-created-event" },
  "scope": { "tenant": "t_01…", "repo": "r_01…", "path": "src/auth/", "task": "…", "attempt": "…", "consumer": "…", "revision": { "base": "sha", "head": "sha" } },
  "producer": { "principal": "p_01…", "kind": "agent", "host": "h_01…", "session": "…", "turn": "…", "asserted_actor": "main" },
  "source": { "repo": "r_01…", "worktree": "wt_…", "branch": "feature-x", "commit": "sha", "dirty": true },
  "parents": ["01M2J…"],
  "evidence_class": "proposal",
  "occurred_at": "2026-09-15T20:00:00.000Z",
  "payload": { "...kind-specific, canonical..." },
  "attachments": [{ "sha256": "…", "bytes": 1234, "media_type": "text/markdown", "source_uri": "…", "anchor": "…", "encoding": "utf-8", "source_kind": "file" }],
  "digest": "sha256:…",
  "sig": { "alg": "ed25519", "key": "k_01…", "value": "base64" }
}
```

Rules:

- **Identity.** `id` is a ULID minted by the producer. Its lexical order is used for *deterministic replay* only — never for precedence (R05: arrival order and wall-clock cannot settle authority).
- **Digest.** `digest` = `sha256` over the **canonical bytes** of the envelope minus `digest` and `sig`. Canonical bytes = JSON with recursively sorted keys, no insignificant whitespace, UTF-8, no NFC normalization (bytes are bytes). The file on disk may be pretty-printed; **file bytes ≠ canonical bytes ≠ source bytes** — three different values, three fields (`digest`, attachment `sha256`, and the transport's own file hash if any).
- **Stable identity + payload digest (R07).** A retry with the same `id` and the same `digest` is a no-op. The same `id` with a different `digest` is an explicit `conflicting_duplicate` and is rejected with the conflict recorded (never applied, never overwritten).
- **Parents.** Causal prerequisites. An event is not applied until every parent is admitted; until then it is `pending_parents` (visible, never dropped).
- **Signature.** Optional Ed25519 over the canonical bytes, by a principal key. Absence makes the producer claim *asserted*, not authenticated. Legacy-migrated events are unsigned by construction.
- **Source-byte representation.** Original bytes live in `.twining/attachments/<sha256[0:2]>/<sha256>` (content-addressed, never rewritten). An attachment record carries `source_uri`, `anchor`, `source_kind` (`file` | `cli_render` | `pr_body` | `commit` | `issue` | `transcript_excerpt` | `other`), hash algorithm (`sha256`), `encoding` (as observed, e.g. `utf-8-bom`, `utf-16le`), `bytes`, and where applicable the Git object identity (`git_oid`) and `base`/`head`. A normalized-text hash, if computed, is a separate `normalized_sha256` field on the observation, never a replacement (C07).

### 1.3 Record types and their `created` payloads

`decision` (summary, context, rationale, rationale_source, constraints, alternatives, depends_on, assumptions, affected_files, affected_symbols, confidence, reversible, domain, **parts?**), `post` (entry_type, summary, detail, tags, relates_to), `entity`, `relation`, `handoff`, `work` (external work definition / assignment / attempt / job **references** — R04: stored, never granted), `principal`, `membership` (store policy), `observation`, `receipt`, `ruling`. Field-level schemas are executable in `src/contracts/`.

`parts` on a decision (optional): `[{ part_id, text }]` — the unit of **partial supersession** (C16, R06).

---

## 2. Q2 — Whose statement is it?

### 2.1 Principals

| Kind | Identity | Key | Minted by |
|---|---|---|---|
| **human** | `p_…` ULID | Ed25519 keypair in the OS keychain or `~/.twining/identity/human-<id>/` (0600), passphrase-protected | `twining identity init --human` (interactive) |
| **agent / service** | `p_…` | none of its own; acts *through* a host key | registered by a host or a human |
| **host / installation** | `h_…` with key `k_…` | Ed25519 in `~/.twining/identity/host/` (0600) | first run on a machine |

`producer.principal` + `producer.host` are what the signature authenticates. `producer.asserted_actor` carries today's caller string (`agent_id`) unchanged — recorded, displayed, never authoritative. Git authorship, possession of a clone and a valid signature are **not** permission: capability comes from the store's `membership` policy (§2.4).

### 2.2 Evidence classes (R03)

| Class | Who can produce | Authority rank | Notes |
|---|---|---|---|
| `human_ruling` | a human principal via the signing ceremony (§2.3) | 5 | the only class that can grant, revoke or resolve authority |
| `verified_observation` | a host adapter or connector that checked the source itself (hash matched, git object present, API returned) | 4 | carries the check method and the source version |
| `reported_result` | a worker's own return, relayed by a trusted parent adapter | 3 | "the worker said" — not "it is so" |
| `human_statement` | host adapter capturing a human's literal prompt text | 3 | proves a human typed it, not that they hold authority; upgradeable only by a ruling that cites it |
| `proposal` / `model_inference` | any agent | 2 | default for everything a model writes |
| `question` | any | 1 | open |
| `legacy_unverified` | migration only | 2 (for precedence) | flagged everywhere it renders |

Rendering preserves the class. `MUST`, `active`, or a heading confers nothing (R17).

### 2.3 The ruling ceremony (RB6)

`twining rule --scope <scope> --statement <text> [--cites <event ids>] [--grants …]` runs **only** on a TTY with the human key unlocked; it refuses when stdin is not a TTY, when `TWINING_AGENT_CONTEXT` or a host-adapter environment marker is present, or when invoked through the MCP or CLI command registry. It writes a signed `ruling` event. MCP/CLI ingress can never mint `human_ruling`; the schema validator rejects it from those paths outright, before storage.

### 2.4 What can be checked where

| Claim | Checked locally | Needs another source | Remains unverified |
|---|---|---|---|
| Event bytes unchanged since production | digest recompute | — | — |
| Producer is who it says | signature vs known host/human key in `principal` records | — | unsigned / legacy |
| Producer *may* do this in this scope | `membership` policy projection | — | if policy absent: default-deny for authority-changing kinds, default-allow for proposals |
| Source bytes are what the observation says | attachment sha256 | — | — |
| Source is still current (PR head, remote branch, permission) | — | live check via connector (`observation` with `volatile: true`) | offline |
| A commit exists | `git rev-parse --verify` in the producing repo | — | when the repo is not present |

---

## 3. Q3 — Where does it apply? Scope algebra

`scope` is a tuple, each component optional except `repo` for repository-bound records:

`tenant → repo (repo_id) → path (prefix) → task → attempt → consumer`, plus `revision {base, head}` and effective time.

- **repo_id** is minted once per repository (`twining identity init` writes `.twining/store.json` with `store_id` and `repo_id`; a *shared* store used by several repositories holds one `store_id` and many `repo_id`s). Remote URL, path and branch are **labels** carried in `source`, never identity (R01). Renames and relocated clones keep `repo_id`; a fork is a new `repo_id` whose `principal`/`membership` records declare `forked_from` — a different trust domain by default.
- **Matching.** A query scope `Q` matches event scope `E` when every component present in `Q` equals (`tenant`, `repo`, `task`, `attempt`, `consumer`) or prefix-matches on a **segment boundary** (`path`) the corresponding component of `E`; components absent in `E` are wildcards *only* for `path` (a repo-wide rule applies to every path) — never for `tenant`/`repo` (an event without `repo` is store-global and must say so with `global: true`).
- **Inheritance.** A broad statement applies to narrower scopes within its authorized envelope. A narrow statement never widens.
- **Explicit global rules.** `global: true` requires ruling or membership authority to create.
- **Cross-repository dependencies.** `depends_on` may cross `repo_id`; retrieval of the dependency is an explicitly authorized cross-scope read, never a silent widening (R13).
- **Relations.** `supersedes`, `corrects`, `overrides`, `depends_on`, `relates_to` are validated at ingress: target must exist or the event stays `pending_parents`; the author's authorized scope must cover **both** endpoints for authority-changing relations, else `quarantined:unauthorized_cross_scope`; cycles in `supersedes`/`corrects` → `rejected:cycle` (C22). A valid scoped relation is admitted (positive control).
- **Store vs source.** `store_id` says where the bytes live; `source.repo`/`worktree`/`commit` say where the producer was working. They are recorded separately and never inferred from one another (gap 4).

---

## 4. Q4 — How does it change? Lifecycle

### 4.1 Lifecycle event kinds

| Kind | Payload | Effect on projection |
|---|---|---|
| `created` | record body | record exists, status `active` or `provisional` (decision), `open` (post) |
| `promoted` | target | provisional → active |
| `reconsidered` | target, reason | active → provisional (clears promotion) |
| `superseded` | target, by (successor record), `parts?`, reason | target (or only the named parts) → superseded; back-link derived |
| `overridden` | target, reason, replacement? | target → overridden |
| `corrected` | target, correction, `applies_to` scope | a scoped correction; target keeps applying outside `applies_to` (C09) |
| `contested` | target, by, reason | marks a live contradiction; both visible |
| `conflict_resolved` | conflict_id, winner, reason | requires authority ≥ both sides (§4.3) |
| `archived` / `restored` | target | archived ↔ prior status (`archived_from` derived, never guessed) |
| `resolved` | target (post), note | open → resolved |
| `acknowledged` | target (handoff) | acknowledged |
| `amended` | target, add_affected_files/symbols, reason | metadata union (append-only) |
| `commit_linked` | target, commit | link |
| `retracted` | target, reason | author withdraws own statement; historical view keeps it |
| `revoked` | target, reason | authority withdrawn (rulings, grants); never silent |
| `tombstoned` | target, reason, purge | content redacted in projections; purge instructs local attachment removal; clones are not recalled (C20) |

### 4.2 Authorization of transitions

| Transition | Who may request | What authorizes | Durable at ack |
|---|---|---|---|
| `created` (proposal/inference/question) | any agent or human principal | membership `write` in scope (default allow) | event journaled + file written (fsync) |
| `created` with `human_statement` | host adapter only | adapter key | same |
| `created` with `verified_observation` | connector/adapter | adapter key + check method recorded | same |
| `promoted`/`reconsidered`/`archived`/`restored`/`resolved`/`acknowledged`/`amended`/`commit_linked` | any principal with `write` | membership | same |
| `superseded`/`overridden`/`corrected` | principal with `write`; **class rule:** the successor's class must be ≥ the target's class, else the event is admitted as `contested`, not applied | membership + class rule | same |
| `retracted` | the target's own producer principal | signature match (or asserted match when unsigned, flagged) | same |
| `revoked`, `conflict_resolved`, `ruling`, `membership` changes, `global: true` | human principal with `rule` capability in scope | ceremony signature + membership | same |
| `tombstoned` | `rule` capability, or the own producer for own proposals | as above | same |

"Durable at ack" is the **local** boundary: the producing API returns only after the journal row and the event file are fsynced. Transfer, receipt and injection are separate states (§5). No acknowledged event is ever silently lost: a failure after the ack is a visible `outbox` backlog, never a rollback.

### 4.3 Precedence rules (what "current" applies)

Applied in this order; wall-clock never enters:

1. **Class rank.** A higher-class event prevails over a lower-class one on the same record part; a lower-class successor becomes `contested` and is shown beside the governing record.
2. **Explicit resolution.** A `conflict_resolved` by an authorized principal settles equal-class contradictions.
3. **Policy rule.** A store `membership` may declare a deterministic rule for equal-class concurrent successors (e.g. `author_wins_for_own_records`). Absent a rule, **both remain applicable and visible as `conflicted`** (R05, C11) — retrieval says so; action qualification refuses.
4. **Scope.** A correction applies only within its `applies_to`; a broader ruling replaces narrower statements only inside its authorized envelope (R06).

Causal order comes from `parents`; equal-class concurrent successors with no path between them are, by definition, concurrent. Corrections of corrections chain through `parents`; competing corrections follow rule 3.

### 4.4 Archival is not revocation

`archived` hides from default retrieval; `restored` returns the record to its **remembered** prior status (derived from the event chain, never assumed). A restored provisional stays provisional; a restored superseded stays superseded; a revoked ruling cannot be restored to authority by `restored` (C16).

---

## 5. Q5 — What has been exchanged? Delivery state machine

Per (event, replica):

```
local_persisted ─▶ exported ─▶ transferred ─▶ received ─▶ admitted ─▶ projected ─▶ injected ─▶ task_acked
                                                    │          ├─▶ pending_parents (waits)
                                                    │          ├─▶ quarantined (kept, not applied, reason)
                                                    │          └─▶ rejected (kept as evidence, reason)
```

| State | Meaning | Evidence |
|---|---|---|
| `local_persisted` | journal + event file fsynced on the producer | producer API return |
| `exported` | event file present in the exchange working tree | file exists |
| `transferred` | the carrier confirmed the bytes left this host (Git: commit on the exchange ref reached the remote; relay: `POST` returned the event's `digest`) | transport receipt with carrier identity (commit sha / relay op id) |
| `received` | bytes present on the consumer replica (fetched / pulled / polled) | consumer inbox scan |
| `admitted` | schema, digest, signature/policy, scope, parents all validated | admission log row |
| `projected` | applied to the consumer's projection | projection version |
| `injected` | included in a specific host/session/turn packet; `receipt` event with `payload_hash` | receipt event (§6 of lane 04) |
| `task_acked` | an explicit task-level acknowledgement by a consumer principal | `receipt` event with `stage: task_acked` |

Memory synchronization (`admitted`) and task completion (`task_acked`) are different events by different principals; a storage ack, a Git merge, a worker return or a passing review never substitutes for another state (R04, C06).

**Cursors.** Producer outbox cursor per transport (`.twining/store/outbox.json`, local). Consumer cursor per principal in `.twining/cursors/<principal>.json` — **single-writer** files (only that principal rewrites its own), so they union-merge without conflict; the same principal writing from two clones is detectable (two cursors with the same principal and diverging `last_admitted` → `cursor_fork` warning).

**"Fully exchanged"** is defined only relative to (a) a **membership version** `M` (an explicit list of consumer principals) and (b) an **event cut** `E` (a set of event ids, e.g. all events admitted on the producer as of a cursor): fully exchanged(M, E) ⇔ every principal in M has a cursor ≥ E. Joining/leaving is a `membership` event that changes `M`; a lost device is a `revoked` principal removed from `M` going forward with the cut recorded; an unreachable replica keeps the phrase false — it never silently becomes true.

**Reconnect and redelivery.** A consumer re-scans from its cursor; duplicates by `id` are no-ops; `id` reuse with a different digest is a conflicting duplicate. Lost acks: the producer retries the *same* `id`; the transport reconciles by `id`/`digest`, never submitting a second operation (C10). Clock skew: `occurred_at` is informational; nothing orders by it. Partition: producers keep writing locally (available); authority-changing operations remain local proposals until admitted by the store's policy — a replica never claims a ruling it has not received. Restart: every state above is on disk; recovery replays from the journal and inbox (C18).

**Consistency/availability.** Local writes are always available (AP for the local replica). Convergence: two replicas with the same admitted set produce byte-identical projections (deterministic reducer). Consistency across replicas is *causal with explicit conflicts* — never last-writer-wins. There is no exactly-once network delivery claim; idempotent application gives at-least-once transfer with exactly-once *effect*.

---

## 6. Q6 — What does "current" mean?

| Category | Example | Rule |
|---|---|---|
| Immutable historical evidence | a review of range A | never changes; `applies_to.revision` bounds it (C01) |
| Time-bound observation | "branch X existed at T" | keeps `observed_at`; present state `unknown` unless re-observed |
| Live-requalify facts | PR head, remote branch, permission, acceptance state | `volatile: true`; consequential use requires a `verified_observation` newer than `max_age` (policy) or an explicit ruling; otherwise **refused**, not assumed |
| Offline last-known | cached observation with age | served as `stale` with age; action qualification refuses |
| Revoked source access | permission revocation `observation` | serving policy `deny` for derived records when the revocation is **known** to this replica; an offline replica reports `revocation_unknown` (C19) — it never claims to know |

A local branch deletion, a file existence test or an index refresh is **not** a live remote check (R12); the staleness scorer stays a heuristic and is labeled as such.

---

## 7. Q7 — Trust boundaries

| Threat | Protection | Honest limit |
|---|---|---|
| Malicious imported record (Git pull, relay, file) | admission validates schema, digest, signature/policy, scope, class; text is data — no ingress path executes it; `human_ruling` from any non-ceremony path is rejected at the schema layer | unsigned proposals are admitted as `proposal`; they can mislead a reader but cannot change authority or policy |
| Authenticated but unauthorized user | capability check against `membership` for every authority-changing kind; a valid signature without capability → `rejected:unauthorized` with the attempt logged (C12) | a store with no membership policy defaults to deny for authority-changing kinds |
| Old client (2.x) | `config.version: 3` → 2.x goes read-only (`FORMAT_VERSION_TOO_NEW`, existing gate); 2.x never sees `events/`; anything it writes into the frozen `records/` after rollback is ingested as new legacy events on forward recovery | a 2.x older than the version gate (< 1.21) is unsupported and documented |
| Compromised adapter/host key | keys are per host, scope-limited by membership; `revoked` principal events; rotation = new key + `principal` event citing the old | events signed before the revocation cut stay admitted (history), flagged `key_revoked_after` |
| Direct DB/file access on the same OS user | projections are rebuildable; signed events detect byte tampering; attachments are content-addressed | an attacker with the user's filesystem can read keys that are not passphrase/keychain protected and can delete files; the guarantee is *not forgeable through Twining's APIs or imported records*, not *unforgeable by local root* |
| Prompt-injection text in any field | rendering preserves evidence class; no field is executed; recipes are retrieved for inspection only (C08) | a model may still be persuaded by data — the boundary is enforced in ingress/action APIs, not in prose |

---

## 8. Storage and transport design (proposed default)

### 8.1 On-disk layout (v3)

```
.twining/
  store.json                  # store_id, repo_id(s), format version 3, created_at   (committed)
  events/<yyyy-mm>/<ulid>.json  # immutable events, one file each                    (committed on the exchange ref)
  attachments/<aa>/<sha256>   # content-addressed source bytes                       (committed, size-capped by policy)
  cursors/<principal>.json    # single-writer consumer cursors                       (committed)
  policy/                     # membership / principal snapshots (also events)       (committed)
  store/twining.db            # projection + journal + outbox + admission log         (gitignored)
  store/identity/             # host key cache                                         (gitignored)
  records/                    # FROZEN v2 view after migration (RECORDS-FROZEN.md)    (committed, untouched by v3)
  legacy/manifest.json        # migration manifest: legacy bytes, ids, relationships   (committed)
```

### 8.2 Git carrier (default) — DP11

Events, attachments, cursors and policy live on a **dedicated exchange ref** (`refs/heads/twining/exchange`, orphan history) checked out in a dedicated worktree at `.twining/exchange/` (gitignored path inside the store). `twining sync` — an explicit CLI verb, never the server — stages only paths under that worktree, commits with a machine message, fetches, merges (set-union by construction: no file is ever rewritten), and pushes. The user's source checkout is never reset, stashed, switched, rebased or auto-committed (R09 non-interference). A source-branch mode (events ride the working branch, as `.twining/records/` does today) is kept as a configuration option for the migration window; it forfeits non-interference and is labeled as such.

Why this beats today's model on the required cases: a rewind of the exchange checkout changes the *received* set, not the *admitted* set — the local journal retains every admitted event, and the replica reports `checkout_behind_journal` instead of silently revoking (C14); history rewrites cannot resurrect a tombstoned record because the tombstone is itself an admitted event in the journal; a force-push that drops events is a visible `receipt gap` for every consumer whose cursor exceeds the new head.

### 8.3 Transport interface

```ts
interface Transport {
  id(): TransportId;                              // git:<remote>/<ref> | relay:<url> | fs:<path>
  publish(events: Event[]): Promise<PublishReceipt>;   // returns carrier ids per event digest; idempotent by id+digest
  poll(cursor: TransportCursor): Promise<{ events: Event[]; cursor: TransportCursor }>;
  ack(consumer: PrincipalId, cursor: TransportCursor): Promise<void>;   // consumer cursor persistence
  health(): Promise<TransportHealth>;             // reachable, lag, last error, credential state
}
```

The Git carrier and an in-process reference relay both implement it; the fault suite (C10, C17, C18, C23, C24) runs against both. The relay is a *test oracle for the state machine*, not a deployed service (plan §3.3).

---

## 9. Alternatives (required by `01-foundation.md`)

Same scenario set for all three: disconnected writers, late revocation, retry after lost ack, competing corrections, dirty source worktrees, incompatible clients, deletion, rollback.

### 9.1 A — Evolve per-record export + file-wins ingest (the smallest change)

**Steelman result (Stage 0, workflow `wf_f80a3b3b-ac2`, full text in `2026-09-foundation-contracts.appendix-a-steelman.md`).** The strongest one-release evolution — per-record revision chains (real ancestry instead of `LIFECYCLE_RANK` guessing), conflict sidecar files, idempotency keys, tombstone records, prerequisite deferral, receipts as posts — was designed and scored case by case:

| Case | Verdict |
|---|---|
| C10 duplicate / reorder / lost ack | fails |
| C11 disconnected incompatible successors | fails |
| C14 rewind / force-push / cherry-pick | fails |
| C16 partial supersession, revoke, archive, restore | fails |
| C20 delete / retract / reconnect old replica | **satisfies** (tombstone records propagate and survive reconnect) |
| C21 migrate / interrupt / roll back | satisfies |
| C22 cycles, dangling, cross-scope, competing corrections | fails |
| R05 lossless lifecycle | fails |
| R07 durable writes / retries | unclear |
| R08 distributed exchange state | fails |

The steelman's own strongest objection is the decisive one: *the record file is at once the current state, its own history and the merge unit, so `git merge` — a text-level rule resolved by a human under time pressure — is the authority, and it executes before any Twining code sees the bytes.* Everything the evolution adds can only detect the collapse afterwards, and only on a host that independently retained the losing side in the derived, gitignored database — so the proof of a loss is neither durable nor replicable (`rm twining.db` and restart erases it).

Correction to the plan of record: the lead predicted C20 would fail under the smallest evolution; the steelman shows tombstone records satisfy it. Recorded as a plan correction, not silently absorbed. The justification for the foundational change therefore rests on C10/C11/C14/C16/C22 and R05/R08 — not on deletion.

### 9.2 B — Immutable events over Git (proposed)

Set-union merges; explicit admission; journal-retained admitted set; cursors as single-writer files. Costs: file count growth (mitigated by month sharding and checkpoint snapshots for cold clones), freshness bounded by sync cadence, coarse repo-level access.

### 9.3 C — Authenticated relay (append-only log service)

Best freshness, receipts and revocation; per-record access control possible. Costs: a service to run, credentials to bootstrap/rotate, a new outbound destination, and a reconciliation story for its own acks. Kept as the reference implementation of `Transport`; would be recommended for live exchange if the flip conditions in the plan (§3.3) are met.

### 9.4 Strongest remaining objection to B

"You have rebuilt a distributed database on top of Git, and Git will never give you timely receipts or per-record confidentiality." True on both counts. The answer is scoped: this programme's cases require *correctness under interruption, reorder, duplication, rewind and offline authoring* — which B gives by construction — and *visible* delivery state, which cursors give; they do not require sub-minute propagation or per-record secrecy. If either becomes required, C replaces the carrier without changing the record or lifecycle contracts, which is why `Transport` is an interface from day one.

---

## 10. Migration, rollback, compatibility (R19, C21)

1. **Manifest.** `twining migrate --to 3 --dry-run` writes `legacy/manifest.json`: sha256 and byte length of every legacy file (`records/**`, `blackboard.jsonl`, `decisions/**`, `graph/**`, `handoffs/**`), every id, and every relationship field (`supersedes`, `superseded_by`, `overridden_by`, `depends_on`, `relates_to`).
2. **Events.** Every legacy record → one `created` event (`payload` = the record minus lifecycle fields; attachment = the legacy file's exact bytes; `evidence_class: legacy_unverified`; `producer.asserted_actor` = legacy `agent_id`; `source` from legacy `provenance`) plus derived lifecycle events reconstructed from status fields (`superseded_by` → `superseded`, `overridden_by` → `overridden`, `promoted_by/at` → `promoted`, `archived_from` → `archived`, `amendments[]` → `amended`, post `status: resolved` → `resolved`, handoff `acknowledged_by` → `acknowledged`), each flagged `derived_from_legacy_snapshot: true`. Legacy `active` never becomes `human_ruling`. Legacy ambiguity (e.g. `overridden` with no `overridden_by`) is preserved as `legacy_ambiguity: [...]` on the event.
3. **ID mapping.** Record ids are preserved (the legacy ULID becomes the `created` event id); `legacy/id-map.json` records every legacy id → event id (identity) plus derived event ids.
4. **Verify.** Rebuild the projection and check: every legacy record present with equal status and relationships (subset containment, as today's verifier), every attachment hash matches the manifest.
5. **Finalize.** `store.json` written, `config.version: 3`, `records/RECORDS-FROZEN.md` written; legacy files untouched.
6. **Interrupt / rerun.** Every step is idempotent (events are keyed by id+digest); an interrupted run leaves `config.version` unchanged and resumes.
7. **Rollback.** `twining rollback --to 2`: regenerate a **restricted legacy view** into `records/` from the projection (2.x-shaped files; each carries `legacy_view_of: <event id>` and, where v3 semantics cannot be represented, `v3_semantics_lost: [...]`), set `config.version: 2`. `events/`, `attachments/`, `cursors/` stay intact and inspectable (`twining events ls`, `twining events show <id>`). Functionality unavailable while rolled back is listed separately from data preservation.
8. **Forward recovery.** `twining migrate --to 3` again: existing events are no-ops; any `records/` file changed after rollback becomes a new legacy event (post-rollback writes are preserved).
9. **Old clients.** 2.x reads `config.version: 3` → read-only (existing gate). Schema negotiation for v3 clients: `store.json.format` + per-event `v`; a client refuses to *write* to a store with a higher `format` and admits events with a lower `v` through a versioned upgrader; unknown `kind`s are `quarantined:unknown_kind`, never dropped.
10. **Deletion semantics.** `tombstoned` (semantic delete, content redacted in projections) vs `purge: true` (local attachment bytes removed, event kept as a stub with its digest) vs local removal (`twining forget <id>`: removes projection rows only). Git history and remote clones are **not** erased by any of these; the operator documentation says so (C20).

---

## 11. Interfaces the lanes implement against

| Lane | Implements | Consumes |
|---|---|---|
| 02 records & exchange | journal, event files, attachments, admission, reducer/projections, outbox/inbox, cursors, Git carrier, reference relay, migrate/rollback | `src/contracts/*` (schemas, canonical digest, validators) |
| 03 runtime & CLI | CLI command core (already in flight on 2.x), host adapters that produce `human_statement`/`verified_observation`/`reported_result`/`receipt` events, injection with receipts | `src/contracts/*`, lane 02's `EventStore` API (`append`, `admit`, `project`, `cursor`) |
| 04 retrieval & trust | scope-first candidate selection, lifecycle resolver over projections, budget/explain/receipt | `src/contracts/scope.ts` matcher, lane 02 projections |
| 05 verification | fixtures, oracles, fault suite, migration qualification, trial | everything, read-only |

Shared-schema changes go through the lead; lanes propose them as PR-style diffs to `src/contracts/` with a fixture.

---

## 12. Vertical slice (Stage 0 proof) — definition

Two host principals `h_A`, `h_B` with keys; one human principal `p_H` with a ruling capability in scope `r_1/src/auth/`; two stores (temp dirs) sharing one `store_id`; carrier = `fs:` transport (a shared directory standing in for a remote) and the reference relay.

1. `p_H` records a ruling R in scope `src/auth/` ("password reset tokens expire in 15 minutes"); both replicas admit it.
2. Offline, `h_A` records a **correction** C (class `verified_observation`, cites R, `applies_to: src/auth/reset/`); `h_B` records a **conflicting interpretation** I (class `model_inference`, `supersedes: R`).
3. Deliver A→B then B→A, and B→A then A→B (fresh replicas each time); deliver each event twice; drop the first ack of C and retry.
4. Expected (from the independent oracle, not from this ADR): both replicas hold R, C, I; R governs `src/auth/`; C governs `src/auth/reset/` within its scope; I is `contested` (lower class cannot supersede a ruling) and visible; no duplicate effects; the retried C has one admission row; the receipts identify which events each replica admitted; a `receipt` never becomes a task acknowledgement.
5. Change the source revision (new `head`) for R's cited range → R's `applies_to.revision` no longer covers `head`: current-use claims are refused with `stale_revision`; R remains in history.
6. Delete `store/twining.db` on both replicas → rebuild from `events/` → projections byte-identical to before.

---

## 13. Unresolved product facts and what would change this ADR

- Whether the field needs sub-minute cross-user propagation (flips the carrier to C).
- Whether any team requires per-record confidentiality inside one store (flips to C or to store partitioning).
- Attachment size policy for committed source bytes (default proposal: 256 KiB per attachment, larger by reference with hash only).
- Whether the ruling ceremony's TTY-only rule is workable for the field's coordinator flow (RB6 accepted it; the trial will show the cost).
- The steelman result for §9.1: if the smallest evolution satisfies C14/C16/C20, this ADR is withdrawn and the plan is superseded.
