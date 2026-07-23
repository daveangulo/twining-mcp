# Spec: `twining_triage` — a project-wide triage read-model for Twining

**Status:** v2 SPEC (final), owned by the twining-mcp project (2026-07-23). Supersedes the
2026-07-22 field draft authored in the agentic-platform-design session, which a
72-agent adversarial review found unbuildable as written, and the v2 draft, which
five adversarial checkers verified against source. All repo citations verified
against `main` @ `b64542a` in `/Users/dave/code/twining-mcp`.
**Feature owner:** project lead. Implementation happens in this repo.

---

## Changes from the 2026-07-22 field draft

Each correction traces to a confirmed review finding; the review report is the
evidence record.

1. **Two buckets (`open`/`recent`) replace ratify_queue/audit_window/recent_signal** —
   the old ratify queue had no exit condition (no "ratified" state exists in
   `DecisionStatus`); the new taxonomy keys on the native lifecycle so every bucket
   drains.
2. **Decision leg follows the native state machine** — `status=provisional` is the
   repo's "awaiting confirmation" state and `twining_promote` is the ratify act; the
   draft inverted this by queueing `active` decisions and omitting `twining_promote`
   entirely.
3. **Old §5 ("THE HARD DECISION") deleted** — it analyzed only the file backend;
   SQLite is the v2 default and its `getIndex()` is a full-record projection, mooting
   the entire Option A/B/C framing, the §5.1 guard, and all `degraded` machinery.
   Replaced by a per-backend read-path section with no index-schema change in v1.
4. **Openness predicate defined** — the draft never said what "open need" means; the
   repo's canonical #40 `relates_to` convention (`src/engine/archiver.ts`) is now the
   single source of truth, consumed via mandatory shared code over a mandated
   unfiltered corpus (§3.4).
5. **Kind `handoff` dropped; kind `artifact` added** — `twining_handoff`/
   `twining_acknowledge` are deprecated for v3 with zero field usage; the
   field-verified handoff signal is `artifact` blackboard posts.
6. **Kind `question` added** — the paradigmatic "waiting on someone" item, already a
   first-class stat (`unanswered_questions`), was absent from the draft's taxonomy.
7. **`stakes` scalar removed** — invented cross-kind weights were policy leaking into
   mechanism (and the formula was sign-inverted and exceeded its own [0,1] contract).
   Items carry named classification fields; ordering is a simple advisory rule.
8. **`for_agent` input added; unfiltered default documented as project-wide** — the
   draft promised "waiting on ME" with no identity model.
9. **MCP tool moves behind `options.fullSurface` for v1** — dashboard is the primary
   surface; promotion/removal criteria are pre-declared (§6.1) per the
   `twining_handoff` deprecation precedent.
10. **Single JSON `toolResult`** — the draft's dual markdown+JSON output contradicted
    the universal tool convention and doubled context cost.
11. **`since` cursor added** — the draft promised "since a cursor" with no cursor
    input; `generated_at` is now the documented next-call cursor.
