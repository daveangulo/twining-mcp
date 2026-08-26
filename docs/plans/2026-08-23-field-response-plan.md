# Field-Response Plan — wave-2 verification reply + routing proposals

> **For agentic workers:** this is a triage-and-disposition plan in the pattern of
> `2026-08-17-read-audit-remediation-plan.md`. Execute Workstream A (response batch) with
> superpowers:executing-plans; Workstream B items get fresh per-wave TDD breakdown docs
> per the standing convention before any code is written.

**Goal:** Answer both unanswered inbound field docs — the 2026-08-17 wave-2 verification
reply (DOC A) and TWINING-ROUTING-UPSTREAM.md (DOC B) — and slot every surviving code ask
into the existing release train without forking it.

**Specs (inbound):** `~/Downloads/2026-08-17-twining-wave2-verification.md` (DOC A),
`~/Downloads/TWINING-ROUTING-UPSTREAM.md` (DOC B). Standing roadmap:
`docs/plans/2026-08-17-read-audit-remediation-plan.md` (W2=2.17.0, W3=2.18.0, W4=2.19.0).

**Status:** EXECUTING — Dave's instruction 2026-08-25: "execute plan". Workstream A is
being executed in this session; Workstream B waves get their per-wave breakdown docs in
fresh sessions per §6.4. The §7 rulings were not answered individually, so each was
resolved by the plan's own conservative default and recorded (see §7 annotations):
send = docs committed, the physical send stays Dave's action; GitHub filing = bodies
PREPARED in `2026-08-23-routing-issues-prepared.md`, NOT filed (outward-facing, explicitly
owner-gated); errata = appended (the recommended option, plus a fifth item — the D15
instrument phrasing); P1 neither-store case = the §6.3 conservative default applies until
ruled; W3 bundle = as scoped with the valve.

**Investigation basis:** three ultracode workflows this session (2026-08-22/23):
10-lane investigation (`wf_83d27f25-418`) including live probes of published builds,
6-lane adversarial verification (`wf_64111579-ba3`), 5-lane response-state audit
(`wf_c9fef0bd-708`). ~5.3M subagent tokens, ~1,500 tool calls. Every load-bearing claim
below carries a primary-source cite; claims that survived a dedicated adversarial pass
are marked ✓v. One gap: the lineage code sketch (§B1) got no dedicated verify pass
(agent stalled twice on machine sleep) — its facts were confirmed collaterally by three
other lanes, and the W2 TDD breakdown must re-derive the sketch before implementation.

---

## 1. What the investigation established

### 1.1 D15 — the field's reopening does not survive; our memo's instrument phrasing does not survive either

The resolution chain, every link verified:

1. **Our memo's invariant was ambiguous, and the ambiguity is our fault.** Ship memo :79
   says "every real promote writes one [status post]". Intended reading (true at every
   shipped version): every promote **that flips at least one id** posts. The field's
   operational reading (false): every promote **call touching the id** posts. The status
   post is guarded by `if (result.promoted.length > 0)` — v2.6.0 `decisions.ts:918`,
   v2.13.0 `:1150`, v2.15.0/HEAD `:1219`. A call landing wholly in `already_active`
   writes **no post**. ✓v (measured on 2.6.0/2.13.0/2.15.0/HEAD + source at all four)
2. **Therefore one post is exactly what the two-call story predicts** — promote#1 flips
   and posts (their found post `01KZWPBPQA34EA7WZ5JS6WBJH5`, 04:33:49.802Z); promote#2
   lands in `already_active`, silent. Singularity *confirms* rather than refutes. ✓v
3. **The field's own artifacts force two calls** (or one call with a duplicated id): the
   post's `detail` is built from `result.promoted` (v2.6.0:923, v2.13.0:1155), so the
   posting call had `promoted:[id]`; their original report — as OUR receipt post
   `01M041QS22BAVJ4THBXWBTPFT8` summarized it (a paraphrase, not a quotation — §6.1 assumption 2)
   — said `promoted:[] / already_active:[id]`. If verbatim, `promoted:[]` ≠ `promoted:[id]`
   ⇒ two distinct calls. Their verification doc §3
   silently upgrades the mirror-inferred flip to an observation; it never was one. ✓v
