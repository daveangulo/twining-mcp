# Technology Stack

**Project:** Twining MCP Server
**Researched:** 2026-02-16
**Overall confidence:** HIGH -- the design spec already prescribes most choices and they are verified as current.

## Recommended Stack

### Core Framework

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `@modelcontextprotocol/sdk` | ^1.26.0 | MCP server framework, tool registration, transport | The official TypeScript SDK. Provides `McpServer`, `StdioServerTransport`, and `registerTool()` with Zod schema validation. Actively maintained, 25k+ downstream packages, supports MCP spec 2025-11-25. Already installed. | HIGH |
| TypeScript | ^5.9.3 | Language | Required by design spec. Latest stable. Already installed. | HIGH |
| Node.js | >=18 | Runtime | Design spec minimum. Recommend targeting Node 20+ for stable `fs/promises`, structured clone, and onnxruntime compatibility. | HIGH |

### Schema Validation

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `zod` | ^3.25 or ^4.0 | Input schema validation for MCP tools | Required peer dependency of `@modelcontextprotocol/sdk`. Already installed transitively as 4.3.6. The SDK accepts `^3.25 \|\| ^4.0`. Use Zod 4 since it ships with the SDK and is the current standard. Do NOT install separately unless you need to pin a version -- the SDK bundles it. | HIGH |

### Embeddings & Semantic Search

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `onnxruntime-node` | ^1.24.1 | ONNX model inference for local embeddings | Prescribed by design spec. Runs all-MiniLM-L6-v2 (~23MB) locally with zero API calls. Supports Apple Silicon (darwin/arm64), Linux x64, Windows x64. Latest 1.24.1 includes performance improvements. | HIGH |
| all-MiniLM-L6-v2 (ONNX format) | - | Embedding model | 384-dimensional embeddings, ~23MB ONNX file. Download from HuggingFace on first use. The `Xenova/all-MiniLM-L6-v2` repo has pre-converted ONNX weights. Max 256 tokens input, best under 128 tokens -- perfect for short summaries and rationales. | HIGH |

**Tokenization approach:** Use the model's `tokenizer.json` vocabulary file directly with a lightweight custom tokenizer implementation, OR use the `tokenizers` npm package (v0.13.3) which provides native Rust-backed tokenization via N-API bindings. The custom approach is preferable because `tokenizers` has native binary dependencies that complicate cross-platform distribution, and for this use case we only need WordPiece tokenization with a fixed vocabulary. The design spec already prescribes token estimation at 4 chars/token for budget management -- full tokenization is only needed for model input.

### ID Generation

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `ulid` | ^3.0.2 | Temporally sortable unique IDs | Prescribed by design spec. ULIDs are lexicographically sortable by creation time, eliminating the need to parse timestamps for temporal ordering. 3.0.2 is current and stable. Already installed. | HIGH |

### File Locking

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `proper-lockfile` | ^4.1.2 | Advisory file locking for concurrent agent access | Prescribed by design spec. Uses atomic `mkdir` strategy that works on local and network file systems. Handles stale lock detection via mtime monitoring. 4.1.2 is the latest and final version (stable, no recent changes needed). Already installed. | HIGH |
| `@types/proper-lockfile` | ^4.1.4 | TypeScript type definitions | proper-lockfile does not ship its own types. Required for TypeScript strict mode. | HIGH |

### Configuration

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `js-yaml` | ^4.1.1 | Parse `.twining/config.yml` | The design spec uses YAML for configuration. js-yaml is the most popular YAML parser (80M+ weekly downloads), fast for reading, minimal API surface. The `yaml` package is more feature-rich but heavier and slower for simple parsing. We only need read support for a small config file. | MEDIUM |
| `@types/js-yaml` | latest | TypeScript type definitions | js-yaml does not ship its own types. | MEDIUM |

**Alternative considered:** Could use JSON for config instead of YAML, which would eliminate this dependency entirely. However, the design spec explicitly uses `config.yml` with YAML syntax, so we follow it.

### Testing

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| `vitest` | ^4.0.18 | Test runner | First-class TypeScript and ESM support. Jest-compatible API. Built-in coverage via v8 provider. Fast watch mode. Already installed. Vitest 4 is the current stable (released Oct 2025). | HIGH |

### Build & Dev Tooling

