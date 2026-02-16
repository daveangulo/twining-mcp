# Architecture Patterns

**Domain:** MCP server with file-based state, embedded semantic search, and multi-agent coordination
**Researched:** 2026-02-16

---

## Recommended Architecture

Twining is a **layered architecture with dependency injection**, following the same structural conventions observed in the official MCP memory server but extended with an additional engine layer to accommodate business logic complexity. The design spec already prescribes this architecture; the research below validates it and adds precision on component boundaries, data flow, and build order.

### High-Level Architecture (Validated)

```
                      ┌──────────────────────────┐
                      │   MCP Protocol Surface    │
                      │   (StdioServerTransport)  │
                      └────────────┬─────────────┘
                                   │
                      ┌────────────┴─────────────┐
                      │   McpServer (SDK v1.26+)  │
                      │   registerTool() per tool │
                      └────────────┬─────────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                     │
    ┌─────────┴──────┐  ┌────────┴────────┐  ┌────────┴────────┐
    │  Tools Layer    │  │  Tools Layer    │  │  Tools Layer    │
    │  (blackboard,   │  │  (decision,     │  │  (context,      │
    │   lifecycle)    │  │   graph)        │  │   lifecycle)    │
    └─────────┬──────┘  └────────┬────────┘  └────────┬────────┘
              │                  │                     │
              └─────────┬────────┴─────────┬───────────┘
                        │                  │
              ┌─────────┴──────┐  ┌────────┴────────┐
              │  Engine Layer   │  │  Embeddings     │
              │  (blackboard,   │  │  (lazy-loaded,  │
              │   decisions,    │  │   fallback to   │
              │   graph,        │  │   keyword)      │
              │   assembler,    │  │                 │
              │   archiver)     │  └────────┬────────┘
              └─────────┬──────┘           │
                        │                  │
              ┌─────────┴──────────────────┴────────┐
              │         Storage Layer                │
              │  (file-store, blackboard-store,      │
              │   decision-store, graph-store)        │
              └─────────────────┬────────────────────┘
                                │
              ┌─────────────────┴────────────────────┐
              │          File System (.twining/)      │
              │  blackboard.jsonl, decisions/*.json,  │
              │  graph/*.json, embeddings/*.index     │
              └──────────────────────────────────────┘
```

### Component Boundaries

| Component | Responsibility | Communicates With | Never Touches |
|-----------|---------------|-------------------|---------------|
| `src/index.ts` | Entry point: create McpServer, connect StdioServerTransport, register all tools | server.ts, config.ts | Storage directly |
| `src/server.ts` | Tool registration orchestration. Creates engine instances, wires tool handlers to McpServer.registerTool() | McpServer SDK, tools/, engine/, config | File system |
| `src/config.ts` | Load .twining/config.yml, merge defaults, provide typed config | storage/file-store (for reading config file) | Engine logic |
| `src/tools/*-tools.ts` | Thin adapters: validate MCP input, call engine, format MCP output. One file per tool group. | engine/ layer only | Storage directly, file system |
| `src/engine/blackboard.ts` | Blackboard business logic: post entries, filter, query | storage/blackboard-store, embeddings/ | File system directly |
| `src/engine/decisions.ts` | Decision logic: create, supersede, conflict detection, trace dependency chains | storage/decision-store, engine/blackboard (for posting cross-references) | File system directly |
| `src/engine/graph.ts` | Graph traversal: neighbors, path finding, entity/relation management | storage/graph-store | File system directly |
| `src/engine/context-assembler.ts` | Build tailored context packages: score, rank, fill token budget | engine/blackboard, engine/decisions, engine/graph, embeddings/search | Storage directly |
| `src/engine/archiver.ts` | Move old entries to archive, rebuild indexes, post summaries | storage/blackboard-store, storage/file-store, embeddings/index-manager | External services |
| `src/embeddings/embedder.ts` | ONNX model loading + inference. Lazy singleton. Graceful fallback. | onnxruntime-node (native), model files | Storage layer |
| `src/embeddings/index-manager.ts` | CRUD for embedding index JSON files | storage/file-store | Engine logic |
| `src/embeddings/search.ts` | Cosine similarity search over index | embeddings/index-manager, embeddings/embedder | Storage layer |
| `src/storage/file-store.ts` | Primitive file I/O: read/write JSON, read/append JSONL, advisory locking via proper-lockfile | Node.js fs, proper-lockfile | Business logic |
| `src/storage/blackboard-store.ts` | Blackboard CRUD: append entry, read all, read filtered | storage/file-store | Engine logic |
| `src/storage/decision-store.ts` | Decision CRUD: write decision file, update index, read by ID/scope | storage/file-store | Engine logic |
| `src/storage/graph-store.ts` | Graph CRUD: read/write entities.json and relations.json | storage/file-store | Engine logic |
| `src/utils/types.ts` | Shared TypeScript interfaces for all data models | Nothing (leaf module) | Everything |
| `src/utils/ids.ts` | ULID generation wrapper | ulid package | Everything |
| `src/utils/tokens.ts` | Token estimation (text.length / 4) | Nothing (pure function) | Everything |

