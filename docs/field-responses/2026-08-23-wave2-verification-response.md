# Response: wave-2 verification of 2026-08-17 — D14 closed, D15 answered with a corrected evidence story, the lineage defect confirmed

**STATUS: LIVE — archive once you have read it and returned the D15 discriminators (§2.6)
or stated which of them cannot be recovered.** Authored 2026-08-25 by the Twining project in
response to `2026-08-17-twining-wave2-verification.md` (your HEAD `e42ff136`, run
2026-08-18T06:24Z, server 2.15.0 / plugin 1.33.0). Every `file:line` below is HEAD
`0f65ef0` = 2.16.0 / plugin 1.34.0 unless a version is named; lines for 2.6.0 and 2.13.0
were read from the published tarballs, 2.15.0 from its tag. Claims marked *measured* were
executed against scratch stores on npx-fetched 2.6.0, 2.13.0, 2.15.0 and a worktree-built
HEAD, each run's `serverInfo` checked before the result was trusted.

**How to read this:** §0 is the verdict table against your §0. §1 closes D14 and carries the
two corrections we owe you. §2 is D15 — the longest section, because your reopening rests on
a sentence of ours that was ambiguous, and the answer has to rebuild the evidence chain from
the code rather than from the sentence. §3 confirms the lineage defect and says what ships
and what you can run today. §4 is `twining_verify`. §5 is build state and the continuing
verification questions. §6 is what changed on our side.

Wave names: W2 = 2.17.0, W4 = 2.19.0 (the release train in F2 §3); DD-n are the named design
decisions in F2 §9. Your reopening does not survive, but it found four things on our side —
an ambiguous invariant, a mis-specified escalation criterion, a promote that never dedupes
its input, and a silent housekeeping promote lane — and your D14 archaeology is the model
of withdrawing a story on evidence. Both are why this doc is long.

The read-audit response (`2026-08-18-read-audit-response.md`, "F2") ships in the same send,
unamended, and is read first — its §1 rescue for your two sibling stores is time-sensitive
and your §1 confirmed they are still armed.

---

## 0. Verdicts against your headline table

| Your item | Your result | Our verdict |
|---|---|---|
| Upgrade | Already satisfied | Confirmed; 2.16.0 / 1.34.0 is now the cumulative target (F2 §1.4 has the npx-rung caveat) |
| Probe (i) nonsense query | Behaves as predicted | Field-confirmed; your "read the count, never the rows" rule is the right posture on ≥2.9.0 |
| Probe (ii) `why` on superseded scope | Works; new wave-3 defect | Field-confirmed; the defect is **confirmed in source and live at HEAD** (§3) |
| D14 (a) id match / twin | Ids matched, no twin | Accepted; D14 closed by mutual agreement (§1) |
| D14 (b) reverting commit | No commit; `git log -p` cannot answer | **Conceded in full** — the instruction was structurally unusable; its consequence reaches one step further than your §2 draws (§1.1) |
| D15 | Reopens: one post, disposition requires two | **Does not reopen.** One post is exactly what two calls predict; the memo's instrument sentence was ambiguous and that is our fault; your third hypothesis is refuted three ways, one of them by your own found post (§2) |
| `twining_verify` priced out (your §6, item 4) | Standing ask | Runtime half already fixed in 2.16.0; token half is W4 with your numbers as acceptance criteria (§4) |

---

## 1. D14 — closed, with two corrections we owe you

Both memo questions are answered: the ids matched, no twin exists, and your archaeology of the
workaround record (`01KZW2Q3WHD7QN2GHKZEAP3BMW` recorded 22:50:32Z with `supersedes:
01KZVRHRTP519Q93NC961RS1FR`, target verified `superseded` first-party with the status post at 22:52:26Z recording the
act, target today `overridden` with `superseded_by: null` while the neighbouring supersession still holds)
is the discriminating fact: a record-level revert, not a verb-level no-op. You accept the
mechanism and withdraw the causal story; we accept the withdrawal. D14 is closed.

### 1.1 The `git log -p` instruction: conceded, with a consequence your §2 does not draw

