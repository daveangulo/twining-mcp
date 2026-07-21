---
name: twining-semantic-review
description: LLM-judged semantic staleness review of Twining entries — flags decisions and blackboard entries tied to historical context that has moved on (dead sprints, renamed concepts, retired architectures). Opt-in, human-confirmed; complements deterministic staleness_review. Use when housekeeping is clean but old entries still reference concepts that no longer make sense.
auto-invocable: false
---

# Twining Semantic Review — LLM-Judged Staleness

Deterministic staleness (`twining_housekeeping` with `staleness_review: true`) catches
orphans-by-structure: the scope path is gone, affected files deleted, branch removed.
It cannot catch entries that are structurally intact but reference *concepts* the
project has moved past — "Wave 3 review action items", "HMS Lancaster compliance",
a sprint that closed a year ago. A future agent finding those will go looking for
concepts that don't exist and hallucinate explanations.

This skill puts the judging model — you — in that loop. **You are the LLM; no API
key, no server-side model call, no cost beyond this session.** Nothing is archived
without explicit user confirmation.

## When to Invoke

- The user asks for a semantic review, deep cleanup, or "are any of these entries still relevant?"
- After a milestone/version ships and its planning vocabulary is retired
- Deterministic housekeeping reports clean but `twining_status` shows a large, old entry population

Never run this as a side effect of another task. It is opt-in by design.

## Workflow

### 1. Ground yourself in what is CURRENT

Before judging anything, build the "still alive" picture:

- `git branch --list` and the current branch — active lines of work
- `README.md` / project docs headline — what the project is now
- `twining_status` — entry counts, current phase if tracked
- The 10 most recent blackboard entries — today's working vocabulary

### 2. Load review candidates

- **Decisions:** `twining_why` on the major scopes (e.g. `src/`, `plugin/`), including
  `include_superseded: false` (superseded ones are already retired). Use the `more`
  tier and `ids` drill-down for full rationale where needed.
- **Blackboard entries:** `twining_read` with no type filter, oldest first if the
  surface allows. `twining_read` requires `tools.full_surface: true` — in lite mode,
  review decisions only (via `twining_why`) plus the `dangling_warnings` items from
  `twining_housekeeping`.

Bound the batch: review at most ~50 items per pass. If there are more, start with
the oldest and tell the user how many remain.

### 3. Score each candidate

For each entry, judge: **would an agent reading this today be grounded or misled?**

Assign a staleness score 0–1 with a one-sentence written reason (same shape as the
deterministic pass's `StaleItem.reasons`):

- **0.9–1.0** — names a concept, sprint, codename, or artifact that verifiably no
  longer exists in the project ("Wave 3", a retired subsystem, a dead migration)
- **0.6–0.8** — tied to a completed effort; content is historical but could confuse
  ("beta.2 soak follow-ups" after 2.0 stable shipped)
- **0.3–0.5** — aged but the concept is still live; keep
- **0.0–0.2** — current, or timeless (conventions, constraints, active warnings)

Judging rules:
- A concept is dead only if you **verified** it's absent — grep the repo/docs before
  scoring above 0.8. "I don't recognize it" is not evidence.
- Still-active concepts (e.g. "JWT auth flow" while `src/auth/` uses JWT) must NOT
  be flagged, however old the entry.
- Unresolved `need`/`warning` entries get extra caution: they are open obligations,
  exempt from age-based archiving (#40), and should only be flagged when the
  obligation itself is provably moot.
- When unsure, score low. False keeps are cheap; false archives erase context.

### 4. Confirm with the user — NEVER auto-archive

Present a table of candidates scoring **≥ 0.7**: id, type, age, summary, score,
reason. Ask which to archive (default suggestion: all listed, but the user picks).

### 5. Archive confirmed items with per-item audit reasons

Call `twining_archive_stale` with the confirmed ids and BOTH:
- `reason`: `"semantic review pass — LLM-judged staleness"`
- `reasons`: a map of each id to its score and written reason, e.g.
  `{"01ABC…": "0.9 — references Wave 3 sprint, closed 2025-11; no matching concept in repo"}`

The per-item reasons land in the audit-trail finding so a future reviewer can spot
bad calls and reverse them (decisions move to status `archived`, not deleted).

### 6. Report

Summarize: items reviewed, flagged, archived, skipped-by-user, and how many
candidates remain unreviewed if the batch was capped.