### Dependency Direction (Strict)

```
tools/ --> engine/ --> storage/ --> file system
             |
             +--> embeddings/ --> storage/ --> file system
```

**Rule:** Dependencies flow downward only. No layer may import from a layer above it. The tools layer never imports from storage. The engine layer never imports from tools. This is the single most important architectural constraint.

---

## Data Flow

### Write Path: Posting a Blackboard Entry

```
1. Claude calls twining_post via MCP protocol (JSON-RPC over stdio)
2. McpServer deserializes, validates input against Zod schema
3. blackboard-tools.ts handler receives validated args
4. Handler calls engine/blackboard.ts.postEntry(args)
5. Engine generates ULID, constructs full BlackboardEntry
6. Engine calls storage/blackboard-store.ts.append(entry)
7. Store calls file-store.ts.appendJsonl(".twining/blackboard.jsonl", entry)
8. file-store acquires lock via proper-lockfile, appends, releases lock
9. Engine calls embeddings/embedder.ts.embed(summary + detail)
   - If embedder initialized: generates 384-dim vector
   - If embedder NOT initialized: lazy-loads ONNX model first
   - If ONNX fails: logs warning, skips embedding (keyword fallback)
10. Engine calls embeddings/index-manager.ts.add(entry.id, vector)
11. Handler returns { id, timestamp } to McpServer
12. McpServer serializes response back over stdio
```

### Read Path: Semantic Query

```
1. Claude calls twining_query("authentication patterns")
2. blackboard-tools.ts handler receives args
3. Handler calls engine/blackboard.ts.query(queryText, filters)
4. Engine calls embeddings/search.ts.search(queryText, limit)
5. Search calls embedder.embed(queryText) to get query vector
6. Search loads embedding index, computes cosine similarity against all entries
7. Search returns ranked entry IDs with relevance scores
8. Engine calls storage/blackboard-store.ts to load full entries for top IDs
9. Handler returns scored results
```

### Complex Path: Context Assembly

```
1. Claude calls twining_assemble({ task, scope, max_tokens })
2. context-tools.ts handler calls engine/context-assembler.ts.assemble(args)
3. Assembler queries multiple sources IN PARALLEL:
   a. decisions.getActiveForScope(scope) -- decisions affecting this scope
   b. blackboard.query(task) -- semantically relevant entries
   c. blackboard.getByTypes(["need","warning","question"], scope) -- open items in scope
   d. graph.getNeighbors(scope) -- related entities
4. Assembler scores each item using weighted formula:
   score = recency * w1 + relevance * w2 + confidence * w3 + warning_boost * w4
5. Assembler fills token budget in priority order (4 chars/token estimate)
6. Returns AssembledContext (ephemeral, not stored)
```

### Side-Effect Path: Recording a Decision

```
1. twining_decide is called
2. decision-tools.ts -> engine/decisions.ts.decide(args)
3. Engine checks for conflicts (same domain + scope, different summary)
4. IF conflict: posts warning to blackboard, marks new decision provisional
5. Engine writes decision file to .twining/decisions/{ulid}.json
6. Engine updates decisions/index.json with summary metadata
7. Engine posts "decision" type entry to blackboard (cross-reference)
8. Engine generates embedding for decision content
9. Engine creates/updates graph entities for affected files with "decided_by" relations
10. Returns { id, timestamp, conflict_info? }
```

---

## Patterns to Follow

### Pattern 1: Singleton Service Registry