| Technology | Version | Purpose | Why | Confidence |
|------------|---------|---------|-----|------------|
| TypeScript | ^5.9.3 | Compiler | Already installed. Compile to `dist/` with `module: "nodenext"`, `target: "esnext"`. | HIGH |
| `@types/node` | ^25.2.3 | Node.js type definitions | Already installed as devDependency. | HIGH |

## What NOT to Use

| Technology | Why Not |
|------------|---------|
| `@huggingface/transformers` | 48MB unpacked, pulls in `sharp` (image processing -- unnecessary), `onnxruntime-web` (browser runtime -- unnecessary), and `@huggingface/jinja`. Pins `onnxruntime-node` to 1.21.0 (stale). Overkill for running a single embedding model. Use `onnxruntime-node` directly with a custom tokenizer -- it is more work but keeps the dependency tree minimal and the ONNX version current. |
| `@xenova/transformers` | Deprecated in favor of `@huggingface/transformers`. Same bloat problems. |
| `tokenizers` (npm) | Native Rust bindings via N-API. Cross-platform compilation complexity. For WordPiece tokenization of short text with a fixed vocabulary, a 50-line custom implementation reading `tokenizer.json` is simpler and more portable. |
| `sqlite3` / `better-sqlite3` | The design spec explicitly requires file-native storage (JSONL, JSON). SQLite adds a native binary dependency and violates the "jq-queryable, git-trackable, human-inspectable" principle. |
| `fastmcp` | Third-party MCP framework. The official `@modelcontextprotocol/sdk` is sufficient and authoritative. FastMCP adds abstraction without clear benefit for this project. |
| `express` / `hono` | No HTTP server needed. Twining is a stdio MCP server spawned by Claude Code. The SDK's `StdioServerTransport` handles all communication. (Note: express is a transitive dependency of the MCP SDK for its HTTP transport support -- it is not used by our code.) |
| `yaml` (npm package) | More features than needed, slower than js-yaml for simple config reading. We only parse a small config file. |
| `uuid` / `nanoid` | ULIDs provide temporal sortability that UUIDs and nanoids lack. The design spec requires ULIDs. |
| `node-fetch` / `axios` | No HTTP client needed. The ONNX model file can be downloaded using Node.js built-in `https` module or `fetch` (available in Node 18+). |
| `winston` / `pino` | No logging framework needed. MCP servers communicate structured responses. Use `console.error` for stderr debug output (stdout is reserved for MCP stdio transport). The SDK provides `ctx.mcpReq.log()` for structured logging to the MCP client. |

## Alternatives Considered

| Category | Recommended | Alternative | Why Not Alternative |
|----------|-------------|-------------|---------------------|
| Embedding runtime | `onnxruntime-node` direct | `@huggingface/transformers` | 48MB bloat, stale onnxruntime pin, unnecessary deps (sharp, onnxruntime-web) |
| Tokenization | Custom WordPiece from `tokenizer.json` | `tokenizers` npm package | Native binary dependency, cross-platform complexity for simple use case |
| YAML parsing | `js-yaml` | `yaml` npm package | Heavier, slower for reads, more features than needed |
| YAML parsing | `js-yaml` | JSON config instead | Design spec prescribes YAML |
| File locking | `proper-lockfile` | `lockfile` (npm) | Uses `O_EXCL` which fails on network FS; no stale detection |
| IDs | `ulid` | `ulidx` | `ulid` is the original, well-maintained, and already in package.json |
| Testing | `vitest` | `jest` | Vitest has native ESM/TS support without babel config. Already installed. |

## tsconfig.json Assessment

The existing `tsconfig.json` needs adjustments for this project:

```jsonc
{
  "compilerOptions": {
    "rootDir": "./src",        // UNCOMMENT -- needed for build output structure
    "outDir": "./dist",        // UNCOMMENT -- compile to dist/
    "module": "nodenext",      // KEEP -- correct for Node.js MCP servers
    "target": "esnext",        // KEEP -- Node 18+ supports latest ES features
    "lib": ["esnext"],         // ADD -- target Node.js runtime
    "types": ["node"],         // CHANGE -- need Node.js types
    "strict": true,            // KEEP
    "sourceMap": true,         // KEEP -- useful for debugging
    "declaration": true,       // KEEP -- needed if publishing
    "declarationMap": true,    // KEEP
    "noUncheckedIndexedAccess": true,  // KEEP -- good for JSON data access safety
    "skipLibCheck": true,      // KEEP -- speeds up compilation
    "jsx": "react-jsx",       // REMOVE -- no JSX in this project
    "verbatimModuleSyntax": true,      // KEEP -- enforces explicit import/export types
    "isolatedModules": true,   // KEEP
    "moduleDetection": "force" // KEEP
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "test"]
}
```

