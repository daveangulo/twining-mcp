# Appendix B — Oracle rulings (C09, C10, C11, C14, C16)

**Status:** rulings draft 1, 2026-09-15. Companion to `2026-09-foundation-contracts.md` (the ADR) and `2026-09-foundation-contracts.appendix-a-steelman.md`.
**Purpose:** give every ambiguity the five implementation-blind oracles flagged a single documented answer, sourced to an ADR section, so lane 02/04 can build the slice and lane 05 can score it without either side quietly reinterpreting the other.
**Authority:** this appendix rules on *how the ADR answers* an oracle's open point. It never edits an oracle. Where a ruling requires the oracle's stated default to change, the row gives the exact ADR/requirement reason, per the oracles' own change-control clauses (`C16 §8`, `C10 §"Change control"`, `C09 §"Authority for this oracle"`).

---

## 0. Provenance and one blocking discovery — read first

**The enumerated OPEN QUESTIONS sections are not in the repository.** The five oracles cross-reference them (`C09 §4.1` "see Open Question 5", `C09 §4.3` "see Open Question 1", `C09 §1`/§7 "see Open Question 8", `C10 §7` "both are flagged in open questions as overlapping other cases", `C11.fixtures.json` "(See open question OQ-2.)", `C16 §2` "See open question Q5", "See Q6", `C16 §8` "declaring the SUT's answer to the open questions **before** the run") — but no oracle file, and no fixture file, contains the sections themselves.

Verified, not assumed:

- `grep -i "open question"` over `test/acceptance/oracles/*.{md,json}` returns only the six cross-references above.
- The five working-tree oracle files are **byte-identical to their staged git blobs** (SHA-1 of `blob <len>\0<content>` equals the index entry for each of `C09/C10/C11/C14/C16.oracle.md`), so this is not an uncommitted truncation — what is committed is what is here.
- No other copy exists under `~/.claude/projects`, `~/.claude/tasks|teams|sessions|file-history`, or the session scratchpad.

The programme log records the population the lead counted from the authoring agents' reports: **56 open questions — C09 (12), C10 (12), C11 (10), C14 (10), C16 (12)** (`docs/plans/2026-09-15-foundation-programme-log.md` D14; blackboard finding `01M2KCPE6CP7E1QDT2DV36WZ0M`). Those 56 texts are not recoverable from the artifacts.

**What this appendix therefore contains.** Rulings on **73 ruling-shaped items**: the 6 open questions whose ids survive as cross-references (ruled under their original ids — `OQ-1`, `OQ-5`, `OQ-8`, `OQ-2`, `Q5`, `Q6`), plus every other point at which an oracle *declares a default, an assumption, a variance, a vocabulary, or a "declared before the run" choice* — which is exactly the material an OPEN QUESTIONS section asks about. Derived items carry explicitly derived ids (`C09-D1`, `C14-ASM-1`, …) and are **not** claimed to be a 1:1 reconstruction of the missing 56.