**What:** Create engine and storage instances once during server startup, inject them into tool handlers.

**When:** Always. This avoids creating new instances per request and ensures shared state (like the lazy-loaded embedder) is consistent.

**Example:**

```typescript
// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function createServer(projectRoot: string): McpServer {
  const server = new McpServer({
    name: "twining-mcp",
    version: "1.0.0"
  });

  // Create storage layer
  const fileStore = new FileStore(projectRoot);
  const blackboardStore = new BlackboardStore(fileStore);
  const decisionStore = new DecisionStore(fileStore);
  const graphStore = new GraphStore(fileStore);

  // Create embedding layer (lazy - does not load model yet)
  const embedder = new Embedder(projectRoot);
  const indexManager = new IndexManager(fileStore);
  const search = new EmbeddingSearch(embedder, indexManager);

  // Create engine layer
  const blackboard = new BlackboardEngine(blackboardStore, search);
  const decisions = new DecisionEngine(decisionStore, blackboard, search);
  const graph = new GraphEngine(graphStore);
  const assembler = new ContextAssembler(blackboard, decisions, graph, search);
  const archiver = new Archiver(blackboardStore, fileStore, indexManager);

  // Register tools - each group gets its engine dependencies
  registerBlackboardTools(server, blackboard);
  registerDecisionTools(server, decisions);
  registerContextTools(server, assembler);
  registerGraphTools(server, graph);
  registerLifecycleTools(server, archiver, blackboard);

  return server;
}
```

### Pattern 2: registerTool() with Zod Schemas

**What:** Use the SDK's `registerTool()` method (not the deprecated `tool()` method) with Zod v4 schemas for input validation.

**When:** For every tool registration.

**Why:** The SDK v1.26+ prefers `registerTool()`. The deprecated `tool()` overloads are confusing and will be removed. Zod v4 (4.3.6 installed) is the correct version for the current SDK.

**Example:**

```typescript
// src/tools/blackboard-tools.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BlackboardEngine } from "../engine/blackboard.js";

export function registerBlackboardTools(
  server: McpServer,
  blackboard: BlackboardEngine
): void {
  server.registerTool("twining_post", {
    description: "Post an entry to the shared blackboard",
    inputSchema: {
      entry_type: z.enum([
        "need", "offer", "finding", "decision",
        "constraint", "question", "answer",
        "status", "artifact", "warning"
      ]),
      summary: z.string().max(200),
      detail: z.string().optional(),
      tags: z.array(z.string()).optional(),
      scope: z.string().default("project"),
      relates_to: z.array(z.string()).optional(),
      agent_id: z.string().default("main"),
    },
  }, async (args) => {
    const result = await blackboard.postEntry(args);
    return {
      content: [{
        type: "text",
        text: JSON.stringify(result)
      }]
    };
  });
}
```

### Pattern 3: Lazy Singleton for Expensive Resources

**What:** The ONNX embedder initializes on first use, not at server startup. Uses a promise-based singleton to handle concurrent first-call races.

**When:** For the embedding system specifically.

**Why:** The ONNX model is ~23MB and takes time to load. The server must start instantly. Multiple concurrent first-time embedding requests must not trigger multiple model loads.

**Example:**

```typescript
// src/embeddings/embedder.ts
export class Embedder {
  private initPromise: Promise<InferenceSession> | null = null;
  private session: InferenceSession | null = null;
  private available: boolean = true;

  async embed(text: string): Promise<number[] | null> {
    if (!this.available) return null;

    try {
      const session = await this.getSession();
      // ... run inference
      return vector;
    } catch (err) {
      console.error("Embedding failed, falling back to keyword search:", err);
      this.available = false;
      return null;
    }
  }

  private getSession(): Promise<InferenceSession> {
    if (this.session) return Promise.resolve(this.session);
    if (!this.initPromise) {
      // Single initialization promise - concurrent calls share this
      this.initPromise = this.initialize();
    }
    return this.initPromise;
  }

  private async initialize(): Promise<InferenceSession> {
    // Download model if needed, create session
    // Set this.session on success
    // On failure, set this.available = false and throw
  }
}
```

### Pattern 4: Lock-Protected File Operations

**What:** All writes to shared state files (blackboard.jsonl, decision index, graph files) are wrapped in advisory locks using proper-lockfile.

