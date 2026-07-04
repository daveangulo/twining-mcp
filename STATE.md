# twining-mcp — STATE

_Last updated: 2026-07-03 (grounded from v1.21.0 source, CHANGELOG, and the foundation-work sessions; see docs/DESIGN-REVIEW-2026-07.md and docs/FOUNDATION-PLAN.md)_

This file is the human-and-LLM-readable snapshot of current reality for the twining-mcp product. Update when the tool surface, gates, or open issues change materially. The npm-published version and GitHub releases are the external source of truth; this file is the internal narrative layer above them.

## TL;DR

- **Framing: product as shipping research artifact.** Twining is simultaneously an npm-published MCP server (`twining-mcp@1.23.0`, plugin `v1.10.1`) and the experimental substrate for the twining-benchmark-harness research program. Neither framing is subordinate. Real users and the benchmark are both first-class consumers. The product is maintained for correctness, not grown for adoption.
- **Posture: maintain, don't grow.** Ship bug fixes and correctness work (e.g., the in-flight plugin-hygiene fixes for issues #7–#10). Do not invest in growth features, marketing, or adoption mechanics. Dogfood rigorously enough that the product stays research-substrate-credible.
- **Lifecycle is now 2 gates** (down from 3 as of 1.17.0, 2026-04-06): **Gate 1** `twining_assemble` before work, **Gate 2** `twining_record` before commit or session end. `twining_record` collapses the old `decide` + `post` + `verify` ceremony into one natural-language call.
- **Tool surface is reconciled at 35** (as of 2026-07-03): 35 `registerTool` calls in source, 35 documented in BEHAVIORS.md (`twining_record`, `twining_housekeeping`, `twining_archive_stale` added). Lite mode registers 6 core tools by default; `full_surface` exposes the rest.
- **Dogfooding debt was substantially repaid 2026-04-24.** Housekeeping run cleaned state: 16 provisionals → 0 (14 promoted to active after verification, 2 superseded). 325 blackboard entries archived, 2 duplicates removed, 2 orphans pruned, 224 metrics rotated. **Remaining gap:** no decisions recorded for 1.16.0 or 1.17.0 shipped behavior, and two decisions (#3 and #1) are implicitly-but-not-explicitly superseded — see "Dogfooding debt" section below.
- **Foundation work (2026-07) landed and released as 1.21.0 / plugin 1.10.x** (PRs #20, #22–#26): atomic storage writes; a format version gate (read-only on newer on-disk formats — the mixed-team migration prerequisite, now soaking in the field); fully sentinel-based fail-open hooks with the CLAUDE.md mutation removed; storage backend interfaces; an opt-in SQLite backend (`storage.backend: sqlite`, node:sqlite, warn-and-fallback) hardened by a multiwriter process soak that found and fixed three real concurrency bugs; and a git sync layer (per-ULID export tree + startup ingest, union-merge across branches). 1.22.0 completed the sync layer's live half (W2.3 phase 2): a git-HEAD probe before every tool call re-ingests the export tree mid-session — branch switches and pulls are visible to the next assemble without a restart — and schema v2's `content_hash` lets the async reconcile pass re-embed only records whose embed text actually changed. 1.23.0 shipped W3, the `twining-mcp migrate` CLI (files ⇄ sqlite, verify-gated, idempotent, with the reverse escape hatch) — acceptance was migrating this repo's own committed `.twining/` diff-clean. Roadmap to v2 (default backend flip, engines >=22.13, config version 2, per-repo daemon) is in docs/FOUNDATION-PLAN.md; **v2.0 is gated on explicit go-ahead** after 1.2x field soak.
- **Open issues:** #16 (semantic staleness review, skill-driven design agreed), #18 (record quality — partially addressed by the one-shot `quality_nudge` in 1.21.0), #19 (dashboard port fights — root fix lands with the W4 daemon).

## Product identity

**What it is.** MCP server + Claude Code plugin that gives AI agents persistent project memory. Decisions, findings, warnings, handoffs survive context resets. Multi-agent work coordinates via shared state rather than orchestrator routing.

**What it's not.** Not an orchestrator (explicit positioning in README). Not a hosted database (state is local: JSONL/JSON files by default, or an opt-in local SQLite cache with a committable per-record export tree). Not cloud-hosted (local-only, optional opt-in telemetry to PostHog). **Not currently pursuing growth** — the product is maintained as a correctness-stable research substrate, not positioned as a category competitor to mem0 / Letta / Zep / the Anthropic Memory tool.

**Distribution channels.**
- **npm**: `twining-mcp` — CLI + MCP server (`dist/index.js`)
- **Claude Code plugin**: `twining@twining-marketplace` — MCP server + skills + lifecycle hooks + pre-commit enforcement
- **Self-hosted marketplace**: `daveangulo/twining-mcp` GitHub repo (since 1.7.1)

**Consumers (both first-class).**
1. **Real end users** — evidence: GitHub issues #7, #8, #9, #10 from outside the project, 2026-03-25 through 2026-04-19. Value to the research program: *real-world failure modes that synthetic benchmarks don't surface.* Issues are research data, not just product obligations.
2. **Benchmark harness** (`twining-benchmark-harness`) — conditions `twining-default` and `twining-full` install the plugin and exercise its full lifecycle. Value to the product: *controlled evidence that the coordination surface actually works, at n=20+ across 6 scenarios.*

**Operating posture.**
- Ship correctness fixes (bugs, plugin hygiene, BEHAVIORS.md drift) because the research-substrate claim depends on the product working.
- Do not ship growth features, onboarding polish, or marketing content.
- Keep the package published and versioned cleanly — both as research-artifact hygiene and as protection against losing the "real users ship against this" claim.

## Lifecycle gates (as of 1.17.0)

From `BEHAVIORS.md` (GEN-01 through GEN-04) and CHANGELOG 1.17.0:

| Gate | Tool | Trigger | Enforced by |
|------|------|---------|-------------|
| 1 | `twining_assemble` | Session start, before any decisions | SessionStart hook prompt; `BEHAVIORS.md` GEN-03 (MUST); assembly-before-decision check in `twining_verify` |
| 2 | `twining_record` | Before `git commit` or session end | `PreToolUse` hook on `git commit` (1.17.0) + Stop hook (blocks session exit if code changed without recording) |

**1.17.0 collapsed the old 3-gate model.** Prior to 1.17.0, Gate 2 was `twining_decide` (plus `twining_post`) and there was a Gate 3 of `twining_verify` (then `twining_post` status). `twining_record` now wraps natural-language decisions → structured `decide()` calls internally, with automatic rationale/alternatives parsing via `record-parser.ts`.

## Tool surface (current, from server.ts + BEHAVIORS.md + CHANGELOG)

**Total tools registered in v1.17.0:** 34 (per CHANGELOG 1.17.0; BEHAVIORS.md covers 32 because `twining_record` and `twining_housekeeping` were added after BEHAVIORS was last regenerated).

**Core (always registered, 5):** `twining_assemble`, `twining_record`, `twining_post`, `twining_why`, `twining_housekeeping`.

**Conditionally registered, always-on for `full_surface: false` (the default):** `registerBlackboardTools`, `registerDecisionTools`, `registerContextTools`, `registerCoordinationTools` each register a subset when `fullSurface=false` and their full set when `fullSurface=true`. Exact split is enforced inside each `register*Tools` module — not visible from server.ts alone. (If this matters for a change, read the individual `tools/*.ts` files; this STATE.md doesn't mirror them.)

**Gated behind `full_surface: true`:**
- `registerVerifyTools` (adds `twining_verify`)
- `registerExportTools` (adds `twining_export`)
- Expanded tool variants from the four `register*Tools` modules above

**Gated behind `tools.mode === "full"` (default):**
- `registerLifecycleTools` (adds `twining_status`, `twining_archive`, etc.)
- `registerGraphTools` (adds `twining_add_entity`, `twining_add_relation`, `twining_neighbors`, `twining_graph_query`, `twining_prune_graph`)

**Two-axis config (`tools.mode` + `tools.full_surface`) is intentional but lightly documented.** README only mentions `full_surface`. `tools.mode` is set by `config.tools?.mode ?? "full"` in server.ts with no config example anywhere in the shipped docs. Either promote `tools.mode` to documented behavior or collapse the axis.

### Divergence watch

| Artifact | Tool count | Accuracy |
|----------|-----------|----------|
| `server.ts` code | 34 (CHANGELOG 1.17.0 claim) | Source of truth |
| `BEHAVIORS.md` | 32 | **Stale** — missing `twining_record`, `twining_housekeeping` (both added 1.17.0) |
| `README.md` core table | 5 | Current |
| `README.md` extended table | ~27 | Current by category, not enumerated |
| `TWINING-REFERENCE.md` core table | 12 (includes `twining_decide` etc. as "core") | **Slightly misleading** — `twining_decide` is extended in server.ts (registered via `registerDecisionTools` behind `full_surface`), but listed as always-available in the core table |

**Action implied:** BEHAVIORS.md needs regeneration to include `twining_record` and `twining_housekeeping` before it can be used as the eval scoring target for 1.17.0 behavior. TWINING-REFERENCE core/extended split should match server.ts registration logic or be explicitly rewritten as "user-facing" vs "available-to-agents".

## Plugin composition (v1.8.0, plugin.json)

- **MCP server**: this package, loaded via `--project .`
- **Skills**: agent behaviors (per CHANGELOG 1.7.0 "Claude Code plugin with skills, hooks, agents, and MCP server instructions"). Third-person skill descriptions with triggers (1.6.0, 2026-03-28).
- **Lifecycle hooks**:
  - `SessionStart` command hook: injects "Twining Lifecycle Gates" into project CLAUDE.md (decision 01KMT252W66VBH, 2026-03-28). Also prints "Two gates: assemble FIRST, record LAST" prompt.
  - `PreToolUse` on `git commit`: blocks commits until `twining_record` called (1.17.0).
  - `Stop` hook: blocks session exit when code changed without recording; single-action message "call twining_record" (1.17.0; previously 3-step checklist).
- **Pre-commit enforcement** via the PreToolUse hook above.

## Architecture (from server.ts)

Layered, with dependency injection at server construction:

```
Storage          → BlackboardStore, DecisionStore, GraphStore, AgentStore, HandoffStore
Embeddings       → Embedder (all-MiniLM-L6-v2 via @huggingface/transformers, lazy ONNX)
                   IndexManager, SearchEngine (keyword fallback when embeddings fail)
Engine           → BlackboardEngine, DecisionEngine, GraphEngine, Archiver,
                   ContextAssembler, PlanningBridge, VerifyEngine, CoordinationEngine,
                   HousekeepingEngine, PendingProcessor, Exporter
Graph            → GraphAutoPopulator (opt-in via config.graph.auto_populate, default false)
Tools            → registerXxxTools modules map 1:1 to MCP tool definitions
Analytics        → MetricsCollector (local .twining/metrics.jsonl, default on),
                   TelemetryClient (PostHog, opt-in, default off)
Dashboard        → HTTP server on port 24282, cytoscape.js + vis-timeline, read-only
```

**Critical coupling:** `GraphAutoPopulator` is wired into `BlackboardEngine.setGraphPopulator()` *conditionally on `config.graph.auto_populate`* — meaning relations extracted from `twining_post` calls only land in the graph when auto-populate is on. `twining_record` → `decisionEngine.decide()` triggers graph population *unconditionally* (decisions auto-create `file`/`function` entities with `decided_by` relations). The finding from benchmark data that "agents never call explicit graph tools yet the graph populates" is this asymmetry in action.

**Stdio transport only.** Never use `console.log` from MCP code paths — corrupts JSON-RPC (comment in `index.ts`). Dashboard HTTP server is a separate fire-and-forget process.

## Recent material changes (chronological)

- **2026-03-19** (1.10.0 MCP, 1.3.0 plugin): Benchmark-driven improvements. `full_surface` config flag introduced — 16 never-called tools gated off by default. Graph auto-population disabled by default. Structured assemble output with markdown briefing. (blackboard 01KM2B5GPM9YBR, 01KM2B66P5YY3B)
- **2026-03-21**: Assemble output improvements — constraints and rejected alternatives included, assumption-based validation, empty-state short-circuit. (blackboard 01KM8XXG7RGSND through 01KM6FNYT78RP8)
- **2026-03-28** (1.15.0 MCP, 1.6.0 plugin): **`fullSurface` tool gate removed** — all 34 tools always registered. Rationale: Claude Code's ToolSearch defers loading, making static gating premature optimization that "actively broke mandatory functionality." CLAUDE.md gates injection hook added. SessionStart prompt slimmed 400→40 tokens. (blackboard 01KMT3GDHV15HA)
- **2026-04-05** (1.16.0): **`fullSurface` gate re-added** — 15 rarely-used tools hidden by default. Gate 3 changed from mandatory `twining_verify` to mandatory `twining_post` status. Scope-distance weighting in assemble scoring. Decision tiering (CRITICAL/CONTEXT/omitted). **No corresponding blackboard decision recorded.** (CHANGELOG only)
- **2026-04-06** (1.17.0): Lifecycle collapsed 3→2 gates. `twining_record` introduced with natural-language decision parser. `twining_housekeeping` introduced. `PreToolUse` hook on `git commit`. Stop hook rewritten. **No corresponding blackboard decision recorded.** (CHANGELOG only)
- **2026-04-17 through 2026-04-19**: Real user bug reports filed (#8, #9, #10) — first external user issues since 1.17.0 ship.

## Open issues and in-flight work

### GitHub issues (open)

| # | Type | Title | Status |
|---|------|-------|--------|
| #7 | enhancement | Scope cleanup — GC for stale scopes/decisions | Question posted 2026-04-21, awaiting reporter |
| #8 | bug | `SessionStart:resume` hook fails with "ToolUseContext is required for prompt hooks" on v1.8.0 plugin | Design clear (matcher tweak to `startup` only, or convert to command hook). Ready to implement. |
| #9 | enhancement | Stop stomping on CLAUDE.md | Detection strategy decided 2026-04-21: **broad marker search** (CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.local.md) **+ opt-out flag**. Ready to implement. |
| #10 | enhancement | Disable Twining in individual projects (`TWINING_DISABLED`) | Scope undecided — depends on reporter confirming which use case (teammate opt-out / per-project / sandbox / mid-session toggle). Question posted 2026-04-21, awaiting reporter. |

**Work grouping:** Issues are bundled into two specs in the pause-state note (session 43a6e067, 2026-04-21):
- **Spec A — Plugin hygiene** (#8, #9, #10): hook matcher fix + CLAUDE.md detection + disable switch
- **Spec B — Scope/decision GC** (#7): larger design, depends on whether existing `twining_housekeeping` covers the gap or a new `/twining-gc` command is warranted

**Paused at:** Awaiting reporter replies on #10 and #7 before finalizing Spec A design and writing it to `docs/superpowers/specs/YYYY-MM-DD-plugin-hygiene-design.md`.

### Non-issue open questions (from decision index, blackboard, and recent sessions)

- **`tools.mode` config axis** is implemented but undocumented. Decide: promote or collapse.
- **BEHAVIORS.md drift** since 1.16.0 and 1.17.0. Regeneration blocked on nothing — just hasn't happened. Affects eval harness correctness.
- **Dogfooding debt (substantially repaid 2026-04-24).** Housekeeping run cleaned the decision index: 16 provisionals → 0 (14 promoted to active after verification, 2 explicitly superseded including the fullSurface-removal decision). Dangling warnings auto-resolved during archiving. Remaining gaps:
  - **Some decisions about twining-mcp architecture are filed in the *harness* decision index, not the product's.** Example: the 2026-04-24 supersession entry in the harness index references "twining-mcp v1.16.0 added proper --version support" — the decision about that product change lives in the harness repo because that's where the work was happening. For a product whose value proposition is "your decisions survive and are queryable," this is a specific dogfooding failure mode: the product's own decision index cannot answer "why does the `full_surface` gate exist in its current form?" without cross-referencing another project. Candidate fixes: (a) cross-repo decision linking via a new relation type, (b) discipline of recording product decisions in the product repo regardless of where the work was done, (c) accept that cross-repo projects have this problem and document the lookup path in STATE.md.
  - **Decisions #3 (01KM2B5GACRK2B5X, "Reduce default tool surface from 32 to 16 via full_surface config flag") and #1 (01KKBXHK, "Enforce mandatory agent registration and handoff in plugin v1.1.5") remain `active` but are implicitly superseded** by newer active decisions in the same scope. Housekeeping deliberately left them as active to avoid bookkeeping noise. Recommendation (see drafting discussion 2026-04-24): mark #3 explicitly superseded with the chain "32→16 gate (3-19) → remove gate entirely (3-28) → re-add gate with different default (1.16.0)"; leave #1 as active historical record.

## Research-instrument constraints

The benchmark harness treats twining-mcp as a black box with two knobs:
1. **Install the plugin** (hooks + skills + BEHAVIORS.md shipped behavior) — this is the `twining-default` condition.
2. **Install the plugin + set `full_surface: true`** — this is the `twining-full` condition.

Any change that alters behavior in either configuration without a version bump breaks comparability between benchmark runs. Specifically:

- **Do not remove or rename core tools** (`assemble`, `record`, `post`, `why`, `housekeeping`) without updating the harness condition configs and rerunning baselines.
- **Do not change the default `full_surface` value** (currently `false`) without rerunning both `twining-default` and `twining-full` conditions to re-baseline.
- **Lifecycle gate changes** (e.g., the 3→2 gate collapse in 1.17.0) invalidate cross-version comparison. The harness ran benchmarks both before and after this; results pooled across versions would be non-comparable.

**Long-horizon stability constraint added 2026-04-24.** The harness's 
committed research direction (multi-sprint, multi-release benchmark; 
see harness STATE.md "Research direction" section) requires a flagship 
run of roughly multi-week duration at fixed Claude Code and 
twining-mcp versions. During flagship execution:

- No tool-surface changes (additions, removals, renames) in 
  twining-mcp or the plugin.
- No changes to default `full_surface` value.
- No changes to lifecycle gate structure (currently 2 gates at 1.17.0; 
  further collapses or expansions invalidate the run).
- No changes to SessionStart hook behavior (affects orientation cost 
  measurement in the scorecard).
- No changes to `twining_record` natural-language parsing behavior 
  (affects decision compliance measurement).

Plugin-hygiene fixes currently in flight (issues #7–#10) should ship 
before the flagship run starts, or explicitly defer until after the 
run completes. Coordinating the ship window with the harness's flagship 
window is a scheduling dependency that should be surfaced in the 
harness methodology document (Phase 2B deliverable) and mirrored here 
when concrete dates are set.

Additionally, the harness's new scorer for "context reconstitution 
cost" depends on the structure of `twining_assemble` output 
(specifically the markdown briefing format, assumption-based 
validation, and empty-state short-circuit behavior shipped in 1.10.0 
and 1.11.0). Material changes to assemble output structure during a 
flagship run break the scorer. Any assemble-format change should go 
through a version bump and a harness baseline rerun.

The harness `CLAUDE.md` in its scenario fixtures references specific tool names (`twining_record`, `twining_assemble`, `twining_verify`) — renaming any of these without updating fixtures causes silent condition breakage.

## Pointers

- Source of truth for version: `package.json` (1.17.0) and `plugin.json` (1.8.0)
- Tool surface: `src/server.ts` + `src/tools/*.ts`
- Behavioral spec: `BEHAVIORS.md` (note: stale vs 1.17.0, see divergence watch above)
- User-facing tool docs: `README.md` and `TWINING-REFERENCE.md`
- Release history: `CHANGELOG.md`
- **Decision index (recommended entry point): `.twining/decisions/index.json`** — 82 decisions with status tracking, cleaner signal than raw blackboard for architectural evolution
- Raw append-only log: `.twining/blackboard.jsonl` (408 entries, includes findings/warnings/statuses beyond decisions)
- Design spec: `TWINING-DESIGN-SPEC.md` (referenced in README, not uploaded — verify still current)
- GitHub issues: `https://github.com/daveangulo/twining-mcp/issues`