4. **Their third hypothesis (creation-time mirror/db status divergence) is refuted three
   independent ways**: (a) measured — `twining_decide({status:"provisional"})` writes
   `provisional` to db row AND mirror at creation on npx 2.6.0, 2.13.0, 2.15.0
   (serverInfo-proven) and on a worktree-built HEAD; (b) code — db INSERT and mirror
   serialize from the same in-memory object in one call at all versions, and the sync
   layer is byte-identical across the 2.6.0→2.13.0 build race (`git diff` empty on
   record-ingest/sync-manager); (c) **their own found post** — under db-active-since-
   creation the id could never appear in any `result.promoted`, but the post's detail
   names it. ✓v
5. **Ingest cannot manufacture the divergence either**: file-wins copies FILE→DB, and
   every committed mirror state in the 04:19–04:33 window says `provisional`. Their own
   04:19:50Z commit moved HEAD, so the TTL-5s dispatch probe would have converged any
   hypothetical db=active back to provisional in the 14-minute gap. ✓v
6. **New defect found on our side (archaeology lane): promote input is never deduped.**
   `promote(['X','X'])` yields `promoted:['X']` AND `already_active:['X']` in ONE call
   with ONE post — a single-call reproduction of the field's shape (though inconsistent
   with their reported `promoted:[]` if that report is verbatim). Code-confirmed at
   2.6.0/2.13.0/HEAD; executed once on HEAD's file backend (scratch store, 2026-08-23:
   one post, record active; two-bucket return not captured). ✓v (source)
7. **Surviving mechanisms** for their incident: (a) flip-then-silent-repeat — two calls,
   concurrent session/subagent **or an MCP-timeout retry of their own call** (concrete:
   they report chronic MCP-budget blowouts); (b) duplicate-id single call, if their
   `promoted:[]` was a paraphrase. Field-side discriminators exist (§A2).
8. **Residual code-permitted violations of the true invariant** (none fit their evidence
   alone, all worth hardening): post-throw after flip; `housekeeping
   promote_provisionals+execute` is a fully silent promote lane (age-gated: their record
   was 15 min old vs 7-day default, but `stale_days` is caller-settable); the
   promote-time mirror-throw window (db=active/mirror=provisional until next ingest
   self-heals it). ✓v

**Disposition: D15 is answered, not reopened.** We concede the memo's instrument phrasing
(our fault, produced their misreading; note the criterion as written asked for the
housekeeping/unarchive rule-outs only in the post-ABSENT branch, so Doc 2 does not fault
their protocol — the corrected criterion in the memo Errata asks for them); we refute the
reopening on the corrected invariant; we fix the real gaps it exposed (§B2, §B4).

### 1.2 Wave-3 lineage defect — confirmed in source, live at HEAD, W2 is the fix vehicle

`decisions.ts:695-700` emits `superseded_by`/`lineage_head` only when `d.superseded_by`
is present; `resolveLineageHead` (`:774-795`) walks forward only. A one-sided link reads
"retired, nothing replaced it." Their `supersedes_dangling` point is right (fires on
nonexistent targets only). Key design facts: `supersedes` is a single string in the JSON
blob (`types.ts:111`), no index; **housekeeping step 9 `superseded_backfill` already
repairs one-sided links today** (pointer-only, last-wins, status-preserving) — an interim
mitigation the field can run now; the field's damage is **ingest-revert, not the
create/updateStatus crash window** (their pointer existed at 22:52:26Z, later null), so
their ask 3 (transactional two-pointer write) cannot defend their case — the read-path
reverse scan is the layer that survives. Full design in §B1.

### 1.3 D14 — closed by mutual agreement; two corrections owed

Field accepts our mechanism, withdraws their causal story. We owe: (a) the `git log -p`
instruction correction (structurally unusable — pathspec restores create no commit, move
no HEAD, and mid-session ingest triggers only on HEAD movement, so the revert lands at the
NEXT ingest — worse than they said); sites: ship memo :61-62, memo-send :67-69 **and**
:84-89 (expected-deliverables list). (b) DD-8 limitation note: file-wins does not explain
the same-turn readback; jointly unexplained; "we do not bank it either."