**When:** Every write operation in the storage layer.

**Why:** Multiple Claude agents (main session + subagents) may call MCP tools concurrently. Without locking, JSONL appends can interleave and corrupt data. Proper-lockfile uses `mkdir` strategy which is atomic on all file systems.

**Example:**

```typescript
// src/storage/file-store.ts
import lockfile from "proper-lockfile";

export class FileStore {
  async appendJsonl(filePath: string, entry: unknown): Promise<void> {
    const release = await lockfile.lock(filePath, {
      retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
      stale: 10000,
    });
    try {
      await fs.appendFile(filePath, JSON.stringify(entry) + "\n");
    } finally {
      await release();
    }
  }

  async writeJson(filePath: string, data: unknown): Promise<void> {
    const release = await lockfile.lock(filePath, {
      retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
      stale: 10000,
    });
    try {
      // Write to temp file, then atomic rename
      const tmpPath = filePath + ".tmp";
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2));
      await fs.rename(tmpPath, filePath);
    } finally {
      await release();
    }
  }
}
```

### Pattern 5: Structured Error Returns (Never Throw)

**What:** Tool handlers catch all errors and return structured error objects. The MCP tool surface never crashes.

**When:** Every tool handler.

**Why:** The design spec mandates this. A crashed tool handler breaks the entire MCP connection. Structured errors let Claude understand what went wrong and potentially retry.

**Example:**

```typescript
// In tool handler
async (args) => {
  try {
    const result = await engine.doThing(args);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          error: true,
          message: err instanceof Error ? err.message : String(err),
          code: classifyError(err),
        })
      }],
      isError: true,
    };
  }
}
```

### Pattern 6: Directory Auto-Initialization

**What:** On first tool call, check for `.twining/` and create it with defaults if missing.

**When:** During the first operation that touches the file system.

**Why:** Zero-config progressive adoption. Users should not need to run an init command.

**Example:**

```typescript
// src/storage/file-store.ts
export class FileStore {
  private initialized = false;

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const twinDir = path.join(this.projectRoot, ".twining");
    if (!await exists(twinDir)) {
      await fs.mkdir(twinDir, { recursive: true });
      await fs.mkdir(path.join(twinDir, "decisions"));
      await fs.mkdir(path.join(twinDir, "graph"));
      await fs.mkdir(path.join(twinDir, "embeddings"));
      await fs.mkdir(path.join(twinDir, "archive"));
      await this.writeDefaultConfig(twinDir);
      await this.writeDefaultGitignore(twinDir);
      // Create empty data files
      await fs.writeFile(path.join(twinDir, "blackboard.jsonl"), "");
      await fs.writeFile(path.join(twinDir, "decisions", "index.json"), "[]");
      await fs.writeFile(path.join(twinDir, "graph", "entities.json"), "[]");
      await fs.writeFile(path.join(twinDir, "graph", "relations.json"), "[]");
    }
    this.initialized = true;
  }
}
```

---

## Anti-Patterns to Avoid

### Anti-Pattern 1: Engine Logic in Tool Handlers

**What:** Putting business logic (conflict detection, graph traversal, scoring) directly in tool handler files.

**Why bad:** Tool handlers become untestable monoliths. The same logic cannot be reused (e.g., `twining_decide` needs to post to the blackboard - if blackboard logic is in the tool handler, the decision engine cannot call it).

**Instead:** Tool handlers are thin adapters: validate input, call engine, format output. All logic lives in engine/.

### Anti-Pattern 2: Direct File System Access from Engine

**What:** Engine modules calling `fs.readFile()` or `fs.writeFile()` directly.

**Why bad:** Breaks testability (tests need real file system), breaks the locking strategy (bypasses proper-lockfile), and creates hidden coupling.

**Instead:** Engine accesses data only through storage/ interfaces. Tests can mock the storage layer.

### Anti-Pattern 3: Eager ONNX Initialization

**What:** Importing onnxruntime-node at the top level or creating InferenceSession during server startup.

**Why bad:** Server startup is blocked until model loads (~2-5 seconds). If ONNX is not available on the platform (e.g., unsupported architecture), the server fails to start entirely.

**Instead:** Dynamic import `await import("onnxruntime-node")` inside the lazy initializer. Wrap in try/catch. Set a flag when ONNX is unavailable and fall back to keyword matching.

