# Pitfalls Research

**Domain:** MCP Server with File-Based State Management, Semantic Search, and Agent Coordination
**Researched:** 2026-02-16
**Confidence:** HIGH (grounded in design spec analysis, MCP SDK documentation, Node.js filesystem semantics, and onnxruntime issue trackers)

## Critical Pitfalls

### Pitfall 1: stdout Corruption via console.log in Stdio Transport

**What goes wrong:**
Any `console.log()` call in the server process writes to stdout, which is the same channel used for JSON-RPC messages between the MCP client (Claude Code) and the server. A single stray `console.log` corrupts the protocol stream, causing the MCP connection to drop silently or produce cryptic "malformed message" errors.

**Why it happens:**
TypeScript developers instinctively use `console.log` for debugging. Libraries imported by the project (including onnxruntime-node) may also write to stdout. During development, logging feels safe because there is no visible error -- the corruption only manifests when the client tries to parse the polluted stream.

**How to avoid:**
- Replace every `console.log` with `console.error` across the entire codebase from day one.
- Create a logger utility (`src/utils/logger.ts`) that wraps `console.error` and is the only sanctioned logging mechanism.
- Add an ESLint rule (`no-console` with exceptions for `console.error`) to catch accidental `console.log` usage at lint time.
- In the server entry point, override `console.log` to redirect to stderr as a safety net: `console.log = console.error`.
- Audit all dependencies for stdout writes. `onnxruntime-node` has been known to emit initialization messages to stdout.

**Warning signs:**
- MCP Inspector shows "malformed message" or "unexpected token" errors.
- Claude Code loses connection to the MCP server intermittently.
- Server works in isolation tests but fails when connected to a real MCP client.

**Phase to address:**
Phase 1 (project scaffolding). The logger utility and ESLint rule must exist before any other code is written.

---

### Pitfall 2: Read-Modify-Write Race Conditions on JSON State Files

**What goes wrong:**
The decision index (`decisions/index.json`), entity store (`graph/entities.json`), and relation store (`graph/relations.json`) require read-modify-write operations: read the file, parse JSON, modify the in-memory object, serialize, write back. If two concurrent agents trigger tool calls that both modify the same file, the second write overwrites the first, silently losing data. This is the classic lost-update problem.

**Why it happens:**
MCP servers can receive concurrent tool calls from multiple agents (main session, subagents, Task() clones). Each call is an independent async operation. Even within a single Node.js process, interleaved async operations on the same file produce races:
1. Agent A reads `entities.json` (contains entities 1-10)
2. Agent B reads `entities.json` (contains entities 1-10)
3. Agent A adds entity 11, writes (file now has 1-11)
4. Agent B adds entity 12, writes (file now has 1-10, 12 -- entity 11 is lost)

**How to avoid:**
- Use `proper-lockfile` for ALL write operations, not just appends. Lock before read, hold lock through the entire read-modify-write cycle, release after write completes.
- Implement the locking at the storage layer (`src/storage/file-store.ts`) so engine code never needs to think about concurrency.
- Use a consistent locking pattern: `lock(file) -> read -> modify -> write -> unlock`. Never read outside the lock.
- Consider in-memory caching with write-through to reduce lock contention, but this adds complexity around cache invalidation.

**Warning signs:**
- Intermittent data loss that only appears under concurrent usage.
- Entity or relation counts decrease unexpectedly after multi-agent sessions.
- Decision index becomes inconsistent with individual decision files.

**Phase to address:**
Phase 1 (storage layer). The file-store module must implement locked read-modify-write as its fundamental operation pattern.

---

### Pitfall 3: JSONL Append Corruption from Partial Writes and Missing Newlines

**What goes wrong:**
JSONL files have a strict invariant: each line is a complete, valid JSON object followed by a newline character. Two failure modes break this:
1. **Partial writes:** A crash or SIGKILL during `fs.appendFile` can leave a half-written JSON line, making the last line unparseable.
2. **Missing trailing newline:** If the previous append did not end with `\n`, the next append concatenates two JSON objects on one line, corrupting both.
3. **Non-atomic appends:** On non-Linux systems, `fs.appendFile` with the `'a'` flag is not guaranteed to be atomic for writes larger than `PIPE_BUF` (~4KB). Large blackboard entries with lengthy detail fields could exceed this threshold.

