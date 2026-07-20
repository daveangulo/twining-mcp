# Upgrading to Twining v2

**TL;DR:** Existing projects change nothing until you run `npx twining-mcp migrate`. New projects start on the sqlite backend. The Node floor is now 22.13.

## Node floor: 22.13

v2 sets `engines.node: ">=22.13.0"` (for `node:sqlite`). This is a **soft** floor — npm prints a warning at install, nothing refuses to run:

- On older Node, the server still boots: sqlite-backed projects fall back to the **file backend** with a loud stderr warning. A coordination server must not be the reason a session can't boot.
- **Fallback divergence caveat:** an old-Node teammate on fallback writes to the legacy files while the rest of the team writes sqlite/records. This is safe but divergent — the warning names it, and re-running `migrate` sweeps the straggler writes back in. Upgrade Node to make it stop.

## How v2 picks a backend

When `config.yml` has no explicit `storage.backend` (the v2 default is `auto`), the server resolves it by inspecting `.twining/`:

| State on disk | Resolves to | Why |
|---|---|---|
| sqlite state present (`twining.db`, or any file under `records/`) | `sqlite` | already-migrated or sqlite-era project |
| legacy content present (blackboard entries, decisions, graph), no sqlite state | `files` + a one-line migrate nudge | the flip must never boot an empty database next to real state |
| nothing yet (fresh project) | `sqlite` | new projects land on the v2 default |
| anything unreadable/ambiguous | `files` | misdetection lands on the safe branch |

An explicit `storage.backend: files` or `sqlite` in `config.yml` always wins. Fresh projects get the choice stamped explicitly into `config.yml` at init — visible and committed, not re-derived per machine.

**So: nothing migrates implicitly.** Existing projects flip only through the verify-gated migrate below.

## Migrating an existing project

```
npx twining-mcp migrate --dry-run   # preview, writes nothing
npx twining-mcp migrate             # migrate to sqlite, verify, finalize
```

- Stop running twining sessions first; have teammates update `twining-mcp` before pulling the migrated state.
- Verification must pass before anything is finalized; on failure the tool exits 1 and `config.yml` is untouched.
- Legacy files are never modified or deleted — they are their own backup. Only `config.yml` is edited, with a first-wins backup at `config.yml.pre-migrate.bak`.
- Afterwards, commit `.twining/records/`, `config.yml`, and `.twining/.gitignore` — the tool prints the exact commands.

## What the `version: 2` stamp means (mixed teams)

Migrate's finalize stamps `version: 2` into `config.yml`. From that moment:

- Teammates on **twining-mcp 1.21–1.24** get READ-ONLY mode on this project with an upgrade message. This is deliberate — it prevents old and new clients silently diverging on the same repo.
- Clients **older than 1.21** predate the version gate entirely and won't notice; upgrade those first (the migrate output reminds you). If one writes to the frozen legacy files anyway, a `migrate` re-run sweeps the stragglers in.

Fresh v2-initialized sqlite projects are stamped `version: 2` from the start for the same reason.

## Reverse: the escape hatch

```
npx twining-mcp migrate --reverse
```

Returns to the file backend **and restores `version: 1`**, so 1.x clients work again — that's the point of reversing. Caveat: after a reverse, `records/` and `twining.db` are frozen; re-run `migrate` before ever switching back to sqlite, or remove `.twining/records/` first. The overwritten file layout is backed up to `pre-reverse-backup/` (last-wins).

## Opt-in auto-migrate

If you want legacy projects to migrate themselves at startup instead of nudging:

- `TWINING_AUTO_MIGRATE=1` in the server's environment, or
- `storage.auto_migrate: true` in `config.yml`.

Default is **off**: auto-running would surprise-mutate a tracked `config.yml` and drop a `records/` tree into every teammate's diff the first time one person upgrades. An explicit `storage.backend` setting disables auto-migrate regardless.

## Contract change: read-time contradiction surfacing

v2's sync model is set-union by construction: records are immutable ULID-named files, and a git merge is "both sets of files land," conflict-free. The consequence (FOUNDATION-PLAN D3): **contradictory decisions from two branches now coexist**, labeled by provenance, instead of colliding at merge time.

