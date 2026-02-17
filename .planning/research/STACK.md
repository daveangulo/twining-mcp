# Technology Stack: Agent Coordination v1.3

**Project:** Twining MCP Server -- Agent Coordination Milestone
**Researched:** 2026-02-17

## Recommended Stack

No new dependencies needed. Agent coordination is built entirely on existing stack.

### Core Framework (Unchanged)
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| TypeScript | ~5.x | Language | Already in use, strict mode |
| Node.js | >= 18 | Runtime | Already in use |
| `@modelcontextprotocol/sdk` | ^1.x | MCP server framework | Already in use, tool registration |
| `zod` | ^3.x | Input validation | Already in use for all tool schemas |

### Storage (Unchanged Approach)
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| JSON files | N/A | Agent registry, handoff records | Same pattern as decisions/index.json, graph/entities.json |
| `proper-lockfile` | ^4.x | Advisory file locking for concurrent writes | Already in use, proven pattern |
| `ulid` | ^2.x | ID generation | Already in use, temporally sortable |

### Testing (Unchanged)
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `vitest` | ^1.x | Test runner | Already in use, 312 tests passing |
| `tmp-promise` | ^3.x | Temp directories for test isolation | Already in use |

### Dashboard (Extended)
| Technology | Version | Purpose | Why |
|------------|---------|---------|-----|
| `node:http` | N/A | Embedded HTTP server | Already in use |
| Vanilla HTML/CSS/JS | N/A | Dashboard frontend | Already in use, no build step |
| cytoscape.js | Vendored | Graph visualization (may show agent nodes) | Already vendored |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not |
|----------|-------------|-------------|---------|
| Agent registry storage | JSON file | SQLite | Over-engineering for <100 agents; JSON matches existing patterns |
| Capability matching | Tag-based substring | Embedding-based semantic | Over-engineering; tags are precise enough for agent capabilities |
| Liveness detection | Timestamp inference | Heartbeat protocol | MCP has no push channel; wastes tokens |
| Delegation routing | Blackboard need entries | Message queue (Redis, etc.) | Violates file-native constraint; adds external dependency |
| Handoff storage | Individual JSON files + index | Single JSONL file | Following decision store pattern for random access by ID |

## No New Dependencies

The entire agent coordination layer is built using existing project dependencies. This is by design:

1. **agent-store.ts** uses `readJSON`/`writeJSON` from file-store.ts + `proper-lockfile` + `ulid`
2. **handoff-store.ts** uses same file-store utilities + locking + ULID generation
3. **agent-engine.ts** uses existing engine types and patterns
4. **agent-tools.ts** uses `zod` for input schemas + `McpServer.registerTool`
5. **Dashboard additions** use existing vanilla HTML/JS patterns

No `npm install` needed for this milestone.

## Installation

```bash
# No new packages needed
# Run existing test suite to verify nothing breaks:
npm test
```

## Sources

- Twining codebase analysis: package.json, existing store implementations, file-store.ts patterns
- Decision: no new dependencies keeps the dependency surface minimal and build reliable