**Why it happens:**
Developers assume `fs.appendFile` is atomic -- it is not, except on Linux for small writes. The JSONL format's simplicity creates false confidence: "just append a line, what could go wrong?" The answer is: a lot, especially when the process can be killed at any moment.

**How to avoid:**
- Always ensure the string being appended ends with `\n`. Enforce this in the storage layer, not the caller.
- Use file locking (`proper-lockfile`) even for JSONL appends. While POSIX append semantics offer some protection, locking is the only reliable cross-platform guarantee.
- Build a JSONL parser that is resilient to corruption: if the last line fails to parse, log a warning and skip it rather than crashing. This is a key advantage of JSONL over monolithic JSON -- partial corruption does not destroy the entire file.
- On startup, validate the JSONL file and truncate any trailing partial line (with a backup of the truncated data).
- Keep individual entries small. If `detail` fields can be very large, consider storing them as separate files referenced by ID.

**Warning signs:**
- `JSON.parse` errors when reading `blackboard.jsonl` that reference the last line.
- Blackboard entry counts do not match ULID sequences (gaps that are not from archiving).
- Test failures that only happen when the process is killed mid-write.

**Phase to address:**
Phase 1 (storage layer). The JSONL read/write utilities must handle corruption gracefully from the start.

---

### Pitfall 4: onnxruntime-node Installation Failures Breaking Server Startup

**What goes wrong:**
`onnxruntime-node` is a native Node.js addon that downloads platform-specific binaries during `npm install`. This fails in multiple real-world scenarios:
- Corporate proxies/firewalls block the binary download
- ARM64 Linux (Raspberry Pi, some CI) may lack prebuilt binaries
- The post-install script has had bugs (e.g., v1.22.0 looking for Windows paths on Linux)
- `npx twining-mcp` in a fresh environment triggers a slow, possibly-failing download
- Docker images without build tools cannot compile from source if prebuilt binaries fail

If the embedding system is not properly isolated, any of these failures prevents the entire MCP server from starting.

**Why it happens:**
Native Node.js addons are inherently fragile across platforms. The design spec correctly mandates lazy loading and graceful degradation, but the implementation is easy to get wrong. A single unguarded `require('onnxruntime-node')` at module scope -- even in a file that is transitively imported -- defeats the lazy loading strategy.

**How to avoid:**
- Use dynamic `import()` exclusively for onnxruntime-node. Never use `require()` or top-level `import`.
- Wrap the dynamic import in a try/catch that sets a module-level flag (`embeddingsAvailable = false`) on failure.
- The embedder module should export an `isAvailable()` function that all consumers check before attempting embedding operations.
- The search module must have a complete keyword-based fallback that activates automatically when embeddings are unavailable.
- Test the fallback path explicitly: add a test that mocks onnxruntime-node as unavailable and verifies the server still starts and search still works.
- Consider making `onnxruntime-node` an optional dependency (`optionalDependencies` in package.json) rather than a hard dependency, so `npm install` succeeds even if the native binary download fails.
- Document the `ONNXRUNTIME_NODE_INSTALL=skip` workaround for users who want to skip embedding support entirely.

**Warning signs:**
- CI builds fail on platforms different from development machines.
- Users report "server failed to start" after `npm install` succeeds without error.
- Server works locally but fails when installed globally via `npx`.

**Phase to address:**
Phase 1 (project scaffolding, embedding module). The lazy-loading and fallback architecture must be established before embedding code is written.

---

### Pitfall 5: MCP Tool Response Size Causing Context Window Bloat

**What goes wrong:**
Claude Code has a default maximum of 25,000 tokens for MCP tool output, and displays warnings at 10,000 tokens. Twining's `twining_assemble` and `twining_read` tools can easily exceed these limits when there are many blackboard entries, decisions, or graph entities. Worse, even if the raw response is under the limit, large responses consume the LLM's context window, reducing the space available for actual code reasoning. A single `twining_assemble` call returning 4,000 tokens of context eats into the window Claude has for understanding the codebase.