**Action for the lead (one line):** paste the 56 original OQ texts (they are in the five oracle-authoring subagents' final reports in your Stage 0 session) into §9's template, or append them to the oracle files under the same ids; every ruling below is keyed so an original id can be mapped onto it without re-deciding anything. Until then, treat §3–§7 as complete on substance and provisional on *numbering*.

### Disposition counts

| Disposition | Count |
|---|---|
| **Oracle default stands** (ADR agrees; some rows add a name mapping only) | **54** |
| **Adjusted** (ADR compels a change; reason given in the row) | **12** |
| **LEAD DECISION NEEDED** (ADR does not answer) | **7** |
| Total ruling rows | 73 |
| Oracle invariants that **conflict** with the ADR (§8) | 6 (+1 ADR-internal ambiguity) |

Legend used in every table: **S** = oracle default stands · **A** = adjusted · **L** = lead decision needed.

---

## 1. How to read a ruling

Each row is: **id** → the question as the oracle poses it (with the oracle location, since the OQ text is missing) → the ruling in one or two sentences → the ADR section it comes from → disposition. Where the disposition is **A**, the row states the requirement/ADR reason that compels the change, which is what the oracles' change-control clauses demand. Where it is **L**, the row states the conservative default proposed and why it is the lower-risk choice.

---

## 2. Cross-cutting rulings (bind all five oracles)

These resolve whole classes of per-oracle questions at once. Apply them before reading §3–§7.

### X-1 — Evidence-class vocabulary · **S** (name mapping)

The five oracles use four different class vocabularies. The ADR's §2.2 table is normative; the mapping below is declared once and used everywhere. No oracle's *substance* changes.

| Oracle term (which oracle) | ADR §2.2 class | Rank |
|---|---|---|
| `authenticated_human_ruling` (C09, C11), `human_authorization` (C14), `human_ruling` (C16) | `human_ruling` | 5 |
| `independently_verified_observation` (C09), `verified_observation` (C10, C11, C14, C16) | `verified_observation` | 4 |
| `reported_worker_result` (C09, C11), `worker_report` (C14) | `reported_result` | 3 |
| (not used by any oracle) | `human_statement` | 3 |
| `model_inference`, `proposal` (all five) | `model_inference` / `proposal` | 2 |
| `open_question` (C09, C11, C14) | `question` | 1 |
| (migration only) | `legacy_unverified` | 2 |

**ADR source:** §2.2. **Note:** `human_statement` (rank 3) has no oracle counterpart; it must not be silently substituted for a ruling — §2.2: "proves a human typed it, not that they hold authority".

### X-2 — Delivery-state vocabulary · **S** (name mapping)

| Oracle state | ADR §5 state | Note |
|---|---|---|
| `authored_local` / `local_durable` (C09, C10, C11, C16) | `local_persisted` | ack boundary = journal row + event file fsynced (§4.2 "Durable at ack") |
| `queued` | (outbox row) | §5 "Producer outbox cursor per transport" |
| `sent_unacked` (C10), "uncertain window" | `exported` → not yet `transferred` | §5: `transferred` requires carrier confirmation, so the unacked window is exactly this gap |
| `transferred` | `transferred` | carrier receipt (commit sha / relay op id) |
| `received` / `remote_received` | `received` | |
| `admitted` | `admitted` | schema, digest, signature/policy, scope, parents all validated |
| `effective` (C09), `materialized` | `projected` | C09 §1 keeps `admitted ≠ effective`; ADR keeps `admitted ≠ projected` — same distinction |
| `injected` / `context_included` | `injected` | `receipt` event with `payload_hash` |
| `task_acknowledged` / `task_ack` | `task_acked` | separate principal, separate event |
| `quarantined` (C10 "quarantine"), `rejected_conflict` (C09), `rejected_request` (C14) | `quarantined` **or** `rejected` | ADR §5 keeps these as *two* lanes: `quarantined` (kept, not applied, reason) and `rejected` (kept as evidence, reason). See X-4 for which applies. |

**ADR source:** §5.

### X-3 — How the harness produces `human_ruling` events at all · **S**

Every oracle needs authenticated human rulings inside an automated run, while §2.3 makes the ceremony TTY-only and says "MCP/CLI ingress can never mint `human_ruling`". Ruling: the harness pre-signs fixture rulings with a synthetic **human** key and admits them through the **import** path — the governing contracts decision states `human_ruling` is "producible only by the signing ceremony **or an import carrying a valid signature by a known HUMAN key**". The harness must never obtain a ruling by asserting a field.

**ADR source:** §2.2 + §2.3, and the recorded contracts decision on evidence-class-by-ingress. **See also** §8.7 — the ADR body should name the import path in §2.2, which today only names the ceremony.

### X-4 — Admission order decides which refusal name applies · **S**

Derived ordering, used by C09 A18, C10 A19, C11 A04, C14 A-EV9, C16 A1.5: **schema/kind → digest → signature & capability (membership) → scope → parents → class rule.**

- unknown kind → `quarantined:unknown_kind` (§10.9)
- same `id`, different digest → `rejected:conflicting_duplicate` (§1.2)
- signature valid but **capability** absent for an authority-changing kind → `rejected:unauthorized`, attempt logged (§7)
- relation whose author's scope does not cover both endpoints → `quarantined:unauthorized_cross_scope` (§3)
- parent not yet admitted → `pending_parents`, visible, never dropped (§1.2)
- capability present, **class insufficient** → the event is **admitted** and marked `contested`; the relation is not applied (§4.2)

This is why C09's `ev-INF2` (agent has `write`, class too low) is *admitted-and-refused* while C16's `EV06` (`agt_scribe` is declared unable to supersede) is *rejected:unauthorized* — the two oracles' different membership declarations, not two different rules.

**ADR source:** §1.2, §3, §4.2, §5, §7, §10.9.

### X-5 — Exact event-count invariants must name the event population · **A**

Every oracle asserts an exact count over "the events" (C09 A1 "count == 8", C10 A01 "`events_total == 5`", C11 A01 "the same 7 `(event_id, payload_digest)` pairs", C14 §9 "15 expected event ids at K6", C16 A3.5 "exactly once each"). Under the ADR, `principal`, `membership`, `observation`, `receipt` and `ruling` are themselves **record types**, i.e. events (§1.3), and injection produces a `receipt` event (§5). A conformant v3 store will therefore hold *more* events than the oracle counts.

**Adjustment (ADR reason §1.3 + §5):** each count is asserted over the declared **record-bearing subset** for the case (the ids the oracle names), with infrastructure events (`principal`, `membership`, `receipt`, and harness-issued `observation`s) enumerated separately in the run record. The invariant that carries the requirement — *no named event missing, no digest changed, no duplicate effect* — is unchanged. This is a scoping adjustment, not a relaxation: a missing named event still fails.

See §8.3 for the conflict entry.

### X-6 — Declared authority must be seeded as `membership` events · **S**

C09 §2, C11 §1, C14 §2 and C16 §4 all declare per-scope authority in prose. Under the ADR authority is a projection of `membership` records (§2.4), and "a store with no membership policy defaults to **deny** for authority-changing kinds" (§7). The harness must therefore seed membership events before T0 in every case, or every ruling in the fixture is refused and the oracles fail vacuously.

**ADR source:** §2.4, §4.2 (row: `membership` changes need `rule` capability), §7.

### X-7 — Two scope operations, never one · **S**

Retrieval matching (what a query returns) and authority governing (what a record may change) are distinct: retrieval matches on segment boundaries and shows narrower records for a broad query; authority is unidirectional — a narrow statement never widens (§3 "Inheritance", §4.3.4). Rulings that depend on this: C09 N6 (default-scope non-leakage), C09 P3 (authorized cross-scope recall is a *retrieval* mode, never an authority widening), C11 rule_E, C16 K1.

**ADR source:** §3, §4.3.4, and the recorded `scopeMatches` / `scopeGoverns` contracts decision.

### X-8 — Attachment size policy for retained source bytes · **L**

C09 A14/A16 and C16 A6 require original bytes, anchors and hashes to survive on every replica, including a store built from a durable export only (`sto-S1R`). The ADR leaves the policy open: §13 "Attachment size policy for committed source bytes (default proposal: 256 KiB per attachment, larger by reference with hash only)".

**LEAD DECISION NEEDED.** Proposed conservative default: adopt the 256 KiB default now and require every oracle fixture's attachments to sit below it, so the slice never exercises the by-reference path. Reason: by-reference attachments make "original bytes retrievable on `sto-S1R`" depend on reachability of a foreign source, which is precisely what C09 A14/A16 are testing against; keeping fixtures under the cap removes the confound without pre-committing the product decision.

---

## 3. C09 — correction scoped to one story (12 rows)

Recoverable ids: `OQ-1`, `OQ-5`, `OQ-8`. Others derived.

| id | Question (oracle location) | Ruling | ADR | Disp |
|---|---|---|---|---|
| **OQ-1** | Does a correction scoped to `src/checkout/` attach a "corrected" status to the inference **in other scopes** too? Oracle default (A10, A15): per-scope annotation — `corrected` in `src/checkout/`, `uncorrected_inference` in `src/billing/`. | Per-scope is correct. A `corrected` event carries `applies_to`, and "target keeps applying outside `applies_to`"; precedence rule 4 confines it. Historical view therefore annotates per scope. | §4.1 (`corrected` row), §4.3.4 | **S** |
| **OQ-5** | May a design **quarantine `ev-INF2` at ingress** instead of admitting it with its relations refused? Oracle default (A3): admitted, relations refused, event durably retained either way. | Admitted-and-refused is the ADR outcome here: the author holds `write` and both relation endpoints are inside its scope, so the failure is the **class rule**, and §4.2 says such an event "is admitted as `contested`, not applied". Ingress quarantine is reserved for unauthorized cross-scope relations and unknown kinds. Retention holds in all branches (§5). | §4.2, §3, §5, §10.9 | **S** |
| **OQ-8** | Are the foundation-bullet assertions (A7/A16/N7 staleness, A17/N4 retry, A21 index loss) scored **separately** from C09's own coverage row? | ADR does not answer — §12 defines the vertical slice, the programme plan defines scoring. **LEAD DECISION NEEDED.** Proposed default: score separately, as the oracle proposes, and report both denominators. Reason: the ADR treats the slice (§12) and the case rows as distinct evidence; merging them would let a C09 pass paper over a slice failure, which is the more expensive error. | (§12, non-dispositive) | **L** |
| **C09-D1** | What is `ev-INF2`'s state name, and does its presence make Story B *conflicted*? Oracle: `refused_insufficient_authority` + `conflict_state == "none"` (A11, A12, N8). | Substance stands: Story B's record-level conflict state is **none** — §4.3.3 reserves `conflicted` for equal-class concurrents. **Adjust the name:** the ADR's state for the refused successor is `contested` (§4.2/§4.3.1), with `refused_insufficient_authority` as its reason code. The SUT must expose both: event-level `contested`, record-level `conflict_state: none`. | §4.1, §4.2, §4.3.1, §4.3.3 | **A** |
| **C09-D2** | Disposition of the mutated resend (`tx-INF2-mutated`, same id, new digest). Oracle A19: `rejected_conflict` / `event_id_reuse_digest_mismatch`, stored digest unchanged. | Stands exactly. ADR name is `conflicting_duplicate`: "The same `id` with a different `digest` is an explicit `conflicting_duplicate` and is rejected with the conflict recorded (never applied, never overwritten)"; rejected events are kept as evidence with their reason. | §1.2, §5 | **S** |
| **C09-D3** | Naming and force of the stale-satisfaction state (A7 `stale_requires_requalification`, N7 `unknown_until_requalified`). | Stands. ADR refuses rather than assumes: consequential use of a volatile fact "requires a `verified_observation` newer than `max_age` … otherwise **refused**, not assumed"; §12.5 names the refusal `stale_revision`. Historical satisfaction keeps its original rev/hash/time (§6 row 1). | §6, §12.5 | **S** |
| **C09-D4** | Evidence-class names (`authenticated_human_ruling`, `independently_verified_observation`). | Map per X-1; no substantive change. | §2.2 | **S** |
| **C09-D5** | Does the TR-13 retry create a second admission or a second correction entry? Oracle A17/N4: attempts 2, admissions 1, duplicate semantic effects 0. | Stands. "A retry with the same `id` and the same `digest` is a no-op"; the attempt counter lives in the transport receipt, not in the admitted set. | §1.2, §5 | **S** |
| **C09-D6** | Is `recall(mode=cross_scope_lessons, authorized_by=…)` (P3) a legitimate surface, and does it widen authority? | Stands. Cross-scope retrieval is "an explicitly authorized cross-scope read, never a silent widening"; the recalled inference stays `authorizes_action: false` because class is preserved in rendering. The parameter shape is lane 04's design choice (§11), not an ADR commitment. | §3, §2.2, §11 | **S** |
| **C09-D7** | Cross-store / cross-arm view-hash equality (A22). | Stands. "Two replicas with the same admitted set produce byte-identical projections (deterministic reducer)"; the per-record form is `version_digest` (§1.1). Arrival order and the +47 m skew are excluded by construction. | §1.1, §5, §4.3 | **S** |
| **C09-D8** | May the +47 m skew or ULID order influence precedence? | Stands — forbidden twice over: "Its lexical order is used for *deterministic replay* only — never for precedence"; "`occurred_at` is informational; nothing orders by it"; §4.3 "wall-clock never enters". | §1.2, §4.3, §5 | **S** |
| **C09-D9** | Must `sto-S1R`, built from `sto-S1`'s durable export alone, reproduce historical bytes (A14/A16) and receipts (A21)? | Stands. Rebuild from `events/` is a first-class operation (§12.6), and events, attachments and cursors are the exported set (§8.1). Attachments must therefore travel with the export — see **X-8** for the open size policy. | §8.1, §12.6 | **S** |

---

## 4. C10 — retry, reorder, lost ack (12 rows)

All ids derived (C10's OQ ids are unrecoverable; §7 tells us at least two concerned cross-case overlap).

| id | Question (oracle location) | Ruling | ADR | Disp |
|---|---|---|---|---|
| **C10-D1** | Must the six projections of §1 be *separately* observable, and what are their v3 equivalents? | Stands. ADR keeps the same separations: `events` = event files + journal; `admitted` = admission log; `current_view` = projection; `receipts` = outbox/cursors + transport receipts; `history_view` = event lineage; `quarantine` = the `quarantined`/`rejected` lanes. Collapsing any two is a failure under both documents. | §5, §8.1 | **S** |
| **C10-D2** | Delivery-state vocabulary, incl. `sent_unacked` and `context_included`. | Stands, mapped per X-2. `sent_unacked` is exactly `exported`-not-yet-`transferred`, because §5 makes `transferred` carrier-confirmed. | §5 | **S** |
| **C10-D3** | Is re-minting an ack-uncertain operation under a new id (`E1-REMINT`) prohibited outright? Oracle N1: central prohibition. | Stands, verbatim support: "Lost acks: the producer retries the *same* `id`; the transport reconciles by `id`/`digest`, never submitting a second operation (C10)." | §5, §1.2 | **S** |
| **C10-D4** | Must a conflicting duplicate be counted separately from a suppressed duplicate (A19)? | Stands. They are different outcomes in the ADR: a same-digest retry is a no-op; a different-digest reuse is `conflicting_duplicate`, rejected with the conflict recorded. Counting them together would erase the distinction the requirement rests on. | §1.2, §5 | **S** |
| **C10-D5** | Field names for causal prerequisites (`requires[]`, `pending_on`). | Stands, mapped: ADR uses `parents`; the waiting state is `pending_parents`, "visible, never dropped". | §1.2 | **S** |
| **C10-D6** | Must the admission log record *why* an event admitted (A10 `admission_trigger == prerequisite_satisfied`)? | ADR requires an admission log row (§5) but does not specify its fields. **LEAD DECISION NEEDED.** Proposed default: record the trigger. Reason: near-zero cost in lane 02, and without it A10 is unevaluable — the oracle's §7 asks unevaluable assertions to be reported as such, which would weaken the evidence for R08. | §5 (silent) | **L** |
| **C10-D7** | Must a **closed** uncertainty window be retained after reconciliation (A09 `uncertain_windows`)? | ADR requires the states and their evidence but is silent on retaining closed intervals. **LEAD DECISION NEEDED.** Proposed default: retain. Reason: R08 asks for *visible* delivery state; retaining the interval is append-only and cheap, while discarding it makes "reconciliation records the uncertainty, it does not erase it" untestable after the fact. | §5 (silent) | **L** |
| **C10-D8** | Can any receipt/dedup/reconciliation move an acceptance axis (A22, N5)? | Stands. "Memory synchronization (`admitted`) and task completion (`task_acked`) are different events by different principals; a storage ack, a Git merge, a worker return or a passing review never substitutes for another state." | §5 | **S** |
| **C10-D9** | Permutation invariance across 12 order×skew runs (A23), with receipts allowed to differ only in timestamps/order. | Stands. Convergence is by identical admitted set + deterministic reducer; ordering inputs are excluded (§4.3, §1.2). | §5, §4.3 | **S** |
| **C10-D10** | After index loss (T12): identical projections, rebuilt rows labeled derived, zero new evidence records (A18). | Stands. §12.6 makes the rebuild a required property; §1.1 makes projections "derived only, never exchanged", which is the label the assertion wants. | §1.1, §12.6 | **S** |
| **C10-D11** | Must the injected `E1-CONFLICT` frame avoid being attributed to `store-south` (A07)? | Stands, and the ADR strengthens it: an unsigned event makes the producer claim "*asserted*, not authenticated", so no projection may credit `store-south` with bytes it did not sign. Recommendation for the slice: sign fixture events, so the forged frame is detectable rather than merely uncounted. | §1.2, §2.4 | **S** |
| **C10-D12** | Do T9 (conflicting bytes → C24) and T12 (index loss → C18) count toward those neighbouring cases? | ADR makes both first-class foundation behaviours (§1.2, §12.6) but sets no scoring convention. **LEAD DECISION NEEDED.** Proposed default: report under C10 with a cross-reference and count once, never toward C24/C18 coverage. Reason: matches C11's own scope-limit discipline ("passing C11 does **not** constitute the multi-computer qualification required by C28") and avoids inflating coverage. | §1.2, §12.6 (scoring silent) | **L** |

---

## 5. C11 — disconnected incompatible successors (13 rows)

Recoverable id: `OQ-2`. The five declared authority rules are ruled here and tabulated against ADR §4.3 in §7.

| id | Question (oracle location) | Ruling | ADR | Disp |
|---|---|---|---|---|
| **OQ-2** | Is there seniority between two authenticated peers (U_ALPHA, U_BETA)? Fixture declares `NONE`. | Stands, and the ADR explains *why* it is a declaration rather than a discovery: a store `membership` **may** declare a deterministic rule for equal-class concurrents; "Absent a rule, **both remain applicable and visible as `conflicted`**". The C11 run must therefore declare **no** such policy rule, or the expected `conflicted` outcome changes legitimately. | §4.3.3 | **S** |
| **rule_A** | Authorized `human_ruling` may supersede in its scope. | Stands. §4.2 authorizes `superseded`/`overridden`/`corrected` for a principal with `write` subject to the class rule; §2.2 ranks `human_ruling` 5; §2.4/§7 bind capability to membership. | §4.2, §2.2, §2.4 | **S** |
| **rule_B** | Lower classes may **never** supersede a `human_ruling`, regardless of recency, prose, or caller-supplied `active`/`actor`/`promoted_by`/`authority`. | Stands, twice over: the class rule (§4.2) and "Rendering preserves the class. `MUST`, `active`, or a heading confers nothing (R17)"; `asserted_actor` is "recorded, displayed, never authoritative". | §4.2, §4.3.1, §2.1, §2.2 | **S** |
| **rule_C** | Two authorized equal-class concurrent successors → explicit conflict, **no automatic winner**. | **Adjust:** the ADR inserts one step the rule omits — §4.3.3 lets a store `membership` declare a deterministic tiebreak for equal-class concurrents, and only *absent* such a rule do both remain applicable and `conflicted`. Requirement reason: §4.3 precedence order (class → explicit resolution → policy rule → scope). Practical effect on C11: **none**, because the fixture declares peers with no policy rule; the rule text must simply carry the "absent a declared policy rule" qualifier so a future store with a policy is not scored as a C11 failure. | §4.3.2, §4.3.3 | **A** |
| **rule_D** | Arrival order, wall-clock and prose similarity are never inputs; display order derives from content identity + causal order. | Stands. "Applied in this order; wall-clock never enters"; ULID "lexical order is used for *deterministic replay* only — never for precedence"; "`occurred_at` is informational; nothing orders by it". | §4.3, §1.2, §5 | **S** |
| **rule_E** | A supersession edge takes effect only inside the superseding record's authorized scope and never alters a neighbouring scope. | **Adjust one word:** "neighbouring" → "non-descendant". The ADR is explicit that a *broader* authorized statement does reach narrower scopes ("A broad statement applies to narrower scopes within its authorized envelope. A narrow statement never widens"), so an edge authored at `src/` legitimately affects `src/policy/`. Requirement reason: §3 Inheritance + §4.3.4. Practical effect on C11: **none** — `src/policy/` and `src/ingest/` are siblings, so A06 is unchanged. | §3, §4.3.4 | **A** |
| **C11-D1** | May the rejected lower-class claim (`REC-B01`) appear anywhere in a `current()` result? Oracle A05: never, in any scope. | **Adjust the rendering contract, not the authority outcome.** ADR §4.3.1 says a lower-class successor "becomes `contested` and **is shown beside the governing record**". Ruling: `current(scope)` returns the **governing set** only — `REC-B01` is not a member and never a winner (A05's substance holds) — while a `contested` annotation *attached to* the governing record may reference it. The SUT must expose membership and annotation separately, or A05 and §4.3.1 cannot both be satisfied. See conflict §8.1. | §4.3.1, §4.1 | **A** |
| **C11-D2** | Status name for the rejected claim: `claim_rejected`, edge "stored as a claim, never as an admitted edge". | Stands in substance (event admitted, edge not applied); ADR's state name is `contested` with the reason `lower_evidence_class_cannot_supersede_human_ruling` — map per X-4. | §4.2, §4.1 | **S** |
| **C11-D3** | What happens to the common ancestor `REC-000` when two authorized successors both supersede it? | Stands as the oracle implies: `REC-000` is superseded (back-links derived from the events, never guessed) while its two successors are the conflicted set; nothing resolves the pair. | §4.1 (`superseded` row), §4.3.3 | **S** |
| **C11-D4** | Post-`G1→G2` state of records anchored at the changed file (A15 `requalification_required`). | Stands; ADR name is `stale_revision` for the refused current-use claim, with the original anchor/hash/time retained. | §6, §12.5 | **S** |
| **C11-D5** | Two clone paths and two remote URLs → one repository entity (A17). | Stands, verbatim: "Remote URL, path and branch are **labels** carried in `source`, never identity (R01)"; store vs source are recorded separately and never inferred from one another. | §3 | **S** |
| **C11-D6** | O1/O2 equality on events, current views, history statuses and conflict membership (A08), and the S3 rebuild (A18). | Stands. Same admitted set ⇒ byte-identical projections; rebuild from `events/` is required to reproduce them. | §5, §12.6 | **S** |
| **C11-D7** | Does any delivery state reach scoped task acceptance (A13)? | Stands — `admitted` and `task_acked` are different events by different principals. | §5 | **S** |

---

## 6. C14 — ref rewind / snapshot rewind (15 rows)

Ids `ASM-1..4` are the oracle's own §11 "assumptions … (challengeable before the run)"; the rest are derived.

| id | Question (oracle location) | Ruling | ADR | Disp |
|---|---|---|---|---|
| **C14-ASM-1** | Store lives **inside** the rewound working tree (§11.1, §2 "`.exchange/`"), the "hardest reading of silent loss". | **Adjust to two arms.** Under the ADR default carrier, events live on a dedicated exchange ref in a gitignored worktree and the DB in gitignored `store/`, so `checkout`/`reset --hard` on the source branch cannot remove them, and "The user's source checkout is never reset, stashed, switched, rebased or auto-committed (R09 non-interference)". Requirement reason: §8.1/§8.2. **Arm A (default carrier):** rewind changes the *received* set only; expected report is `checkout_behind_journal`, admitted set intact. **Arm B (source-branch mode, §8.2's documented migration option):** the oracle's hard variant runs unchanged. Both must pass; Arm B is where the oracle's assumption is literally true. | §8.1, §8.2 | **A** |
| **C14-ASM-2** | "Restoring a human-authored record requires human authorization; an agent-issued restore would also be a refusal case." | **Adjust, split in two.** (a) *Unarchive*: §4.2 places `archived`/`restored` in the "any principal with `write`" row — an agent-issued unarchive is **not** a refusal case. (b) *Reinstating a superseded record* (C14's actual `ev-020`): see **C14-D11**; capability should be `rule`. Requirement reason: §4.2 authorization table. | §4.2, §4.4 | **A** |
| **C14-ASM-3** | Qualification is keyed to exact revision identity; byte-identical content at another revision does not requalify. | Stands, strongly. §12.5 refuses current-use claims when `applies_to.revision` no longer covers head; §1.2 separates file bytes, canonical bytes and source bytes and forbids a normalized-text hash from rebinding evidence (C07). N5 is therefore an ADR-backed prohibition, not a strict oracle preference. | §1.2, §6, §12.5 | **S** |
| **C14-ASM-4** | A restored record coexisting with its successor is a contradiction to surface, not to auto-resolve. | Stands (conditional on C14-D11 being granted): §4.1 `contested` "marks a live contradiction; both visible", and §4.3.3 forbids an automatic winner without an authorized resolution. | §4.1, §4.3.3 | **S** |
| **C14-D1** | `representations[]` on the event envelope (§1 "Key modelling decision"), retaining an unreachable old representation (A-EV4). | **Adjust the surface, keep the invariant.** The v3 envelope is strict (unknown keys rejected), and carrier identity belongs to the delivery layer: `transferred` evidence is a "transport receipt with carrier identity (commit sha / relay op id)" (§5), Git specifics in §8.2. Requirement reason: §1.2 + §5. The invariant "a rewrite adds a representation; it never mints an event" holds by construction because `id`/`digest` are content-derived — so A-EV4 is read off the receipt/admission projection, not the envelope. | §1.2, §5, §8.2 | **A** |
| **C14-D2** | Must the store emit `source.checkout` / `source.reset` / `source.history_rewrite` observation events (A-EV2, A-EV5, A-EV8)? | ADR provides the *type* (`observation`, class `verified_observation` when an adapter checked git itself) but mandates no watcher, and "the server never runs git". **LEAD DECISION NEEDED.** Proposed default: the harness/CLI adapter issues these observations explicitly and A-EV2/5/8 are evaluated against them; no implicit git-watching is built for the slice. Reason: an automatic watcher is new surface area with its own failure modes and would be the only ADR component that observes the user's source checkout unasked — the lower-risk path is explicit issuance. | §0, §1.3, §2.2 (watcher silent) | **L** |
| **C14-D3** | `rebuild_from_durable` must return `acknowledged_events_lost: 0`, `capture_gap: none` (A-EV3). | Stands. §12.6 requires a `store/twining.db` deletion to rebuild byte-identical projections; §8.2 makes the journal, not the checkout, the retained admitted set. | §8.2, §12.6 | **S** |
| **C14-D4** | Qualification after force-push: `unknown` + `source_revision_reachable: false` (A-CUR3), while `rec-050`'s `c1aa` survives. | Stands. §6 row 2: a time-bound observation keeps `observed_at` and "present state `unknown` unless re-observed"; consequential use is refused (`stale_revision`), historical facts keep their original times. | §6, §12.5 | **S** |
| **C14-D5** | Three delivery attempts, one admitted effect, one event-list instance (A-EV6, N6). | Stands — same-id/same-digest retries are no-ops; the cherry-pick re-carry is another carrier representation, not another event. | §1.2, §5 | **S** |
| **C14-D6** | After index loss or snapshot rewind, may an unrecoverable receipt state default to "completed"? (A-RCP3, N8.) | Stands, forbidden by the ADR: an offline replica "reports `revocation_unknown` … it never claims to know"; a post-ack failure is "a visible `outbox` backlog, never a rollback". `uncertain` is the required answer. | §5, §6 | **S** |
| **C14-D7** | No unsolicited source-repo write in response to a rewind (N10). | Stands, verbatim ADR support: `twining sync` is "an explicit CLI verb, never the server", staging only the exchange worktree; the source checkout is never touched (R09). | §8.2, §0 | **S** |
| **C14-D8** | Non-Git transport variant (§10): run the identical case on another transport if the SUT is not Git-based. | **Adjust from *alternative* to *both*.** The ADR ships a `Transport` interface with a Git carrier **and** a reference relay, and states "the fault suite (C10, C17, C18, C23, C24) runs against both". Requirement reason: §8.3. C14 must therefore run on the Git carrier **and** on `fs:`/relay; the oracle's §10 substitution becomes the second mandatory arm, and its "must not mark an unimplemented Git adapter as covered" caution still applies. | §8.3, §12 | **A** |
| **C14-D9** | Restore of the **revoked** `rec-300` (`ev-021`) must be refused (N2, A-HIS3). | Stands, explicit ADR text: "a revoked ruling cannot be restored to authority by `restored` (C16)"; and the refusal itself must be visible, kept as evidence with a reason. | §4.4, §5 | **S** |
| **C14-D10** | Agent attempt to supersede a human ruling (`ev-022`) recorded as `rejected_request` with a `reason_class` (A-EV9, N7). | **Adjust the name.** Under X-4 the outcome depends on capability: if `agt-scribe-b` holds `write` (C14 §2 says Bo "may author proposals and observations only", so membership denies the supersede kind) the result is `rejected:unauthorized` with the attempt logged (§7); if it held `write`, it would be admitted-`contested` (§4.2). Either way the refusal is recorded and visible — the substance of A-EV9/N7 stands; only the label changes. Requirement reason: §4.2 + §7. | §4.2, §7 | **A** |
| **C14-D11** | **Which lifecycle kind is `record.restore` of a *superseded* record (`ev-020`)?** Oracle P1/A-CUR7/A-HIS1 require it to succeed and yield `restored_applicable`. | **ADR does not answer — and as written it says the opposite** (§4.4: "a restored superseded stays superseded"; §4.1 `restored` is only the inverse of `archived`). **LEAD DECISION NEEDED.** Proposed default: add a distinct kind `reinstated` (target, reason) requiring the `rule` capability in scope and a class ≥ the superseding event's class, projecting to `restored_applicable` and forcing the pair with the still-applicable successor into `contested` per §4.3.3. Reason: widening `restored` would break C16 A3.1/A3.2, which depend on §4.4 exactly as written; a separate authorized kind satisfies C14's positive control without touching archive semantics. See conflict §8.4. | §4.1, §4.4 (gap) | **L** |

---

## 7. C16 — partial supersession, revocation, archival, restoration (13 rows)

Recoverable ids: `Q5`, `Q6`. `C16-A1..A7` are the oracle's own §2 declared assumptions — **A4 is ruled as `Q5` and A5 as `Q6`** (the oracle itself points each at that question), so they are not repeated as separate rows; `D1..D6` derived.

| id | Question (oracle location) | Ruling | ADR | Disp |
|---|---|---|---|---|
| **Q5** | Is archival a replicated **lifecycle fact** about the record, or a per-store/per-viewer preference? Oracle A4 assumes replicated, with a per-store variance path. | Replicated. `archived`/`restored` are lifecycle **event kinds** (§4.1) and every durable state is an event that is exchanged and projected (§0, §5); a per-viewer preference could not satisfy "archived ↔ prior status … derived, never guessed". CP3 is asserted globally; the oracle's per-store variance branch is not needed for a v3 SUT. | §4.1, §5, §0 | **S** |
| **Q6** | Is revocation forward-effective and bitemporal — does an as-of query before the revocation still return the part as applicable-as-of-then? Oracle A5/A3.8 assume yes. | Yes. Scope carries "`revision {base, head}` and effective time" (§3); historical evidence "never changes" (§6); projections are deterministic replays of the admitted set (§1.1), so an as-of projection is a replay to a cut. Revocation withdraws authority going forward and is never silent (§4.1). | §1.1, §3, §4.1, §6 | **S** |
| **C16-A1** | Authority is scope-delegated and declared by the oracle, not discovered from the SUT. | Stands, with X-6's requirement: the declaration must be seeded as `membership` events, since absent policy the ADR **denies** authority-changing kinds. The `usr_juno == usr_hera` fallback stays a reported coverage gap. | §2.4, §7 | **S** |
| **C16-A2** | The SUT must distinguish *historical* from *current applicable*; failure is by construction. | Stands. §1.1 separates the immutable event log from the derived projection, and §6 makes "current" a qualified answer rather than a stored flag. | §1.1, §6 | **S** |
| **C16-A3** | "Multi-part decision" = one record with independently addressable parts; fallback maps parts 1:1 to records + a container relation. | **Adjust:** for the v3 slice the fallback is not applicable — the ADR mandates the parts model: "`parts` on a decision (optional): `[{ part_id, text }]` — the unit of **partial supersession** (C16, R06)", and `superseded` carries an optional `parts` list. Requirement reason: §1.3 + §4.1. A SUT mapping parts to separate records would not be testing partial supersession at all. | §1.3, §4.1 | **A** |
| **C16-A6** | Revocation is not redaction: bytes, anchors and class survive in history. | Stands, cleanly separated in the ADR: `revoked` withdraws authority; `tombstoned` (with optional `purge`) is the redaction kind, and it belongs to C20. | §4.1, §10.10 | **S** |
| **C16-A7** | One repository; two stores are replicas; identity independent of clone path. | Stands. `repo_id` is minted once, paths/remotes are labels (§3), and §12 builds the slice as "two stores (temp dirs) sharing one `store_id`". | §3, §12 | **S** |
| **C16-D1** | Disposition of the escalation attempt `EV06` (claims to supersede `D1#P1`, carries `claimed_actor: usr_hera`, `claimed_active: true`, MUST-prose): rejected ledger with an explicit unauthorized disposition (A1.4, A1.5). | Stands. `agt_scribe`'s membership denies the supersede kind, so by X-4 the outcome is `rejected:unauthorized` "with the attempt logged" — visible, never silently discarded; and the claimed fields confer nothing ("`MUST`, `active`, or a heading confers nothing"). | §7, §2.1, §2.2, §5 | **S** |
| **C16-D2** | How must `sto_S2`, rebuilt from the pre-revocation export, label its view before reconciliation (A3.4)? | Stands. §5 cursors bound what a replica knows; §6 requires an offline replica to report `revocation_unknown` rather than claim knowledge; §8.2's `checkout_behind_journal` is the same discipline for the Git carrier. A backup can never resurrect the revocation-free state as current-unlabeled. | §5, §6, §8.2 | **S** |
| **C16-D3** | May the producer report `admitted` on the peer after the lost ack (A4.1)? | Stands — no. `admitted` is evidenced by "admission log row" on the consumer; the producer only knows `transferred` (carrier receipt) or nothing. | §5 | **S** |
| **C16-D4** | Under plan B (reverse delivery), what happens to events whose prerequisites have not arrived (A4.4)? | Stands: `pending_parents` — "visible, never dropped" — and all three plans must converge because the admitted set is identical. | §1.2, §5 | **S** |
| **C16-D5** | May the authorized post-restore ruling `D4` supersede the provisional `D1#P3` (PC2)? | Stands. `human_ruling` (5) ≥ `model_inference` (2) satisfies the class rule, the author holds scope authority, and the retirement of a provisional part is therefore an explicit authorized act — never a side effect of restoration (§4.4 "restored provisional stays provisional"). | §4.2, §4.4 | **S** |
| **C16-D6** | What does `applicable_provisional` mean for a `model_inference` part (A2.2), and can `promoted` ever make it authorizing? | **Adjust the vocabulary to avoid a false pass.** C16's "provisional" means *non-authorizing because of its class*; the ADR's `provisional` is a **promotion status** on a decision (`created` → `promoted` → active). They are orthogonal: a `promoted` event moves status, never class — class is fixed at ingress and "rendering preserves the class". So `D1#P3` may become status-active and still have `authorizes_action: false`. Requirement reason: §2.2 + §4.1. Declare the two axes separately before the run, or a conformant store will look like it "promoted provisional data". See conflict §8.2. | §2.2, §4.1 | **A** |

---

## 8. Oracle invariants that conflict with the ADR

Six conflicts, each quoted from both sides, with a proposed resolution. These are for the lead to settle — not for lane 02 to interpret.

### 8.1 `contested` visibility vs "never appears in `current()`"

> **ADR §4.3.1:** "A higher-class event prevails over a lower-class one on the same record part; a lower-class successor becomes `contested` and **is shown beside the governing record**."
> **C11 A05:** "`REC-B01` **never appears in any `current()` result for any scope**, and its `active` / `actor` / `promoted_by` / `authority` fields never change its evidence class from `model_inference`."
> **C09 A12 / N8:** "`conflict_state(wrk-STORY-B)` == `"none"`. A lower-authority contradiction of a human ruling is a **refusal**, not an unresolved conflict." / "The system MUST NOT report Story B as `conflicted` merely because a lower-authority inference contradicts the ruling."

**Why it matters:** a store that renders the contested claim *inside* the current view passes the ADR and fails C11 A05 — an immediate-rejection assertion.
**Proposed resolution (lead):** amend §4.3.1 to "…becomes `contested`; it is **not** a member of the governing set and MUST NOT set the target's `conflict_state` (which §4.3.3 reserves for equal-class concurrents); it is surfaced as an annotation attached to the governing record." This keeps both documents true and makes the C09/C11 difference (refusal vs conflict) a rule, not a judgement call.

### 8.2 `promoted` vs "cannot promote provisional data"

> **ADR §4.1:** "`promoted` | target | provisional → active".
> **C16 §1 (case text) + immediate-rejection #2:** "restore … cannot resurrect revoked authority **or promote provisional data**" / "`D1#P3` presented as authorizing an action at any checkpoint."

**Why it matters:** the word "promoted" appears on both sides meaning different things (status vs authority). A conformant `promoted` event on `D1#P3` is legal under the ADR and reads as the forbidden act under C16.
**Proposed resolution (lead):** state in §4.1 that `promoted`/`reconsidered` move **status only** and never alter `evidence_class` or `authorizes_action` (which §2.2 fixes at ingress). One sentence; removes the collision.

### 8.3 Exact event counts vs the ADR's infrastructure events

> **ADR §1.3:** record types include "… `principal`, `membership` (store policy), `observation`, `receipt`, `ruling`." **ADR §5:** "`injected` | included in a specific host/session/turn packet; `receipt` event with `payload_hash`".
> **C09 A1:** "`admitted_event_ids` == exactly `{ev-RUL1, ev-INF1, ev-VER-A, ev-REQB, ev-OBS1, ev-COR-A, ev-INF2, ev-COR-B1}`; **count == 8**." (Same shape: C10 A01 `events_total == 5`; C11 A01 "the same 7 pairs"; C14 §9 "15 expected event ids at K6".)

**Why it matters:** a conformant v3 store holds membership, principal and receipt events too, so every exact count fails on a *correct* implementation — a false negative on assertions the pass/fail sections treat as immediate rejection.
**Proposed resolution (lead):** adopt X-5 — counts are asserted over the declared record-bearing subset, with infrastructure events enumerated separately. No named event may be missing; no digest may change.

### 8.4 Restoring a superseded record

> **ADR §4.4:** "A restored provisional stays provisional; **a restored superseded stays superseded**; a revoked ruling cannot be restored to authority by `restored` (C16)."
> **C14 P1:** "**intentional restoration works.** `ev-020` succeeds: `rec-050` → `restored_applicable`, supersession preserved in history, contradiction with `rec-100` surfaced."

**Why it matters:** this is a direct contradiction on the same verb, and C14 P1 is a *positive control* — without it, N1/N2 could be passed by a store that never restores anything. The ADR as written makes C14 unpassable.
**Proposed resolution (lead):** C14-D11 — add `reinstated` as a distinct, `rule`-capability lifecycle kind; leave §4.4's sentence untouched for archive-restores (C16 A3.1/A3.2 depend on it).

### 8.5 Store inside the rewound working tree vs non-interference

> **ADR §8.2:** "Events, attachments, cursors and policy live on a **dedicated exchange ref** … checked out in a dedicated worktree at `.twining/exchange/` (gitignored path inside the store) … **The user's source checkout is never reset, stashed, switched, rebased or auto-committed** (R09 non-interference)."
> **C14 §2 / §11.1:** "Both are placed **inside** the repository working tree at `.exchange/` — the hard variant, chosen so that a `reset --hard` physically removes the store's working copy." / "the beside-the-repo placement is a documented easier variant, not a substitute."

**Why it matters:** under the ADR default the oracle's trigger cannot fire (gitignored paths survive `checkout`/`reset --hard`), so the case would "pass" without testing anything.
**Proposed resolution (lead):** C14-ASM-1 — run both arms; Arm B uses §8.2's documented source-branch mode so the hard variant is genuinely exercised, and Arm A asserts the `checkout_behind_journal` report.

### 8.6 `representations[]` on the envelope vs the strict envelope

> **ADR §1.2 + contracts decision:** envelope fields are fixed and "Envelope and lifecycle payloads are STRICT (unknown keys rejected)"; carrier identity appears as "transport receipt with carrier identity (commit sha / relay op id)" (§5).
> **C14 §1:** "Key modelling decision: `representations[]` is the seam this case turns on. One semantic event has one `event_id` and one `payload_digest`, and zero-or-more transport representations (a git commit + path, an export bundle entry, a snapshot row)."

**Why it matters:** an implementer reading C14 literally would add a mutable array to an immutable, digest-covered envelope — which would either break digest stability or be rejected by the strict validator.
**Proposed resolution (lead):** C14-D1 — keep the invariant, move the surface: representations are a receipt/admission-log projection. The oracle's assertions (A-EV4, A-EV7) are evaluated there.

### 8.7 ADR-internal ambiguity surfaced by the oracles (not an oracle conflict)

> **ADR §2.2:** `human_ruling` — "a human principal via the signing ceremony (§2.3)". **§2.3:** "MCP/CLI ingress can never mint `human_ruling`; the schema validator rejects it from those paths outright."
> **Governing contracts decision:** "`human_ruling` is producible only by the signing ceremony **or an import carrying a valid signature by a known HUMAN key**."

As the ADR body reads today, no automated acceptance harness can produce the human rulings that four of the five oracles require. The decision record's import path resolves it (X-3); §2.2 should say so explicitly, or every oracle run is blocked on a TTY.

---

## 9. The rule table C11 asks for — `rule_A..rule_E` mapped onto ADR §4.3

C11 §2 requires the authority rules to be "published by the implementer **before** measurement". This is that publication: the oracle's declared rules, the ADR clause that implements each, and the precedence step it occupies. **Precedence order is applied top-down and wall-clock never enters** (§4.3).

| Precedence step (§4.3) | ADR clause (quoted) | C11 rule | Disposition |
|---|---|---|---|
| **1. Class rank** | "A higher-class event prevails over a lower-class one on the same record part; a lower-class successor becomes `contested` and is shown beside the governing record." | **rule_B** — `model_inference` / `proposal` / `reported_worker_result` / `open_question` may never supersede a `human_ruling`, regardless of recency, prose form, or caller-supplied `active`/`actor`/`promoted_by`/`authority` | **S** — reinforced by §4.2's class rule, §2.1 (`asserted_actor` never authoritative) and §2.2 ("`MUST`, `active`, or a heading confers nothing") |
| **(gate before 1) Capability** | §4.2: "`superseded`/`overridden`/`corrected` | principal with `write` …" ; §7: "a valid signature without capability → `rejected:unauthorized` with the attempt logged" | **rule_A** — an authorized `human_ruling` may supersede a record in its scope | **S** — authority comes from the `membership` projection (§2.4), never from possession of a clone or a signature |
| **2. Explicit resolution** | "A `conflict_resolved` by an authorized principal settles equal-class contradictions." (`conflict_resolved` requires the `rule` capability, §4.2) | — (C11 declares no resolution event; the conflict must persist) | **S** — the only legitimate way out of A02's `conflicted` state |
| **3. Policy rule** | "A store `membership` may declare a deterministic rule for equal-class concurrent successors (e.g. `author_wins_for_own_records`). Absent a rule, **both remain applicable and visible as `conflicted`** (R05, C11) — retrieval says so; action qualification refuses." | **rule_C** — two authorized, causally-unrelated, equal-class successors are equally authoritative → explicit conflict, no automatic winner · **seniority: NONE** (OQ-2) | **A** — add "absent a declared membership policy rule". C11 declares none, so the expected `conflicted` outcome is unchanged; the qualifier prevents a future store with a declared tiebreak from being scored as a C11 failure |
| **4. Scope** | "A correction applies only within its `applies_to`; a broader ruling replaces narrower statements only inside its authorized envelope (R06)." + §3: "A broad statement applies to narrower scopes within its authorized envelope. A narrow statement never widens." | **rule_E** — a supersession edge takes effect only inside the superseding record's authorized scope and never alters a neighbouring scope | **A** — read "neighbouring" as "non-descendant": a broader authorized edge *does* reach narrower scopes. C11's `src/policy/` vs `src/ingest/` are siblings, so A06 is unchanged |
| **Ordering inputs (excluded at every step)** | §4.3: "Applied in this order; wall-clock never enters." · §1.2: ULID "lexical order is used for *deterministic replay* only — never for precedence (R05)". · §5: "Clock skew: `occurred_at` is informational; nothing orders by it." · Causal order comes from `parents`. | **rule_D** — arrival order, wall-clock and prose similarity are never inputs; deterministic display order derives from content identity + causal order only | **S** — this is the clause that defeats C11's skew trap (B01 latest clock, A01 mid, B02 earliest) |

**Two conditions this table places on the C11 run** (both are declarations, not relaxations): (i) the fixture must seed `membership` events granting U_ALPHA and U_BETA `rule` capability over `src/policy/`, `src/export/`, `src/ingest/` — absent policy the ADR denies authority-changing kinds (§7) and every ruling in the fixture would be refused; (ii) the fixture must declare **no** equal-class tiebreak policy, or §4.3.3 legitimately resolves what A02/A03 require to stay conflicted.

---

## 10. Template for slotting the original 56 questions in

When the original OQ texts are recovered, append rows here rather than editing §3–§7 — the chain stays visible:

```
| <original id> | <original question text, verbatim> | <ruling row above it maps onto, or NEW> | <ADR §> | S/A/L |
```

If an original question has no counterpart above, rule it fresh using the same five-column shape. If an original question's stated default conflicts with a ruling above, record the supersession explicitly (both rulings, with the reason the later one wins) — the oracles' change-control clauses require the original to be preserved beside the correction, and this appendix is held to the same standard.

---

## 11. Summary for the lead

- **73 ruling rows: 54 stand, 12 adjusted, 7 need a lead decision.** Only 6 of the original 56 open-question ids were recoverable from the artifacts (§0) — the rest of the rows are derived from the oracles' declared defaults and assumptions and are keyed for mapping, not claimed as a reconstruction.
- **7 lead decisions:** X-8 attachment size policy (§13 is explicitly unresolved and C09 A14/A16 depend on it) · C09 OQ-8 scoring split · C10-D6 admission-trigger field · C10-D7 uncertainty-window retention · C10-D12 cross-case scoring overlap · C14-D2 source-observer scope · **C14-D11 reinstatement kind — the only one that blocks a case outright.**
- **6 oracle/ADR conflicts (§8)**, of which §8.4 (restore of a superseded record) and §8.3 (exact event counts) would fail a *correct* implementation as written, and §8.1 (`contested` visibility) would let an incorrect one pass C09 while failing C11.
- **1 ADR-internal ambiguity (§8.7):** §2.2/§2.3 as written block an automated harness from producing any `human_ruling`; the import path in the governing contracts decision resolves it but is not in the ADR body.

---

## Lead rulings (2026-09-15, after this appendix was written)

Answers to the seven LEAD DECISION NEEDED rows and the conflicts in §8, applied to the ADR and the contracts in the same commit.

| Item | Ruling |
|---|---|
| C14-D11 restore-of-superseded | Accepted: new lifecycle kind `reinstated` (target, reason; `rule` capability; class ≥ the superseding event's class) — the only path back from supersession/override. `restored` (from archive) keeps §4.4 semantics. Contracts: `src/contracts/lifecycle.ts`. |
| X-8 attachment size | 256 KiB per committed attachment by default; larger sources by hash/size/URI reference. ADR §13. |
| C09 OQ-8 | Foundation-bullet assertions are scored separately from the C09 row. |
| C10-D6 admission reasons | The admission log records the reason for every outcome, including `admitted`. |
| C10-D7 uncertainty windows | Closed uncertainty windows are retained in history after reconciliation. |
| C10-D12 overlap with C24/C18 | Report under C10, count once in the matrix. |
| C14-D2 git observations | Harness-issued in the slice; the Git carrier (lane 02) issues its own rewind observations when it detects them — no filesystem/git watcher. |
| Conflict 1 `contested` | `contested` is an annotation (explain packets, history), never a member of `current()`, never a change to the target's conflict state. ADR §4.3 rule 1 reworded. |
| Conflict 2 `promoted` | No semantic conflict: `promoted` is an explicit authorized status transition; restoration never emits or implies it. ADR §4.4 reworded. |
| Conflict 3 event counts | Oracle counts are over the case's record types only; principal/membership/observation/receipt events excluded (R01). ADR §12. |
| Conflict 5 store placement | C14 runs two arms (exchange-ref carrier vs source-branch mode). ADR §12. |
| Conflict 6 `representations[]` | Projection state on the admission log, never on the envelope. ADR §12. |
| Conflict 7 ruling production | ADR §2.3 now states the signed-import admission path explicitly; oracle runs sign with a fixture human key. |
| rule_C / rule_E wording | Accepted as adjusted: "absent a declared membership policy rule"; "non-descendant" instead of "neighbouring". |

**Discovered need:** the oracles' open-question sections had not been written into the oracle files (the lead's extraction saved only the markdown body); they are now appended to each `*.oracle.md` under "Open questions (structured list…)" from the workflow journal, with the original ids. The 73 ruling rows above stand; a mapping pass from the original ids to the derived rows is lane 05 work if any assertion turns on it.
