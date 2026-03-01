# Changelog

All notable changes to Twining MCP are documented here.

## [1.8.1] - 2026-02-28

### Fixed
- Dashboard auto-open now targets the correct project when multiple instances run

## [1.8.0] - 2026-02-28

### Added
- `twining_register` tool and subagent dispatch integration for Claude Code plugin
- Blackboard Stream View — alternate card-based visualization with time groups and thread lines
- Graph toolbar with type filters and hover effects
- Search bar redesign with toggle chips and search icon

### Fixed
- Timeline zoom stuck bug — replaced `overflow:auto` with `overflow:hidden` and added zoom controls
- Stop hook now tracks per-commit Twining coverage via line-number comparison

## [1.7.1] - 2026-02-28

### Added
- Plugin release automation with version bump script and CI enforcement
- Self-hosted GitHub marketplace for plugin distribution

### Fixed
- Skip ONNX embedding init in tests to eliminate 30s timeouts
- Replace prompt-type Stop hook with command-type for reliable JSON validation
- Dashboard UI redesign and 3 bug fixes

## [1.7.0] - 2026-02-27

### Added
- Claude Code plugin with skills, hooks, agents, and MCP server instructions
- CI/CD badge and documentation in README

## [1.6.5] - 2026-02-26

### Added
- CI and publish GitHub Actions workflows with Node 18/20/22 matrix
- npm publish with provenance attestations and auto-generated GitHub Releases
- Build-time PostHog API key injection (no more hardcoded secrets)

### Fixed
- Removed hardcoded PostHog API key from source code

## [1.6.0] - 2026-02-26

### Added
- `twining_promote` tool — promote provisional decisions to active
- `twining_prune_graph` tool — remove orphaned graph entities
- `twining_dismiss` tool — targeted blackboard entry removal

### Fixed
- PostHog telemetry YAML config format

## [1.5.0] - 2026-02-26

### Added
- Three-layer usage analytics: value stats, tool metrics, opt-in PostHog telemetry
- Project name in dashboard title with GitHub icon link

## [1.4.2] - 2026-02-20

### Added
- 5 remaining design spec gaps implemented
- P0-P2 verification and rigor capabilities in integration guides

### Fixed
- Critical and high-severity issues from deep code review
- Flaky handoff sort test

## [1.4.1] - 2026-02-19

### Added
- Dashboard UI polish with improved visualizations and activity tracking

## [1.4.0] - 2026-02-19

### Added
- `twining_verify` tool — drift detection and constraint checking
- Integration tests for full tool-to-engine flows
- Context assembly caching and tracking
- Federation design document
- 4 new coordination tools from architecture gap closure
- Claude Code Review and PR Assistant GitHub Actions

### Fixed
- 9 gaps from architecture review closed

## [1.3.0] - 2026-02-17

### Added
- Agent coordination: `twining_agents`, `twining_discover`, `twining_delegate`, `twining_handoff`, `twining_acknowledge`
- AgentStore and HandoffStore with liveness tracking
- Delegation posting with urgency-based expiry and agent matching
- Context assembly integration with handoff results and agent suggestions
- Dashboard Agents tab with delegations and handoffs views

## [1.2.0] - 2026-02-17

### Added
- Embedded web dashboard with HTTP server on port 24282
- Operational stats, scope filtering, and polling-based updates
- Search and filter with `/api/search` endpoint
- Decision timeline visualization (vis-timeline)
- Knowledge graph visualization (cytoscape.js) with click-to-expand
- Dark mode with system preference detection

## [1.1.0] - 2026-02-16

### Added
- Git commit linking: `twining_link_commit`, `twining_commits`
- `twining_search_decisions` — keyword search with domain/confidence filters
- `twining_export` — full state export as markdown
- GSD planning bridge for STATE.md sync
- Serena knowledge graph enrichment workflow

## [1.0.0] - 2026-02-16

### Added
- Core blackboard engine with JSONL-backed storage and advisory file locking
- Decision engine with conflict detection, trace, reconsider, and override
- Knowledge graph with BFS traversal and entity upsert
- Embeddings layer with lazy ONNX loading and keyword fallback
- Context assembly with token budgets
- 23 MCP tools across blackboard, decisions, context, graph, and lifecycle
- Archiver for state cleanup

[1.8.1]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.8.1
[1.8.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.8.0
[1.7.1]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.7.1
[1.7.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.7.0
[1.6.5]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.6.5
[1.6.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.6.0
[1.5.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.5.0
[1.4.2]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.4.2
[1.4.1]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.4.1
[1.4.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.4.0
[1.3.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.3
[1.2.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.2
[1.1.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1.1
[1.0.0]: https://github.com/daveangulo/twining-mcp/releases/tag/v1