**Why it happens:**
The design spec sets `default_max_tokens: 4000` for context assembly, which is reasonable. But the `twining_read` tool with no filters returns up to 50 entries, and each entry includes `summary` + `detail`. The `twining_why` tool returns all decisions for a scope, which can grow unbounded. Tool designers think about "what information is useful" without considering "what information fits."

**How to avoid:**
- Enforce hard token limits on ALL tool responses, not just `twining_assemble`. Truncate with a clear "... truncated, use filters to narrow results" message.
- Default to conservative limits: `twining_read` should default to 20 entries, not 50. `twining_recent` should default to 10.
- Return summaries by default, with an option to include detail. The `detail` field should be opt-in, not always included.
- For `twining_why`, return only active decisions by default, not superseded or overridden ones.
- Measure actual token sizes during testing. The 4-chars-per-token heuristic underestimates for structured JSON.

**Warning signs:**
- Claude Code shows "MCP tool output exceeds 10,000 tokens" warnings.
- Agents seem to "forget" code context after calling Twining tools (because the tool response consumed the window).
- `twining_assemble` results are ignored by the agent because they are too long to process.

**Phase to address:**
Phase 2 (engine and tool layers). After storage works, the tool handlers must be tested with realistic data volumes.

---

### Pitfall 6: proper-lockfile Stale Lock Accumulation Under Crash Recovery

**What goes wrong:**
When the MCP server process is killed with SIGKILL (or an OOM crash), `proper-lockfile` cannot clean up its `.lock` directories. On next startup, the lock files still exist. Although `proper-lockfile` handles stale detection via mtime, there are edge cases:
- If the system clock is wrong, stale detection fails.
- If the default stale timeout (10s) is too short for a slow operation, legitimate locks are stolen.
- If the default stale timeout is too long, the server hangs waiting for abandoned locks on startup.
- Multiple processes with different `stale` values for the same file can both acquire the lock simultaneously.

**Why it happens:**
MCP servers run as child processes of Claude Code. When Claude Code exits, it may SIGKILL the server process, which does not trigger Node.js cleanup handlers. The `proper-lockfile` library handles most cases, but crash recovery is inherently imperfect with advisory file locking.

**How to avoid:**
- Use consistent stale/update values across all lock operations. Define them once in a configuration constant, not per-call.
- Set the stale timeout appropriately: 10 seconds is reasonable for most operations, but the embedding index rebuild during archiving may take longer. Measure actual operation times and set the timeout to 3x the expected duration.
- On server startup, check for and clean up stale locks explicitly before entering normal operation.
- Implement a `compromised` callback that logs when a lock is stolen, so you know it happened rather than silently corrupting data.
- Test the crash-recovery path: kill the server mid-operation and verify the next startup recovers correctly.

**Warning signs:**
- Server hangs on the first tool call after a crash.
- Lock-related error messages in stderr logs.
- Intermittent "EEXIST" or "lock already held" errors.

**Phase to address:**
Phase 1 (storage layer). Lock configuration and crash recovery must be established with the storage foundation.

---

### Pitfall 7: Embedding Index Divergence from Source Data

**What goes wrong:**
The embedding index (`embeddings/blackboard.index`, `embeddings/decisions.index`) is a derived data structure that must stay in sync with the source JSONL/JSON files. Divergence happens when:
1. An entry is written to the blackboard but the embedding generation fails (ONNX error, model not loaded yet).
2. The archive process moves entries from the blackboard but fails to rebuild the embedding index.
3. The server crashes between writing the entry and writing the embedding.
4. Someone manually edits the JSONL files.

When the index diverges, semantic search returns stale or incorrect results, and entries without embeddings are invisible to `twining_query`.

**Why it happens:**
The embedding index is a secondary index maintained separately from the primary data. Any two-phase write (write data, then write index) has a failure window between the phases. Without transactions, consistency is best-effort.

