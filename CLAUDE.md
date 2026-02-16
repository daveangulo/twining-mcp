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
