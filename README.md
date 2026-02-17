# Twining MCP Server

Agent coordination for Claude Code and other MCP clients. Twining provides a shared blackboard, decision tracking with rationale, selective context assembly, a lightweight knowledge graph, and local semantic search — all backed by plain JSONL files that are git-trackable and human-inspectable.

## Features

- **Shared Blackboard** — Append-only message stream for findings, needs, warnings, and questions across agents
- **Decision Tracking** — Record decisions with rationale, alternatives, confidence, and dependency chains
- **Context Assembly** — Build tailored context packages for a task within a token budget
- **Knowledge Graph** — Lightweight entity-relation graph with traversal and search
- **Semantic Search** — Local embeddings via all-MiniLM-L6-v2 with automatic keyword fallback
- **Archiving** — Move stale entries to archive while preserving decision records

## Quick Start

### Install

```bash
npm install -g twining-mcp
```

### Configure in Claude Code

Add to your Claude Code MCP settings (`~/.claude/claude_desktop_config.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "twining": {
      "command": "twining-mcp",
      "args": ["--project", "/path/to/your/project"]
    }
  }
}
```

If `--project` is omitted, Twining uses the current working directory.

### Usage

Once configured, Twining tools are available in your Claude Code sessions:

```
> Use twining_post to share a finding about the auth module
> Use twining_assemble to get context for the refactoring task
> Use twining_decide to record the database choice with rationale
> Use twining_why to understand why we chose PostgreSQL
```

All state is stored in a `.twining/` directory in your project root.

## Tools

| Tool | Description |
|------|-------------|
| `twining_post` | Post an entry (finding, need, warning, question) to the shared blackboard |
| `twining_read` | Read blackboard entries with optional filters by type, scope, or agent |
| `twining_query` | Semantic search across blackboard entries, with keyword fallback |
| `twining_recent` | Get the most recent blackboard entries |
| `twining_decide` | Record a decision with rationale, alternatives, and traceability |
| `twining_why` | Retrieve all decisions affecting a given scope or file |
| `twining_trace` | Trace a decision's dependency chain upstream and/or downstream |
| `twining_reconsider` | Flag a decision for reconsideration with downstream impact analysis |
| `twining_override` | Override a decision with a reason, optionally creating a replacement |
| `twining_assemble` | Build tailored context for a task within a token budget |
| `twining_summarize` | Get a high-level summary of project state and activity |
| `twining_what_changed` | Report what changed since a given point in time |
| `twining_add_entity` | Add or update a knowledge graph entity (upsert semantics) |
| `twining_add_relation` | Add a relation between two knowledge graph entities |
| `twining_neighbors` | Traverse the knowledge graph from an entity up to depth 3 |
| `twining_graph_query` | Search the knowledge graph by name or property substring |
| `twining_status` | Overall health check — entry counts, warnings, and summary |
| `twining_archive` | Archive old blackboard entries to reduce working set size |

## Architecture

Twining is organized in layers:

- **Storage Layer** — File-backed stores for blackboard (JSONL), decisions (JSON index + individual files), and knowledge graph (JSON). All I/O goes through this layer with file locking for concurrent access.
- **Engine Layer** — Business logic for each domain: blackboard posting/querying, decision recording/tracing, graph traversal, context assembly with token budgeting, and archiving.
- **Embeddings Layer** — Lazy-loaded local embeddings using `@huggingface/transformers` with all-MiniLM-L6-v2. Falls back to keyword search if model loading fails. The server never fails to start because of embedding issues.
- **Tools Layer** — MCP tool definitions that map 1:1 to the tool surface. Each tool validates input with Zod and returns structured results.

All state lives in `.twining/` as plain files — JSONL for the blackboard stream, JSON for decisions and graph data. Everything is `jq`-queryable, `grep`-able, and git-diffable.

See [TWINING-DESIGN-SPEC.md](TWINING-DESIGN-SPEC.md) for the full design specification.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Watch mode
npm run test:watch
```

Requires Node.js >= 18.

## License

[MIT](LICENSE)