**How to avoid:**
- Treat embedding failures as non-fatal: if embedding fails, write the entry anyway and log a warning. The entry is still findable via `twining_read` (filter-based) even if not via `twining_query` (semantic search).
- On server startup, verify index consistency: compare entry IDs in the index with entry IDs in the source files. Rebuild missing embeddings.
- During archiving, rebuild the index atomically: generate the new index in a temporary file, then rename it to replace the old one. Never modify the index in place during bulk operations.
- Store a hash or entry count in the index metadata that can be quickly compared against the source file to detect divergence without a full scan.
- Make the index fully rebuildable from source data. Never store information in the index that does not exist in the source files.

**Warning signs:**
- `twining_query` returns fewer results than expected for a query that should match known entries.
- Entry count in `twining_status` does not match the count of entries with embeddings.
- Semantic search works for recent entries but not older ones.

**Phase to address:**
Phase 2 (embedding system and archiver). The consistency verification should be built alongside the embedding module.

---

### Pitfall 8: JSON State Files Growing Without Bound (entities.json, relations.json)

**What goes wrong:**
While the blackboard has an archiving mechanism, the knowledge graph files (`entities.json`, `relations.json`) and the decision index (`decisions/index.json`) have no growth management. In a long-running project:
- `entities.json` accumulates entities for every file, function, class, and concept ever mentioned.
- `relations.json` accumulates every relationship ever created.
- `decisions/index.json` grows with every decision.

These files are loaded entirely into memory for every operation. At thousands of entities, JSON parsing becomes slow. At tens of thousands, it starts consuming significant memory and causes noticeable latency on every tool call.

**Why it happens:**
The design spec focuses on the blackboard archiving lifecycle but does not specify a growth management strategy for graph or decision data. Developers build the happy path first and discover the scaling problem months into usage.

**How to avoid:**
- Implement lazy loading: do not parse the entire file on every tool call. Keep a parsed in-memory cache that is loaded once at startup and written through on mutations.
- Add a `graph_cleanup` or `graph_prune` lifecycle tool that removes entities and relations for files/symbols that no longer exist in the project.
- For the decision index, only include the fields needed for fast lookup (id, scope, domain, summary, status). Full decision details stay in individual `{ulid}.json` files.
- Monitor file sizes. Log a warning when `entities.json` exceeds 1MB or 5,000 entities.
- Consider splitting large files: `entities-by-type/module.json`, `entities-by-type/function.json`, etc. But this adds complexity -- better to implement the in-memory cache first.

**Warning signs:**
- Tool call latency increases over weeks/months of project usage.
- Memory usage of the MCP server process grows steadily.
- `twining_status` call takes noticeably long.

**Phase to address:**
Phase 2 (engine layer). The storage layer should be designed to support future caching, but the in-memory cache can be deferred until the engine is built.

---

## Technical Debt Patterns

Shortcuts that seem reasonable but create long-term problems.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Skipping file locking "because Node.js is single-threaded" | Simpler code, faster writes | Silent data corruption when agents make concurrent tool calls via separate MCP connections | Never -- MCP servers receive concurrent requests |
| Loading entire JSON files into memory for every operation | Simple implementation, no cache invalidation logic | O(n) parse time on every tool call; memory proportional to file size | MVP only, must add caching before production use |
| Hardcoding the 4-chars-per-token heuristic everywhere | Quick token estimation | Underestimates for JSON (which has structural overhead); context budgets are wrong by 20-30% | Acceptable if all callers go through `src/utils/tokens.ts` so the heuristic can be refined later |
| Using `JSON.stringify` without error handling for writes | Clean code | A circular reference or BigInt in the data silently produces corrupt output | Never -- always wrap stringify in try/catch |
| Storing embeddings as `number[]` in JSON | Simple serialization | 384 floats as JSON text is ~3KB per entry; 10,000 entries = 30MB of index file parsed on every search | Acceptable initially; add binary serialization when index exceeds 5,000 entries |
| Using `ulid()` without monotonic factory | Simpler import, one function call | Possible ULID collisions within the same millisecond during burst writes; non-monotonic ordering | Never -- always use `monotonicFactory()` for concurrent environments |

## Integration Gotchas

