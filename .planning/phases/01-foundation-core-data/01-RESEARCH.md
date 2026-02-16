# Phase 1: Foundation + Core Data - Research

**Researched:** 2026-02-16
**Domain:** MCP server, file-native storage, advisory locking, ULID generation, TypeScript
**Confidence:** HIGH

## Summary

Phase 1 builds the storage layer (file-store with locking, blackboard-store, decision-store), engine layer (blackboard, decisions), tool handlers, and MCP server wiring with stdio transport. The technology stack is well-established: `@modelcontextprotocol/sdk` v1.26+ for MCP server/tools with Zod schemas, `proper-lockfile` for advisory file locking, `ulid` for temporally sortable IDs, and `js-yaml` for YAML config parsing.

The MCP SDK uses `McpServer` + `StdioServerTransport` with `registerTool()` taking Zod v4 schemas for input validation. All tool handlers must return `{ content: [{ type: "text", text: JSON.stringify(result) }] }` format. The SDK requires Zod as a peer dependency and internally uses `zod/v4` imports. Console.log MUST NOT be used in stdio servers as it corrupts the JSON-RPC protocol on stdout.

**Primary recommendation:** Build bottom-up per CLAUDE.md order (utils -> storage -> engine -> tools -> server), using proper-lockfile with retry/backoff for all file writes, JSONL append for blackboard, individual JSON files for decisions with an index file.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- Tool response design: Claude's discretion on verbosity per tool (minimal for writes, richer for reads), error detail level, metadata inclusion, response size limits
- Init behavior: Silent auto-create `.twining/` on first tool call, YAML config (`config.yml`), gitignore `embeddings/*.index` and `archive/` only
- Concurrency model: Claude's discretion on lock strategy (retry with backoff vs fail-fast), lock scope, stale lock handling, corrupt data recovery. Use proper-lockfile with sensible defaults.
- Scope conventions: Leverage Serena symbol names when available, fall back to file paths. Need rebuild capability. Discretion on prefix matching, wildcard scopes, hierarchical cascading.