**Key change:** `"types": ["node"]` replaces the empty array. Without this, Node.js APIs (`fs`, `path`, `Buffer`, etc.) have no type information.

## package.json Adjustments Needed

```jsonc
{
  "name": "twining-mcp",
  "version": "0.1.0",
  "type": "module",           // CHANGE from "commonjs" -- MCP SDK and modern Node use ESM
  "main": "dist/index.js",    // CHANGE -- point to compiled output
  "bin": {
    "twining-mcp": "dist/index.js"
  },
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "start": "node dist/index.js"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
```

**Critical change:** `"type": "module"` -- the MCP SDK and modern Node.js ecosystem use ESM. The current `"type": "commonjs"` will cause import resolution failures with the SDK.

## Installation

```bash
# Already installed (from package.json)
# @modelcontextprotocol/sdk, proper-lockfile, typescript, ulid

# Additional production dependencies
npm install onnxruntime-node js-yaml

# Additional dev dependencies
npm install -D @types/proper-lockfile @types/js-yaml
```

**Note:** `zod` does NOT need explicit installation -- it ships as both a direct and peer dependency of `@modelcontextprotocol/sdk` v1.26.0.

## Dependency Tree Summary

### Production (5 direct dependencies)
```
@modelcontextprotocol/sdk  -- MCP server framework (brings zod, express, ajv transitively)
onnxruntime-node           -- ONNX inference engine (native binary, ~50MB platform-specific)
ulid                       -- ID generation (zero dependencies)
proper-lockfile            -- File locking (minimal deps)
js-yaml                    -- YAML parsing (zero dependencies)
```

### Dev (4 direct dependencies)
```
typescript                 -- Compiler
@types/node                -- Node.js types
@types/proper-lockfile     -- Lock file types
@types/js-yaml             -- YAML parser types
vitest                     -- Test runner
```

## Platform Compatibility

| Platform | Status | Notes |
|----------|--------|-------|
| macOS arm64 (Apple Silicon) | Supported | onnxruntime-node ships darwin/arm64 binaries |
| macOS x64 (Intel) | Supported | onnxruntime-node ships darwin/x64 binaries |
| Linux x64 (glibc) | Supported | Standard target |
| Linux arm64 (glibc) | Supported | onnxruntime-node ships linux/arm64 |
| Linux musl (Alpine) | NOT supported | onnxruntime-node requires glibc. Embedding system will gracefully fall back to keyword search per design spec. |
| Windows x64 | Supported | onnxruntime-node ships win32/x64 binaries |

## Sources

- [@modelcontextprotocol/sdk npm](https://www.npmjs.com/package/@modelcontextprotocol/sdk) -- verified 1.26.0 is latest, checked peer deps
- [MCP TypeScript SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk) -- server patterns, tool registration API
- [MCP SDK server docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md) -- registerTool, StdioServerTransport
- [onnxruntime-node npm](https://www.npmjs.com/package/onnxruntime-node) -- verified 1.24.1 is latest
- [ONNX Runtime releases](https://onnxruntime.ai/docs/reference/releases-servicing.html) -- version history and platform support
- [Xenova/all-MiniLM-L6-v2 HuggingFace](https://huggingface.co/Xenova/all-MiniLM-L6-v2) -- ONNX model weights, usage examples
- [@huggingface/transformers npm](https://www.npmjs.com/package/@huggingface/transformers) -- evaluated and rejected (48MB, stale onnxruntime pin)
- [proper-lockfile GitHub](https://github.com/moxystudio/node-proper-lockfile) -- mkdir strategy, stale detection
- [ulid npm](https://www.npmjs.com/package/ulid) -- verified 3.0.2 is latest
- [zod npm](https://www.npmjs.com/package/zod) -- verified 4.3.6 is latest, compatible with MCP SDK
- [Vitest 4.0 release](https://www.infoq.com/news/2025/12/vitest-4-browser-mode/) -- verified 4.0.18 is current
- [js-yaml vs yaml comparison](https://npm-compare.com/js-yaml,yaml,yamljs) -- performance and feature comparison
- npm registry (`npm view`) -- all version numbers verified directly against registry on 2026-02-16
