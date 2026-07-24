# Field validation — testing the 2026-07 deep review against real usage

The deep review's conclusions came from reading code. This document exists to
test them against a heavily-used store before anyone commits to structural
changes. It is designed so that a run can **disprove** the review as easily as
confirm it.

Two parts:

- **Part A — store measurement.** A read-only script over accumulated
  `.twining/` state. Takes seconds. Answers "did the predicted damage actually
  happen here?"
- **Part B — behavioral probes.** Things no file can answer, run inside a live
  session in the field repo. Answers "does the system behave this way for a
  working agent?"

Run Part A first. It is cheap and several conclusions stand or fall on it alone.

> **Probe v3 (2026-07-24) — re-run required if you ran v1 or v2.**
>
> Two corrections came out of the first field run:
>
> 1. Archive counts were contaminated by the pre-1.24.0 auto-archive feedback
>    loop (#35), whose "Archive: N entries archived" findings are machine exhaust
>    rather than captured knowledge. They are now excluded from H2/H2b and
>    reported separately as **H2c**.
> 2. **The live board was read from the wrong place.** On a sqlite backend
>    `.twining/blackboard.jsonl` is a pre-migration leftover that stops tracking
>    the database, and the probe preferred it — so every board-derived metric
>    (H2b, H2d, H3, H3b, H6) described a board that had not existed for months.
>    On the dogfood repo the stale file claimed 3 warnings and 162 statuses while
>    the database held 15 warnings and no statuses at all. The probe now reads
>    `twining.db` directly (read-only), then `records/posts`, and only falls back
>    to the JSONL for a genuine file backend. The active source is printed in the
>    header as `live board from:`.
>
> Decision-derived metrics (H1, H1b, H4, H5, H7, H7b, H8) were unaffected — they
> always came from `records/decisions`, which matches the database exactly.

---

## Ground rules

1. **Do not edit the thresholds before running.** They were registered before
   the script was ever pointed at a field store, and the dogfood baseline below
   was recorded with the identical thresholds. Tuning a threshold after seeing a
   result converts this from evidence into decoration. If a threshold looks
   wrong, run it, record the result, *then* argue about the threshold.
2. **Report REFUTES loudly.** A refuted hypothesis is the most valuable output
   here — it means a proposed structural change should not be built.
3. **`LOW N` is not `REFUTES`.** Small denominators report inconclusive on
   purpose. "0 of 3" is not evidence of absence.
4. **Part A is strictly read-only.** It opens nothing for writing and never
   imports the server or engines. Part B does write to the store, because
   posting is what is being tested — do it on a branch if that matters to you.

---

## Part A — run the store probe

From the field repo root, using this repo's copy of the script:

```bash
node /path/to/twining-mcp/scripts/field-probe.mjs \
  --project /path/to/field-repo \
  --json field-probe.json
```

Node ≥ 18, no dependencies, no install. It reads whichever backend is present
(`records/` tree, `decisions/` + `blackboard.jsonl`, or both) plus `archive/`
and `git log` metadata.

Send back the console output and `field-probe.json`.

### Pre-registered hypotheses

| ID | Claim under test | Predicted (supports the review if…) |
|----|------------------|--------------------------------------|
| **H1** | Rationale is often a copy of the summary — WHAT stored as WHY | ≥15% of decisions have rationale identical to, or contained in, the summary |
| **H1b** | The NL parser manufactures bogus rejected alternatives | ≥20% of decisions with alternatives contain a `"Not chosen"` placeholder or a sentence-fragment option |
| **H2** | Archiving uses `cutoff=now`, sweeping fresh entries | ≥50% of archive sweeps swept an entry ≤1 day old |
| **H2b** | Findings and open questions are destroyed wholesale | archived findings + questions exceed currently-live findings |
| **H2c** | Repo carries damage from the pre-1.24.0 archive feedback loop (#35) | any archiver-loop junk findings remain in `archive/` |
| **H2d** | Sweeping leaves bookkeeping and removes the tacit layer | <10% of live entries are findings/warnings/needs/questions |
| **H3** | Resolved obligations keep resurfacing | ≥1 live warning/need is already resolved by another entry |
| **H3b** | Warnings accumulate with no drain | ≥25% of live warnings are older than 30 days |
| **H4** | Scope silently degrades to `project` | ≥20% of decisions are scoped `project` |
| **H5** | The corpus outgrows the assemble budget | ≥1 scope holds more decisions than a 4000-token budget renders |
| **H6** | Subagent knowledge is discarded | ≥80% of "Subagent completed" entries have empty detail |
| **H7** | Gate 1 is unenforced — decisions recorded without assembling | ≥30% of decisions carry `assembled_before: false` |
| **H7b** | Agent identity collapses to `main` | ≥70% of decisions attributed to `main` |
| **H8** | Commit traceability is largely absent | <20% of commits since the first decision are linked |

### Baseline: this repo (dogfood store, 400 decisions, 226 live entries, 1570 archived, probe v3)

Recorded so the field numbers have something to sit against. **The dogfood repo
is the best case** — it is where the gates are most carefully followed — so a
field store should look the same or worse. A field store looking *better* on any
row is itself an interesting result.

| ID | Verdict here | Measured |
|----|--------------|----------|
| H1 | **REFUTES** | 4% (16/400) |
| H1b | **SUPPORTS** | 65.9% — 164 placeholder, 34 fragment, of 258 |
| H2 | **SUPPORTS** | 71.4% (5/7 sweeps hit same-day entries) |
| H2b | **SUPPORTS** | 469 findings archived vs 4 live |
| H2c | **SUPPORTS** | 1 junk finding (essentially clean) |
| H2d | **REFUTES** | 11.1% tacit (25/226) — `{decision:201, warning:15, need:6, finding:4}` |
| H3 | **REFUTES** | 0 resolved-but-live of 21 obligations |
| H3b | LOW N | 0 of 15 warnings older than 30d (needs 20) |
| H4 | **REFUTES** | 13% (52/400) |
| H5 | **SUPPORTS** | `project` holds 52, ~42 fit |
| H6 | LOW N | no subagent entries on the live board (they archive as findings) |
| H7 | **REFUTES** | 18.5% (74/400) |
| H7b | **SUPPORTS** | 90.5% `main`, 8 distinct ids |
| H8 | **SUPPORTS** | 8.8% of 329 commits linked |

**What the baseline already tells us.** The review's *capture-quality* claim
splits in two. The strong form — agents write rationales that merely restate the
summary (H1) — is **not** supported at 4%. The mechanical form — the NL parser
corrupts records it was handed (H1b) — is supported at 66%, and the damage is
in the parser, not the agent. That is a materially different fix: repair or
remove the parser, rather than redesign the capture model around distrust of
agents. H4 and H7 also came in under threshold. If the field store agrees, three
of the proposed structural changes shrink to bug fixes.

---

## Part B — behavioral probes

Run these in a live session in the field repo. Each states what would falsify
the review. Record the actual output verbatim, including failures.

### B1 — Teammate tool access (the reported field failure)

The plugin fix for this is on `fix/deep-review-2026-07`. Run **before** updating
the plugin to confirm the diagnosis, then after to confirm the fix.

1. Spawn a teammate with a **generic** agent type. Ask it, verbatim:
   *"List the exact names of every tool you can call. Then run ToolSearch for
   'twining' and report the raw result. Do not guess or infer — report only what
   you observe."*
2. Spawn one with `agentType: twining:twining-aware-worker`. Ask the same.

- **Supports the diagnosis:** generic sees `mcp__*twining*` tools; the plugin
  agent type reports only `Read, Write, Edit, Bash` and no `ToolSearch`.
- **Refutes it:** both fail identically → the cause is not the `tools:`
  allowlist. Then run, in the failing pane: `/mcp`, `/plugin`,
  `echo "$CLAUDE_PLUGIN_ROOT"`, and
  `bash "$CLAUDE_PLUGIN_ROOT/scripts/launch-server.sh" --probe` (expect
  `runner=<something> node=v22+`; `runner=none` is the smoking gun), plus the
  newest file in `~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-twining/`.

### B2 — Does assemble surface the decision that constrains the file?

This is the review's single most consequential retrieval claim, and the one
fixed by the ordering change.

1. Pick 5 files with real decision history — ideally in your busiest scope.
2. For each: call `twining_why` on the file and note the decision ids returned
   in **full detail** (not the `more` one-liners).
3. Call `twining_assemble` with a realistic task for that file and its narrowest
   scope. Note which decision ids appear in the `CRITICAL` tier.
4. Record: for each file, was the most-relevant constraining decision in the
   full-detail tier, or collapsed into `+N more`?

- **Supports:** the constraining decision is frequently absent from the top tier
  in scopes holding more than ~5 decisions.
- **Refutes:** it reliably appears. Then the ordering fix is cosmetic here and
  no further retrieval work is warranted.

### B3 — Mid-task delivery gap

1. In session A, start a task in some scope and call `twining_assemble`.
2. In session B (or a teammate), post a `warning` in that same scope.
3. In session A, keep working — edit files in that scope. Do **not** re-assemble.

- **Supports:** session A never sees the warning; nothing surfaces it.
- **Refutes:** it reaches session A somehow → a push channel already exists and
  should not be built.

### B4 — Archive horizon in practice

1. Note the current live entry count (`twining_status`).
2. From the Part A output, take the median days between archive sweeps.

This converts H2 into the number that actually matters: **how many days of
finding-level context this project retains.** If it is under two weeks, the
archive change is urgent regardless of anything else. If sweeps are months
apart, it drops down the list.

### B5 — Are the gates actually gating?

Try each and record what happens:

1. `git add -A && git commit -m "probe"` with no prior `twining_record` this
   session. **Supports** the review if the commit succeeds (the hook inspects
   only the leading clause).
2. `twining_post` a `status` with summary `"done"` and no detail, then commit.
   **Supports** if that unlocks the gate — it means the gate checks that a write
   happened, not what it said.

Undo the probe commits afterward.

---

## How to read the results

| Outcome | What it means for the structural changes |
|---------|------------------------------------------|
| H1 refuted, H1b supported | Do **not** redesign capture around distrusting agents. Fix or delete the NL parser. Much smaller change. |
| H2 + B4 show a short horizon | Archive retention becomes the top priority — it is silently deleting the product's reason to exist. |
| H6 supported (very likely) | Subagent transcript capture is the highest-value new capability, and the machinery already exists in-repo. |
| B2 refuted | Retrieval is healthier than the review claims; deprioritize the ranking work. |
| B3 refuted | Skip the push-channel design entirely. |
| H7/H7b split | Identity is broken (H7b) but blind-decision rate is low (H7) — fix identity, leave Gate 1 enforcement alone. |
| B5 both succeed | Gate enforcement is theatre today; either make it real or stop advertising it. |

The honest summary of the baseline: **the review's mechanical findings hold up,
and its most sweeping capture-model claim does not.** Expect the field run to
sharpen that further.

---

## Copy-paste prompt for an agent in the field repo

> You are running a pre-registered validation of a code review's conclusions
> against this repository's real Twining state. Your job is to produce evidence,
> not to agree with the review — a refuted hypothesis is a successful outcome
> and must be reported as prominently as a confirmed one.
>
> **Part A.** Run:
> `node <path-to-twining-mcp>/scripts/field-probe.mjs --project . --json field-probe.json`
> Report its full console output verbatim. Do not edit the script or its
> thresholds. If a hypothesis reports `LOW N`, report it as inconclusive, never
> as refuted.
>
> **Part B.** Work through probes B1–B5 in `docs/FIELD-VALIDATION.md` of that
> repo. For each, record exactly what you observed, including the raw tool
> output and any errors. Where a probe says a result would refute the review,
> say so explicitly when it does.
>
> **Rules.** Do not modify `.twining/` except where a probe requires posting.
> Do not fix anything you find. Do not infer a result you did not observe — if a
> probe is blocked, say it is blocked and why. Quote real ids, counts, and file
> paths.
>
> **Deliverable.** A report with one section per hypothesis and probe, each
> marked SUPPORTS / REFUTES / INCONCLUSIVE with the evidence that determined it,
> followed by a short list of which proposed structural changes your evidence
> argues *against* building.