### Claude's Discretion
- Tool response verbosity and metadata inclusion per tool
- Error response detail level
- Config file completeness (minimal vs full defaults)
- All concurrency implementation details (lock strategy, stale handling, corruption recovery)
- Scope matching semantics (prefix rules, wildcard scopes, hierarchy)

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|-----------------|
| FOUND-01 | Auto-create `.twining/` with default config and empty data files | MCP SDK init pattern; fs.mkdirSync recursive; YAML write for config.yml |
| FOUND-02 | All IDs are ULIDs | `ulid` package v3.0.2 — `ulid()` generates temporally sortable IDs |
| FOUND-03 | Advisory file locking for all writes | `proper-lockfile` v4.1.2 — mkdir-based atomic locks, configurable retry/stale |
| FOUND-04 | Structured error responses, never crash MCP | Try/catch in all tool handlers, return `{ error: true, message, code }` pattern |
| FOUND-05 | Token estimation (4 chars/token) | Simple `text.length / 4` heuristic, no library needed |
| FOUND-06 | Config from `.twining/config.yml` | `js-yaml` or `yaml` npm package for YAML parse/dump |
| BLKB-01 | Post entries with type/summary/detail/tags/scope | Append to JSONL with lock; Zod schema validates entry_type enum |
| BLKB-02 | Read entries filtered by type/tags/scope/time | Stream-parse JSONL, apply filters in-memory |
| BLKB-04 | Retrieve N most recent entries | ULID sorting (lexicographic = temporal); read JSONL, slice last N |
| BLKB-05 | Stored as append-only JSONL | `fs.appendFileSync` under lock; one JSON object per line |
| BLKB-06 | 10 entry types supported | Zod enum validation in tool input schema |
| DCSN-01 | Record decision with full rationale/alternatives/confidence | Individual JSON file per decision; Zod schema for complex nested input |
| DCSN-02 | Retrieve decisions by scope (`twining_why`) | Index lookup by scope field; prefix matching on scope strings |
| DCSN-06 | Individual JSON files with index | Write `{ulid}.json` + update `index.json` under lock |
| MCPI-01 | Register all tools via MCP SDK with Zod schemas | `server.registerTool()` with Zod v4 inputSchema objects |
| MCPI-02 | Stdio transport | `StdioServerTransport` from SDK; never use console.log |
| MCPI-03 | Installable via `npx twining-mcp` | package.json `bin` field pointing to compiled entry point |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/sdk` | ^1.26.0 | MCP server framework, tool registration, stdio transport | Official SDK; only supported way to build MCP servers |
| `proper-lockfile` | ^4.1.2 | Advisory file locking for concurrent write safety | Uses atomic mkdir; works on network FS; staleness detection built-in |
| `ulid` | ^3.0.2 | Temporally sortable unique ID generation | ULID spec; lexicographic sort = temporal sort; 128-bit unique |
| `zod` | ^3.25.0 (peer) | Schema validation for MCP tool inputs | Required peer dependency of MCP SDK; SDK uses zod/v4 internally |
| `typescript` | ^5.9.3 | Type-safe development | Already in project; strict mode required for Zod |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `js-yaml` | ^4.1.0 | Parse/dump YAML for config.yml | Config loading/saving; lighter than `yaml` package |
| `@types/proper-lockfile` | ^4.1.4 | TypeScript types for proper-lockfile | Development only; proper-lockfile has no built-in types |
| `@types/js-yaml` | ^4.0.9 | TypeScript types for js-yaml | Development only |
| `vitest` | ^4.0.18 | Test runner | Already in devDependencies; use with temp directories |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `proper-lockfile` | `async-lock` | async-lock is in-process only; proper-lockfile works cross-process |
| `js-yaml` | `yaml` | yaml (eemeli) is more featureful but heavier; js-yaml is sufficient for config |
| `ulid` | `ulidx` | ulidx has more utils (decodeTime, isValid) but ulid is simpler and already installed |
| JSONL append | SQLite WAL | SQLite adds binary dependency; JSONL is human-readable, git-trackable, jq-queryable |

**Installation:**
```bash
npm install js-yaml zod
npm install -D @types/proper-lockfile @types/js-yaml
```

Note: `zod` is needed as a peer dependency for `@modelcontextprotocol/sdk`. The SDK internally imports from `zod/v4`.

## Architecture Patterns

### Recommended Project Structure
```
src/
├── index.ts                  # Entry point (parse args, start server)
├── server.ts                 # McpServer creation, tool registration, transport
├── config.ts                 # YAML config loading with defaults
├── storage/
│   ├── file-store.ts         # Low-level file I/O: readJSON, writeJSON, appendJSONL, readJSONL
│   ├── blackboard-store.ts   # Blackboard CRUD: append entry, read with filters
│   ├── decision-store.ts     # Decision CRUD: create, read, update status, index management
│   └── graph-store.ts        # (stub for Phase 1 — not implemented yet)
├── engine/
│   ├── blackboard.ts         # Business logic: validate entry, generate ID, delegate to store
│   ├── decisions.ts          # Business logic: validate decision, conflict check (stub), delegate
│   └── init.ts               # Directory initialization: create .twining/ structure
├── tools/
│   ├── blackboard-tools.ts   # registerTool() calls for post, read, query (stub), recent
│   ├── decision-tools.ts     # registerTool() calls for decide, why
│   └── lifecycle-tools.ts    # registerTool() call for status (basic version)
└── utils/
    ├── types.ts              # All TypeScript interfaces from design spec
    ├── ids.ts                # ULID generation wrapper
    ├── tokens.ts             # Token estimation (text.length / 4)
    └── errors.ts             # Structured error response helpers
```

### Pattern 1: MCP Server with Tool Registration
**What:** Create McpServer, register all tools with Zod schemas, connect via stdio
**When to use:** Server entry point
**Example:**
```typescript
// Source: MCP TypeScript SDK docs/server.md
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "twining-mcp",
  version: "1.0.0",
});