Common mistakes when connecting to external services and dependencies.

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| `@modelcontextprotocol/sdk` | Registering tools with overlapping or vague descriptions that confuse the LLM | Each tool name must be unique and action-oriented (verb_noun). Descriptions must explain WHEN to use the tool, not just what it does. Test with MCP Inspector before connecting to Claude. |
| `@modelcontextprotocol/sdk` | Using `structuredContent` in tool responses without matching the declared output schema | If you declare an output schema, every response must conform to it. If you do not need structured output, omit the schema entirely. |
| `onnxruntime-node` | Importing at module scope, which fails at require-time if the native binary is missing | Use dynamic `import('onnxruntime-node')` inside an async function, wrapped in try/catch. Never at top level. |
| `onnxruntime-node` | Assuming the model file exists at a fixed path | The ONNX model must be downloaded lazily. Check for its existence, download if missing, and handle download failures (network, disk space). |
| `proper-lockfile` | Using default options without understanding them | Explicitly set `stale`, `update`, and `retries` values. Use `realpath: false` when locking files that may not exist yet. Always handle the `compromised` callback. |
| `proper-lockfile` | Locking the data file directly instead of using a separate lock file path | For JSONL files that are appended to, lock a separate sentinel file (e.g., `blackboard.lock`) rather than the data file itself, to avoid interference with file watchers or mtime-based stale detection. |
| `ulid` | Using the default `ulid()` function in a concurrent environment | Use `monotonicFactory()` from the ulid package to guarantee monotonic ordering within the same millisecond. |
| Claude Code hooks | Writing to `.twining/pending-posts.jsonl` from a shell hook without file locking | The hook runs in a separate process. Without locking, concurrent hooks and the MCP server reading the file can race. Use a simple lock or atomic rename pattern. |

## Performance Traps

Patterns that work at small scale but fail as usage grows.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Parsing entire `blackboard.jsonl` on every `twining_read` call | Increasing latency on read operations | Stream-parse the JSONL file; maintain an in-memory index of entry metadata; only parse full entries that match filters | >500 entries (noticeable), >2,000 entries (unacceptable) |
| Brute-force cosine similarity over the entire embedding index | Slow `twining_query` responses | Pre-filter by entry type or scope before computing similarity; consider partitioning index by scope | >5,000 entries (~2ms baseline, but combined with JSON parsing overhead it compounds) |
| Loading `entities.json` and `relations.json` for every graph query | Repeated JSON parse of growing files | In-memory cache loaded once at startup, updated on writes, persisted on shutdown | >1,000 entities (parse time becomes noticeable) |
| Rebuilding embedding index during archive (blocking) | Archive operation takes tens of seconds, blocking all other tool calls | Make archive non-blocking: write new entries to a temp index, then atomic-swap. Or rebuild incrementally (remove archived entries, do not re-embed remaining ones). | >1,000 entries with embeddings |
| Token estimation at 4 chars/token for JSON output | Context assembly overshoots token budget; Claude's context fills faster than expected | JSON structural overhead (keys, braces, brackets, quotes) means 3 chars/token is more accurate for structured output. Calibrate with real measurements. | Immediately -- affects correctness of context budgets from day one |
| Synchronous file operations anywhere in the request path | Server becomes unresponsive during I/O | Use async fs operations exclusively. Never `fs.readFileSync`, `fs.writeFileSync`, etc. in tool handlers. | Any concurrent usage -- a synchronous read blocks ALL tool calls |

## Security Mistakes

Domain-specific security issues relevant to an MCP server managing project state.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Allowing `scope` or `affected_files` parameters to contain path traversal (`../../../etc/passwd`) | An agent could read or reference files outside the project directory | Validate all file paths in tool inputs: resolve to absolute path and verify it is within the project root. Reject paths containing `..` segments. |
| Storing secrets posted to the blackboard (API keys, tokens accidentally included in `detail`) | Secrets persisted in git-tracked `.twining/` files | Add a pre-write filter that scans for common secret patterns (API keys, tokens, passwords). Warn but do not block -- the agent may have a legitimate reason. |
| No access control on the MCP server | Any process on the machine can connect and read/write project state | For stdio transport this is mitigated (only the parent process connects). Document that HTTP transport (future) will need auth. |
| Embedding index contains semantic fingerprints of sensitive content | Even without the original text, embedding vectors can be used to infer content through similarity attacks | Exclude the embeddings directory from git (already in spec). Document that embedding indexes should be treated as sensitive. |