- `twining_assemble` and housekeeping surface cross-branch contradictions; the staleness/reconsider flow archives the losers.
- This is correct blackboard semantics — both decisions *were* made. What changes is where you deal with it: at read time, guided by the tools, not in a git conflict marker.

## Deprecated in v2.0: `twining_handoff` / `twining_acknowledge`

The structured handoff API is deprecated as of v2.0. Field analysis across three heavy-use repos found zero calls to either tool, while the same repos accumulated 40+ rich, git-committed markdown handoff documents doing exactly the job the API was designed for — the structured surface is too shallow for how projects actually hand off. Both tools keep working throughout v2.x; the replacement (a redesign around document-shaped payloads, or removal in v3) is tracked in [#33](https://github.com/daveangulo/twining-mcp/issues/33).

## Release channels

v2.0.0 is stable: the npm dist-tag `latest` resolves to 2.x, so plain `npx -y twining-mcp` gets v2. The `next` dist-tag remains for future prereleases. The Claude Code plugin bundles a `^2.0.0` server as of plugin **1.12.0**.

### Leaving the beta (if you enrolled a project during 2.0.0-beta.x)

The beta enrollment added a project-level `.mcp.json` pinning `twining-mcp@next`, plus a workaround that disabled the plugin's then-1.x bundled server (a `/mcp` disable or a `deniedMcpServers` block). With the plugin now bundling a 2.x server, undo both:

1. Remove the `twining` entry from the project's `.mcp.json` (or repoint it to `twining-mcp@latest` if you rely on the login-shell wrapper below — see the minimal-PATH caveat).
2. Remove the `deniedMcpServers` block from `.claude/settings.json`, or re-enable `plugin:twining:twining` via `/mcp` — whichever you added.

### If you deliberately run a project pin alongside the plugin

A project-level `.mcp.json` `twining` server and the plugin's bundled server register as **two** servers against the same `.twining/` (namespaces `twining` and `plugin:twining:twining`); the model may call either per tool call, both race on the `records/` export tree, and both contend for the dashboard port. Same-version 2.x servers are write-safe (the multiwriter guarantees hold) but wasteful and confusing — keep exactly one. To suppress the plugin's copy while keeping its hooks, skills, and gates, use a checked-in deny in `.claude/settings.json`:

```json
{
  "deniedMcpServers": [
    { "serverCommand": ["npx", "-y", "twining-mcp@^2.0.0", "--project", "."] }
  ]
}
```

The deny matches by **exact launch command** (name-based matching can't work — both servers are named `twining`), so it must be kept in lockstep with the plugin's pin: when a plugin update changes the pin, update the deny and re-check with `claude mcp list` (the denied server disappears from the list when the block is working). This repo enforces that lockstep in CI (`scripts/check-mcp-deny-sync.mjs`). The per-user alternative — `/mcp`, select `plugin:twining:twining`, disable — persists in `~/.claude.json`; note `disabledMcpjsonServers` does **not** govern plugin-bundled servers.

### Agent teams and GUI-spawned sessions: wrap the server command in a login shell

Sessions spawned with a minimal environment — agent-team teammates (e.g. cmux split panes), GUI-launched apps — may lack the `PATH` entry that holds `npx` (Homebrew, nvm). The `.mcp.json` server then fails to spawn in ~10ms and twining is **silently absent** from those sessions: no error appears, the tools just never register, and with the plugin's 1.x server denied there is no fallback. The MCP log (`~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-twining/`) shows `Executable not found in $PATH: "npx"`.

Enroll with a login-shell wrapper instead of a bare `npx` command (macOS/Linux):

```json
{
  "mcpServers": {
    "twining": {
      "command": "sh",
      "args": ["-lc", "exec npx -y twining-mcp@latest --project ."]
    }
  }
}
```

The login shell rebuilds `PATH` (`path_helper` on macOS, `/etc/profile` + `~/.profile` on Linux), and `exec` keeps signal delivery pointed at the server process. Windows testers: skip the wrapper — `sh` is not reliably available; Windows sessions inherit the registry `PATH` and don't hit this failure.
