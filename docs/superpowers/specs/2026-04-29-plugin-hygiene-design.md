# Plugin Hygiene — Design Spec

**Date**: 2026-04-29
**Status**: Draft, awaiting user review
**Scope**: Issues #8, #9, #10 (plugin runtime / install hygiene)
**Out of scope**: Issue #7 (decision/scope GC) — separate spec, see [Out of scope](#out-of-scope)

## Summary

Three small, related fixes to the Twining plugin that improve install behavior and per-project control without changing the underlying coordination model:

- **#8** — fix the SessionStart `prompt`-type hook crash on session resume
- **#9** — stop the CLAUDE.md gate-injection hook from re-stomping the file when the user has moved gates elsewhere
- **#10** — add a `TWINING_DISABLED` env var that fully suppresses Twining for a project

These ship as a single plugin patch release. Existing users aren't broken; nothing on disk changes shape.

## Issues addressed

| # | Reporter | Title | Class |
|---|---|---|---|
| [#8](https://github.com/daveangulo/twining-mcp/issues/8) | LannyRipple | "ToolUseContext is required for prompt hooks" on SessionStart resume | bug |
| [#9](https://github.com/daveangulo/twining-mcp/issues/9) | LannyRipple | `ensure-claude-md-gates.sh` re-appends gates when user moves them to `.local.md` | bug-shaped enhancement |
| [#10](https://github.com/daveangulo/twining-mcp/issues/10) | LannyRipple | No way to opt out of Twining per-project without uninstalling the plugin | enhancement |

## Architecture overview

Two surfaces change:

1. **Plugin hook scripts** (`plugin/hooks/*.sh`) — gain a uniform "disabled" early-exit at the top of every script; `ensure-claude-md-gates.sh` gains broader detection logic; `hooks.json` gets a corrected matcher for the `prompt`-type SessionStart hook.
2. **MCP server entry point** (`src/index.ts`) — gains a startup guard that exits cleanly when `TWINING_DISABLED=true`, before any tools are registered.

Nothing about decisions, blackboard, scopes, graph, or the dashboard changes. Existing data on disk stays compatible.

## Assumptions

These are load-bearing premises. If any is wrong at implementation time, surface it via discovered-needs and revise before continuing.

1. **#8 root cause is upstream-shaped.** The error string "ToolUseContext is required for prompt hooks. This is a bug." originates from Claude Code's hook runner, not from our scripts. The fix is on our side (config), not waiting for upstream. The likely shape is that `prompt`-type hooks need a tool-use context that `resume`-event sessions don't supply. **Verification before implementation**: confirm against Claude Code hooks docs (search `prompt`-hook + SessionStart events). If the docs disagree, fall back to the conservative design (drop the prompt hook, keep the command hook only).
2. **Env var propagation.** Claude Code propagates env vars from the user's shell and from `.claude/settings.json` `env` block into hook script execution and MCP server startup. **Verification**: smoke test with `TWINING_DISABLED=true claude` and confirm both the hook scripts and the MCP server see it.
3. **MCP server can no-op cleanly.** The MCP server can `process.exit(0)` early in `main()` before connecting the stdio transport, and Claude Code treats that as "no tools registered" rather than a startup error surfaced to the user. **Verification**: trace the startup path; if exit-without-connection is treated as error, register a server with zero tools instead.
4. **Existing-user CLAUDE.md is intact.** Users who already have the gates appended from prior sessions: detection finds the marker and skips. The hook is purely additive, never destructive. *Verified by reading the current script* — only `>>` append, no edits.
5. **`.twining/` exists when flag is checked.** The opt-out flag `.twining/.no-claude-md-gates` is checked only after the script has located project root via `.git` or `.twining/`. So flag presence implies `.twining/` exists. Consistent with current control flow.
6. **Single hook firing on resume.** Issue #8 reports the error on `SessionStart:resume`. We assume the SessionStart event fires for all subkinds (`startup`, `resume`, etc.) under the same `*` matcher, and the failing piece is specifically the `prompt`-type hook entry, not the `command`-type one. *Validated by reading `hooks.json`* — both hook entries are under one SessionStart matcher.

## Detailed design

### Issue #8 — SessionStart prompt hook crashes on resume

**Symptom**: User sees `SessionStart:resume hook error. Failed to run: ToolUseContext is required for prompt hooks. This is a bug.` after starting Claude Code in a project with the plugin installed.

**Root cause** (working hypothesis, see assumption 1): The `prompt`-type SessionStart hook entry in `plugin/hooks/hooks.json` requires a `ToolUseContext` that Claude Code's `resume` event flow doesn't construct. The `command`-type entry next to it has no such requirement.

**Fix**: Convert the `prompt`-type SessionStart entry to a `command`-type. The current prompt content is short:

> "Twining MCP tools are available. Two gates: (1) `twining_assemble` FIRST — before reading code. (2) `twining_record` LAST — before committing or ending. See CLAUDE.md \"Twining Lifecycle Gates\" for details."

That can be emitted as `additionalContext` from a tiny `command`-type hook script (`plugin/hooks/session-start-context.sh`) that prints a JSON envelope:

```bash
#!/bin/bash
set -euo pipefail
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0
cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"Twining MCP tools are available. Two gates: (1) `twining_assemble` FIRST — before reading code. (2) `twining_record` LAST — before committing or ending. See CLAUDE.md \"Twining Lifecycle Gates\" for details."}}
JSON
```

This avoids the `prompt`-type entirely. Command hooks don't need `ToolUseContext`; they just emit JSON.

**Why not narrow the matcher to startup-only?** Considered and rejected. Resume sessions are exactly when the gate reminder is most useful — the user is mid-work and hasn't seen the SessionStart prompt this conversation. Skipping resume defeats the purpose.

**Why not just drop the prompt hook entirely?** The `command`-type hook already in place runs `ensure-claude-md-gates.sh`, which writes to CLAUDE.md but doesn't surface a session-start nudge. Removing the prompt hook means the only reminder is whatever the user's CLAUDE.md happens to say — fine in steady state, but loses the moment-of-session signal. A command hook with `additionalContext` gives us that nudge without the bug.

### Issue #9 — CLAUDE.md re-stomping

**Symptom**: User moves the "Twining Lifecycle Gates" section out of `CLAUDE.md` (e.g., into `.claude/CLAUDE.local.md` for personal use), and `ensure-claude-md-gates.sh` re-appends it on next session.

**Root cause**: `ensure-claude-md-gates.sh` only checks one path (`$PROJECT_ROOT/CLAUDE.md`) for the marker string. Anywhere else the user puts the gates is invisible to the detector.

**Fix**: Two-part detection — broaden the marker search, and add an explicit opt-out flag.

**Part 1 — Broader marker search**. Before appending, check the marker in these locations (in this order, short-circuit on first match):

- `$HOME/.claude/CLAUDE.md` — user-global file; if gates live here, they're already loaded for every project
- `$PROJECT_ROOT/CLAUDE.md`
- `$PROJECT_ROOT/CLAUDE.local.md`
- `$PROJECT_ROOT/.claude/CLAUDE.local.md`

If the marker is found in any of them, skip. The reporter's exact setup (`.claude/CLAUDE.local.md`) is covered. Search order is cheapest first (global file is small and on a fast path).

**Part 2 — Opt-out flag**. If `$PROJECT_ROOT/.twining/.no-claude-md-gates` exists, skip without checking anything. Empty file is enough; presence is the signal. This is the explicit user-controlled escape hatch for cases where the gates live somewhere we don't search (rare team-specific patterns), or where the user just doesn't want Twining touching CLAUDE.md regardless.

**Order**: Flag check first (cheapest, no file reads), then marker search.

**Why not env var (`TWINING_MANAGE_CLAUDE_MD=false`)?** Considered. Flag file wins because it's explicit, project-scoped, visible in `ls`, and survives shell-environment differences across team members. Env vars are good for runtime knobs; flag files are good for "I have made a deliberate choice about this directory." (We *also* have an env var path coming via #10's `TWINING_DISABLED`, which short-circuits the entire script anyway — so env-var users are covered.)

**Why not refuse to write to CLAUDE.md at all (reporter's alternative)?** Considered seriously and rejected. Empirical evidence from prior testing: when gates are only injected via session-start prompts, Claude Code is finicky about consistently calling `twining_record`. CLAUDE.md gates load into the system context every turn and persist through compaction; prompt-injected content is exactly the class of "session-start guidance" that gets summarized away. We don't have new data showing that's changed. The risk-asymmetric move is to keep CLAUDE.md authority. **Follow-up**: file a benchmark task to measure recordingDiscipline with vs. without CLAUDE.md gates on the current model. If data shows prompt-only is now reliable, revisit.

### Issue #10 — `TWINING_DISABLED` env var

**Goal**: A user with the plugin installed globally can opt out of Twining for one project without uninstalling, by setting `TWINING_DISABLED=true` (typically in `.claude/settings.json` `env` block per the reporter's preference, or in shell rc).

**Reporter scenario**: per-project suppression (Project X uses Twining, Project Y doesn't). Mid-session toggle is explicitly out of scope.

**Fix**: Two layers — hooks no-op; MCP server refuses to start.

**Layer 1 — hook no-op**. Add this 2-line guard at the top of every hook script (after `set -euo pipefail`):

```bash
[[ "${TWINING_DISABLED:-}" = "true" ]] && exit 0
```

Applied to: `pre-commit-hook.sh`, `stop-hook.sh`, `subagent-stop-hook.sh`, `ensure-claude-md-gates.sh`, plus the new `session-start-context.sh` from #8.

The guard exits before any state inspection or output. PreToolUse hooks that exit 0 with no JSON are treated as "allow" by Claude Code, so commits aren't blocked. Stop hooks that exit 0 with no JSON allow session exit. SessionStart command hooks that exit 0 emit no `additionalContext`. Net effect: invisible.

**Layer 2 — MCP server startup gate**. Early in `main()` in `src/index.ts`, before `createServer()`:

```typescript
if (process.env.TWINING_DISABLED === "true") {
  process.exit(0);
}
```

The MCP server exits cleanly. Claude Code sees no tools registered for this server and shows nothing in the tool list. Hooks no-op (Layer 1). Nothing in the project resists Twining-related actions because nothing Twining-related is running.

**Why both layers and not just the server?** Hooks fire even when MCP tools aren't available (they're configured by the plugin manifest, not by tool registration). Without Layer 1, a disabled-server project would still trigger PreCommit blocks complaining about missing `twining_record` calls — broken UX.

**Accepted values**: Only `TWINING_DISABLED=true` (case-sensitive). Any other value (`1`, `yes`, empty, unset) means enabled. Single canonical truthy value avoids the "is it `1` or `true` or `yes`" footgun.

**Re-enabling**: Unset the variable (or set to anything other than `true`) and restart Claude Code. No mid-session toggle.

## Files changed

| Path | Change |
|---|---|
| `plugin/hooks/hooks.json` | Replace `prompt`-type SessionStart entry with new `command`-type referencing `session-start-context.sh` |
| `plugin/hooks/session-start-context.sh` | **New**: emits `additionalContext` JSON envelope; gated by `TWINING_DISABLED` |
| `plugin/hooks/ensure-claude-md-gates.sh` | Add `TWINING_DISABLED` guard; broaden marker search to 4 paths; add opt-out flag check |
| `plugin/hooks/pre-commit-hook.sh` | Add `TWINING_DISABLED` guard at top |
| `plugin/hooks/stop-hook.sh` | Add `TWINING_DISABLED` guard at top |
| `plugin/hooks/subagent-stop-hook.sh` | Add `TWINING_DISABLED` guard at top |
| `src/index.ts` | Add `TWINING_DISABLED` guard at top of `main()` |
| `plugin/.claude-plugin/plugin.json` | Version bump |
| `.claude-plugin/marketplace.json` | Version bump (in lockstep — see project memory) |
| `package.json` | MCP server version bump |
| `CHANGELOG.md` | Add entries under new version |

## Testing strategy

### Unit-level (hook scripts)

Bash hook scripts have no existing test framework in this repo. Strategy: add a `test/hooks/` directory with bats-style or shell-driven test cases, OR rely on integration tests. **Decision deferred to implementation plan** — depends on what's already convention in `plugin/hooks/`.

Concrete cases per script:

- **`session-start-context.sh`**: emits valid JSON when enabled; emits nothing when `TWINING_DISABLED=true`
- **`ensure-claude-md-gates.sh`**: skips on flag file present; skips on marker found in each of the 4 search paths; appends when none of the above; skips when `TWINING_DISABLED=true`
- **`pre-commit-hook.sh` / `stop-hook.sh` / `subagent-stop-hook.sh`**: existing tests still pass; new test confirms early-exit with `TWINING_DISABLED=true`

### Integration (MCP server)

Add a test in `test/` that spawns the MCP server with `TWINING_DISABLED=true` set in the env, expects exit code 0, expects no stdio activity. Counterpart test without the env var confirms normal startup.

### Manual smoke test

A short checklist in the implementation plan:

1. Set `TWINING_DISABLED=true` in a test project's `.claude/settings.json` `env` block, launch Claude Code, confirm no Twining tools in the tool list, confirm no hook output.
2. Unset the var, relaunch, confirm tools and hooks restored.
3. Move CLAUDE.md gates to `.claude/CLAUDE.local.md`, relaunch, confirm CLAUDE.md is not re-stomped.
4. Add `.twining/.no-claude-md-gates`, relaunch, confirm CLAUDE.md is left alone regardless of gate location.
5. On a resumed session (Claude Code → quit → restart and resume), confirm no `ToolUseContext` error.

## Release plan

Single coordinated release covering both plugin and MCP server. Per project memory: bump both `.claude-plugin/marketplace.json` and `plugin/.claude-plugin/plugin.json` in lockstep (enforced by CI); use `scripts/bump-plugin-version.sh` for the bump.

Versioning:
- **Plugin**: minor bump (e.g., current 1.8.x → 1.9.0). New `TWINING_DISABLED` env var is a user-visible feature, not a fix-only.
- **MCP server**: minor bump matching plugin (current 1.18.x → 1.19.0). The startup gate is a behavior change.

Release flow:
1. Bump versions in all three files via the bump script.
2. Add CHANGELOG entries under the new version with issue links to #8, #9, #10.
3. Commit, push, tag (`v1.19.0` for the MCP server per project memory).
4. CI's `Publish` workflow handles the npm release; never publish locally.

## Verification items (open before implementation)

These are items deferred from the assumptions list to the implementation plan, where they should be resolved before writing code touches the relevant area:

- **V1**: Confirm Claude Code hooks docs / source on `prompt`-type SessionStart behavior across `startup` / `resume` events. If docs say prompt hooks are supported on resume, the bug is upstream and the fix is to file an issue and patch in our release notes; design in this spec still works (command hook works regardless).
- **V2**: Confirm env var propagation from `.claude/settings.json` `env` block into both hook script execution and MCP server stdio launch. Smoke test before locking the design in #10.
- **V3**: Confirm MCP server startup behavior on `process.exit(0)` before transport connect. If Claude Code surfaces this as an error to the user, fall back to "register zero tools" or to a `--disabled` arg.

## Risks and rollback

- **Risk**: Users with custom CLAUDE.md edits adjacent to the gates marker. Detection is by marker string only — unchanged. Risk unchanged from current.
- **Risk**: A future Claude Code update changes the `command`-hook JSON schema for `additionalContext`. Standard plugin compatibility risk; addressed by integration testing before release.
- **Risk**: An existing global plugin user upgrades and notices the new env var unexpectedly silencing things. Mitigated: var is opt-in (default behavior unchanged when unset).
- **Rollback**: Revert the plugin version. State on disk is unchanged across this release, so rollback is clean.

## Out of scope

**Issue #7 (decision/scope GC)** — covered in a separate spec (TBD: `2026-XX-XX-decision-scope-gc-design.md`). Reporter's answers (paraphrased) lock in: housekeeping-triggered (not a separate command), staleness-score with configurable threshold, human-in-the-loop on first runs, in-core preferred, archive-with-provenance (ticket/sprint/branch). The actual operational driver is *branch-scoped decisions becoming stale on merge*, which is the design center, not the agent-driven semantic review.

**Benchmark for prompt-injection vs. CLAUDE.md authority** — file as a separate evaluation task. If the harness shows current Claude reliably calls `twining_record` with prompt-only injection, a future spec can simplify #9's design. Until measured, keep CLAUDE.md authority.
