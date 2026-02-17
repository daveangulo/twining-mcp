# Phase 2: Intelligence - Context

**Gathered:** 2026-02-16
**Status:** Ready for planning

<domain>
## Phase Boundary

Add semantic search across all stored data (blackboard entries and decisions) and token-budgeted context assembly to the existing MCP server. Agents get `twining_search`, `twining_context`, `twining_summarize`, and `twining_what_changed` tools. The embedding system is lazy-loaded with graceful keyword fallback. Knowledge graph and decision lifecycle are Phase 3.

</domain>

<decisions>
## Implementation Decisions

### Search experience
- Default result count: 10 results per search query
- Tool design: Follow TWINING-DESIGN-SPEC.md for tool structure and naming
- Claude's discretion: relevance threshold strategy (hard cutoff vs always fill), whether to expose similarity scores

### Context budget strategy
- Claude's discretion: budget allocation approach (dynamic by relevance vs reserved minimums)
- Claude's discretion: whether agents can pass priority hints for content types
- Claude's discretion: typical budget range assumptions and truncation aggressiveness
- Claude's discretion: whether to show overflow/exclusion metadata in response

### Fallback behavior
- Claude's discretion: whether to flag keyword fallback mode to agents (transparency)
- Claude's discretion: keyword search algorithm (substring vs TF-IDF style)
- Claude's discretion: ONNX recovery strategy (retry vs stay in fallback)
- Claude's discretion: whether to expose a force-keyword search mode

### Summary & changelog
- Tool filtering: Follow TWINING-DESIGN-SPEC.md for scope filtering on summarize/what_changed
- Claude's discretion: what_changed granularity (entry-level vs grouped)
- Claude's discretion: live generation vs pre-computed summaries
- Claude's discretion: whether to include quantitative stats alongside narrative

### Claude's Discretion
The user has given Claude broad latitude on implementation details for this phase. The key constraints are:
- 10 results default for search
- Follow TWINING-DESIGN-SPEC.md for all tool signatures, naming, and filtering behavior
- ONNX must be lazy-loaded and must fall back gracefully (per project constraint)
- Make sensible choices that serve agents well — the user trusts Claude's judgment on the technical details

</decisions>

<specifics>
## Specific Ideas

No specific requirements — open to standard approaches. The design spec (TWINING-DESIGN-SPEC.md) is the authoritative reference for all tool signatures and behavior.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 02-intelligence*
*Context gathered: 2026-02-16*