### 1.4 twining_verify — runtime half already fixed; token half is W4 with their numbers

8809cff (in 2.16.0, sourced from read-audit S2-C, predates their measurement run) fixes
the runtime; the ~198K-token payload and 120s budget remain until W4. Their figures become
W4 acceptance criteria. The field doesn't know any of this — F2 is unsent.

### 1.5 Routing proposals — verdicts

- **P1 (relative TWINING_PROJECT vs cwd): the field's diagnosis is right; their fix is
  wrong; and our "prior art" is weaker than we thought.** Their sketch
  `resolveWorktreeMain(cwd) ?? gitRootOf(cwd) ?? cwd` fails for subdir-of-worktree
  (resolveWorktreeMain doesn't walk up — `:33-34`); correct composition:
  `root = gitRootOf(cwd) ?? cwd; base = resolveWorktreeMain(root) ?? root`. `gitRootOf`
  doesn't exist and must be written. The server **unconditionally mkdirs the store at
  whatever resolves** (`init.ts:75-81`, seven recursive mkdirs, zero validation) — a
  misresolved relative value fabricates a complete spurious store. All five hook copies
  carry the identical cwd-relative line at the exact lines DOC B cites. ✓v
  **Crucially: decision `01KY68QN70W0RRWCNMWH57WNEW` is a doc-placement decision** (its
  recorded rationale is about settings.json env delivery and shell profiles), *not*
  reasoned prior art for "never redirected" — so P1 is an open design question, and #46's
  maintainer-note premises are genuinely broken (its migration runbook recommends
  committing absolute paths for a multi-machine fleet, which cannot be right on two
  machines). ✓v
- **P2 correction to carry back: the server never ancestor-walks** (`project-root.ts:87-91`;
  only the five hooks walk). The server-side equivalent silent failure is spurious
  CREATION at cwd. The warning still ships — reworded to the real rule. ✓v
- **P3: one merged design with our S1-F** (resolution trace + `created` flag +
  out-of-repo warning + `expect_project` + stable `store_id` in config.yml + echo through
  BOTH `toolResult` and `toolError`). Our own store proves basename identity is broken
  (`config.yml` literally says `project_name: .`); the dashboard already has the fixed
  derivation pattern (`path.basename(path.resolve(...))`, api-routes.ts:364). Two verified
  constraints: `expect_project` cannot *prevent* creation (init runs at process spawn,
  before any tool call — only a `created:true` refusal + eventual lazy-init can); refusal
  must run before `assembleWithStatus` or it pollutes the in-memory assembly-gating state
  (`hasRecentAssembly` feeds decide/verify checkers). ✓v
- **P4 (write policy): design-doc-first as DD-11**, jointly with DD-6 (read-only is the
  degenerate policy) and DD-4 (identity). Facts: 21 of 39 registered tools mutate (not
  their 3, not our lane's 22 — ✓v enumeration); no MCP annotations exist; the right seam
  is an **unconditional** pre-handler registerTool wrapper (the current instrumentation
  wrap is gated on analytics config — a policy layer must not be); the storage
  `assertWritable` layer is the wrong seam (identity-blind, gates internal maintenance,
  throws mid-multi-store op). Gate-2 risk is **commit denial, not deadlock** ✓v:
  `TWINING_DISABLED=true` bypasses every hook, the stop hook self-releases via
  `stop_hook_active`, and the sentinel is advanced by record/post/decide — but a policy
  refusing all three does pin the commit gate closed in-session; the DD-11 design must
  give hooks a refusal protocol. The pending-posts hook path and record-sync ingest enter
  the stores beneath any wrapper — DD-11 must state whether they're governed (ingest
  exemption is mandatory: DD-8 untouched). Re-record our per-call-project decline on the
  field's architectural grounds (durable) with lifecycle/locking as secondary.

### 1.6 Outbound state

F1 (memo caveat) is **overtaken by events** — the memo went out 2026-08-16 without the
planned edits; F2 §10 discharges F1's content. F2 (read-audit response) is committed,
unsent, and **nothing in DOC A contradicts it** — its §1 rescue instructions for the two
still-armed amnesia stores (776/418 stranded records, confirmed re-armed by DOC A §1) are
time-sensitive. DOC A's archive condition requires **acknowledgment only** — the send must
not wait for fixes. 2.16.0's S0 guard covers exactly their 0-byte-db case
(`backend-resolve.ts:55-69`, size+magic-header; regression test pins it), with the
records/-populated variant handled by the factory's tier-matched warning — two layers,
don't blur them. GitHub: tracker dormant since #46 (2026-07-21); the field's EMU account
cannot file; filing is ours to do or decline.

---

## 2. Dispositions (inbound item → disposition → vehicle)

| Inbound item | Disposition | Vehicle |
|---|---|---|
| DOC A §3 D15 reopen | Refuted on corrected invariant; memo phrasing + protocol gap conceded; discriminators requested; input-dedupe + hardening shipped | Doc 2 (§A2) + W2 + W4 |
| DOC A §3 hypothesis 3 | Refuted (measured ×4 builds, code ×3 versions, their own post) | Doc 2 |
| DOC A §4 lineage asks 1–2 | Accepted — reverse-scan fallback + `lineage_unresolved` + counts | W2 / 2.17.0 (§B1) |
| DOC A §4 ask 3 (two-pointer txn) | Accepted at write-time as `createSuperseding` txn, **explicitly non-defensive against ingest reverts** (DD-8); interim: housekeeping `superseded_backfill` today | W2 (own commit + decision record; W4 if W2 crowds — never W3) |
| DOC A §2 D14 corrections | Conceded verbatim; instruction corrected; DD-8 limitation recorded | Doc 2 + memo errata + DD-8 evidence |
| DOC A §6.4 verify cost | Runtime: already fixed (8809cff/2.16.0), tell them + re-measure ask. Tokens: W4, their numbers = acceptance criteria | Doc 2 + W4 re-scope |
| DOC A §1 build-state caveats | S0 guard covers their sibling stores → migrate-now instruction; 3 stale plugin pins noted as future-contradiction source | Doc 2 (+ F2 §1 already) |
| DOC B P1 | Accept diagnosis; corrected composition; dual-base warn phase → flip later, gated on quiet notices | W3 warn-phase (or 2.18.1) + W5 flip |
| DOC B P2 | Accept, reworded to the real rule (creation-at-cwd, not ancestor walk, server-side) | W3 (§B3) |
| DOC B P3 | Accept as merged S1-F bundle: trace + created + warning + `expect_project` + `store_id` + echo (result+error) | W3 (§B3), relief valve 2.18.1 |
| DOC B P4 | Design-doc-first → DD-11 (joint w/ DD-6, DD-4); observability rider (role echo) in W3; enforcement ≥W5; per-call decline re-grounded architecturally | DD-11 + W3 rider |
| DOC B GitHub ask | File all 4 + respond in-lane, both Dave-gated; wave-name slotting comments, no dates | §A4 |

---

## 3. Workstream A — the response batch (docs first, time-sensitive)

One commit + push carrying all of A1–A5, then Dave's go for the send (and separately for
the GitHub filings). Do NOT hold for any code work.