## UX Pitfalls

Common user experience mistakes specific to MCP tool design for LLM consumers.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Tool descriptions that explain "what" but not "when" | Claude calls the wrong tool or fails to call the right one. E.g., calling `twining_query` when `twining_read` with filters would be more appropriate. | Each tool description must include a "Use this when..." sentence. E.g., `twining_query`: "Use this when you need to find entries by meaning, not exact keywords." |
| Returning raw internal data structures | Claude receives noisy JSON with fields it does not need (embedding_id, internal timestamps, etc.) and wastes context tokens processing them. | Return only fields relevant to the agent's task. Strip internal metadata from tool responses. |
| Too many tools with overlapping functionality | Claude wastes turns calling the wrong tool, or avoids calling any Twining tool because the options are confusing. 15+ tools is a lot. | Consider combining `twining_read`, `twining_query`, and `twining_recent` into a single `twining_search` tool with a `mode` parameter. Reduce the total tool count if MCP tool search is not active. |
| Error messages that are not actionable | Claude retries the same call or gives up. "Error: ENOENT" tells Claude nothing useful. | Error responses must include: what failed, why, and what to do differently. E.g., "No entries found for scope 'src/auth'. Try a broader scope like 'src/' or 'project'." |
| Requiring too many parameters for basic operations | Claude generates incorrect or missing parameters, especially for `twining_decide` which has many fields. | Make almost everything optional with sensible defaults. Only `summary` should be truly required for most tools. |

## "Looks Done But Isn't" Checklist

Things that appear complete but are missing critical pieces.

- [ ] **File locking:** Locks implemented but `compromised` callback not handled -- silent data corruption when locks are stolen.
- [ ] **JSONL append:** Entries written but newline character not guaranteed at end of each append -- next entry corrupts previous line.
- [ ] **Embedding fallback:** Keyword search implemented but not tested with embeddings actually unavailable -- fallback path has bugs.
- [ ] **Archive process:** Entries moved to archive file but embedding index not rebuilt -- stale embeddings in the index for entries that no longer exist.
- [ ] **Decision superseding:** New decision created and old one marked superseded, but blackboard cross-reference entry not posted -- agents do not see the change unless they query decisions directly.
- [ ] **Context assembly:** Token budget enforced on assembled output, but individual sections (decisions, warnings, findings) not capped -- a single section with 100 decisions consumes the entire budget.
- [ ] **Error handling:** Tool handlers return structured errors, but the error format does not include `isError: true` -- Claude interprets errors as successful results.
- [ ] **Graph entity deduplication:** `twining_add_entity` checks name+type uniqueness, but the comparison is case-sensitive -- "AuthModule" and "authModule" create duplicates.
- [ ] **Startup validation:** `.twining/` directory created on first tool call, but existing corrupt files from a previous failed run are not detected -- server uses partial/corrupt state.
- [ ] **Scope matching:** Prefix matching implemented for file paths, but does not handle trailing slash inconsistency -- "src/auth" does not match "src/auth/jwt.ts" because it also matches "src/authentication/".

## Recovery Strategies

When pitfalls occur despite prevention, how to recover.

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| JSONL corruption (partial last line) | LOW | Truncate the last incomplete line. Data from that single entry is lost but all other data is intact. |
| Embedding index divergence | LOW | Delete the embedding index files. They are fully rebuildable from source JSONL/JSON data. Server rebuilds on next query. |
| JSON state file corruption (entities/relations) | MEDIUM | If in git, restore from last commit. If not, the file is likely unrecoverable. Mitigation: write JSON files atomically (write to temp file, rename). |
| Lost updates from concurrent writes | HIGH | No automatic recovery. Lost data is gone. Prevention is the only option (proper locking). If detected, manually re-enter the lost entries. |
| onnxruntime-node fails to install | LOW | Set `ONNXRUNTIME_NODE_INSTALL=skip` and restart. Server falls back to keyword search. Re-attempt install when environment is fixed. |
| Stale lock prevents server operation | LOW | Delete `.lock` files/directories in `.twining/`. They are advisory and safe to remove when no other process is accessing the files. |
| Decision index out of sync with decision files | MEDIUM | Rebuild the index by scanning all `decisions/{ulid}.json` files. Implement a `twining_repair` tool or startup validation for this. |
| Context window bloated by tool responses | LOW | Reduce `max_tokens` in config, add explicit `limit` parameters to tool calls, restart the Claude session to clear the context. |

