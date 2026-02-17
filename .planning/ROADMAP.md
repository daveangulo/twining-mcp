# Roadmap: Twining MCP Server

## Milestones

- ✅ **v1** — Phases 1-3 (shipped 2026-02-17)
- 🚧 **v1.1 Integrations + Polish** — Phases 4-6 (in progress)

## Phases

<details>
<summary>✅ v1 (Phases 1-3) — SHIPPED 2026-02-17</summary>

- [x] Phase 1: Foundation + Core Data (2/2 plans) — completed 2026-02-16
- [x] Phase 2: Intelligence (2/2 plans) — completed 2026-02-16
- [x] Phase 3: Graph + Lifecycle (2/2 plans) — completed 2026-02-17

</details>

### v1.1 Integrations + Polish

- [x] **Phase 4: Git Commit Linking** - Bidirectional decision-to-commit traceability with data model extension and new query tools (completed 2026-02-17)
- [x] **Phase 5: GSD Planning Bridge + Serena Docs** - Planning state feeds context assembly, decisions sync to planning docs, Serena workflow documented (completed 2026-02-17)
- [ ] **Phase 6: Search + Export** - Standalone tools for decision search and full state export to markdown

## Phase Details

### Phase 4: Git Commit Linking
**Goal**: Decisions and git commits are linked bidirectionally — agents can trace from decision to commit and from commit to decisions
**Depends on**: Phase 3 (v1 complete)
**Requirements**: GITL-01, GITL-02, GITL-03, GITL-04
**Success Criteria** (what must be TRUE):
  1. Agent can record a decision with an associated commit hash at creation time via `twining_decide`
  2. Agent can retroactively link a commit hash to an existing decision via `twining_link_commit`
  3. Agent calling `twining_why` on a linked decision sees the associated commit hashes in the output
  4. Agent can query "what decisions drove this commit?" via `twining_commits` and get matching decisions back
**Plans**: 2 plans

Plans:
- [ ] 04-01-PLAN.md — Data model extension + commit linking (GITL-01, GITL-02)
- [ ] 04-02-PLAN.md — Query tools + why output enrichment (GITL-03, GITL-04)

### Phase 5: GSD Planning Bridge + Serena Docs
**Goal**: Twining is aware of GSD planning state and surfaces it in context assembly and summaries; Serena enrichment workflow is documented for agents
**Depends on**: Phase 4
**Requirements**: GSDB-01, GSDB-02, GSDB-03, GSDB-04, SRNA-01
**Success Criteria** (what must be TRUE):
  1. When an agent calls `twining_assemble` for a task related to a planning scope, `.planning/` state (current phase, progress, blockers) appears in the assembled context
  2. `twining_summarize` output includes current planning state (phase, progress, open requirements) when `.planning/` exists
  3. After `twining_decide` is called, the decision summary appears in `.planning/STATE.md` accumulated context section
  4. CLAUDE.md contains clear instructions for the Serena-mediated knowledge graph enrichment workflow
**Plans**: 2 plans

Plans:
- [ ] 05-01-PLAN.md — Planning bridge read-side: PlanningBridge + assemble/summarize integration (GSDB-01, GSDB-02, GSDB-04)
- [ ] 05-02-PLAN.md — Planning bridge write-side + Serena docs: decide() syncs to STATE.md, CLAUDE.md workflow (GSDB-03, SRNA-01)

### Phase 6: Search + Export
**Goal**: Agents and humans can search decisions without knowing scope and export full Twining state as readable markdown
**Depends on**: Phase 4 (needs commit-linked decisions for complete export; independent of Phase 5)
**Requirements**: SRCH-01, SRCH-02, XPRT-01, XPRT-02
**Success Criteria** (what must be TRUE):
  1. Agent can find decisions by keyword/semantic search across all scopes via `twining_search_decisions` without specifying a scope
  2. `twining_search_decisions` results can be filtered by domain, status, or confidence level
  3. Agent or human can get a single markdown document of all Twining state (blackboard, decisions, graph) via `twining_export`
  4. `twining_export` accepts a `scope` parameter that filters output to only the relevant subset of state
**Plans**: TBD

Plans:
- [ ] 06-01: TBD
- [ ] 06-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 4 → 5 → 6

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation + Core Data | v1 | 2/2 | Complete | 2026-02-16 |
| 2. Intelligence | v1 | 2/2 | Complete | 2026-02-16 |
| 3. Graph + Lifecycle | v1 | 2/2 | Complete | 2026-02-17 |
| 4. Git Commit Linking | v1.1 | Complete    | 2026-02-17 | - |
| 5. GSD Planning Bridge + Serena Docs | v1.1 | Complete    | 2026-02-17 | - |
| 6. Search + Export | v1.1 | 0/? | Not started | - |