### Anti-Pattern 4: God Object Server Module

**What:** Putting all tool registration, engine creation, and configuration in a single large server.ts file.

**Why bad:** The design spec defines 18+ tool handlers across 5 tool groups. A single file would be 1000+ lines and unmaintainable.

**Instead:** server.ts creates instances and calls `registerXTools(server, engine)` functions from separate files. Each tool group file is self-contained and independently testable.

### Anti-Pattern 5: Shared Mutable State Without Coordination

**What:** Multiple engine modules reading and writing the same files (e.g., decisions.ts writing to blackboard.jsonl directly instead of going through blackboard engine).

**Why bad:** Bypasses locking, breaks single-responsibility, creates race conditions.

**Instead:** Cross-cutting operations go through the proper engine. `decisions.ts` calls `blackboard.postEntry()`, not `blackboardStore.append()` directly.

### Anti-Pattern 6: Synchronous File I/O

**What:** Using `fs.readFileSync()` or `lockfile.lockSync()` anywhere in the codebase.

**Why bad:** MCP servers handle requests over stdio. Synchronous I/O blocks the event loop, preventing the server from processing other messages. With multiple concurrent agents, this creates artificial serialization.

**Instead:** All file operations are async. Use `fs.promises` (or the `node:fs/promises` module) everywhere.

---

## Scalability Considerations

| Concern | At 100 entries | At 1K entries | At 10K entries |
|---------|---------------|---------------|----------------|
| Blackboard read | Negligible - read full JSONL | ~50ms - full file scan | Consider index/pagination |
| Embedding search | Brute-force cosine sim, <1ms | ~10ms brute-force | ~100ms - may need ANN index |
| Decision index | In-memory JSON array, instant | Fine, index.json ~100KB | Fine, individual files help |
| Graph traversal | In-memory, instant | In-memory, <10ms | May need adjacency index |
| File locking | No contention | Rare contention | Moderate contention on blackboard.jsonl |
| Archiving | Not needed | Optional | Required regularly |

**Key insight:** The design spec's archiving strategy (keep blackboard under 500 entries) is the primary scalability mechanism. At 500 entries, brute-force cosine similarity over 384-dim vectors takes ~5ms, which is acceptable. Archiving before hitting 10K entries avoids the need for ANN indexing.

---

## Build Order and Dependencies

The build order follows the dependency graph bottom-up. Each layer can be fully tested before the layer above it is built.

### Phase 1: Foundation (no dependencies)
```
src/utils/types.ts      -- All interfaces from the design spec
src/utils/ids.ts        -- ULID generation wrapper
src/utils/tokens.ts     -- Token estimation function
```
**Test strategy:** Unit tests for id uniqueness/sortability, token estimation accuracy.

### Phase 2: Storage Layer (depends on: utils)
```
src/storage/file-store.ts       -- File I/O + locking primitives
src/storage/blackboard-store.ts -- Blackboard CRUD on top of file-store
src/storage/decision-store.ts   -- Decision CRUD on top of file-store
src/storage/graph-store.ts      -- Graph CRUD on top of file-store
src/config.ts                   -- Config loading (uses file-store)
```
**Build order within phase:** file-store first (it is the foundation), then the three domain stores in any order, then config.

**Test strategy:** Each store tested with vitest using temp directories. Verify locking behavior by simulating concurrent appends.

### Phase 3: Engine Layer (depends on: storage, utils)
```
src/engine/blackboard.ts         -- Blackboard logic (no embeddings yet)
src/engine/decisions.ts          -- Decision logic + conflict detection
src/engine/graph.ts              -- Graph traversal
src/engine/archiver.ts           -- Archive logic
```
**Build order within phase:** blackboard first (decisions cross-references it), then decisions, graph, archiver in any order.

**Test strategy:** Mock storage layer. Test business logic independently.

### Phase 4: Embeddings Layer (depends on: storage, utils)
```
src/embeddings/embedder.ts       -- ONNX lazy loading + fallback
src/embeddings/index-manager.ts  -- Embedding index CRUD
src/embeddings/search.ts         -- Cosine similarity search
```
**Build order within phase:** embedder first, then index-manager, then search.