## Pitfall-to-Phase Mapping

How roadmap phases should address these pitfalls.

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| stdout corruption | Phase 1: Scaffolding | ESLint rule passes; server connects to MCP Inspector without protocol errors |
| Read-modify-write races | Phase 1: Storage layer | Concurrent write test (parallel tool calls) shows no data loss |
| JSONL append corruption | Phase 1: Storage layer | Kill-during-write test recovers cleanly on restart; corrupted last line is detected and skipped |
| onnxruntime install failures | Phase 1: Embedding module | Test suite passes with `onnxruntime-node` mocked as unavailable; server starts and search works via keyword fallback |
| Tool response size bloat | Phase 2: Tool handlers | All tool responses under 4,000 tokens with realistic test data; context assembly respects budget |
| Stale lock accumulation | Phase 1: Storage layer | Kill-and-restart test shows no lock-related hangs; compromised callback logs events |
| Embedding index divergence | Phase 2: Embedding + Archiver | Startup consistency check detects and repairs missing embeddings; archive rebuilds index atomically |
| JSON state file growth | Phase 2: Engine layer | Performance test with 5,000 entities shows acceptable latency; in-memory cache hit rate logged |
| Path traversal in inputs | Phase 2: Tool handlers | Input validation tests with `../` paths reject malicious inputs |
| Too many/confusing tools | Phase 2: Tool design | MCP Inspector test: each tool is called correctly by Claude for its intended purpose; no tool confusion observed |
| ULID collision in burst writes | Phase 1: Utils | Use monotonicFactory(); concurrent ID generation test produces unique, sorted IDs |
| Token estimation inaccuracy | Phase 2: Context assembler | Calibration test: estimated tokens vs actual tokens (measured by tiktoken or similar) are within 15% |

## Sources

- [Implementing MCP: Tips, Tricks and Pitfalls -- Nearform](https://nearform.com/digital-community/implementing-model-context-protocol-mcp-tips-tricks-and-pitfalls/)
- [proper-lockfile GitHub -- Gotchas section](https://github.com/moxystudio/node-proper-lockfile)
- [Node.js fs.writeFile corruption -- Issue #1058](https://github.com/nodejs/node/issues/1058)
- [Node.js Help: writeFile corrupts data -- Issue #2346](https://github.com/nodejs/help/issues/2346)
- [onnxruntime-node npm -- Install issues](https://www.npmjs.com/package/onnxruntime-node)
- [onnxruntime Linux install bug -- Issue #24918](https://github.com/microsoft/onnxruntime/issues/24918)
- [Claude Code MCP truncated tool responses -- Issue #2638](https://github.com/anthropics/claude-code/issues/2638)
- [Claude Code MCP token overhead -- Issue #3406](https://github.com/anthropics/claude-code/issues/3406)
- [MCP TypeScript SDK -- stdio transport issues](https://github.com/modelcontextprotocol/typescript-sdk)
- [ULID spec -- Monotonic ordering](https://github.com/ulid/spec)
- [MCP Server Naming Conventions](https://zazencodes.com/blog/mcp-server-naming-conventions)
- [Node.js race conditions -- Luciano Mammino](https://nodejsdesignpatterns.com/blog/node-js-race-conditions/)
- [MCP Best Practices](https://modelcontextprotocol.info/docs/best-practices/)

---
*Pitfalls research for: MCP Server with File-Based State Management (Twining)*
*Researched: 2026-02-16*
