/**
 * MCP server instructions for non-plugin clients.
 * Condensed version of the 2 mandatory gates from docs/CLAUDE_TEMPLATE.md.
 * Sent in the MCP initialize response so any MCP client gets workflow guidance.
 */

export const TWINING_INSTRUCTIONS = `# Twining — Agent Coordination

Twining provides persistent project memory: decisions survive context resets, new sessions start informed, and multi-agent work stays coordinated. State lives in \`.twining/\` as plain files.

## 2 Mandatory Gates

### Gate 1: Context Assembly (BEFORE working)
Your FIRST tool call MUST be \`twining_assemble\` with your task description and scope. Do not read files or make changes until assemble returns. Also call \`twining_why\` on files you plan to modify.

### Gate 2: Record (BEFORE committing or ending)
Call \`twining_record\` with a summary and any decisions before every \`git commit\` or session end. Write decisions as natural sentences: "Chose X over Y — reason". The server handles routing to the decision store and blackboard.

## Key Conventions
- **Scopes** use path-prefix semantics: \`"src/auth/"\` not \`"project"\` — use the narrowest scope that fits
- Never skip \`twining_assemble\` before work or \`twining_record\` before committing

## Core Tools
- **twining_assemble** — orient before working (Gate 1)
- **twining_record** — record what you did before committing/ending (Gate 2)
- **twining_post** — share findings, warnings, or needs during work
- **twining_why** — check what decisions constrain a file before modifying it
`;
