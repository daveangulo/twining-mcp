# Changelog

All notable changes to Twining MCP are documented here.

## [1.21.0] - 2026-07-02

Storage-safety release — phase W0 of the v2 foundation plan (`docs/FOUNDATION-PLAN.md`). No tool-surface or data-format changes.

### Added
- **Format version gate.** The server now reads `config.yml`'s `version` field at startup. If the on-disk format is newer than this release supports, the server logs a clear upgrade message and enters read-only mode: all reads keep working, all writes refuse with `FORMAT_VERSION_TOO_NEW`. This protects projects migrated by a future Twining release from being silently diverged by a stale client, and must be in the installed base before any format change ships.
- `.twining/.gitattributes` (`blackboard.jsonl merge=union`) is created on init so branches that both append blackboard entries union-merge instead of conflicting.

### Fixed
- **Atomic writes everywhere.** All whole-file writes (graph `entities.json`/`relations.json`, `decisions/*.json` + `decisions/index.json`, embedding indexes, agent registry, handoffs, blackboard rewrites) now go through a temp-file + rename pattern. Previously a process killed mid-write could truncate a JSON store and make the entire dataset unreadable; now readers observe either the old or the new content, never a torn file. `readJSON` additionally retries once on a parse failure to tolerate files last written by older releases.
- The `.twining/.gitignore` template now covers all local runtime state (`metrics.jsonl`, `pending-posts.jsonl`, `pending-actions.jsonl`, `.last-record`, `.last-known-branches.json`), matching what the README has claimed since 1.18. This repo's own tracked `metrics.jsonl`/`pending-posts.jsonl` were untracked accordingly.

## Plugin [1.9.2] - 2026-07-02

### Fixed
- SubagentStop hook no longer appends directly to `blackboard.jsonl`. A raw bash append can't take the store's file lock, so a concurrent server write could interleave and corrupt lines. The hook now queues its status entry in `pending-posts.jsonl` — the drop box the server drains through the locked store path on next startup.

## [1.20.0] - 2026-05-05

Closes #7 (deterministic portion). The LLM-judged semantic-content review piece is tracked in #16.

