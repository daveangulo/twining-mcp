/**
 * MCP server instructions for non-plugin clients.
 * Condensed version of the 3 mandatory gates from docs/CLAUDE_TEMPLATE.md.
 * Sent in the MCP initialize response so any MCP client gets workflow guidance.
 */

export const TWINING_INSTRUCTIONS = `# Twining — Agent Coordination

Twining provides persistent project memory: decisions survive context resets, new sessions start informed, and multi-agent work stays coordinated. State lives in \`.twining/\` as plain files.

## 3 Mandatory Gates

### Gate 1: Context Assembly (BEFORE working)
Call \`twining_assemble\` with your task description and scope BEFORE reading code or making changes. This retrieves prior decisions, warnings, and context. Also call \`twining_why\` on files you plan to modify.

### Gate 2: Decision Recording (AFTER choices)
Call \`twining_decide\` for any architectural or implementation choice where alternatives exist. Include rationale and at least one rejected alternative. Post \`finding\`, \`warning\`, and \`need\` entries via \`twining_post\` for discoveries, gotchas, and follow-up work.

### Gate 3: Verification (BEFORE completing)
Call \`twining_verify\` on your scope before finishing. Link tests to decisions via \`twining_add_relation\` with type \`tested_by\`. Post a \`status\` entry summarizing what you did. Link commits via \`twining_link_commit\`.

## Key Conventions
- **Scopes** use path-prefix semantics: \`"src/auth/"\` not \`"project"\` — use the narrowest scope that fits
- **Confidence**: \`high\` (proven), \`medium\` (reasonable), \`low\` (needs validation)
- **Domains**: architecture, implementation, testing, deployment, security, performance, api-design, data-model
- Never use \`twining_post\` with entry_type "decision" — always use \`twining_decide\`
- Never skip \`twining_assemble\` before work or \`twining_verify\` before handoff

## Tool Groups
- **Blackboard**: twining_post, twining_read, twining_query, twining_recent
- **Decisions**: twining_decide, twining_why, twining_trace, twining_reconsider, twining_override, twining_search_decisions, twining_link_commit, twining_commits
- **Context**: twining_assemble, twining_summarize, twining_what_changed
- **Graph**: twining_add_entity, twining_add_relation, twining_neighbors, twining_graph_query
- **Verification**: twining_verify
- **Lifecycle**: twining_status, twining_archive, twining_export
- **Coordination**: twining_agents, twining_register, twining_discover, twining_delegate, twining_handoff, twining_acknowledge
`;
