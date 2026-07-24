---
name: twining-review
description: Reviews pre-commit state — verifies all significant decisions are recorded and traces decision coverage. Use before creating git commits to ensure Twining completeness.
disable-model-invocation: true
---

# Twining Review — Pre-Commit Decision Review

Review the current session's work to ensure all significant architectural and implementation decisions have been properly recorded in Twining.

> **Requires the full tool surface.** `twining_what_changed`, `twining_trace`, `twining_search_decisions`, `twining_commits`, `twining_link_commit`, and `twining_decide` exist only when the project sets `tools.full_surface: true` in `.twining/config.yml`. On a default install, run the equivalent review with `twining_assemble` (what the next agent will see for this scope) and `twining_status` (counts, warnings, open needs), then close any gap with `twining_record` — passing `commit_hash` for traceability.

## Workflow

### 1. Review What Changed

Call `twining_what_changed` with `since` set to the session start time (or the last commit time). This shows:
- New decisions made in this session
- New blackboard entries (findings, warnings, needs)
- Overridden or reconsidered decisions

### 2. Trace Decision Chains

For each decision made, call `twining_trace` with the decision ID to see:
- Upstream dependencies (decisions this one depends on)
- Downstream dependents (decisions that depend on this one)
- Verify the chain is complete — no dangling references

### 3. Search for Related Decisions

Call `twining_search_decisions` to find potentially related decisions that should be linked:
- Search by domain and scope to find nearby decisions
- Check for conflicts or superseded decisions that weren't caught

### 4. Verify Commit Linkage

Call `twining_commits` with recent commit hashes to check which decisions are already linked. For any unlinked decisions, use `twining_link_commit`.

### 5. Check Decision Coverage

Look for gaps — significant choices made during the session that aren't recorded:
- Algorithm selections
- Library/framework choices
- API design decisions
- Data model changes
- Security-relevant choices
- Performance tradeoffs

For each gap, use `twining_decide` to record the missing decision.

### 6. Review Output

Summarize:
- Total decisions recorded this session
- Decision chain completeness
- Any gaps identified and filled
- Commit linkage status
