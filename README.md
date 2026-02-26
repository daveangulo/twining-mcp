<p align="center">
  <img src="assets/logo.png" alt="Twining" width="400">
</p>

<p align="center">
  <strong>Your AI agents forget everything. Twining remembers.</strong><br>
  Persistent project memory for Claude Code and other MCP clients.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/twining-mcp"><img src="https://img.shields.io/npm/v/twining-mcp" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License"></a>
</p>

---

## The Problem

You spend two hours with Claude Code making architectural decisions. You choose PostgreSQL over MongoDB. You settle on JWT for auth. You flag a race condition in the payment module. Then the session ends.

Tomorrow you start a new session. Claude has no idea what happened. The decisions are gone. The warnings are gone. The rationale is gone. You re-explain everything — or worse, Claude silently contradicts yesterday's choices.

This gets worse with multiple agents. Agent A decides on REST. Agent B picks gRPC for the same service. Neither knows the other exists. You find out when the code doesn't compile.

**Context windows are ephemeral. Your project's decisions shouldn't be.**

## How Twining Fixes It

Twining is an MCP server that gives your AI agents persistent project memory. Decisions survive context resets. New sessions start informed. Multi-agent work stays coordinated.

```
# Install in 10 seconds
claude mcp add twining -- npx -y twining-mcp --project .
```

**Record a decision with rationale:**
```
> Use twining_decide to record: chose PostgreSQL over MongoDB for ACID compliance
```
Twining captures the decision, rationale, alternatives considered, confidence level, and affected files — as a structured record, not chat history.

**Start a new session. Get caught up instantly:**
```
> Use twining_assemble for the database module
```
Twining scores every decision, warning, and finding by relevance to your task, then fills a token budget in priority order. You get exactly the context you need — no firehose, no re-explaining.

**Ask why things are the way they are:**
```
> Use twining_why src/auth/middleware.ts
```
Returns the full decision chain for any file: what was decided, when, why, what alternatives were rejected, and which commit implemented it.

## Why Not Just Use CLAUDE.md?

CLAUDE.md is static. You write it once and update it manually. It doesn't capture decisions *as they happen*, doesn't track rationale or alternatives, doesn't detect conflicts between agents, and can't selectively assemble context within a token budget.

Twining is dynamic. Every `twining_decide` call records a structured decision. Every `twining_post` shares a finding or warning. Every `twining_assemble` scores relevance and delivers precisely what the current task needs. The `.twining/` directory is your project's living institutional memory.

## Why Not an Orchestrator?

Orchestrators (like agent swarms and hierarchical coordinators) route work by *assigning tasks*. Twining coordinates by *sharing state*. The difference matters:

- **Orchestrators** hold coordination context in their own context window — a single point of failure that degrades as the window fills
- **Twining's blackboard** persists coordination state outside any agent's window, surviving context resets without information loss

Agents self-select into work by reading the blackboard. No central bottleneck. No relay that drops context. Every agent sees every other agent's decisions and warnings, directly.

## Quick Start

### Add to Claude Code

```bash
claude mcp add twining -- npx -y twining-mcp --project .
```

Or scope to a single project:

```bash
claude mcp add twining -s project -- npx -y twining-mcp --project .
```

### Manual Configuration

Add to your `.mcp.json`:

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

### Get the Most Out of It

Add Twining instructions to your project's `CLAUDE.md` so agents use it automatically. See **[docs/CLAUDE_TEMPLATE.md](docs/CLAUDE_TEMPLATE.md)** for a ready-to-copy template.

### Dashboard

A web dashboard starts automatically at `http://localhost:24282` — browse decisions, blackboard entries, knowledge graph, and agent state. Configurable via `TWINING_DASHBOARD_PORT`.

## What's Inside

### Persistent Decisions

| Tool | What It Does |
|------|-------------|
| `twining_decide` | Record a decision with rationale, alternatives, confidence, and traceability |
| `twining_why` | Get the full decision chain for any file or scope |
| `twining_trace` | Trace a decision's dependency chain upstream and downstream |
| `twining_reconsider` | Flag a decision for reconsideration with impact analysis |
| `twining_override` | Override a decision, optionally creating a replacement |
| `twining_search_decisions` | Search decisions by keyword or semantic similarity |
| `twining_link_commit` | Link a git commit to a decision |
| `twining_commits` | Find decisions by git commit |

### Shared Blackboard

| Tool | What It Does |
|------|-------------|
| `twining_post` | Share a finding, warning, need, or question with all agents |
| `twining_read` | Read entries filtered by type, scope, or agent |
| `twining_query` | Semantic search across all entries |
| `twining_recent` | Get the latest entries |

### Context Assembly