// Register tool with Zod input schema
server.registerTool("twining_post", {
  title: "Post to Blackboard",
  description: "Post an entry to the shared blackboard",
  inputSchema: {
    entry_type: z.enum(["need", "offer", "finding", "decision", "constraint",
      "question", "answer", "status", "artifact", "warning"]),
    summary: z.string().max(200),
    detail: z.string().optional(),
    tags: z.array(z.string()).optional(),
    scope: z.string().optional().default("project"),
    relates_to: z.array(z.string()).optional(),
    agent_id: z.string().optional().default("main"),
  },
}, async (args) => {
  try {
    const result = await blackboardEngine.post(args);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    return { content: [{ type: "text", text: JSON.stringify({ error: true, message: String(err) }) }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

### Pattern 2: File Store with Locking
**What:** Wrap all file operations in advisory locks using proper-lockfile
**When to use:** Every write to blackboard.jsonl, decision files, index.json
**Example:**
```typescript
// Source: proper-lockfile README + design spec requirements
import lockfile from "proper-lockfile";
import fs from "node:fs";
import path from "node:path";

async function appendJSONL(filePath: string, data: object): Promise<void> {
  const release = await lockfile.lock(filePath, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
    stale: 10000,
  });
  try {
    fs.appendFileSync(filePath, JSON.stringify(data) + "\n");
  } finally {
    await release();
  }
}

async function writeJSON(filePath: string, data: object): Promise<void> {
  const release = await lockfile.lock(filePath, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
    stale: 10000,
  });
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } finally {
    await release();
  }
}
```

### Pattern 3: JSONL Read with Streaming Filter
**What:** Read JSONL file line by line, parse each, apply filters
**When to use:** Blackboard reads with filters
**Example:**
```typescript
function readJSONL<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as T);
}
```

### Pattern 4: Structured Error Responses
**What:** Wrap all tool handlers in try/catch, return structured errors
**When to use:** Every tool handler
**Example:**
```typescript
function toolResult(data: object) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function toolError(message: string, code: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, message, code }) }] };
}
```

### Anti-Patterns to Avoid
- **console.log in stdio server:** Corrupts JSON-RPC on stdout. Use console.error for debugging or a file logger.
- **Direct fs calls from engine layer:** Always go through storage layer. Engine depends on storage, never on fs directly.
- **Throwing from tool handlers:** Uncaught exceptions crash the MCP connection. Always return structured error responses.
- **Synchronous lock operations:** Use async lock/unlock to avoid blocking the event loop during contention.
- **Reading entire JSONL into memory for every query:** For Phase 1 this is acceptable (<500 entries before archive), but design the interface so it can be optimized later.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| File locking | Custom lock files, flock wrappers | `proper-lockfile` | Handles staleness, cross-process, atomic mkdir, crash recovery |
| ULID generation | Custom timestamp + random | `ulid` package | Spec-compliant, monotonic option available, well-tested |
| Schema validation | Manual type checks in handlers | Zod schemas via MCP SDK | SDK does validation automatically; Zod gives type inference |
| YAML parsing | JSON config, custom parser | `js-yaml` | YAML is the design spec format; js-yaml handles all YAML 1.2 |
| MCP protocol | Custom JSON-RPC, custom stdio | `@modelcontextprotocol/sdk` | Protocol is complex; SDK handles framing, errors, capabilities |

**Key insight:** The MCP SDK handles the hardest parts (protocol framing, capability negotiation, transport abstraction). Focus implementation effort on the domain logic (blackboard, decisions) not the MCP wiring.

## Common Pitfalls

### Pitfall 1: Console.log Corrupts Stdio Transport
**What goes wrong:** Any `console.log()` writes to stdout, which is the JSON-RPC transport channel. Output gets mixed with protocol messages, breaking the connection.
**Why it happens:** Developers use console.log for debugging out of habit.
**How to avoid:** Use `console.error()` for all debugging output (writes to stderr). Or use a file-based logger. Set up an eslint rule to ban console.log.
**Warning signs:** MCP client shows "parse error" or connection drops.

### Pitfall 2: Lock File Left Behind After Crash
**What goes wrong:** If the process crashes (SIGKILL, OOM) while holding a lock, the `.lock` directory remains, blocking subsequent operations.
**Why it happens:** Process exit handlers don't run on SIGKILL.
**How to avoid:** proper-lockfile handles this via staleness detection — locks older than `stale` ms (default 10s) are considered abandoned and can be overtaken. Keep `stale` value reasonable (10-15s).
**Warning signs:** Operations hang or fail with "already locked" after a crash.

### Pitfall 3: JSONL Corruption from Partial Writes
**What goes wrong:** If the process crashes mid-write, the last line of the JSONL file may be incomplete, causing parse errors on read.
**Why it happens:** appendFileSync is not truly atomic — it can be interrupted.
**How to avoid:** When reading JSONL, wrap each line parse in try/catch and skip corrupt lines with a warning. This is defensive but prevents one bad line from losing all data.
**Warning signs:** JSON.parse errors when reading blackboard.

### Pitfall 4: Module Resolution with NodeNext
**What goes wrong:** TypeScript with `module: "nodenext"` requires explicit `.js` extensions in imports, even for `.ts` files.
**Why it happens:** NodeNext enforces Node.js ESM resolution rules.
**How to avoid:** Always use `.js` extensions in import paths: `import { foo } from "./bar.js"`. The TypeScript compiler resolves `.js` to `.ts` during compilation.
**Warning signs:** "Cannot find module" errors at runtime.

### Pitfall 5: package.json Type Mismatch
**What goes wrong:** Current `package.json` has `"type": "commonjs"` but `tsconfig.json` uses `"module": "nodenext"`. The MCP SDK uses ESM imports.
**Why it happens:** Project was initialized without ESM in mind.
**How to avoid:** Either change to `"type": "module"` in package.json (recommended for new projects) or ensure all imports/exports use CJS patterns. Since MCP SDK examples use ESM (`import`), switching to `"type": "module"` is recommended.
**Warning signs:** `ERR_REQUIRE_ESM` or `SyntaxError: Cannot use import statement` at runtime.

### Pitfall 6: Decision Index Race Condition
**What goes wrong:** Two concurrent decision writes both read index.json, add their entry, and write back — one write overwrites the other.
**Why it happens:** Read-modify-write cycle without locking.
**How to avoid:** Lock index.json before reading, modify, write, then release. Use the same lock for both the individual decision file write and the index update.
**Warning signs:** Missing decisions in index that exist as individual files.

## Code Examples

### Directory Initialization
```typescript
// Source: Design spec section 2.3
import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const DEFAULT_CONFIG = {
  version: 1,
  project_name: "",
  embedding_model: "all-MiniLM-L6-v2",
  archive: {
    auto_archive_on_commit: true,
    auto_archive_on_context_switch: true,
    max_blackboard_entries_before_archive: 500,
  },
  context_assembly: {
    default_max_tokens: 4000,
    priority_weights: {
      recency: 0.3,
      relevance: 0.4,
      decision_confidence: 0.2,
      warning_boost: 0.1,
    },
  },
  conflict_resolution: "human",
};

function initTwiningDir(projectRoot: string): void {
  const twiningDir = path.join(projectRoot, ".twining");
  if (fs.existsSync(twiningDir)) return;

  fs.mkdirSync(twiningDir, { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "graph"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "embeddings"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "archive"), { recursive: true });

  // Config
  const config = { ...DEFAULT_CONFIG, project_name: path.basename(projectRoot) };
  fs.writeFileSync(path.join(twiningDir, "config.yml"), yaml.dump(config));

  // Empty data files
  fs.writeFileSync(path.join(twiningDir, "blackboard.jsonl"), "");
  fs.writeFileSync(path.join(twiningDir, "decisions", "index.json"), "[]");
  fs.writeFileSync(path.join(twiningDir, "graph", "entities.json"), "[]");
  fs.writeFileSync(path.join(twiningDir, "graph", "relations.json"), "[]");

  // Gitignore
  fs.writeFileSync(path.join(twiningDir, ".gitignore"), "embeddings/*.index\narchive/\n");
}
```

### ULID Generation
```typescript
// Source: ulid npm package
import { ulid } from "ulid";

function generateId(): string {
  return ulid(); // e.g., "01ARZ3NDEKTSV4RRFFQ69G5FAV"
}
```

### Token Estimation
```typescript
// Source: Design spec section 10.4
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

### Decision Store with Index
```typescript
// Source: Design spec sections 3.2, 2.2
import lockfile from "proper-lockfile";

async function createDecision(
  decisionsDir: string,
  decision: Decision
): Promise<void> {
  const filePath = path.join(decisionsDir, `${decision.id}.json`);
  const indexPath = path.join(decisionsDir, "index.json");

  // Lock index for atomic read-modify-write
  const release = await lockfile.lock(indexPath, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
    stale: 10000,
  });
  try {
    // Write individual decision file
    fs.writeFileSync(filePath, JSON.stringify(decision, null, 2));

    // Update index
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    index.push({
      id: decision.id,
      timestamp: decision.timestamp,
      domain: decision.domain,
      scope: decision.scope,
      summary: decision.summary,
      confidence: decision.confidence,
      status: decision.status,
    });
    fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  } finally {
    await release();
  }
}
```

### Server Entry Point
```typescript
// Source: MCP SDK docs + design spec section 10.7
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

async function main() {
  const server = new McpServer({
    name: "twining-mcp",
    version: "1.0.0",
  });

  // Register all tools (from tools/ modules)
  registerBlackboardTools(server);
  registerDecisionTools(server);
  registerLifecycleTools(server);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| MCP SDK `server.tool()` | `server.registerTool()` | SDK v1.20+ | registerTool is the recommended API; tool() is legacy |
| Zod v3 schemas | Zod v4 (via `zod/v4` import) | 2025 | MCP SDK internally uses zod/v4; 14x faster parsing |
| Manual JSON-RPC | `StdioServerTransport` | MCP SDK v1.0+ | Handles framing, errors, capabilities automatically |
| CJS require() | ESM imports | Node 18+ | Modern projects should use `"type": "module"` |

**Deprecated/outdated:**
- `server.tool()` — Still works but `registerTool()` is preferred
- SSE transport — Deprecated in favor of Streamable HTTP (not relevant for Phase 1)

## Open Questions

1. **package.json type field**
   - What we know: Current package.json has `"type": "commonjs"`, but MCP SDK uses ESM imports
   - What's unclear: Whether the existing project setup expects CJS or if this is just a default
   - Recommendation: Switch to `"type": "module"` since all MCP SDK examples use ESM and tsconfig already has `"module": "nodenext"`

2. **Zod peer dependency version**
   - What we know: MCP SDK requires zod as peer dep and uses `zod/v4` internally; zod v3.25+ has backwards-compatible v4 import paths
   - What's unclear: Whether to install zod v3.25+ or v4.x
   - Recommendation: Install latest zod (v3.25+) which provides the `zod/v4` import path the SDK needs

3. **Decision index format**
   - What we know: Design spec says `index.json` with "summaries + metadata for fast lookup"
   - What's unclear: Whether the index should be an array or a map keyed by ID
   - Recommendation: Use an array (matches the `[]` empty default), but consider a map if lookup-by-ID is frequent

## Sources

### Primary (HIGH confidence)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — server.md, README, registerTool API
- [MCP SDK docs/server.md](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md) — Tool registration patterns
- [proper-lockfile GitHub](https://github.com/moxystudio/node-proper-lockfile) — Full API, options, design rationale
- [TWINING-DESIGN-SPEC.md](./TWINING-DESIGN-SPEC.md) — Authoritative data models, tool signatures, architecture

### Secondary (MEDIUM confidence)
- [Zod v4 release notes](https://zod.dev/v4) — Version compatibility, import paths
- [ulid npm](https://www.npmjs.com/package/ulid) — API usage
- [Vitest docs](https://vitest.dev/guide/) — Test configuration

### Tertiary (LOW confidence)
- None — all findings verified against primary sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all libraries already in package.json or well-documented
- Architecture: HIGH — design spec is authoritative and detailed
- Pitfalls: HIGH — verified against official docs (stdio warning, proper-lockfile staleness, ESM resolution)

**Research date:** 2026-02-16
**Valid until:** 2026-03-16 (stable ecosystem, no fast-moving dependencies)