12. **`counts`/`section`/`limit`/uninitialized semantics fully specified**; HTTP
    routing follows the `/api/search` parsed-URL pattern (the draft's "follow
    /api/handoffs exactly" produces a route that 404s on query strings); standalone
    stores built via `createStores()` (the raw file-store fallback serves empty data
    on sqlite projects).
13. **Tests parameterized over both backends with an injected clock** — the draft had
    zero sqlite coverage despite the repo's parity suite.
14. **Findings cut from v1** — package-generated conflict findings are untagged system
    noise; reversal path and its prerequisite are documented (§11.2).
15. **Neutral bucket naming (`open`/`recent`)** — "ratify"/"audit" were the consumer
    project's charter vocabulary baked into a published API.

## 0. Reading path

- Implementing agent → §3 (taxonomy), §4 (data contract), §5 (read path +
  shared-code prerequisites), §6–8 (tool/API/view specs), §10 (tests).
- Reviewer → §2 (gap proof), §3.3 (exit semantics), §9 (scope boundary).
- §11 records resolved design points and documented limitations — nothing there
  blocks implementation.

## Contents

- §1 Motivation
- §2 The gap (why this isn't already in Twining)
- §3 Design overview — three surfaces, one core; the two-bucket taxonomy
- §4 Data contract — `TriageItem` / `TriageResult` / inputs
- §5 Read path — per backend, plus mandatory shared-code prerequisites
- §6 MCP tool spec — `twining_triage` (surface gating + promotion test)
- §7 HTTP API spec — `GET /api/triage`
- §8 Dashboard view spec — the Triage tab
- §9 Scope boundary — what stays OUT of Twining
- §10 Testing requirements
- §11 Resolved design points & documented limitations
- Handoff notes

---

## 1. Motivation

Twining tracks *why* decisions were made and coordinates multi-agent work, but gives
no one — lead or agent — a way to ask: **"what in this project is awaiting a
lifecycle act, and what just happened?"** Today that answer is reconstructed by hand:
reading the blackboard, the decision log, and open needs across scopes. That
reconstruction is the information silo Twining exists to eliminate, applied to the
operator.

The human operator is already a first-class actor in Twining's data model
(`conflict_resolution` defaults to human; `twining_override` defaults
`overridden_by` to `"human"`), and core already *generates* human-addressed work
items — provisional decisions, conflict warnings — with no delivery mechanism beyond
an agent remembering to mention them. Triage closes a delivery gap that already
exists.

`twining_triage` makes the queue a first-class, queryable read-model:

- **`open`** — items awaiting a defined resolution act: provisional decisions,
  unresolved needs, questions, and warnings. Unbounded, drained by the act.
- **`recent`** — activity with no resolution lifecycle: newly active decisions
  (including the disagree-and-commit audit material) and artifact posts, drained by
  time and the `since` cursor.

The primitive is *policy-free*: it returns classified items with named fields
(`kind`, `reversible`, `confidence`, `status`, `urgency`, `age_ms`, `tags`).
Project-specific ranking weights and noise filters stay in the consumer (§9).

**Why a read-model in the engine, not a consumer-side wrapper:** the classification
depends on engine invariants that live nowhere else — the #40 `relates_to`
resolution convention, delegation expiry, provisional semantics. A wrapper over the
HTTP API would duplicate those invariants and silently drift.

## 2. The gap — why this isn't already in Twining (verified at b64542a)

- `reversible` is a first-class required field on `Decision`
  (`src/utils/types.ts:73`), defaulted `?? true` at record time
  (`src/engine/decisions.ts:310`). The classifying data exists.
- The ratification state machine exists: `twining_reconsider` demotes
  active→provisional (`src/tools/decision-tools.ts:206-207`), `twining_promote`
  confirms provisional→active ("Use this to confirm provisional decisions",
  `decision-tools.ts:283-288`), `twining_override` vetoes (`decision-tools.ts:243-244`).
- Openness is already defined by convention #40: a need/warning counts as resolved
  when a live entry back-references it via `relates_to`
  (`src/engine/archiver.ts:33-38`, `61-63`) — and unresolved ones are exempt from
  age-archival because they "matter MORE as they age, not less." The predicate is
  order-agnostic and self-inclusive: the canonical code applies no timestamp
  condition and no self-reference exclusion (§3.4).
- `need`, `question`, `warning`, `artifact` are native blackboard entry types
  (`src/utils/types.ts:8-19`); `unanswered_questions` is a first-class status stat
  (`types.ts:269`, `src/engine/context-assembler.ts:810`).
- The dashboard serves `/api/decisions`, `/api/blackboard`, `/api/search`, etc.
  through one dispatcher (`src/dashboard/api-routes.ts`).

What is absent (grep `triage|work.?queue|inbox` across `src/` — zero hits): any
surface that joins these into "what's awaiting an act / what just happened." Twining
owns every ingredient and exposes no dish. This spec is additive, not duplicative.

## 3. Design overview

### 3.1 Three surfaces, one core

```
                 ┌──────────────────────────────────┐
                 │  buildTriage(stores, opts, now)  │  ← src/engine/triage.ts
                 │  reads stores, classifies,       │
                 │  orders, returns TriageResult    │
                 └───────────────┬──────────────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        ▼                        ▼                        ▼
  twining_triage           GET /api/triage          Dashboard "Triage" tab
  (MCP tool, §6 —          (JSON, §7 —              (SPA view, §8 —
   fullSurface in v1)       always available)        PRIMARY v1 surface)
```

`buildTriage` is typed against the store interfaces (`IDecisionStore`,
`IBlackboardStore`), with injected store instances and an injected `now()` clock.
The three adapters are thin: parse inputs → call `buildTriage` → emit. No logic
duplication, one test target. All input range-normalization (defaults, clamps)
lives inside `buildTriage` so the adapters cannot drift (§4.1).

### 3.2 The two-bucket taxonomy

The bucket boundary is **exit semantics**:

- **`open`** — items with a defined resolution act. Unbounded; never window-limited;
  `since` never filters it (windowing open obligations would silently hide unresolved
  hazards). Drained only by the resolution act.
- **`recent`** — items with no resolution lifecycle. Windowed; drained by time and
  the `since` cursor.

The decision/blackboard, reversibility, and signal splits all collapse into
item-level fields (`kind`, `reversible`, `status`) that consumers and the dashboard
partition for free. "Open" is already the repo's status vocabulary (`open_needs`,
`active_warnings`, `unanswered_questions`).

**Bucket `open` — membership and exit, per kind:**

| kind | open when | exit (drain) |
|---|---|---|
| `decision` | `status === "provisional"` — the native awaiting-confirmation state | `twining_promote` (the ratify act), `twining_override` (veto), supersession, `twining_archive_stale` (the decision-archival act — `src/tools/housekeeping-tools.ts:147` calls `decisionStore.updateStatus(id, "archived")`; `twining_archive` touches only blackboard entries, `src/tools/lifecycle-tools.ts:176`) |
| `need` | live `entry_type "need"`, unresolved per the #40 predicate (§3.4); if `parseDelegationMetadata(entry) !== null` (`src/engine/coordination.ts:97-110`), additionally not expired per `isDelegationExpired(metadata, injectedNow)` (`coordination.ts:112-121` — boundary-INCLUSIVE: `now >= expires_at` means expired) | resolver entry posted with `relates_to` (`twining_post`), delegation expiry, dismissal, archival |
| `question` | live `entry_type "question"`, unresolved per the SAME uniform predicate — ANY live back-reference resolves, not only `answer`-typed entries | back-reference via `relates_to` (normally an answer), dismissal, archival |
| `warning` | live `entry_type "warning"`, unresolved per the same predicate. Warnings are open obligations, NOT windowed signal — the archiver exempts unresolved warnings from age-archival on exactly this rationale (`archiver.ts:33-38`) | resolution via `relates_to`, `twining_dismiss`, `twining_archive_stale` |

Questions use the uniform predicate deliberately: agents routinely resolve questions
with status/finding posts; an answer-only rule would strand visibly-addressed
questions and force a second predicate variant. (An answer back-reference satisfies
the uniform predicate, so nothing is lost.)

**Bucket `recent` — membership and exit:**

Item included iff its timestamp is **strictly after** the cutoff, where
`cutoffMs = max(nowMs − window_ms, sinceMs ?? −infinity)`. The membership
comparison is performed on **parsed epoch milliseconds** (equivalently: `since` is
normalized via `new Date(since).toISOString()` before comparison). Store-written
timestamps are uniformly `new Date().toISOString()` (Z-suffixed —
`src/storage/blackboard-store.ts:53`, `src/storage/decision-store.ts:36`), but
`since` is foreign input: a parseable offset-form value like
`2026-07-22T10:00:00+02:00` would misfilter under raw string comparison, so raw
string comparison is reserved for the §4.2 presentation-order comparator only,
where every input is store-generated and uniform.

Strict `>` is a deliberate divergence from `/api/search`'s inclusive post-filter
(`api-routes.ts:228`): `generated_at` is the next-call cursor and must not re-return
same-instant items (the repo's `/api/index` route already uses strict `>`,
`src/dashboard/query-routes.ts:196`). The boundary is pinned by an injected-clock
test (§10).

**Cursor race, pinned:** `generated_at` is sampled from the injected clock **BEFORE
the store reads**. Consequently a strictly-cursoring consumer can miss only a write
that lands in the same millisecond as `generated_at` after the snapshot — the
unavoidable residual race under strict `>`, documented here. Sampling after the
reads would make same-instant writes permanently invisible to a cursoring consumer;
that ordering is forbidden.

| kind | membership | exit |
|---|---|---|
| `decision` | `status === "active"` within cutoff — BOTH reversible and irreversible. This is the disagree-and-commit audit window; the `reversible`/`confidence` fields carry the audit split, and `counts.recent.irreversible` gives the truncation-proof tally | window expiry / cursor advance; veto = `twining_override`; doubt = `twining_reconsider` |
| `artifact` | live `entry_type "artifact"` within cutoff — the field-verified handoff signal (§3.5) | window expiry / cursor advance (the sole lifecycle exit — time-based only), dismissal, archival |

**Cross-bucket transition (explicit):** `twining_reconsider` demotes an active
decision to provisional and thereby MOVES it from `recent` to `open`. This is the
mechanism's answer to "this needs a longer look."

**Documented limitations (honest residue, all pinned or disclosed):**

1. `updateStatus` does not refresh the decision's `timestamp`
   (`src/storage/sqlite/sqlite-stores.ts:208-220`,
   `src/storage/decision-store.ts:118-130`), so a decision promoted
   provisional→active does not re-enter `recent`. Deliberate: it was already
   reviewed in `open`. An active irreversible decision older than the window
   appears nowhere — that IS drain (committed after the audit window passed);
   "still unratified" is spelled `status=provisional` and lives in `open` until a
   drain act. Residual risk: a misrecorded `reversible: true` active decision ages
   out of `recent` unreviewed. Mitigations: the `since` cursor, a larger
   `window_ms`, and the unwindowed `open` bucket for anything demoted via
   `reconsider`.
2. **Machine drain of `open`'s decision leg:** housekeeping's opt-in
   `promote_provisionals` (`src/engine/housekeeping.ts:213-218`) bulk-promotes
   every provisional older than `staleDays` to `active` when `promote_provisionals`
   and `execute` are both set — no per-decision review, no reversibility check —
   and `twining_housekeeping` is a default-surface tool
   (`src/tools/housekeeping-tools.ts:19`, registered unconditionally at
   `src/server.ts:258`). Because `updateStatus` preserves `timestamp` (point 1),
   such decisions typically skip the `recent` window too — machine-ratified without
   ever being reviewed. Consumer-policy note (consistent with §9): projects using
   triage as a ratification queue should leave `promote_provisionals` off.
3. **Reconsider's companion warning:** `twining_reconsider` auto-posts a warning
   ("Reconsideration flagged: …") with `tags: [domain]` and NO `relates_to`
   (`src/engine/decisions.ts:737-744`). Under the #40 predicate that warning is
   unresolved, so it lands in `open` — and neither `twining_promote` (its status
   post carries no `relates_to`, `decisions.ts:862-874`) nor `twining_override`
   (posts nothing) resolves it. It is also exempt from age-archival
   (`archiver.ts:72-79`; `keep_open_needs_warnings` defaults true,
   `archiver.ts:51`). **v1 treatment (pinned by a §10 test):** the companion
   warning is an ordinary open warning; its drains are a `relates_to` back-reference
   (`twining_post`), `twining_dismiss`, or `twining_archive_stale`. Operators who
   ratify a reconsidered decision should resolve or dismiss the companion warning
   as part of the same act — the tools do not do it for them. The structural fix
   (system-tagging the post site) is future work bundled with the findings
   reversal, §11.2 — note the §11.2 "ages out of the window" rationale does NOT
   transfer here, because `open` is deliberately unwindowed; this residue persists
   until dismissed.

**Excluded everywhere:** superseded/overridden/archived decisions; `finding` entries
(cut from v1 — §11.2); `offer`/`status`/`constraint`/`answer`/`decision` blackboard
entry types (decision entries are no longer cross-posted per #30,
`src/engine/decisions.ts:350`); kind `handoff` (deprecated surface — §3.5). There is
no `include_system` param in v1 (it existed only to serve findings).

### 3.3 Mutation-tool enumeration (the drain acts)

- `twining_promote` — the ratify act for provisional decisions (MUST be understood
  as such; the field draft omitted it). `fullSurface`-gated
  (`decision-tools.ts:283`).
- `twining_override` — veto. `fullSurface`-gated (`decision-tools.ts:243`).
- `twining_reconsider` — demote active→provisional (recent→open transition).
  `fullSurface`-gated (`decision-tools.ts:206`).
- `twining_post` with `relates_to` — the resolution act for need/question/warning.
  **Default surface** (registers unconditionally, `src/tools/blackboard-tools.ts:32-33`).
- `twining_dismiss` — removal of blackboard items, including the reconsider
  companion warning (§3.2 limitation 3). `fullSurface`-gated
  (`blackboard-tools.ts:234`).
- `twining_archive_stale` — archival: decisions → `status "archived"`, blackboard
  ids → dismissed (`housekeeping-tools.ts:147`). **Default surface** (registers
  unconditionally at `housekeeping-tools.ts:111`; `registerHousekeepingTools` is
  called without a surface flag, `src/server.ts:258`).
- `twining_housekeeping` with `promote_provisionals` + `execute` — the opt-in
  machine drain of `open`'s decision leg (§3.2 limitation 2). Default surface.

So the gating picture, stated precisely: the **decision-lifecycle drains**
(promote/override/reconsider) and `twining_dismiss` are `fullSurface`-gated;
`twining_post` and `twining_archive_stale` are default-surface, so the
blackboard-kind drains (resolve via `relates_to`, archival) work on any surface.
Since `twining_triage` itself registers behind `options.fullSurface` in v1 (§6),
any **agent session** that can see the tool can perform every drain act — the
**tool surface** has no see-but-cannot-act asymmetry in v1, a fortiori for the
blackboard drains, which are MORE available than the triage tool. The dashboard
and `GET /api/triage` — including the PRIMARY v1 surface — are deliberately
**read-only viewers** (§8: no mutation UI): a human watching the dashboard acts
through an agent session, whose drains are governed by that session's surface.
That is the read-only design, not an accidental asymmetry. The promotion test
(§6.1) re-examines the tool-surface picture at promotion time; only the
decision-leg drains and `twining_dismiss` need co-promotion consideration,
exactly because the other drains are already default-surface.

### 3.4 The openness predicate — single source of truth

A need/question/warning is **resolved** when **any live entry** back-references
its id via `relates_to`. The canonical prose says "any other entry"
(`archiver.ts:33-38`) but the canonical CODE applies neither a timestamp condition
nor a self-reference exclusion (`archiver.ts:61-63` adds every entry's
`relates_to` ids, including a self-referencing entry's own) — **the code is
normative**: the extracted helper must preserve `archiver.ts` behavior exactly,
including its indifference to entry order and its lack of self-exclusion. The canonical implementation rationale and code are
`src/engine/archiver.ts:33-38` (convention #40) and `archiver.ts:61-63` (the
`resolvedIds` computation). `buildTriage` MUST consume this via the shared helper
(§5.1) — **no parallel implementation is permitted**. Delegation needs are
additionally excluded when expired (§3.2 table). Dismissed/archived entries are
excluded by store semantics (they leave the live board).

**Resolution corpus (normative):** `computeResolvedIds` MUST be computed over the
**complete unfiltered live board** — `blackboardStore.read()` with no filters, the
archiver's own corpus (`archiver.ts:56-63`). The `scope`/`for_agent`/entry-type
filters apply to item MEMBERSHIP only, never to the resolution corpus. This matters
because `IBlackboardStore.read()` accepts `entry_types`/`scope`/`since` filters
(`src/storage/interfaces.ts:36-42`) and the repo itself contains both patterns —
the archiver reads unfiltered, while `verify.ts` reads scope-filtered
(`src/engine/verify.ts:227`) for its own, different purpose. A type-narrowed corpus
computes `resolvedIds` empty (resolvers are typically `status`/`finding`/`answer`
entries — types triage never emits) and every resolved item stays open forever; a
scope-narrowed corpus misses resolvers posted under the resolver's own working
scope. Both failure modes are pinned by §10 tests.

Implementers are explicitly forbidden from "helpfully" extending this predicate to
artifacts — no consumption convention exists for artifacts in the mechanism, and
inventing one is exactly the parallel-predicate drift this section forbids.

### 3.5 Artifact placement — why `recent`, not `open`

Artifacts are the field-verified handoff signal: `twining_handoff`/
`twining_acknowledge` are DEPRECATED for v3 removal because field data showed real
handoffs are committed markdown docs signaled via artifact posts
(`src/tools/coordination-tools.ts:232,319`). But no consumption lifecycle exists for
artifacts — #40 covers need/warning (extended here to question), NOT artifacts. An
unbounded artifact bucket would violate the every-bucket-has-an-exit rule and
re-create the never-drains defect the review killed the field draft for. The window
IS the exit. Under `for_agent`, self-posted artifacts are excluded — your own
outbound handoffs are not waiting on you.

**Future note:** if a `relates_to` consumption convention for artifacts emerges from
field data, artifacts migrate to `open` non-breakingly at the ITEM level (same item
shape, open kind union). At the COUNTS level, the fully-enumerated `by_kind`
guarantee (§4) is preserved across the migration: `counts.recent.by_kind.artifact`
remains present and zeroed for at least one major version after the move, so
consumers reading it without an existence check do not break. Key relocation
without that grace period would violate the counts contract.

### 3.6 `for_agent` semantics

When provided, ALL blackboard-sourced kinds (need/question/warning/artifact) exclude
items with `agent_id === for_agent` — one uniform rule: your own outbound posts are
not waiting on you. `for_agent` matches `BlackboardEntry.agent_id` under the **same
self-reported convention `twining_post` uses** (default `"main"`,
`src/engine/blackboard.ts:122`); there is no registry lookup or validation. Note
the consequence honestly: in a single-identity install where everything is posted
as `"main"`, `for_agent: "main"` filters ALL blackboard items — expected, since a
solo actor has no inbound queue. Decisions are never identity-filtered — decision
review is a role, not an addressee, and no target field exists on `Decision`. The
unfiltered default is the **project-wide view**, not "your" queue; the tool
description must be role-neutral (§6).

## 4. Data contract

New types in `src/utils/types.ts`. `buildTriage` lives in `src/engine/triage.ts`.

```ts
export interface TriageItem {
  kind: "decision" | "need" | "question" | "warning" | "artifact";
  // The union is declared OPEN for additive extension: adding kinds is
  // non-breaking; consumers MUST tolerate unknown kind strings.
  id: string;              // decision id or blackboard entry id — the deep-link key
  scope: string;
  summary: string;
  agent_id: string;        // REQUIRED — see note below
  timestamp: string;       // ISO: Decision.timestamp / BlackboardEntry.timestamp
  age_ms: number;          // injectedNow − timestamp; presentation only, NEVER an ordering key
  tags?: string[];         // blackboard-sourced kinds only; OMITTED (not []) for decisions
  detail_preview?: string; // see construction rule below. OMITTED when source
                           // empty; OMITTED for delegation needs (their detail is
                           // the JSON metadata blob — the parsed urgency/expires_at
                           // fields replace it)
  detail_truncated?: true; // present only when detail_preview was cut
  // decision-only (absent otherwise):
  reversible?: boolean;
  confidence?: DecisionConfidence;            // "high" | "medium" | "low"
  status?: "provisional" | "active";          // provisional in open, active in recent
  // delegation-need-only (native DelegationMetadata via parseDelegationMetadata):
  urgency?: "high" | "normal" | "low";        // types.ts:401
  expires_at?: string;                        // ISO
}
```

**`detail_preview` construction (order pinned):** collapse all whitespace runs in
the source text (`BlackboardEntry.detail` for blackboard kinds,
`Decision.rationale` for decisions) to single spaces and trim FIRST; then
`detail_preview` = the first 200 characters of the collapsed string;
`detail_truncated: true` is present iff the **collapsed** string exceeds 200
characters. (Truncate-then-collapse is forbidden — the two orders diverge on both
the preview string and the `detail_truncated` flag near the boundary; a §10 fixture
pins a raw-length > 200 / collapsed-length ≤ 200 case as complete.)

**`agent_id` is required despite `DecisionIndexEntry` lacking it**
(`types.ts:292-303` — no `agent_id`, no `reversible`): the two-phase read (§5)
already fetches full `Decision` records for every emitted decision item, so
`agent_id` is free. This dissolves the review's index-gap finding.

**Deliberately omitted:** full `detail` (unbounded prose — consumers fetch full
records by id via existing tools), `stakes` (no heuristic scalar ships),
`acknowledged`/`source_agent`/`target_agent` (handoff kind dropped), `domain`,
`embedding_id`, `provenance`.

```ts
export interface TriageResult {
  generated_at: string;    // injectedNow, sampled BEFORE store reads (§3.2);
                           // documented as the next-call `since` cursor
  window_ms: number;       // applied value after defaulting
  section: "all" | "open" | "recent";  // echo, always present (applied value)
  scope?: string;          // echo, present iff provided and non-empty
  for_agent?: string;      // echo, present iff provided and non-empty
  since?: string;          // echo, present iff provided AND valid
  open?: TriageItem[];     // present iff section is "all" or names it; ABSENT
                           // (undefined) when not requested — distinguishable from
                           // genuinely-empty []
  recent?: TriageItem[];
  counts: {                // ALWAYS computed over BOTH buckets regardless of
                           // section; PRE-TRUNCATION totals (limit truncates arrays
                           // only); by_kind keys always fully enumerated with
                           // zeros; future kinds add keys additively (and §3.5
                           // governs any future key relocation)
    open:   { total: number; irreversible: number;
              by_kind: { decision: number; need: number; question: number; warning: number } };
    recent: { total: number; irreversible: number;
              by_kind: { decision: number; artifact: number } };
  };
}
```

`counts.<bucket>.irreversible` = pre-truncation count of `kind=decision` items in
that bucket with `reversible === false`. `counts.recent.irreversible` is the
truncation-proof audit-lane tally; `counts.open.irreversible` is the
truncation-proof **ratify-lane** tally — the highest-stakes class (provisional
irreversible decisions) must be countable even when the array is truncated (§4.1)
and the dashboard must surface truncation (§8). Truncation is detectable as
`counts.<bucket>.total > array.length`; no separate flag.

### 4.1 Inputs

All optional. The tool takes a zod shape; HTTP reads `searchParams`. **All
range/validity normalization lives inside `buildTriage`** so the two adapters share
one implementation and only TYPE errors differ between them (zod-rejected at the
tool; string-parse-defaulted at HTTP). Per-param adapter behavior:

| param | tool (zod shape) | HTTP (`searchParams`) | shared normalization (in `buildTriage`) |
|---|---|---|---|
| `scope` | `z.string().optional()`; `""` treated as absent | missing or `""` → absent (empty-string params are treated as absent and NOT echoed) | bidirectional prefix match via shared `scopeMatches` (§5.1) on the item's declared `scope` only — see below |
| `window_ms` | `z.number().optional()` — **unconstrained**; non-numeric is unreachable (zod-rejected) | non-numeric string → absent | absent or ≤ 0 → default `604_800_000` (7 days); no upper clamp (documented) |
| `section` | `z.enum(["all","open","recent"]).optional()` — invalid value zod-rejected | invalid → `"all"` | absent → `"all"` |
| `limit` | `z.number().optional()` — **unconstrained** | non-numeric → absent | absent → 25 per bucket; then clamped to [1, 200] |
| `since` | `z.string().optional()` | string as-is | unparseable via `new Date(since)` → ignored (treated as absent, not echoed); parseable → normalized to epoch for the cutoff comparison (§3.2) |
| `for_agent` | `z.string().optional()`; `""` treated as absent | missing or `""` → absent | equality on `agent_id` (§3.6) |

Do NOT put range constraints (`.positive()`, `.min()`, `.max()`) in the zod shape —
that would make the tool reject values HTTP silently defaults, forking the adapters.

- **`scope` matching:** bidirectional prefix
  (`a.startsWith(b) || b.startsWith(a)`) on the item's **declared `scope` field
  only**, via the shared `scopeMatches` util (§5.1), applied uniformly to decisions
  AND blackboard kinds. `affected_files`/`affected_symbols` matching is
  intentionally NOT applied — a documented divergence from
  `DecisionStore.getByScope` (`src/storage/decision-store.ts:70-81`, which also
  matches affected files/symbols bidirectionally): triage membership is by declared
  scope; file-overlap constraint discovery is `twining_why`'s job. Consequence,
  stated plainly and pinned by a §10 test: a decision whose `affected_files` match
  the query scope but whose declared `scope` does not is EXCLUDED from scoped
  triage. Revisit only if field data shows scoped triage missing decisions
  constraining in-scope files. `scope: ""` is treated as absent (see table) — it is
  never passed to `scopeMatches` (where it would silently match everything while
  looking like a filter).
- **`window_ms` default rationale:** `604_800_000` (7 days) is a repo-native
  neutral-mechanism constant: it matches the existing 7-day stale-provisional
  threshold (`src/tools/lifecycle-tools.ts:90-96`). Applies to `recent` only.
- **`section`:** payload reducer ONLY — counts always cover both buckets, so the
  empty state is well-defined on filtered calls.
- **`limit` — truncation selection is CONTRACTUAL:** `limit` truncates arrays
  AFTER classification; counts are unaffected. Which items survive truncation is a
  **stable contract, independent of the advisory presentation ordering (§4.2)**:
  `open` truncation always retains the N **oldest** items by `(timestamp, id)`
  ascending; `recent` truncation always retains the N **newest** by
  `(timestamp, id)` descending. Future ordering changes may REORDER delivered
  items but never change which items survive truncation (§4.2). A §10 test asserts
  selection as set membership, separate from the ordering golden fixture.
- **Known v1 limitation — the 200 cap:** because `open` is unbounded by design and
  has no offset/cursor, a project whose open total exceeds 200 can see the total in
  `counts.open.total` (and the ratify-lane in `counts.open.irreversible`) but
  cannot enumerate items beyond the 200 retained through any triage surface — the
  remainder requires the underlying stores. Triage is a read-model, not an export;
  the mitigation is counts-driven drain-down. A future additive `offset` or
  keyset cursor on the `(timestamp, id)` sort key is non-breaking future work
  (§11.7).
- **`since`:** `recent`-only additional cutoff, strict `>` on epoch-normalized
  values; effective cutoff per §3.2. Never filters `open`.
- **`for_agent`:** per §3.6.

### 4.2 Ordering — deterministic, advisory, non-contractual

Ordering MAY change in minor versions. Golden tests pin **per-version fixtures**,
not a cross-version behavioral contract; consumers re-rank on the named
classification fields (`kind`, `reversible`, `confidence`, `status`, `urgency`,
`age_ms`, `tags`). Ordering changes may reorder delivered items but MUST NOT change
which items survive truncation — truncation selection is the separate, stable
contract defined in §4.1.

The deterministic default, per bucket:

- **`open`: ascending by `(timestamp, id)` — oldest first.** Rationale is the
  archiver's own documented principle: open obligations "matter MORE as they age,
  not less" (`archiver.ts:37-38`). One native key, no invented weights; also
  structurally fixes the field draft's tie-break inversion.
- **`recent`: descending by `(timestamp, id)` — newest first** (activity feed). No
  cross-kind weighting, no reversibility term in the sort — the audit split is
  carried by the `reversible` field, `counts.recent.irreversible`, and dashboard
  presentation (§8 badges/grouping happen client-side).

The presentation-order comparator operates on the raw ISO timestamp string and ULID
id string, both lexicographically time-ordered — safe here because every compared
value is store-generated and uniformly Z-suffixed (unlike the `since` cutoff, which
must be epoch-normalized, §3.2). Ordering is a pure function of store contents and
does NOT involve `now()` (`age_ms` is excluded from ordering), so it is poll-stable
when stores are unchanged — eliminating the dashboard row-churn defect — and golden
fixtures need no clock in the comparator.

### 4.3 Payload stance

Tags IN (short, load-bearing for consumer policy — delegation/urgency/domain/user
tags). `detail_preview` IN at 200 chars — required to make the §9 consumer-policy
layer implementable without undoing the context-cost fix. Full detail OUT. Worst
case at defaults: 50 items × (summary + ≤200-char preview + tags) ≈ 25–30 KB in a
single JSON `toolResult` — bounded, far below re-reading the blackboard.

## 5. Read path — per backend (no index change, no degraded machinery)

`buildTriage` narrows candidates via `getIndex()` (status/scope/timestamp fields),
then reads full records for the narrowed candidate set. That is the whole design.
There is no options menu, no backfill, no `degraded` state.

**Corpus rule (mirrors §3.4):** candidate narrowing applies to item membership
only. The resolution corpus for `computeResolvedIds` is ALWAYS the complete
unfiltered live board (`blackboardStore.read()` with no filters) — never the
narrowed candidate set, never a scope- or type-filtered read.

**Honest per-backend picture:**

- **SQLite (the v2 default** — fresh and migrated projects resolve to sqlite,
  `src/storage/backend-resolve.ts:27,32`): `SqliteDecisionStore.getIndex()` is a
  read-time **projection over full Decision JSON rows**
  (`src/storage/sqlite/sqlite-stores.ts:223-242` — it parses every record and drops
  fields). The "extra" full-record reads triage adds are reads of rows already
  parsed today on every `getIndex()` call.
- **File backend:** `getIndex()` is an mtime-cached persisted index
  (`src/storage/decision-store.ts:137-147`); full-record reads are per-file
  `readJSON` calls for the narrowed set only.

**Measured cost (from the review):** ~3.3 ms to read+parse all 170 full records in
this repo's store; ~45 ms extrapolated to field scale (~2,180 decisions) — and the
two-phase design reads only the active/provisional subset, a fraction of that.
Acceptable for a dashboard-poll surface.

**Future optimization (NOT v1), gated on profiling:** add `reversible` (and
`agent_id`) to the sqlite `getIndex()` projection (a one-line addition) and to the
file backend's persisted index entries. Do this only if profiling shows the
full-record phase is a real cost; note that on the file backend the index-write
sites (`updateStatus`/`linkCommit` patch single fields,
`decision-store.ts:118-130`) would also need to rewrite full entries.

### 5.1 Mandatory shared-code prerequisites

These make §3.4 literally true and are required implementation work — cheap
adjacent-debt paydown, no parallel predicates permitted:

1. **Extract `computeResolvedIds(entries)` into `src/engine/resolution.ts`** —
   behavior-preserving copy of the archiver's type-agnostic, order-agnostic rule
   (any entry's `relates_to` ids resolve; no timestamp condition, no
   self-reference exclusion beyond what the source code does) — and refactor the
   **two true near-copies** onto it: `src/engine/archiver.ts:61-63` and
   `src/engine/blackboard.ts:164-174` (both implement the identical uniform rule),
   plus `buildTriage` as the new third consumer.

   **Explicitly EXCLUDED: `src/engine/verify.ts:226-244`.** `checkWarnings` is NOT
   a near-copy — it deliberately discriminates by the referencing entry's type,
   building `acknowledgedIds` from `answer`/`finding` referencers and `resolvedIds`
   from `status` referencers only, feeding `twining_verify`'s
   acknowledged/resolved/silently-ignored warning stats. Collapsing it onto the
   uniform helper would silently change `twining_verify`'s observable output.
   verify.ts stays as-is, with a comment cross-referencing `resolution.ts` and
   noting the intentional difference. If unification is ever wanted, it is a
   SEPARATE recorded decision speccing a resolver-type-parameterized helper with
   the verify call sites kept behavior-preserving (its existing tests as the
   guard) — not adjacent-debt paydown under this spec. Regression bar for this
   item: `twining_verify` output must be byte-identical before and after the
   extraction.
2. **Extract `scopeMatches` into `src/utils/scope.ts`** and refactor the three
   stores' identical bidirectional-prefix implementations onto it
   (`src/storage/decision-store.ts:75-76`, `src/storage/blackboard-store.ts:87`,
   `src/storage/handoff-store.ts:97-98`).

## 6. MCP tool spec — `twining_triage`

New file `src/tools/triage-tools.ts`, wired into `src/server.ts` beside the other
`register*Tools` calls. Follow `src/tools/decision-tools.ts` pattern:
`server.registerTool(name, {description, inputSchema}, handler)` with
`toolResult`/`toolError` from `../utils/errors.js`.

**Surface gating: registers behind `options.fullSurface` in v1** (the default
surface stays lean — `full_surface` defaults to `false`, `src/server.ts:254`). The
dashboard is the primary v1 surface; `GET /api/triage` is always available. Per the
§3.3 gating picture, every drain act is available to any agent session that can
see the tool, so the tool surface has no see-but-cannot-act asymmetry in v1; the
dashboard and HTTP surfaces are read-only viewers by design (§3.3).

**Output:** a single `toolResult(JSON.stringify(TriageResult))` per the universal
convention (`src/utils/errors.ts:7-11`). No markdown channel. The empty state IS the
zero-value JSON — no prose channel exists or is needed; the dashboard renders a
friendly empty state client-side.

**Description (role-neutral; must not claim a personal queue):**

> "Project-wide triage read-model: open items awaiting a lifecycle act (provisional
> decisions; unresolved needs, questions, warnings) and recent activity (newly
> active decisions, artifact posts) within a time window. Optionally pass for_agent
> (an agent_id as self-reported to twining_post) to exclude that agent's own
> outbound posts. Read-only — act via twining_promote / twining_override /
> twining_reconsider / twining_post."

**Input schema:** the §4.1 fields as a zod shape (`scope`, `window_ms`, `section`,
`limit`, `since`, `for_agent`), all optional, numerics UNCONSTRAINED per the §4.1
adapter table (normalization lives in `buildTriage`).

### 6.1 Pre-declared surface promotion / removal test

- **Promotion to the default surface:** only if, within an **8-week field
  observation window**, `twining_triage` shows **organic usage (calls not mandated
  by CLAUDE.md gate instructions) in ≥2 distinct field repos** — and promotion MUST
  simultaneously resolve the see-but-cannot-act asymmetry it would create:
  co-promote the decision-leg drains
  (`twining_promote`/`twining_override`/`twining_reconsider`) and
  `twining_dismiss`, or explicitly document drain-via-dashboard as the
  default-surface story. (`twining_post` and `twining_archive_stale` are already
  default-surface, §3.3 — they need no co-promotion.)
- **Removal trigger** (the `twining_handoff` precedent —
  `coordination-tools.ts:232`): **zero field calls of the MCP tool across the same
  8-week window** → deprecate the tool surface, keep dashboard + HTTP (the
  read-model survives; only the tool adapter is removed).

The owner may retune the window length/repo count, but these numbers ship as written
absent a stated reason.

## 7. HTTP API spec — `GET /api/triage`

Add to `src/dashboard/api-routes.ts`. **URL matching and param parsing follow the
`/api/search` block** (`api-routes.ts:151-175`): `new URL(url, "http://localhost")`,
match on parsed `pathname === "/api/triage"`, read `searchParams`. Do NOT copy the
`/api/handoffs` exact-string match (`api-routes.ts:632` — it 404s when a query
string is present).

Envelope follows the sibling collection routes: `fs.existsSync(twiningDir)` guard →
zero shape; `sendJSON`; try/catch logging
`console.error("[twining] API /api/triage error:", err)` → 500. **Never**
`console.log`/stdout (MCP owns stdout).

**Param handling:** per the §4.1 adapter table — type-invalid values default at
HTTP; range normalization happens inside `buildTriage`; empty-string params
(`?scope=` yields `""` from `searchParams.get`) are treated as absent and NOT
echoed; unparseable `since` → ignored, not echoed; unknown params ignored.

**Uninitialized store:** HTTP 200 with `initialized: false` plus the full zero shape
mirroring the success shape **field-for-field for the same params**: the
requested-section rule applies to the arrays (unrequested arrays absent); `counts`
always full and zeroed with every `by_kind` key and both `irreversible: 0` fields;
`generated_at` = now; `window_ms`/`section` = applied values; echoes present per the
same rules. Success responses carry `initialized: true`. `initialized` is
HTTP-adapter decoration only — the MCP tool returns the bare `TriageResult`.

**Standalone store construction is backend-aware via `createStores()`**
(`src/storage/backend-factory.ts:63-66` — it takes `(twiningDir, config)`), never
the raw file-store fallback the existing routes use (`api-routes.ts:84-91` — that
fallback silently serves empty data on sqlite-backend projects). **Construction
cadence:** when `deps` is absent, construct the `StoreSet` ONCE in the
`createApiHandler` closure — the same position as the existing fallback — via
`createStores(twiningDir, loadConfig(twiningDir))` (`src/config.ts:248`). NEVER
per request: a per-request `createStores` opens a fresh sqlite connection plus
`IndexManager` on every dashboard poll — connection churn that only surfaces in
the field.

## 8. Dashboard view spec — the "Triage" tab

New SPA view module `src/dashboard/public/js/triage-view.js`, mounted by
`js/main.js` like the other module views. Follow `js/list-view.js` for view
STRUCTURE only — note `list-view` never fetches an API; it renders from the client
index (`store.rows`/`store.filter`, `js/list-view.js:103,122`). Triage is
different: it must fetch `GET /api/triage` itself.

**Refresh wiring (accurate to the repo — do not use `app.js`'s legacy loop):** the
module-view world polls via `js/main.js`'s own loop — `POLL_MS = 5000`
(`main.js:31`) with a `setInterval` that fetches `/api/status` and calls
`store.poll` (`main.js:467-475`); `store.poll` notifies subscribers ONLY when the
status signature changed (`js/store.js:91-100`, notify at `:188-190`). `js/store.js`
itself is the `/api/index` delta-polling client index — it is NOT a generic
fetch/cache layer and does not serve triage data. The triage view therefore:

1. fetches `GET /api/triage` once on mount,
2. re-fetches from a `store.subscribe` callback (`store.js:70`) — a
   **change-gated refetch**: quiet store ⇒ no refetch. No bespoke `setInterval` —
   and
3. re-fetches on tab activation (whenever `switchTab` reveals the triage panel).

**Accepted staleness (documented):** the two time-based exits — window expiry and
delegation expiry — happen without a store write, so a quiet store leaves them
un-re-evaluated between activations. Accepted v1 staleness; refreshed on the next
store change or tab activation. Do not add a timer for it.

(`app.js:25`'s `pollInterval: 3000` / `refreshData` drives the legacy tabs only —
do not attach triage to it.)

**Tab creation:** add a `data-tab="triage"` button and panel host in
`index.html` (the existing buttons are at `index.html:67-83`); `app.js`'s
`switchTab` (`app.js:338`) and `js/router.js`'s `readRoute` (`router.js:35,53`)
handle any tab name generically — router.js has NO tab allowlist to extend.

- **Layout:** two stacked panels — **Open items** (top, always expanded) and
  **Recent activity** (collapsible). Item rows: scope chip · summary · age · agent,
  with reversible/confidence/status badges on decisions and urgency badges on
  delegation needs.
- **Truncation indicator (NORMATIVE):** whenever
  `counts.<bucket>.total > array.length`, the panel MUST render a
  "showing N of {counts.<bucket>.total}" indicator. The view SHOULD badge and
  visually group `reversible === false` rows and `status === "provisional"` rows
  in BOTH panels (client-side — the API ordering stays the simple §4.2 rule).
  Rationale: the zero-config lead view must never silently hide the existence of a
  truncated provisional irreversible decision; `counts.open.irreversible` (§4) is
  the signal and the indicator is its rendering.
- **Deep links:** reuse the existing `sel=` hash-router mechanism
  (`js/router.js:3,57,76`): decisions → `#/decisions?...sel=<id>`; blackboard kinds
  → `#/blackboard?...sel=<entry-id>`. `id` + `kind` are sufficient; no extra fields.
- **No `since` cursor in v1:** the view always fetches the plain window for both
  panels. The cursor is drain semantics for consuming agents, not display
  semantics — a naive per-poll `since` would empty the Recent panel on every quiet
  poll. Window membership plus the clock-free §4.2 ordering already make renders
  poll-stable; no client-side accumulation buffer is needed or built.
- **Empty state:** rendered client-side from the zero-value JSON.
- **Theme/format:** reuse existing CSS tokens; no new stylesheet. No mutation UI in
  v1 (drain acts go through the tools, §3.3).
- **Presentation conventions (client-side only; the API is unchanged):** rows
  tagged `needs-human` pin into a "Needs human" band at the top of Open items
  and carry a badge — a tag convention, deliberately NOT a mechanism field
  (§9 litmus test; promote into the mechanism only on field evidence, §11.2
  reserved-tag precedent). `http(s)` URLs in summaries, previews, and the
  Blackboard/Decision detail panels render as links opening in a new tab
  (`rel="noopener noreferrer"`, DOM-constructed — never innerHTML). File
  Repo-relative file paths (e.g. `docs/TRIAGE-SPEC.md`) linkify through the
  read-only raw-file route below; a best-effort remote link ("↗", from
  `/api/repo-info`) accompanies them when a browsable remote exists —
  **derived at render time, never rewritten into stored entries**. The
  approval-time transition to a canonical URL is the resolver post
  (`relates_to` drain) carrying that URL — records are immutable.
- **Raw-file route (`GET /api/raw?path=<repo-relative>`):** read-only,
  root-jailed via `resolveRawPath` (`src/dashboard/raw-path.ts`): no absolute
  paths, no `..`/empty/dotted segments (blocks `.git`, `.twining`, dotfiles),
  symlink escapes rejected by realpath containment, files only, 1 MB cap
  (413). Every deny reason is an undifferentiated 404. Content is ALWAYS
  served `text/plain; charset=utf-8` with `X-Content-Type-Options: nosniff`
  — repo content must never execute in the dashboard origin.
  `GET /api/repo-info` returns `{ web_url, branch }` (60s cache, best-effort
  git probing; remote links may not exist until the branch is pushed — the
  local raw link is authoritative).
- **Needs-human filter:** the Open items panel has a "needs-human only"
  toggle filtering to tagged rows client-side; the count line shows
  `showing N needs-human of M` while active. Presentation state only — not
  routed, not an API param.

## 9. Scope boundary — what stays OUT of Twining

Mechanism in Twining, policy in the consumer:

| Belongs in Twining (mechanism) | Stays in the consumer (policy) |
|---|---|
| The lifecycle-based `open`/`recent` split; the #40 openness predicate | The *definition* of what's irreversible (any charter's closed list) |
| Named classification fields (`kind`, `reversible`, `confidence`, `status`, `urgency`, `age_ms`, `tags`) | Ranking weights / re-ranking |
| Neutral-mechanism defaults: 7-day `window_ms` (matches the repo's own stale-provisional horizon), limit 25 | Drain cadence, which scopes matter, panel wiring |
| `scope`/`window_ms`/`section`/`limit`/`since`/`for_agent` params | Noise filters beyond what the mechanism tags |
| — | Whether to enable housekeeping's `promote_provisionals` (leave OFF if triage serves as a ratification queue — §3.2 limitation 2) |

Defaults this spec ships are neutral-mechanism defaults, chosen to be defensible for
a generic user — the 7-day window is the package's own existing staleness constant,
not a drain-cadence opinion.

**Litmus test (kept from the field draft):** if a rule would be wrong for a
*different* Twining user, it's policy — keep it out. `buildTriage` must be correct
and useful for a solo dev with ten decisions and no charter at all.

**Consumer guidance — provisional-at-creation gap:** `twining_decide` cannot create
a decision as provisional (no status input; provisional arises only via
`twining_reconsider` demote or the duplicate-summary auto-demote). A consumer policy
of "record irreversible decisions as provisional-pending-ratification" therefore
needs a decide-then-reconsider two-step today — which, per §3.2 limitation 3, also
posts a companion warning the operator must resolve or dismiss after ratifying.
An additive `status: "provisional"` input on `twining_decide` is flagged as future
work — NOT v1.

**Carve-outs:** no irreversible-list config knob in Twining (the `reversible` flag
IS the mechanism; the policy that sets it lives at record time). No mutation in v1 —
triage is read-only; "act from the queue" is a tempting v2, not built now.

## 10. Testing requirements

Match the repo bar: `npm test` (vitest) green, `npm run build` clean, one feature
per PR (`CONTRIBUTING.md:39`). **All core tests are parameterized over BOTH
backends** per `test/sqlite-backend.test.ts` parity conventions
(`describe.skipIf(!HAS_SQLITE)` guard at `test/sqlite-backend.test.ts:44,90`;
cross-backend parity at `:494`). The clock is injected everywhere.

Required coverage:

1. **Openness-predicate exclusion** — a need/question/warning back-referenced by a
   live entry's `relates_to` is excluded from `open`; verified via the SHARED helper
   (§5.1), not a reimplementation. Order-agnostic: a back-reference from an entry
   with an EARLIER timestamp also resolves (pins the "any other entry" rule).
2. **Resolution corpus** (§3.4) — (a) an in-scope need back-referenced by an
   OUT-OF-SCOPE entry is excluded from `open` on a scoped call (the corpus is
   unfiltered even when membership is scoped); (b) a need resolved by a
   `status`/`finding` entry — types triage never emits — is excluded (the corpus is
   type-unfiltered).
3. **Delegation-expiry boundary** — inclusive: `now === expires_at` → expired
   (injected clock).
4. **All five `DecisionStatus` placements** — provisional→open, active→recent,
   superseded/overridden/archived→nowhere.
5. **The reconsider cross-bucket transition + companion warning** — active decision
   demoted to provisional moves recent→open; AND the auto-posted
   "Reconsideration flagged" warning (§3.2 limitation 3) appears in `open` as an
   ordinary warning, is NOT resolved by a subsequent `twining_promote`, and IS
   drained by a `relates_to` back-reference or dismissal (pins the v1 treatment).
6. **limit/counts interaction + truncation selection** — counts pre-truncation;
   truncation SELECTION asserted as set membership (N oldest open / N newest
   recent by `(timestamp, id)`), separate from the ordering fixture; clamping
   shared via `buildTriage`. Includes the ratify-lane case: an `open` bucket with
   more than `limit` items whose NEWEST item is a provisional irreversible
   decision — assert it is truncated from the array but counted in
   `counts.open.irreversible`.
7. **Section semantics** — absent vs empty arrays distinguishable; counts always
   full regardless of section.
8. **Since cursor** — strict `>`; `max()` with window; invalid `since` ignored and
   not echoed; `generated_at` round-trips as the next `since`; an offset-form
   `since` (e.g. `2026-07-22T10:00:00+02:00`) is epoch-normalized and filters
   correctly against Z-form store timestamps (§3.2).
9. **for_agent** — self-posted items excluded across all four blackboard kinds;
   decisions unfiltered; matches the self-reported `agent_id` convention
   (default `"main"`).
10. **Ordering determinism** — golden fixture per-version, including the
    `(timestamp, id)` tie-break; ordering unchanged under a moved clock
    (poll-stability). The fixture also pins a `detail_preview` boundary case: a
    detail whose RAW length exceeds 200 but whose collapsed length does not →
    complete preview, no `detail_truncated` (§4 collapse-then-truncate rule).
11. **Uninitialized vs initialized-empty** — HTTP zero shape asserted
    field-for-field (including both `irreversible: 0` fields); distinct from an
    initialized store with no items.
12. **Window boundary + clock plumbing** — inclusion/exclusion at the exact cutoff
    with injected `now()`; AND an exact `age_ms` assertion: with injected `now()`,
    an item's `age_ms` equals `injectedNow − item.timestamp` precisely, on both
    backends (an implementation hard-coding `Date.now()` must fail this).
13. **Scope filter** (§4.1) — bidirectional in BOTH directions (a broad-scope
    `src/` entry matches query scope `src/auth/`, and vice versa); a decision
    matching ONLY via `affected_files` is EXCLUDED (the documented `getByScope`
    divergence); `scope: ""` is treated as absent (identical result to omitting
    the param, no echo); blackboard kinds scoped through the same shared
    `scopeMatches`.
14. **Adapter tests** — per-adapter expectations from the §4.1 table: numeric
    type errors zod-rejected at the tool / defaulted at HTTP; `window_ms: -1`
    defaults IDENTICALLY through both adapters (normalization in `buildTriage`);
    empty-string HTTP params treated as absent and not echoed; unknown params
    ignored; pathname-parsed routing works with query strings present; no stdout
    pollution.

## 11. Resolved design points & documented limitations

Nothing here blocks implementation; these record resolutions and known edges.

1. **Naming freeze:** `open`/`recent` are final API names — frozen before golden
   fixtures are written (bucket names are the hardest-to-rename API fields).
   Dashboard labels: "Open items" / "Recent activity".
2. **Findings cut from v1.** The package's own "Related decisions in scope" conflict
   findings are untagged system noise (`src/engine/decisions.ts:336-348` tags only
   `[domain]`); consumers compensate via existing blackboard reads and
   `twining_assemble`. **Reversal path:** kind `finding` slots into `recent` with a
   `by_kind` key, non-breaking under the open kind union. **Prerequisite** for that
   future addition: tag BOTH package post sites with a reserved `"twining:auto"`
   system tag — the `decisions.ts:340-348` conflict-finding site AND the
   `decisions.ts:737-744` reconsider-warning site (§3.2 limitation 3) — plus an
   `include_system` input on `buildTriage` that default-excludes system-tagged
   items. A future bundled change, NOT a v1 mechanism change. Honesty note on
   backfill: old untagged FINDINGS age out of the 7-day `recent` window naturally,
   but old untagged reconsider WARNINGS do not — `open` is unwindowed — so until
   that change ships, the reconsider residue persists and is drained manually
   (§3.2 limitation 3).
3. **Question-archival blind spot.** The archiver's #40 exemption covers
   need/warning only (`archiver.ts:72-74`), so an open question can be age-archived
   and silently exit `open` via archival. File a follow-up issue to extend the
   exemption to questions; explicitly NOT v1 scope — documented limitation.
4. **Archived-resolver blind spot** (inherited from the archiver, same failure
   direction it documents at `archiver.ts:59-60`): a resolver entry archived in an
   earlier run isn't visible to `computeResolvedIds`; this fails toward keeping an
   item open, never toward hiding an open obligation.
5. **Surface promotion/removal test** — see §6.1; the numbers ship as written.
6. **Provisional-at-creation** — see §9 consumer guidance; optional additive
   `twining_decide` status input is future work.
7. **Open-bucket enumeration beyond 200** — see §4.1: `counts.open.total` above the
   clamp is visible but not enumerable through triage surfaces. Future additive
   `offset` or keyset cursor on `(timestamp, id)` is non-breaking future work,
   taken up only on field evidence of >200 steady-state open backlogs.
8. **verify.ts predicate stays type-discriminating** — see §5.1: intentionally
   different semantics, explicitly excluded from the shared-helper refactor; any
   future unification is a separate recorded decision.

---

## Handoff notes

- **Repo:** `/Users/dave/code/twining-mcp` (`main` @ `b64542a` at authoring; public
  `github.com/daveangulo/twining-mcp`). Implementation happens HERE — one feature
  per PR (`CONTRIBUTING.md:39`).
- **Plugin coupling:** the dashboard JS lives in `src/dashboard/public/` and ships
  to plugin users via the committed server bundle —
  `scripts/build-plugin-bundle.mjs:100-106` copies `src/dashboard/public/` into
  `plugin/server/public/`. So the dashboard tab (and any server change) requires a
  bundle rebuild to reach plugin installs; `scripts/bump-plugin-version.sh` performs
  the rebuild and bumps both version files (`bump-plugin-version.sh:59-68`), and CI
  enforces a plugin version bump on any `plugin/` change. Plan the triage PRs
  accordingly: engine + tool + HTTP can land without touching `plugin/`; the
  release that ships the dashboard tab to plugin users needs the bump script run.
- **Suggested sequencing (one feature per PR):** (1) shared-code extraction
  (`resolution.ts`, `scope.ts`) + refactor of the two true near-copies —
  behavior-preserving pure paydown (verify.ts explicitly untouched, §5.1),
  independently shippable; (2) `buildTriage` + types + both-backend tests;
  (3) tool + HTTP adapters; (4) dashboard tab + plugin version bump.
- **Decoupling:** the mechanism reads whatever `reversible`/status flags exist — it
  does not depend on any consumer charter being settled.
- **Record the build:** per this repo's gates, implementation sessions record
  decisions via `twining_record` before committing.