### A1. Send F2 unamended
`docs/field-responses/2026-08-18-read-audit-response.md` ships as-is. Doc 2 carries a
one-line count-drift note (F2 §1.5's 770/766/417 vs DOC A's fresher 776/418).

### A2. Write Doc 2 — `docs/field-responses/2026-08-23-wave2-verification-response.md`
Answers DOC A. Required content (order matters; the corrections lane's earlier D15
retraction draft is **superseded** by §1.1 — do not use its "disposition withdrawn"
framing):
1. **D14**: both memo questions answered; mechanism field-confirmed; closed by mutual
   agreement. Corrections section: the `git log -p` instruction (all three sites),
   with what CAN detect the class — `lifecycle_reverts` (2.14.0 counter, 2.15.0 scoped
   warning; honest bounds: arms only for overridden/superseded downgrades — a reverted
   PROMOTE is deliberately silent; at-ingest-time only), mirror-vs-db comparison
   (retroactive, their method, sanctioned), contemporaneous session evidence. DD-8
   limitation note ("we do not bank it either").
2. **D15**: the §1.1 chain, in their register. Concede the phrasing and that our
   escalation criterion was mis-specified; correct the invariant ("one post per call that
   flips ≥1 id"); show one post = the two-call prediction; three-way refutation of
   hypothesis 3 including the self-refutation via their own post's `detail`; the
   duplicate-id single-call mechanism; the MCP-timeout-retry variant. **Discriminators
   requested from them**: (a) the original promote response payload verbatim — was
   `promoted` truly empty, and did `decision_ids` contain duplicates? (b) its timestamp
   vs 04:33:49.802Z; (c) the found post's `agent_id` (non-'main' names promote#1's
   actor; 'main' is uninformative); (d) session identity/transcript evidence of a retry;
   (e) their housekeeping call history in the window (rule out the silent
   `promote_provisionals` lane — unlikely, age-gated, but their search protocol skipped
   it). What we fix regardless: input dedupe + `duplicate_input` bucket (W2);
   flip-without-post hardening (W4); note `already_active_detail` (≥2.14) makes a repeat
   promote self-diagnosing.
