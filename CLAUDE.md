# Twining MCP Server

## Architecture
See TWINING-DESIGN-SPEC.md for full design. This is the authoritative reference for all data models, tool signatures, and behavior.

## Build Order
Build bottom-up in this order:
1. src/utils/ (types, ids, tokens)
2. src/storage/ (file-store, then blackboard-store, decision-store, graph-store)
3. src/engine/ (blackboard, decisions, graph, context-assembler, archiver)
4. src/embeddings/ (embedder, index-manager, search) — lazy-loaded, graceful fallback
5. src/tools/ (one file per tool group, matching spec exactly)
6. src/server.ts + src/index.ts (MCP registration and entry point)

## Conventions
- All IDs are ULIDs
- All file I/O goes through storage/ layer, never direct fs calls from engine/
- All tool handlers return structured errors, never throw
- Tests alongside implementation — write tests for each module before moving to next
- Use vitest for testing with temp directories

## Key Constraint
The embedding system MUST be lazy-loaded and MUST fall back gracefully to keyword search if ONNX fails. The server should never fail to start because of embedding issues.

## Serena Knowledge Graph Enrichment Workflow

When Serena MCP tools are available alongside Twining, agents should enrich Twining's knowledge graph after making decisions that affect code structure. This is an agent-mediated workflow — the agent orchestrates both Serena and Twining tools.

### After `twining_decide` (when decision affects code symbols):

1. **Identify affected symbols** from the decision's `affected_files` and `affected_symbols`
2. **Use Serena** to analyze the symbols:
   - `find_symbol` to get full symbol details (class, function, method)
   - `find_referencing_symbols` to discover usage patterns
   - `get_symbols_overview` for file-level structure
3. **Use Twining** to record the code structure:
   - `twining_add_entity` for each significant symbol (classes, key functions, modules)
   - `twining_add_relation` for dependencies between symbols (calls, imports, implements)
   - Link entities to decisions with `decided_by` relations
4. **Example flow:**
   ```
   # Agent makes a decision
   twining_decide(domain="architecture", scope="src/auth/", summary="Use JWT middleware pattern", ...)

   # Agent uses Serena to understand the code
   serena.find_symbol("JwtMiddleware")  # Get symbol details
   serena.find_referencing_symbols("JwtMiddleware")  # Find usage

   # Agent enriches Twining's knowledge graph
   twining_add_entity(name="JwtMiddleware", type="class", properties={file: "src/auth/jwt.ts"})
   twining_add_entity(name="AuthRouter", type="module", properties={file: "src/auth/router.ts"})
   twining_add_relation(source="AuthRouter", target="JwtMiddleware", type="imports")
   ```

### When NOT to enrich:
- Trivial decisions (naming, formatting, config values)
- Decisions that don't affect code structure
- When Serena tools are not available in the current session