### Added
- **Provenance stamping** on all blackboard entries and decisions. `BlackboardEngine.post()` and `DecisionEngine.decide()` now capture `{ recorded_at, branch?, commit_sha? }` synchronously at write time via `git rev-parse`. Stored as the optional `provenance` field on each entry / decision. Detached-HEAD and non-git directories are tolerated (fields omitted).
- **Staleness detection** in `twining_housekeeping`. Pass `staleness_review: true` to scan blackboard entries and active decisions for three deterministic orphan signals: scope path no longer exists on disk, affected files no longer on disk (proportionally scored), or originating branch has been deleted. Items scoring at or above the configurable threshold (`housekeeping.staleness_threshold` in `config.yml`, default `0.95`) are returned as candidates. Branch-gone is automatically neutralized when branch enumeration fails (non-git project) so the signal never false-flags.
- **Branch-merge sweep** in `twining_housekeeping`. Pass `merge_sweep: true` to track the local branch set across runs (snapshot stored in `.twining/.last-known-branches.json`) and surface entries / decisions whose `provenance.branch` was deleted between calls — typically post-merge cleanup. First call records the initial snapshot and returns no candidates. Preview passes (`execute=false`) leave the snapshot untouched so deletions stay visible across multiple previews. Returns candidate IDs only; pass them to `twining_archive_stale` to act. When run alongside `staleness_review`, branch-gone duplicates are removed from the staleness list (merge_sweep is the more specific signal).
- **`twining_archive_stale` tool** — accepts an array of IDs (typically the candidate list from `staleness_review` or `merge_sweep`) and archives them with provenance preserved. Decisions move to a new `archived` status (excluded from `twining_assemble` / `twining_why`); blackboard entries are dismissed. A finding is posted to the audit trail summarizing what was archived and why. Supports first-pass GC (#7) without deleting anything irreversibly.

### Changed
- `DecisionStatus` gains `archived` as a valid value alongside `active | provisional | superseded | overridden`. Decisions in `archived` status are excluded from `twining_assemble`, `twining_why`, and verification queries; they remain on disk with provenance intact.
- `ValueStats.decision_lifecycle` gains an `archived` bucket so analytics totals reconcile after archival.

## Plugin [1.9.1] - 2026-05-05

Plugin-only release. The npm package stays at 1.19.0 — server protocol is unchanged.

### Fixed
- Pre-commit hook no longer false-blocks commits in same-turn record→commit batches (#11 Bug 1) or when commands contain the substring `git commit` inside heredocs/pipelines (#11 Bug 2). The bash regex extracting the command from hook input also no longer truncates on escaped quotes (#13). And the hook no longer counts assistant prose, failed-attempt command bodies, or heredoc message bodies that mention `git commit` as if they were real commits.
- Replaced the JSONL-transcript scan with a synchronous sentinel file. `twining_record`, `twining_post`, and `twining_decide` write `.twining/.last-record` (unix timestamp) on every successful call. The hook compares it against `git log -1 --format=%ct HEAD`. Sentinel writes complete before the tool returns, so transcript flush latency no longer matters.
- Replaced the bash-regex JSON parser with `node -e` (node is already a hard dep), and replaced substring `grep 'git commit'` with argv-tokenized matching: `argv[0]=='git' && argv[1]=='commit'` after stripping pipes / `&&` / `;`.
- Hook silently allows commits in repos without a `.twining/` directory (so the global plugin install doesn't break unrelated repos).

## [1.19.0] - 2026-04-29

### Added
- `TWINING_DISABLED` env var (#10). Set `TWINING_DISABLED=true` (e.g. in `.claude/settings.json` `env` block) to disable Twining for a project — the MCP server exits cleanly before registering tools, so no Twining tools appear in Claude's list. Use case: per-project opt-out without uninstalling the plugin globally. Restart Claude Code to re-enable.

### Plugin v1.9.0
- Fixed: `SessionStart:resume` hook crash (#8). The `prompt`-type SessionStart hook was failing with "ToolUseContext is required for prompt hooks" on session resume. Replaced with a `command`-type hook (`session-start-context.sh`) that emits the gate reminder via `additionalContext` JSON; works on both startup and resume.
- Fixed: `ensure-claude-md-gates.sh` no longer re-stomps `CLAUDE.md` (#9). The hook now searches for the "Twining Lifecycle Gates" marker in `~/.claude/CLAUDE.md`, project `CLAUDE.md`, project `CLAUDE.local.md`, and `.claude/CLAUDE.local.md`, skipping the append if the marker is found anywhere. An explicit opt-out flag `.twining/.no-claude-md-gates` silences the hook regardless of marker location.
- Added: `TWINING_DISABLED=true` causes all hook scripts (`pre-commit-hook.sh`, `stop-hook.sh`, `subagent-stop-hook.sh`, `ensure-claude-md-gates.sh`, and the new `session-start-context.sh`) to no-op silently. Pairs with the server-side gate above.

## [1.18.0] - 2026-04-24

### Fixed
- `twining_record` rationale truncation — content past the second split separator in a natural-language decision string was being silently dropped by `text.split(regex, 2)`. Parser now preserves the full remainder as rationale. There was never a per-field character cap on decision summary or rationale; the behavior was always a parser artifact.
- `twining_record` rejected-alternatives undercount — `REJECTION_PATTERNS` used `text.match()` without the `/g` flag, so only one match per pattern was captured. Multiple explicit rejections in a single decision are now all detected via `matchAll` plus new patterns for numbered lists (`(1) ... (2) ... (3) ...`) and labelled phrasings (`Alternative rejected: X` / `Rejected: X`).
- `twining_record` silent failure when `decisions_created: []` but the decision file was on disk. Root cause: `DecisionEngine.decide` cross-posted the unbounded decision summary to the blackboard, which enforces a 200-char limit and threw after the decision JSON was already written. Summary is now sliced for the cross-post and the call is wrapped in try/catch so post-write failures no longer propagate.

### Added
- Structured-object variant on `twining_record.decisions` — each item can now be either a natural-language string (existing behavior) or a structured object: `{ summary, rationale?, context?, domain?, alternatives?: [{ option, reason_rejected, pros?, cons? }], assumptions?, constraints?, confidence? }`. Structured objects bypass the NL parser entirely for exact round-trip — recommended for long multi-paragraph rationales or when you need ≥2 explicit rejected alternatives preserved verbatim.
- Explicit rationale markers in the NL parser — `Rationale:`, `Why:`, `Reason:`, `Because:` now win over heuristic split words like "as" / "since" / "because", avoiding mid-sentence misfires on long decisions.
- `decision_errors` field in the `twining_record` response — per-decision persistence errors are now surfaced instead of being silently swallowed.

### Plugin v1.8.0 (no change)
No plugin-side changes required. The plugin consumes `twining-mcp` via `npx -y twining-mcp --project .` without a version pin, so plugin users pick up the fix on the next resolve after `1.18.0` is published to npm.

## [1.17.0] - 2026-04-06

### Added
- `twining_record` tool — unified recording that accepts natural language summary, decisions, findings, assumptions, constraints, and affected files in one call. Decisions are parsed into structured records automatically ("Chose X over Y — reason" extracts rationale and rejected alternatives). Scope auto-inferred from git diff when omitted.
- `twining_housekeeping` tool — periodic store maintenance: archives old entries, removes duplicates, surfaces stale provisionals and dangling warnings, prunes orphaned graph entities, rotates old metrics. Dry-run by default.
- `PreToolUse` hook on `git commit` — blocks commits until `twining_record` is called, enforcing decision capture at the natural checkpoint
- Natural language decision parser (`record-parser.ts`) — extracts summary, rationale, rejected alternatives, and domain from freeform sentences

### Changed
- Lifecycle simplified from 3 gates to 2: Gate 1 (assemble) + Gate 2 (record). Gate 2 replaces the old decide+post+verify ceremony with a single `twining_record` call.
- Stop hook rewritten — blocks session exit when code changes lack recording, asks for one action: "call twining_record"
- MCP server instructions condensed — 2 gates, 4 core tools listed instead of full tool group taxonomy

### Plugin v1.8.0
- SessionStart prompt updated: "Two gates: assemble FIRST, record LAST"
- PreToolUse hook added for git commit enforcement
- Stop hook blocks with single-action message instead of 3-step checklist
- CLAUDE.md gates: Gate 2 is now "Record (BEFORE committing or ending)"
- Housekeeping recommendation added for long sessions

## [1.16.0] - 2026-04-05

### Added
- `--version` / `-v` CLI flag — prints version and exits before starting MCP server
- Decision tiering in assemble output — top 3 CRITICAL (full detail), next 2 CONTEXT (summary), rest omitted with count
- Scope-distance weighting in assemble scoring — exact/child scope = 1.0, parent = 0.7, grandparent+ = 0.4
- YOUR NEXT STEP directive at end of assemble briefing — explicit first-action guidance
- `full_surface` config wired to tool registration — 15 rarely-used tools hidden by default, 17 remain

### Changed
- Gate 3 changed from mandatory `twining_verify` to mandatory `twining_post` status entry
- Default verify checks reduced from 5 to 3 (excludes test_coverage and constraints)
- Verify auto-post finding only fires on failures, not on pass/skip
- Stop hook changed from blocking to approve-with-systemMessage reminder
- Conflict detection tightened to same-or-narrower scope only (broad decisions no longer trigger false conflicts)
- Conflict response softened from warning to finding; new decisions stay active instead of provisional
- Assemble tool returns briefing + metadata only (no duplicate raw JSON)
- Auto-orient instruction strengthened to imperative first-call requirement
- Improved tool descriptions for ToolSearch discoverability

### Plugin v1.7.0
- CLAUDE.md gates updated: Gate 3 is now "Status & Handoff"
- BEHAVIORS.md: VERIFY-01 changed from MUST to SHOULD
- Stop hook: approve-with-reminder instead of blocking
- SessionStart prompt: imperative assemble-first instruction
- Verify skill: marked as recommended for complex tasks, not required

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