3. **§4 lineage**: confirmed in source with cites; asks 1–2 ship in 2.17.0 with exact
   field names (`superseded_by_inferred`, `lineage_unresolved`, `lineage_inferred_count`,
   `inferred_links`); ask 3 ships as write-time txn with the explicit DD-8 boundary
   statement; **interim mitigation today**: `twining_housekeeping` `superseded_backfill`
   (preview → execute) repairs their trace now, pointer-only.
4. **Verify**: runtime fixed in 2.16.0 (8809cff — the audit's control-store measurement,
   5,465 `affected_files` entries across 764 decisions, was the motivating scale; NOT the
   design store's `specs/` scope — Doc 2 review caught the conflation), re-measure ask; token half W4 with their 198K/120s as acceptance
   criteria; pointer to F2 §8.6.
5. **Build state**: their sibling amnesia stores → migrate-now (F2 §1 is the runbook);
   their 3 stale plugin pins acknowledged as the expected source of contradictory future
   reports; count-drift note; their probe (i)/(ii) results marked field-confirmed for
   CNT/lineage work; verification questions continue (#6+; restate DD-5's unanswered
   error-distribution ask; re-ask #5 on ≥2.16.0 with `server_version`).

### A3. Write Doc 3 — `docs/field-responses/2026-08-23-routing-upstream-response.md`
Answers DOC B (separate doc: different lane/corpus, part goes public). Content: verdict
per proposal (§1.5, §2 table); the two technical corrections to their P1 (no `gitRootOf`
exists; their composition mis-handles subdir-of-worktree — adopt their test list verbatim
plus a fifth: relative env from a subdir of a linked worktree); the P2 rewording (server
creates-at-cwd, never walks); `expect_project` prevention limits (boot-time creation);
DD-11 framing for P4 + our per-call decline re-grounded on their architecture argument;
issue numbers mapped back to their `#(F1)–#(F4)` placeholders once filed; note that
landing P1 retires their `bcs/wfos-chassis#58` ruling (their claim — ask them to confirm).

### A4. GitHub filings (Dave-gated, same class as the send)
File all 4 essentially verbatim; cross-link Issue 1 ↔ #46; maintainer comment on each
slotting it by wave NAME (no dates). Also correct #46's runbook advice (committed
absolute paths) in a comment there.

### A5. Wrapper + errata + records
- Wrapper `docs/field-responses/2026-08-23-response-send.md` (pattern of 08-16): reading
  order F2 → Doc 2 → Doc 3 (field session forwards Doc 3 + issue links to the wfos lane).
- **Memo errata (owner call, recommended)**: dated, clearly post-hoc append to
  `2026-08-13-wave2-ship-memo.md` — four items (F2 §10's three + the git-log-p
  correction) — because retrieval is `curl`/pull from main and DOC A predicts the next
  reader hits the wall. Append-only; never rewrite the body. Severable if Dave declines.
- **Store records at commit time**: D14 field-confirmed decision; D15
  evidence-story-corrected decision (explicitly NOT superseding
  `01M04AD2GSZDDC9NDNHW83F47A` — additive-over-rebucketing stands); DD-8 evidence folds;
  per-call decline re-grounding.
- **Memory edits**: MEMORY.md:16 and `project_wave2_field_defects.md` still assert "both
  field-misdiagnosis" — update to "D14 field-confirmed 2026-08-17; D15 answered with
  corrected evidence story (memo instrument conceded, reopen refuted), discriminators
  pending field."

---

## 4. Workstream B — release-train insertions

Each wave still gets its own TDD breakdown doc before code; the items below are scope
commitments with sizings, not step plans. Waves remain strictly sequential; pre-tag
adversarial review before every tag (8 consecutive majors caught) is unchanged.

### B1. W2 / 2.17.0 riders (read-path honesty — exact thematic fit)
1. **Lineage reverse-scan bundle** (S–M): `IDecisionStore.listSupersessionEdges()`
   (sqlite: `json_extract` scan — cheaper than the existing per-call `getIndex()` full
   scan; files: step-9 pattern; Exporting store delegates); lazy memoized reverse map in
   `why()` — healthy stores pay nothing; new additive fields per §A2.3;
   `resolveLineageHead` reverse fallback **only at retired dead-ends, never past a live
   record**; cycle-safe under the existing visited-set/50-hop guard; last-wins parity
   with housekeeping backfill. Test list T1–T9 as drafted by the design lane (one-sided
   resolves; two-sided byte-identical; mid-chain break; genuinely unresolved; dangling
   unchanged; mutual one-sided cycle; multiple claimants; never-infer-past-live; backend
   parity). No schema bump; expression index noted as the >10k-decisions option.
   *Caveat: sketch had no dedicated verify pass — TDD breakdown re-derives.*
2. **`createSuperseding` two-pointer txn** (M, own commit + decision record): sqlite one
   IMMEDIATE txn; files one lock section with documented partial-state recovery (S0
   repair salvages); Exporting wrapper exports BOTH mirror files (the real win — shrinks
   the mirror-divergence window); DD-8 boundary stated verbatim in the method comment.
   Defer to W4 if W2 crowds — never W3.
3. **Promote input dedupe** (S): order-preserving Set at the top of `promote` +
   `duplicate_input` bucket so one call can never emit an id in two buckets. Closes the
   §1.1(6) defect.
4. One-sided-link count in housekeeping preview (S) — shares the reverse-scan machinery.

### B2. W3 / 2.18.0 — the "store identity + routing honesty" bundle
Expands the S1-F line item (all additive; the scope matcher stays the release's only
default-behavior change, preserving W3's bisection property):
1. Resolver trace: `resolveProjectRootTraced` → `{root, rule: argv|env|worktree-redirect|
   cwd-default, candidate}`; `gitRootOf` helper (pure-fs walk-up, .git dir-or-file). (S)
2. `created` flag threaded through `ensureInitialized` → ServerIdentity → status
   `resolution:{...}` block. (S)
3. Out-of-repo warning on status + assemble when `rule=cwd-default` and resolved root is
   outside (or without) the cwd's git repo; declared (argv/env) and worktree-redirect
   exempt; created-store addendum. (S–M)
4. `store_id` ULID stamped in config.yml at creation; migration = append-only line on
   next boot, fail-open; logical-store identity (committed, clone-shared) recorded as
   deliberate; boot-write coupled to W4 S4-14(a). (S–M)
5. `expect_project` on assemble: pass on `store_id` or `basename(path.resolve(root))`
   match; refuse `STORE_MISMATCH` naming both sides + rule + fix; **also refuse on
   `created:true` regardless of name match**; check ordered before `assembleWithStatus`
   (zero side effects incl. assembly-gating state). (M)
6. S1-F echo done right: `setStoreEcho({name,id})`, appended by **both** `toolResult`
   AND `toolError` (`<basename>#<id6>`); reset in closeDb; byte-cost pinned. (S)
7. Riders: `TWINING_ROLE` observability echo (no enforcement) (S); **P1 warn-phase** —
   dual-base disagreement notice per the field's own migration design, identical
   candidate policy in TS and all five hooks (equal→no-op; exactly-one-has-store→bind it
   + notice; both→bind cwd + loud ambiguity warning; neither→**Dave ruling needed**,
   recommendation: bind repo-root candidate since cwd-side creation is the known spurious
   mode). (S–M + 5×bash + plugin bump)

**Capacity valve (pre-agreed, not improvised):** if pre-tag review load is too heavy,
bump items 3, 5, and 7 to a 2.18.1 point release; items 4+6 ship together in W3 in every
scenario (echoing a bare basename re-opens the conceded ambiguity); never the reverse
order.

### B3. W4 / 2.19.0 amendments
- VER-unbounded → **default-bounded** verify (default summary detail + max_items,
  truncation disclosed via W4's shared shape, knobs to raise); acceptance criteria =
  the field's numbers (no ~198K default payloads; well under the 120s budget at
  5,465-affected-entry scale); ships WITH its escape hatch per W4's own gate rule.
  Schedule-or-retire VER-git-spawn on field re-measurement.
- **Flip-without-post hardening**: promote's status post wrapped so a real flip always
  leaves a post or an explicit `post_failed` marker; same treatment for the promote-time
  mirror-throw window. (S–M; write-path error semantics — pre-tag review flag)

### B4. W5 / 2.20.0 (new) — "routing + resolver"
P1 default flip (corrected composition; test/project-root.test.ts:32 flips to new spec +
the field's four tests + the fifth; all five hooks lockstep + plugin bump), gated on the
W3 warn-phase showing cwd-relative reliance is absent (measurement path: field reports —
open question §6.3). Candidates: lazy store creation (the only true prevention for
spurious stores); DD-11 enforcement if adopted.

### B5. Design decisions
- **DD-11 (new)**: store-side write policy. Design doc must answer the ten questions the
  policy lane enumerated (seam = unconditional pre-handler wrapper; mutation
  classification via MCP `readOnlyHint` annotations on all 39 registrations + argument
  predicates for housekeeping/prune_graph/verify; Gate-2 refusal protocol — commit-denial
  is the real failure mode; pending-queue and ingest treatment with ingest exempt by
  DD-8; role namespace disjointness from AgentRecord.role and agent_id; free-form roles
  with normalization; fail-closed malformed policy with named repair; one committed
  identity+policy file question shared with B2.4; misconfiguration-guard trust model).
- **DD-8**: fold DOC A evidence (accepted record-level revert; one-sided-link residue;
  unbanked same-turn readback; the promote-time mirror-throw self-heal dependency).
- **Per-call project decline**: re-record with the field's architectural grounds primary.
- **P1**: new decision (NOT a supersession of `01KY68QN70W0RRWCNMWH57WNEW`, which is
  doc-placement only ✓v); supersedes the `project-root.ts:16-18` header comment and
  #46's maintainer-note premises, both shown wrong.

---

## 5. Sequencing

1. **Now**: Dave reviews this plan. Rulings needed: §7.
2. **A-batch** (docs 2–3, wrapper, errata, records, memory) — drafted, committed, pushed;
   Dave's go for the send; separately his go for the GitHub filings.
3. **W2 breakdown → implement → pre-tag review → 2.17.0** (existing W2 scope + B1).
   F3 delta note to field.
4. **W3** (+B2, capacity valve pre-agreed) → **W4** (+B3) → **W5** (B4).
5. DD-11 design session post-W4 (or earlier if field routing pain escalates — their own
   ordering says "implemented last or never," so no).

---

## 6. Plan discipline

### 6.1 Assumptions (unconfirmed by Dave)
1. The send mechanics remain "commit to main, Dave pastes the wrapper prompt on the field
   machine" (pattern of 08-16). If delivery changed, A5 adjusts, nothing else.
2. The field's receipt-post quote of their original D15 report (`promoted:[]`) is
   verbatim, not paraphrase. If paraphrase, the duplicate-id single-call mechanism gains
   weight — the Doc 2 asks are designed to discriminate either way, so the response is
   robust to this assumption failing.
3. The read-audit waves (W2–W4) remain the release train of record; no other work is
   queued ahead of them.
4. DOC B's wfos lane is reachable via the design-lane field session (we don't know its
   path); the wrapper's forward-indirection is acceptable.
5. Plugin 1.34.0 remains the shipped plugin; all hook edits ride the next plugin bump
   with both version files + bundle rebuild (standing coupling).

### 6.2 What we don't know that would change the approach
- The field-side D15 discriminators (§A2.2). They select among surviving mechanisms but
  do NOT change our disposition or any code plan — every fix in §B ships regardless.
- Whether 2.16.0's verify memoization suffices at their distinct-file count (re-measure
  ask; determines W4 VER-git-spawn's fate).
- How often cwd-default-outside-repo fires in their fleet (the W3 trace makes it
  measurable; calibrates `TWINING_STRICT_REPO_BOUNDARY` and the P1 flip gate).

### 6.3 Decision points we'll hit without Dave, with criteria
- **W2 crowding**: if the W2 breakdown exceeds the wave's review budget, `createSuperseding`
  moves to W4 (criterion: the breakdown's item count vs W1's shipped precedent; the
  reverse-scan bundle never moves — it is the field-facing commitment).
- **W3 capacity valve**: trigger = pre-tag review flags digestibility; action = bump
  B2 items 3/5/7 to 2.18.1 (pre-agreed here).
- **Doc-2 wording pressure to name a root cause**: resist; the doc ships "two surviving
  mechanisms + discriminators," never a single unproven cause (this class already cost
  one retraction cycle).
- **P1 neither-store-exists migration case**: needs Dave's one-line ruling (§7); if
  unruled at implementation time, conservative default = preserve cwd semantics until the
  general flip, recorded.

### 6.4 Failure modes & recovery
- *Machine-sleep killed agents mid-investigation* (happened 5×): all conclusions were
  re-derived on resume from journal cache; no partial results were trusted. Recovery
  path for execution: per-wave breakdowns are fresh sessions.
- *Doc 2 over-concedes or over-claims*: mitigated by the §A2 content spec being written
  from verified findings only; pre-send review by Dave is the gate.
- *W3 bundle destabilizes the matcher release*: valve in §6.3; scope.ts one-file revert
  path stands.
- *Errata append misread as history rewriting*: dated block + referenced from Doc 2;
  severable.
- *A field report from a stale-pin scope contradicts Doc 2*: pre-empted in Doc 2 §5
  (ask for the plugin pin first — their own §1 advice).

### 6.5 Strongest alternative, and why not
**Consolidate everything into one omnibus response doc + one mega-release.** Rejected:
the plan of record already rejected mega-releases (review cannot digest a 40-item diff;
7-of-7 pre-tag reviews caught majors); separate docs per inbound thread is the lane
convention with different audiences and archive conditions; and the send must not wait
on code — DOC A's archive condition needs acknowledgment only, and the amnesia stores
are still armed. A second alternative — treat D15 as reopened and investigate before
responding — was executed *within this planning session instead* (three workflows), which
is what converted the response from a concession into a correction.

## 7. Rulings requested from Dave
1. Go/no-go: A-batch send (F2 + Doc 2 + Doc 3 + wrapper).
   *2026-08-25: batch drafted, reviewed, committed. The send itself (pasting the wrapper
   prompt on the field machine) remains Dave's physical action — no ruling substituted.*
2. Go/no-go: file the 4 GitHub issues (+ #46 correction comment).
   *2026-08-25: NOT filed. Bodies + maintainer comments + `gh` commands prepared in
   `docs/field-responses/2026-08-23-routing-issues-prepared.md`. Outward-facing and
   explicitly owner-gated; "execute plan" was not read as a filing go.*
3. Memo errata append on the shipped ship-memo file: yes (recommended) / no.
   *2026-08-25: appended (recommended option), with a fifth item added — the D15 instrument
   phrasing — because it is the batch's headline correction and the memo is what the field
   re-reads. A matching two-line errata was appended to the 2026-08-16 wrapper, whose
   session prompt repeats the unusable instruction (cheap, append-only, decision recorded).*
4. P1 neither-store-exists case: bind repo-root candidate immediately (recommended) or
   preserve cwd semantics until the flip.
   *2026-08-25: unruled → §6.3 conservative default stands (preserve cwd semantics until
   the general flip) and Doc 3 tells the field the recommendation is pending an owner ruling.
   Must be ruled before the W3 breakdown.*
5. W3 bundle as scoped (with the pre-agreed 2.18.1 valve), or split now.
   *2026-08-25: unruled → as scoped, valve pre-agreed. Revisit at the W3 breakdown.*