| Tool | What It Does |
|------|-------------|
| `twining_assemble` | Build tailored context for a task within a token budget |
| `twining_summarize` | High-level summary of project state |
| `twining_what_changed` | What changed since a given point in time |
| `twining_status` | Health check — entry counts, warnings, agent status |
| `twining_archive` | Move stale entries to archive |
| `twining_export` | Export full state as markdown |

### Knowledge Graph

| Tool | What It Does |
|------|-------------|
| `twining_add_entity` | Add or update an entity |
| `twining_add_relation` | Add a relation between entities |
| `twining_neighbors` | Traverse from an entity up to depth 3 |
| `twining_graph_query` | Search by name or property |

Decisions auto-populate the graph: `twining_decide` creates file and function entities with `decided_by` relations for every affected file.

### Agent Coordination

| Tool | What It Does |
|------|-------------|
| `twining_agents` | List agents with capabilities and liveness |
| `twining_discover` | Find agents matching required capabilities |
| `twining_delegate` | Post a delegation request with capability requirements |
| `twining_handoff` | Hand off work with results and auto-assembled context |
| `twining_acknowledge` | Acknowledge receipt of a handoff |

## How It Works

All state lives in `.twining/` as plain files — JSONL for the blackboard, JSON for decisions, graph, agents, and handoffs. Everything is `jq`-queryable, `grep`-able, and git-diffable. No database. No cloud. No accounts.

**Architecture layers:**

- **Storage** — File-backed stores with locking for concurrent access
- **Engine** — Decision tracking, blackboard, graph traversal, context assembly with token budgeting, agent coordination
- **Embeddings** — Local all-MiniLM-L6-v2 via `@huggingface/transformers`, lazy-loaded, with keyword fallback. The server never fails to start because of embedding issues.
- **Dashboard** — Read-only web UI with cytoscape.js graph visualization and vis-timeline
- **Tools** — MCP tool definitions validated with Zod, mapping 1:1 to the tool surface

See [TWINING-DESIGN-SPEC.md](TWINING-DESIGN-SPEC.md) for the full specification.

## FAQ

**Does Twining slow down Claude Code?**
No. It's a local MCP server — tool calls are local file reads/writes. Semantic search loads lazily on first use.

**Can I use it with Cursor, Windsurf, or other MCP clients?**
Yes. Twining is a standard MCP server. Any MCP host can connect to it.

**Where does my data go?**
All coordination state is local in `.twining/`. Tool call metrics are stored locally in `.twining/metrics.jsonl` (gitignored). Optional anonymous telemetry can be enabled — see [Analytics](#analytics) below.

**Is Twining an agent orchestrator?**
No. It's a coordination state layer. It captures what agents decided and why, and makes that knowledge available to future agents. Use it alongside orchestrators, agent teams, or standalone sessions.

## Analytics

Twining includes a three-layer analytics system to help you understand the value it provides.

### Insights Dashboard Tab

The web dashboard includes an **Insights** tab showing:

- **Value Metrics** — Blind decision prevention rate, warning acknowledgment, test coverage via `tested_by` graph relations, commit traceability, decision lifecycle, knowledge graph stats, and agent coordination metrics
- **Tool Usage** — Call counts, error rates, average/P95 latency per tool
- **Error Breakdown** — Errors grouped by tool and error code

All value metrics are computed from existing `.twining/` data — no new data collection needed.

### Tool Call Metrics

Every MCP tool call is automatically instrumented with timing and success/error tracking. Metrics are stored locally in `.twining/metrics.jsonl` (gitignored — operational data, not architectural).

To disable local metrics collection, set in `.twining/config.yml`:

```yaml
analytics:
  metrics:
    enabled: false
```

### Opt-in Telemetry

Anonymous aggregate usage data can optionally be sent to PostHog to help improve Twining. **Disabled by default.** To enable, add to `.twining/config.yml`:

```yaml
analytics:
  telemetry:
    enabled: true
```

That's it — the PostHog project key is built into the source code. If you run your own PostHog instance, you can override with `posthog_api_key` and `posthog_host`.

**What is sent:** tool names, call durations, success/failure booleans, server version, OS, architecture.

**What is never sent:** file paths, decision content, agent names, error messages, tool arguments, environment variables.

**Privacy safeguards:**
- `DO_NOT_TRACK=1` environment variable always overrides config
- `CI=true` auto-disables telemetry
- Identity is a SHA-256 hash of hostname + project root (never raw paths)
- Network failures are silent — no retries
- `posthog-node` is an optional dependency — graceful no-op if not installed

## Development

```bash
npm install       # Install dependencies
npm run build     # Build
npm test          # Run tests (570+ tests)
npm run test:watch
```

Requires Node.js >= 18.

## License

[MIT](LICENSE)
