<p align="center">
  <img src="assets/logo.png" alt="Twining" width="400">
</p>

<p align="center">
  <strong>Separate threads, stronger together.</strong><br>
  Agent coordination for Claude Code and other MCP clients.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/twining-mcp"><img src="https://img.shields.io/npm/v/twining-mcp" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>

---

Twining provides a shared blackboard, decision tracking with rationale, selective context assembly, a lightweight knowledge graph, agent coordination with capability-based delegation, and local semantic search — all backed by plain JSONL/JSON files that are git-trackable and human-inspectable. Includes an embedded web dashboard for browsing and visualizing all state.

## Features

- **Shared Blackboard** — Append-only message stream for findings, needs, warnings, and questions across agents
- **Decision Tracking** — Record decisions with rationale, alternatives, confidence, dependency chains, and git commit linking
- **Context Assembly** — Build tailored context packages for a task within a token budget, with handoff results and agent suggestions
- **Knowledge Graph** — Lightweight entity-relation graph with traversal, search, and full state export
- **Semantic Search** — Local embeddings via all-MiniLM-L6-v2 with automatic keyword fallback
- **Agent Coordination** — Registry with capability-based discovery, delegation matching, structured handoffs, and liveness tracking
- **Web Dashboard** — Embedded HTTP server with stats, search, decision timeline, interactive graph visualization, and agent coordination views
- **Archiving** — Move stale entries to archive while preserving decision records

## Quick Start

### Add to Claude Code

```bash
claude mcp add twining -- npx -y twining-mcp --project .
```

Or scope it to a single project:

```bash
claude mcp add twining -s project -- npx -y twining-mcp --project .
```

### Manual Configuration

Alternatively, add to your `.mcp.json` directly:

```json
{
  "mcpServers": {
    "twining": {
      "command": "npx",
      "args": ["-y", "twining-mcp", "--project", "."]
    }
  }
}
```

### Usage

Once configured, Twining tools are available in your Claude Code sessions:

```
> Use twining_post to share a finding about the auth module
> Use twining_assemble to get context for the refactoring task
> Use twining_decide to record the database choice with rationale
> Use twining_why to understand why we chose PostgreSQL
> Use twining_agents to see which agents are available
```

All state is stored in a `.twining/` directory in your project root.

### Claude Code Integration

For maximum value with Claude Code, add Twining instructions to your project's `CLAUDE.md`. See **[docs/CLAUDE_TEMPLATE.md](docs/CLAUDE_TEMPLATE.md)** for a ready-to-copy template covering Twining + Serena + GSD integration.

### Dashboard

The web dashboard starts automatically on port 24282 (configurable via `TWINING_DASHBOARD_PORT`). Open `http://localhost:24282` to browse blackboard entries, decisions, knowledge graph, and agent coordination state.

## Install

```bash                                                                           
npm install -g twining-mcp
```

then update mcp settings file:

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

## Tools

### Blackboard

| Tool | Description |
|------|-------------|
| `twining_post` | Post an entry (finding, need, warning, question) to the shared blackboard |
| `twining_read` | Read blackboard entries with optional filters by type, scope, or agent |
| `twining_query` | Semantic search across blackboard entries, with keyword fallback |
| `twining_recent` | Get the most recent blackboard entries |

### Decisions

| Tool | Description |
|------|-------------|
| `twining_decide` | Record a decision with rationale, alternatives, and traceability |
| `twining_why` | Retrieve all decisions affecting a given scope or file |
| `twining_trace` | Trace a decision's dependency chain upstream and/or downstream |
| `twining_reconsider` | Flag a decision for reconsideration with downstream impact analysis |
| `twining_override` | Override a decision with a reason, optionally creating a replacement |
| `twining_search_decisions` | Search decisions by keyword or semantic similarity with filters |
| `twining_link_commit` | Link a git commit hash to an existing decision |
| `twining_commits` | Query decisions by git commit hash |

### Context & Lifecycle

| Tool | Description |
|------|-------------|
| `twining_assemble` | Build tailored context for a task within a token budget |
| `twining_summarize` | Get a high-level summary of project state and activity |
| `twining_what_changed` | Report what changed since a given point in time |
| `twining_status` | Overall health check — entry counts, agent counts, warnings, and summary |
| `twining_archive` | Archive old blackboard entries to reduce working set size |
| `twining_export` | Export full Twining state as a single markdown document |

### Knowledge Graph

| Tool | Description |
|------|-------------|
| `twining_add_entity` | Add or update a knowledge graph entity (upsert semantics) |
| `twining_add_relation` | Add a relation between two knowledge graph entities |
| `twining_neighbors` | Traverse the knowledge graph from an entity up to depth 3 |
| `twining_graph_query` | Search the knowledge graph by name or property substring |

### Agent Coordination

| Tool | Description |
|------|-------------|
| `twining_agents` | List registered agents with capabilities, liveness status, and filtering |
| `twining_discover` | Find agents matching required capabilities, ranked by overlap and liveness |
| `twining_delegate` | Post a delegation request to the blackboard with capability requirements |
| `twining_handoff` | Create a handoff between agents with work results and auto-assembled context |
| `twining_acknowledge` | Acknowledge receipt of a handoff |

## Architecture

Twining is organized in layers:

- **Storage Layer** — File-backed stores for blackboard (JSONL), decisions (JSON index + individual files), knowledge graph (JSON), agent registry, and handoff records. All I/O goes through this layer with file locking for concurrent access.
- **Engine Layer** — Business logic for each domain: blackboard posting/querying, decision recording/tracing, graph traversal, context assembly with token budgeting, agent coordination with capability-based discovery and delegation, and archiving.
- **Embeddings Layer** — Lazy-loaded local embeddings using `@huggingface/transformers` with all-MiniLM-L6-v2. Falls back to keyword search if model loading fails. The server never fails to start because of embedding issues.
- **Dashboard Layer** — Embedded HTTP server running alongside MCP stdio transport. Vanilla HTML/CSS/JS with cytoscape.js for graph visualization and vis-timeline for decision timelines. Read-only observer of Twining state.
- **Tools Layer** — MCP tool definitions that map 1:1 to the tool surface. Each tool validates input with Zod and returns structured results.

All state lives in `.twining/` as plain files — JSONL for the blackboard stream, JSON for decisions, graph, agents, and handoffs. Everything is `jq`-queryable, `grep`-able, and git-diffable.

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