**Test strategy:** Test with mock vectors (not real ONNX) for unit tests. One integration test with real model.

### Phase 5: Wire Embeddings into Engine
```
Update engine/blackboard.ts to use embeddings on post
Update engine/decisions.ts to use embeddings on decide
src/engine/context-assembler.ts  -- Full context assembly (needs all engines + search)
```
**Why separate phase:** Context assembler depends on everything. Embeddings integration into blackboard/decisions is a cross-cutting concern. Separating this avoids premature coupling during initial engine development.

### Phase 6: Tool Handlers (depends on: engine, embeddings)
```
src/tools/blackboard-tools.ts
src/tools/decision-tools.ts
src/tools/context-tools.ts
src/tools/graph-tools.ts
src/tools/lifecycle-tools.ts
```
**Build order within phase:** Any order. Each is independent.

**Test strategy:** Integration tests calling tool handlers with real (temp dir) storage. Verify full request/response cycle.

### Phase 7: Server Wiring (depends on: tools, engine, config)
```
src/server.ts    -- Service registry, tool registration orchestration
src/index.ts     -- Entry point, transport connection
```
**Test strategy:** Full end-to-end integration test. Start server, send MCP messages, verify responses.

---

## Module Resolution and TypeScript Configuration

**Important:** The tsconfig uses `"module": "nodenext"` and `"verbatimModuleSyntax": true`. This means:

1. All imports must include `.js` extensions (even for `.ts` files): `import { FileStore } from "./storage/file-store.js"`
2. Use `import type { ... }` for type-only imports
3. Package.json has `"type": "commonjs"` but tsconfig uses `"module": "nodenext"` -- this needs alignment. Recommend changing package.json to `"type": "module"` for ESM, or adjust tsconfig to `"module": "commonjs"`. The MCP SDK publishes both CJS and ESM builds. Given the project uses Zod v4 (which is ESM-first), **recommend ESM** by setting `"type": "module"` in package.json.

---

## Key Architectural Decisions from Design Spec (Validated)

| Decision | Rationale | Confidence |
|----------|-----------|------------|
| Stdio transport, not HTTP | Claude Code connects to local MCP servers via stdio. No need for HTTP complexity. | HIGH - verified against SDK docs |
| JSONL for blackboard, JSON for everything else | Append-only JSONL avoids read-modify-write for the highest-write-frequency store. JSON files for decisions/graph allow atomic replacement. | HIGH - standard pattern |
| proper-lockfile for concurrency | Advisory locking using mkdir strategy works cross-platform. Sufficient for MCP server load (not database-level concurrency). | HIGH - verified |
| Brute-force cosine similarity | At <500 entries (enforced by archiving), brute-force is faster than ANN index overhead. | HIGH - math checks out |
| ULID for IDs | Temporally sortable, no coordination needed between agents. Lexicographic sort = temporal sort. | HIGH - well-established |
| Zod v4 for schema validation | SDK v1.26+ uses Zod for tool input schemas. Zod v4.3.6 installed, compatible. | HIGH - verified in node_modules |

---

## Sources

- [MCP TypeScript SDK - GitHub](https://github.com/modelcontextprotocol/typescript-sdk) -- HIGH confidence, primary source
- [MCP SDK server.md documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md) -- HIGH confidence, official docs
- [MCP Memory Server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) -- HIGH confidence, reference implementation
- [proper-lockfile - npm](https://www.npmjs.com/package/proper-lockfile) -- HIGH confidence, verified API
- [all-MiniLM-L6-v2 ONNX](https://huggingface.co/Xenova/all-MiniLM-L6-v2) -- HIGH confidence, model source
- [Blackboard Pattern for Multi-Agent Systems](https://medium.com/@dp2580/building-intelligent-multi-agent-systems-with-mcps-and-the-blackboard-pattern-to-build-systems-a454705d5672) -- MEDIUM confidence, pattern validation
- [Cosine Similarity TypeScript Implementation](https://alexop.dev/posts/how-to-implement-a-cosine-similarity-function-in-typescript-for-vector-comparison/) -- MEDIUM confidence, implementation reference
- [Node.js File Locking](https://blog.logrocket.com/understanding-node-js-file-locking/) -- MEDIUM confidence, pattern validation
- Installed SDK type definitions at `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` -- HIGH confidence, verified locally