The memo said "`git log -p` on that mirror file will show the reverting commit" (ship memo
:61-62); the send wrapper repeated it in the session prompt (`2026-08-16-memo-send.md` :68-69)
and in its expected-deliverables paragraph (:84-85). All three are wrong for the reason you
gave — `git checkout -- <pathspec>` and `git restore` create no commit and write no reflog
entry — and there is a consequence your §2 names the premise for but does not draw:
mid-session ingest is a
TTL-gated probe on tool dispatch that re-ingests only when HEAD has **moved**
(`src/storage/sync/sync-manager.ts:64-91` — `if (sha === this.lastHeadSha) return;`). A
pathspec restore moves no HEAD, so the revert does not land at the restore; it lands at the
next ingest after a *later* HEAD move (a commit, a branch switch, a pull). The reverting
operation and the visible revert are therefore separated in time as well as invisible to
`git log`. Your "`git add .twining/` plus a restore, three times in one session, against a target
whose committed bytes read `provisional`" is the precondition, met.

What CAN see this class, with honest bounds:

- **`lifecycle_reverts`** — 2.14.0 counts, 2.15.0 posts a blackboard WARNING naming the
  reverted ids (one per distinct decision scope, deduplicated) so it reaches the agent via
  assemble (`src/storage/sync/record-ingest.ts:63-70`, `:269-275`, `:300-332`). Bounds: it
  arms only when the db-side status is `overridden` or `superseded` and the file downgrades
  it (`REVERT_WATCHED`, `:70`) — a reverted **promote** (db `active`, file `provisional`) is
  deliberately silent, because `active → provisional` is also what a sanctioned reconsider
  arriving via git looks like; and it fires at ingest time, i.e. after the next HEAD move,
  never at the restore.
- **Mirror-vs-db comparison** of the record — the method you used, retroactive, sanctioned;
  from 2.16.0 `twining_status.backend`/`backend_reason` tells you which db you are comparing.
- **Contemporaneous session evidence** of the add/restore — your commit message was exactly
  this, and it is the only instrument that sees the operation itself.

The ship memo now ends in a dated Errata block (item 1) saying the above; the 2026-08-16
wrapper carries a matching two-line errata. Neither body was rewritten.

### 1.2 The same-turn readback: jointly unexplained, and we do not bank it either

You are right that file-wins ingest explains the loss of the supersession cleanly and does
**not** obviously explain an override → `why` readback with no git command and no HEAD move
between. We have no mechanism for that half. It is recorded against our file-wins design
decision (DD-8) as an open limitation — "field-confirmed record-level revert; same-turn
readback unexplained by the mechanism" — so nobody on our side cites D14 as fully explained.
Not reopening D14 on it, per your own call; the practical guidance stands (override is the
sanctioned path; verify the readback; from 2.14.0 `twining_override` returns post-state and
errors `PERSIST_FAILED` on a lost write).

---

## 2. D15 — the reopening does not survive; our instrument sentence does not survive either

### 2.1 The sentence we wrote, and the two readings of it

Ship memo :78: *"every real promote writes one [status post]."* Two readings:

- **What the code does** (true at every shipped version): every promote call that **flips at
  least one id** writes one post. The post is guarded by `if (result.promoted.length > 0)` —
  `src/engine/decisions.ts:918` at 2.6.0, `:1150` at 2.13.0, `:1219` at 2.15.0 and HEAD.
- **What you reasonably read** (false): every promote call that **touches the id** writes
  one post.

