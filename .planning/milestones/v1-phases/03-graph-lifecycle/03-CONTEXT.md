# Phase 3: Graph + Lifecycle - Context

**Gathered:** 2026-02-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Knowledge graph for code entities (add, relate, traverse, query), full decision lifecycle (trace dependency chains, reconsider with new context, human override, conflict detection), and blackboard archiving with summarization. Status/health reporting for the overall Twining state.

</domain>

<decisions>
## Implementation Decisions

### Graph population
- Conflicts detected: new decision saved as provisional, warning posted, agent keeps working. Human resolves later via twining_override.

### Claude's Discretion
- **Auto-population scope:** Whether decisions-only or decisions+findings auto-create graph entities. Claude picks the most useful level.
- **Entity deduplication:** Merge (upsert) vs always-create-new strategy for same name+type entities.
- **Relationship inference:** Whether to auto-create 'related_to' relations from shared scope, or keep relations explicit-only.
- **Graph search approach:** Name/property matching vs semantic search for graph_query tool.
- **Conflict detection strictness:** Exact scope match vs prefix overlap for triggering conflicts.
- **Reconsideration cascade:** Whether flagging a decision as provisional also cascades to downstream dependents.
- **Override flow:** Whether twining_override auto-creates a replacement decision when new_decision text is provided.
- **Summarization method:** Template-based vs concatenation vs hybrid approach for archive summaries (no LLM available in server).
- **Archive triggers:** Which of the spec triggers to implement (manual, threshold, commit hook, context switch).
- **Archive searchability:** Whether archived entries remain in the embedding index or are removed.
- **Protected entry types:** Whether any types beyond decisions are protected from archiving.
- **Status depth:** Whether twining_status includes actionable warnings (stale provisionals, unanswered questions) beyond basic counts.
- **Archive threshold logic:** Direct config value vs percentage-based early warning.
- **Graph health in status:** Whether to report disconnected entities, orphan relations, graph density.
- **Status summary string:** Whether to include a human-readable summary alongside structured data.

</decisions>

<specifics>
## Specific Ideas

- User explicitly chose: conflicts should accept the new decision as provisional (not block). Warning posted, human resolves later.
- The design spec (TWINING-DESIGN-SPEC.md) has detailed data models, tool signatures, and behaviors for all Phase 3 features — use it as the primary reference.
- Config already defines `max_blackboard_entries_before_archive: 500` and `conflict_resolution: "human"`.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 03-graph-lifecycle*
*Context gathered: 2026-02-16*