A call whose ids all land in `already_active` writes **no post**, at 2.6.0, 2.13.0, 2.15.0
and HEAD (*measured* on all four; source at all four). The ambiguity is ours, it produced
your inference, and the escalation criterion we gave you ("if it does not exist AND no
housekeeping/unarchive/merge-ingest trace fits, escalate") was mis-specified in the same
way: it treated post-presence as evidence of the second call, when the second call is
precisely the one that leaves nothing. Conceded, in the memo's Errata block (item 2).

### 2.2 One post is exactly what the two-call story predicts

Under the corrected reading: promote #1 flips `provisional → active` and writes the post you
found (`01KZWPBPQA34EA7WZ5JS6WBJH5`, 04:33:49.802Z); promote #2 finds the id `active`,
reports `already_active`, writes nothing. Singularity of the post is the *prediction* of
the disposition, not its refutation. Your §3 branch "the single promote both flipped and
reported `already_active`" is the one the code excludes for a single occurrence of the id in
the request — buckets are computed per id from the row's status at the moment it is read
(`:1186-1198` vs `:1205-1215`), so one occurrence cannot land in both; the one exception is
our own defect in §2.5(b), a duplicated id in `decision_ids` — and your other branch, "a real promote wrote no post", is the corrected invariant
working as designed for the no-op call, not a defect.

### 2.3 Your own artifacts require two calls (or one call with a duplicated id)

The post's `detail` is built from `result.promoted` — `` `Decision IDs: ${result.promoted.join(", ")}` ``
(`:926` at 2.6.0, `:1158` at 2.13.0, `:1227` at HEAD). The post names the id, so the call
that wrote it had `promoted: [01KZWNFGNGNVC4BTZXMEPH1J8P]`. Your original D15 report, as we
summarized it on receipt, said the call returned `promoted: []` with the id under
`already_active`. If that `[]` was verbatim, `promoted: []` ≠ `promoted: [id]` — two distinct
responses, hence two distinct calls. If it was a paraphrase of "the id I asked about was not
in `promoted`", §2.5(b) is live instead. That is discriminator (a). Your §3 states the flip as if observed
("the single promote both flipped … AND reported"); in your original report the flip was
*inferred* from the mirror (provisional in the pre-promote commit, active in the
post-promote commit), never observed in a response. The inference was sound; the upgrade
to an observation is what does not hold.

### 2.4 Your third hypothesis is refuted three independent ways

*A creation-time mirror/db divergence: `twining_decide({status: "provisional"})` writes
`provisional` to the mirror but `active` to the db.*

1. **Measured.** On npx 2.6.0, 2.13.0, 2.15.0 (serverInfo-proven) and a worktree-built
   HEAD, creating a provisional and reading the db row and the mirror file before any
   promote gives `provisional` in both, every time. Scratch stores only — and your offer to
   run it is discharged: do not run it on your store; the ratify-queue cost you named is
   real and the result is in hand at four versions.
2. **Code.** At every one of those versions the db INSERT and the mirror file serialize the
   same in-memory decision object inside one call; there is no second status computation.
   And the sync layer that could have re-written either side is byte-identical across the
   2.6.0 → 2.13.0 build race you were living in — `git diff v2.6.0 v2.13.0 --
   src/storage/sync/record-ingest.ts src/storage/sync/sync-manager.ts` is empty — so the
   build that served a given session cannot have changed what creation persisted.
3. **Your own found post.** Under db-`active`-since-creation, the id could never appear in
   any `result.promoted` — the promote would bucket it `already_active` on first sight and
   write no post. The post exists and its `detail` names the id. The hypothesis is
   self-refuting against the artifact that motivated it.

Ingest cannot manufacture the divergence either: file-wins copies FILE → DB, every committed
mirror state of the record in the 04:19–04:33 window says `provisional`, and your own
04:19:50Z commit moved HEAD, so the dispatch probe would have converged any hypothetical
db-`active` back to `provisional` in the fourteen minutes before the post — the promote
dispatch itself runs the probe, the TTL is 5s against a 14-minute gap, and a server started
after the commit ingests at boot. There is no window in which db-`active` could survive to be
read by a promote; the one assumption is that the promoting server was bound to that
checkout's `.twining/`, which your shared-store setup guarantees.

### 2.5 What survives — two mechanisms, and a real defect of ours found on the way

**(a) Flip, then a silent repeat.** Two calls: a concurrent session or subagent in your
shared-store cmux setup, **or an MCP-timeout retry of your own call** — you report chronic
MCP-budget blowouts, and a client that times out and re-issues `twining_promote` produces
exactly: first call flips and posts (possibly after the client stopped listening), second
call returns `promoted: [] / already_active: [id]` to the caller who is listening. This
variant needs no second human and no second session.

**(b) One call with a duplicated id — a defect on our side.** `promote` iterates
`decisionIds` as given (`:1179`) with no dedupe: `promote(['X', 'X'])` flips `X` on the
first iteration and finds it `active` on the second, returning `promoted: ['X']` **and**
`already_active: ['X']` from one call, with one post. Code-confirmed at 2.6.0, 2.13.0 and
HEAD, and executed once on HEAD's file backend in a scratch store (one post, record active);
the sqlite path and the two-bucket return value are code-inferred, not yet captured. It reproduces the *shape* you saw in a single call — but it is
inconsistent with your report if `promoted: []` was verbatim rather than a paraphrase of
"the id I asked about was not in `promoted`". Which is why we ask (§2.6 a).

**Residual ways the corrected invariant can still be violated in code** — none fits your
evidence on its own, all worth hardening: the post is written after the flip, so a throw
between them leaves a flip with no post (W4 hardening); `twining_housekeeping({promote_provisionals: true, execute: true})`
promotes with **no post at all** (`src/engine/housekeeping.ts:317-330` — it stamps
`promoted_by: "housekeeping-promote_provisionals"` and nothing else) — age-gated to
`stale_days` (default 7; your record was fifteen minutes old) but `stale_days` is
caller-settable; and the promote-time mirror write can throw after the db write, leaving
db-`active`/mirror-`provisional` until the next ingest resolves it file-wins — by silently
reverting the promote, which `lifecycle_reverts` does not arm for (§1.1).

### 2.6 Discriminators — what we need from your store (verification question #6)

Everything below selects among the surviving mechanisms; **none of it changes what we
ship** (§2.7). Unrecoverable is a valid answer for any item.

- **(a)** The original promote call's response payload **verbatim**: was `promoted` truly
  `[]`, and did the request's `decision_ids` contain `01KZWNFGNGNVC4BTZXMEPH1J8P` more than
  once? (`[]` + no duplicate ⇒ two calls; a duplicate ⇒ our dedupe defect, one call.)
- **(b)** That call's timestamp relative to the post's 04:33:49.802Z (before it ⇒ your call
  was promote #1 and something else answered you; after it ⇒ your call was promote #2).
- **(c)** The found post's `agent_id`. The post carries `promotedBy ?? "main"` (`:1229`) —
  a non-`main` name identifies promote #1's actor outright; `main` is uninformative.
- **(d)** Session/transcript evidence of an MCP-timeout retry of the promote: a client-side
  timeout logged against `twining_promote`, or two `twining_promote` entries in
  `.twining/metrics.jsonl` inside the 04:19–04:38Z window (metrics carry tool name,
  timestamp and `agent_id`, not the decision id — so the second entry's `agent_id` and
  timing are the evidence, and `success: false` on one of them marks a timed-out call).
- **(e)** Every `twining_housekeeping` call in the 04:19–04:38Z window and whether any
  passed `promote_provisionals: true` with `execute: true` — the one silent promote lane.
  Unlikely (age gate), and the memo's criterion did not ask for it in the post-present
  branch — it is the rule-out the corrected criterion (memo Errata item 2) now asks for.

### 2.7 What we fix regardless

- **W2 (2.17.0)**: `promote` dedupes its input (order-preserving) and reports duplicates in a
  new `duplicate_input` bucket, so one call can never emit an id in two buckets. Closes §2.5(b).
- **W4 (2.19.0)**: flip-without-post hardening — a real flip always leaves a post or an
  explicit `post_failed` marker in the result; same treatment for the promote-time mirror
  throw.
- **Already shipped (2.14.0)**: `already_active_detail` carries `promoted_by`/`promoted_at`
  for each `already_active` id, so a repeat promote is self-diagnosing — "already promoted
  by X at T" versus "active since creation". Your post-promote mirror showing `promoted_by:
  null` is expected: your promote ran on a build before 2.14.0 stamped it.

**Disposition: D15 is answered, not reopened.** We concede the memo's phrasing and the
mis-specified criterion; we refute the reopening on the corrected invariant; we fix the
real gaps the reopening exposed. Your "additive over rebucketing" outcome from the original
disposition stands unchanged — a call that changed nothing must not claim it ratified.

---

## 3. Wave-3: one-sided supersession links defeat `lineage` — confirmed, W2 fixes it

### 3.1 Confirmed in source

`twining_why` emits `superseded_by` and `lineage_head` only when the record's own
`superseded_by` is present (`src/engine/decisions.ts:695-700`), and `resolveLineageHead`
walks `superseded_by` forward only (`:774-795`, visited-set + 50-hop cap). A record whose
successor's `supersedes` points at it but whose own back-pointer is gone reads as "retired,
nothing replaced it" — your trace, exactly. `supersedes_dangling` cannot see it (it fires on
a *nonexistent* target). `supersedes` is a single optional string on the record
(`src/utils/types.ts:111`); there is no reverse index, which is why nothing reports the
asymmetry today. Your framing — this defect and D14's revert are one bug seen from its two
ends — is right about the residue: the one-sided link is what an ingest revert of the
target's back-pointer leaves behind, while the successor's forward pointer, written on a
different record, survives.

### 3.2 What ships — W2 / 2.17.0

Asks 1 and 2, accepted as specified, with these field names so your tooling can pin them:

- `lineage` falls back to a **reverse scan on `supersedes`** when `superseded_by` is absent,
  and marks the result `superseded_by_inferred: true` on the row (a `superseded_by` you can
  trust as written is not the same as one we reconstructed).
- Rows where neither pointer resolves carry `lineage_unresolved: true`.
- The response carries `lineage_inferred_count` and `inferred_links` (the target → successor
  pairs the reverse scan supplied), so the asymmetry is a number, not an absent field.
- The reverse fallback runs **only at retired dead-ends, never past a live record** — an
  active decision with a `supersedes` claimant is a conflict to report, not a chain to walk.
  Last-wins parity with the housekeeping backfill when several records claim the same
  target.

Ask 3 (transactional two-pointer write) ships in W2 as `createSuperseding` — one sqlite
transaction (one lock section on the files backend) writing the new record, the target's
status flip and both pointers, with the mirror exporting both files — **with an explicit
boundary stated in the code**: it shrinks the create-time window, and it does nothing
against an ingest revert, which is what ate your pointer (recorded at 22:52:26Z, null later).
File-wins precedence is our named design decision DD-8 and is not changed by this. If W2's
review load forces a split, `createSuperseding` moves to W4; the reverse-scan bundle does not
move — it is the field-facing commitment.

### 3.3 What you can run today

`twining_housekeeping` step 9, `superseded_backfill`
(`src/engine/housekeeping.ts:503-545`), already repairs one-sided links: it scans records
carrying `supersedes`, and where the target exists and lacks `superseded_by` it writes the
pointer — status-preserving (`updateStatus(targetId, target.status, …)`, `:533-535`), last
claimant wins, dangling targets counted and skipped. Preview: `twining_housekeeping({})` and
read `superseded_backfill.items` (expect `{ id: 01KZVRHRTP519Q93NC961RS1FR, superseded_by:
01KZW2Q3WHD7QN2GHKZEAP3BMW }`); apply: `twining_housekeeping({execute: true})` with
`promote_provisionals` and `archive` left unset (both default false — your ratify queue is
untouched). `execute: true` is not backfill-only: it also rotates `metrics.jsonl` entries
older than 30 days, dismisses duplicate blackboard entries, prunes relation-less graph
entities and checkpoints the WAL — read the preview's `metrics_rotated` / `deduplicated` /
`graph_pruned` counts first, and **snapshot `metrics.jsonl` before executing** if you have not
yet extracted F2 #3 (§5) from it. Then **commit `.twining/` immediately**, because the repair is a mirror write
like the one that was reverted. After that, `twining_why({scope: "specs/registry-service/",
lineage: true})` resolves the row. Your CLAUDE.md hazard note for this hole can be retired
when 2.17.0 reaches you; until then the backfill is the workaround.

---

## 4. `twining_verify`

**The runtime half is already fixed.** 2.16.0 commit `8809cff` (sourced from the read-audit's
S2-C, which predates your measurement run) hoists the scope population out of the
per-stale-file loop and memoizes the `git log` lookup per distinct file — the superlinear
loop-invariant `getByScope` call and the linear per-file spawn your S2-C diagnosis
identified, and the two candidates for your 7.5s → 330s → 494s growth. Your `specs/` run
(1,747 decisions checked, 1,721 stale entries across 273 distinct files, ~198K tokens past the
120s budget) and the audit's control-store measurement (5,465 `affected_files` entries across
764 decisions) were the motivating scale; memoized per distinct file, your `specs/` run now
spawns at most 273 `git log`s — at the ~45 ms you measured, seconds. **Re-measure once on ≥2.16.0** with the same call
(`twining_verify({scope: "specs/"})`) and report wall-clock, payload tokens and
`server_version` (verification question #7). Seconds-class runtime confirms the fix at your
scale; anything else is a W4 input.

**The token half is not fixed.** A ~198K-token payload against a 120s MCP budget is W4
(2.19.0): verify becomes default-bounded (summary detail + `max_items`, truncation disclosed
in W4's shared disclosure shape, knobs to raise), with **your numbers as the acceptance
criteria** — no ~198K default payloads, well under the budget at your scale — and the
unbounded form kept behind an explicit escape hatch. Until then F2 §8.6's caveat stands:
verify cannot see populated-but-untouched records (structural until DD-1, F2 §9: the
content-hash drift signal).

---

## 5. Build state and the continuing verification questions

- **Your sibling amnesia stores are still armed** — your §1 confirms them (776 and 418 by
  its count; see the drift note below) behind 0-byte `twining.db` files. F2 §1 is the runbook and needs no upgrade
  (`npx twining-mcp@latest migrate`, or delete the 0-byte db). 2.16.0's resolver ignores a
  db that is under the SQLite header length or lacks the magic bytes
  (`src/storage/backend-resolve.ts:55-69`), so the class cannot recur after the upgrade —
  but the guard does not import what is already stranded. Count drift: your §1 repeats
  776/418, which your own audit corrected to 775/417 (file counts that had included
  `index.json`). Expected `twining_status.active_decisions` after migrate: 770 for
  `agentic-platform-code` (775 files = 770 active + 5 superseded; the files backend
  under-reports 766 via the 4-entry index desync) and 417 for `agentic-platform-oss` —
  F2 §1.5 / F2 #4.
- **Your three stale project-scope plugin pins** (1.24.1 / 1.26.0 / 1.30.0) are acknowledged
  as the expected source of any future report that contradicts this doc; we will ask for
  the pin first, per your own §1 advice. From 2.16.0 `twining_status` returns
  `server_version` (`src/tools/lifecycle-tools.ts:221`); its absence means <2.16.0.
- **Probe (i)/(ii)**: marked field-confirmed on our side for the count-semantics and lineage
  work; (ii)'s hole is §3.
- **Verification questions** (numbering continues from the memo and F2):
  - **#3** (F2, still open): the `twining_record` `error_code` distribution from your
    `metrics.jsonl`, split before/after your 1.24.0-era sessions — DD-5 (F2 §9: the record
    `INVALID_INPUT` residual) is blocked on it.
  - **#5** (F2): re-run the read audit's §3 sequence (steps 1–3, one warning-dense scope) on
    ≥2.16.0 with `server_version` stated.
  - **#6** (new): the D15 discriminators, §2.6 (a)–(e).
  - **#7** (new): the `twining_verify` re-measurement, §4.
  - **#8** (new): the `superseded_backfill` preview/execute counts and the post-commit
    `twining_why … lineage: true` row for `01KZVRHRTP519Q93NC961RS1FR`, §3.3.

---

## 6. What changed on our side

- Store records: D14 closed as field-confirmed; D15 recorded as answered-with-corrected-
  evidence-story (not superseding the original additive-over-rebucketing disposition);
  DD-8 evidence folded (record-level revert accepted; one-sided-link residue; same-turn
  readback unbanked; promote-time mirror-throw dependency).
- The ship memo now ends in a dated Errata block (five items: the `git log -p` instruction,
  the D15 instrument sentence, and the three corrections F2 §10 already listed); the
  2026-08-16 send wrapper carries a matching errata. Bodies unchanged.
- W2's scope gains the lineage reverse-scan bundle, `createSuperseding`, and the promote
  input dedupe; W4's scope gains flip-without-post hardening and the verify bound with your
  acceptance numbers.

On your §5: your retirements are correct as applied (the carrier rule, the D9 absence
footnote, the `supersedes` fan-out claim, override as the sanctioned withdrawal path), and
the seven wave-2 behaviour changes you encoded are accurate at 2.16.0 (checked against
`CHANGELOG.md` — the `relates_to` removal and the assemble-lane self-post marking included);
keep the `twining_why` + `total_in_scope` absence gate. Keep the one-sided-link hazard note
until 2.17.0 reaches you, then retire it against `lineage_inferred_count`. One caveat for
your §2 statement that a worktree session reads and writes the main checkout's `.twining/`:
true unless `TWINING_WORKTREE_LOCAL=true` is set, which opts a worktree into its own store.

Reading order for this batch is in the send wrapper (`2026-08-23-response-send.md`): F2, this
doc, then the routing response for the wfos lane.
