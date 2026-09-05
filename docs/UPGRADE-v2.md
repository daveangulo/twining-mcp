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

v2's sync model is set-union by construction for record **creates**: every record is a ULID-named file, so two branches that add records merge as "both sets of files land" with no conflict. Mutations are **not** conflict-free — a status change, supersede, link_commit, amend, resolve, acknowledge, or entity upsert rewrites the same ULID file in place, so two hosts that mutate the same record between syncs can produce a textual conflict on that file (see "Merging `.twining`" below). The consequence (FOUNDATION-PLAN D3): **contradictory decisions from two branches now coexist**, labeled by provenance, instead of colliding at merge time.

- `twining_assemble` and housekeeping surface cross-branch contradictions; the staleness/reconsider flow archives the losers.
- This is correct blackboard semantics — both decisions *were* made. What changes is where you deal with it: at read time, guided by the tools, not in a git conflict marker.

## Working across machines

Git is the only channel between hosts. A decision recorded on host A exists only in A's `twining.db` and A's `.twining/records/` mirror until that mirror is **committed and pushed**. Host B sees it after a `git pull` that moves HEAD — the server re-ingests within 5 seconds of the next tool call — or on its next server start. `git fetch` alone changes nothing. Until then, `twining_assemble` and `twining_why` on host B return an **empty** result for that decision, not an error: from B's point of view the decision does not exist yet.

The server never commits or pushes. Every host that writes must commit its mirror, from the **main checkout** (a session in a linked git worktree writes its records into the main checkout's tree, unless `TWINING_WORKTREE_LOCAL=true` or an explicit `--project` / `TWINING_PROJECT` points elsewhere):

```sh
ROOT=$(cd "$(git rev-parse --git-common-dir)/.." && pwd)   # the main checkout, even when run from a linked worktree
git -C "$ROOT" pull --ff-only || exit 1                    # non-fast-forward, no upstream, or fetch failure: do not drain
git -C "$ROOT" rev-parse -q --verify MERGE_HEAD >/dev/null && exit 1
git -C "$ROOT" add -- .twining/records ':(exclude).twining/records/*.tmp'
for f in .twining/config.yml .twining/.gitignore; do if [ -f "$ROOT/$f" ]; then git -C "$ROOT" add -- "$f"; fi; done
git -C "$ROOT" diff --cached --quiet || git -C "$ROOT" commit -qm 'twining: records mirror'
git -C "$ROOT" push
```

Add only those paths — not `git add -A .twining`. Keep the `*.tmp` exclude anchored to the directory exactly as written: a bare `:(exclude)*.tmp` makes `git add` skip every untracked file (measured on git 2.50), so new records would never be committed. The exclude exists because the server writes each record atomically through a `<file>.<pid>.<rand>.tmp` sibling; older servers do not gitignore that sibling, so a commit racing a write can stage it — the exclude makes the recipe safe on every version.

To see what this host holds that no other host can see yet:

```sh
git --no-optional-locks status --porcelain --untracked-files=all -- .twining/records | wc -l   # unshared records
git rev-list --left-right --count HEAD...@{u} 2>/dev/null || echo 'no upstream'   # unpushed / unpulled, as of the last fetch
```

Do not substitute `git diff-index --quiet HEAD` for the first line: it reports every file whose mtime changed as modified, even when the content did not.

## Merging `.twining`

What git can and cannot merge inside `.twining/`, measured with two clones on git 2.50:

| Situation | Result | Class |
|---|---|---|
| Two hosts each ADD records (distinct ULID files) | clean merge, both land | auto-safe |
| Two hosts mutate the SAME record, non-overlapping keys | merges cleanly into valid JSON only when the edited lines are not adjacent (keys are sorted, one per line); a new key that sorts last rewrites the previous line's trailing comma and conflicts | treat as human until verified per verb pair |
| Two hosts mutate the SAME record, overlapping keys (both change `status`) | conflict markers; the file no longer parses | human |
| One host deletes a record (dismiss, prune), the other edits it | modify/delete conflict | human |
| Any conflict in `decisions/index.json`, `graph/entities.json`, `graph/relations.json`, `agents/registry.json`, `handoffs/index.jsonl`, `blackboard.jsonl`, `config.yml` | no safe textual merge exists | human, or untrack (below) |

Rules that follow:

- **Never apply `merge=union` to any JSON file.** On a per-record file it produces invalid JSON; on an array aggregate it produces output that PARSES with a duplicate key and silently drops an entry — worse than a conflict. `-X ours` / `-X theirs` drops one side without a trace.
- **Never leave conflict markers in a record file.** A record file the server cannot parse must be repaired before any server ingests the tree; a record file that is absent is treated as deleted. When an automated merge queue evicts a conflicted entry, resolve the path (`git checkout --ours -- <path> && git add <path>`) or abort the merge — a bare `checkout --ours` leaves the path unmerged and blocks the next commit.
- **Optional, for pipelines that cannot guarantee marker-free eviction:** add `records/**/*.json -merge` to `.twining/.gitattributes`. Git then keeps "ours" as valid JSON and flags the path as unmerged instead of writing markers — at the cost of also refusing the non-overlapping edits it would otherwise merge cleanly. Twining does not set this by default.
- **The shipped `blackboard.jsonl merge=union` attribute is for file-backend stores.** On a sqlite-era store `blackboard.jsonl` is frozen and the line is inert; leave it.
- **Frozen v1 aggregates on a sqlite-era store only conflict.** After `twining-mcp migrate`, the sqlite backend never writes `decisions/index.json`, `graph/entities.json`, `graph/relations.json`, `agents/registry.json`, `blackboard.jsonl`, or `handoffs/index.jsonl` again; the only writers that can move them are a host that fell back to the file backend (Node older than 22.13) and an explicit `twining-mcp migrate --reverse`. Once **every** host serving the store runs Node >= 22.13, you may untrack them: `git rm --cached` the ones that are tracked and commit. Do this earlier and a host that falls back to the file backend fails on every decision tool, because that backend requires `decisions/index.json`, and a plain `git pull` on a clean clone removes the working-tree copy of any file the pulled commit untracked.

## Deprecated in v2.0: `twining_handoff` / `twining_acknowledge`

The structured handoff API is deprecated as of v2.0. Field analysis across three heavy-use repos found zero calls to either tool, while the same repos accumulated 40+ rich, git-committed markdown handoff documents doing exactly the job the API was designed for — the structured surface is too shallow for how projects actually hand off. Both tools keep working throughout v2.x; the replacement (a redesign around document-shaped payloads, or removal in v3) is tracked in [#33](https://github.com/daveangulo/twining-mcp/issues/33).

## Release channels

v2.0.0 is stable: the npm dist-tag `latest` resolves to 2.x, so plain `npx -y twining-mcp` gets v2. The `next` dist-tag remains for future prereleases. The Claude Code plugin bundles a `^2.0.0` server as of plugin **1.12.0**; since **1.13.0** it spawns through a login shell (`sh -lc`), so minimal-PATH sessions (agent-team teammates, GUI launches) resolve `npx` without any per-project configuration. Since **1.18.0** the launch goes through `scripts/launch-server.sh` instead of bare `npx`: it falls back from `npx` to npm's `npx-cli.js` (resolved next to the `node` binary) to a global `twining-mcp` install, and fails loudly with guidance if none exist. Since **1.19.0** the ladder gains two rungs: a project pin — `./node_modules/twining-mcp/dist/index.js`, installed via `npm i -D twining-mcp` — outranks every npm rung and the plugin's own copy (only the `TWINING_SERVER_JS` env override beats it), and a plugin-bundled dependency-free single-file server is the final fallback, so node-only environments (no npm/npx, offline included, Node >= 22) get a fully working server. On the bundled rung semantic search degrades to keyword mode with a one-line stderr notice; `npm i -D twining-mcp` restores full mode. The loud exit-127 diagnostic is now reachable only with no Node at all or Node too old for the bundle. The same bundle ships in the npm tarball as of **2.3.0** — `node node_modules/twining-mcp/dist/server.bundle.mjs` is a supported direct launch. No user action needed — README "Node installed but npm/npx missing" covers the remaining manual cases.

Since server **2.3.0** and plugin **1.20.0**, a project root that is a linked git worktree resolves to the main checkout's `.twining` by default (server and hooks alike), so `--worktree` agent teammates share one store instead of forking it; `--project`/`TWINING_PROJECT` are never redirected, and `TWINING_WORKTREE_LOCAL=true` keeps a worktree-local store.

### Leaving the beta (if you enrolled a project during 2.0.0-beta.x)

The beta enrollment added a project-level `.mcp.json` pinning `twining-mcp@next` (possibly with a login-shell wrapper), plus a workaround that disabled the plugin's then-1.x bundled server (a `/mcp` disable or a `deniedMcpServers` block). With plugin **1.13.0+** both are obsolete — the bundled server is 2.x and handles minimal-PATH spawns itself:

1. Update the Twining plugin to 1.13.0 or later.
2. Remove the `twining` entry from the project's `.mcp.json` — including the `sh -lc` wrapper variant; the plugin now does that internally.
3. Remove the `deniedMcpServers` block from `.claude/settings.json`, or re-enable `plugin:twining:twining` via `/mcp` — whichever you added. After a session restart, `claude mcp list` should show exactly one `twining` server.

One knock-on effect: the plugin-bundled server registers its tools under a different namespace — `mcp__plugin_twining_twining__*` instead of the project server's `mcp__twining__*` — so any `mcp__twining__*` entries in your settings `permissions.allow` list go stale and twining calls will start prompting. Replace them with `mcp__plugin_twining_twining__*`.

### If you deliberately run a project pin alongside the plugin

A project-level `.mcp.json` `twining` server and the plugin's bundled server register as **two** servers against the same `.twining/` (namespaces `twining` and `plugin:twining:twining`); the model may call either per tool call, both race on the `records/` export tree, and both contend for the dashboard port. Same-version 2.x servers are write-safe (the multiwriter guarantees hold) but wasteful and confusing — keep exactly one. To suppress the plugin's copy while keeping its hooks, skills, and gates, use a checked-in deny in `.claude/settings.json`:

```json
{
  "deniedMcpServers": [
    { "serverCommand": ["sh", "-lc", "exec npx -y twining-mcp@^2.0.0 --project ."] }
  ]
}
```

The deny matches by **exact launch command** (name-based matching can't work — both servers are named `twining`), so it must be kept in lockstep with the plugin's spawn command: when a plugin update changes it, update the deny and re-check with `claude mcp list` (the denied server disappears from the list when the block is working). The per-user alternative — `/mcp`, select `plugin:twining:twining`, disable — persists in `~/.claude.json`; note `disabledMcpjsonServers` does **not** govern plugin-bundled servers.

### Windows: the bundled server needs a project-level fallback

The plugin's `sh -lc` launcher does not resolve on Windows, so plugin 1.13.0+ users there get no bundled server (the plugin's hooks, skills, and gates still work). Windows sessions inherit the registry `PATH` and never had the minimal-PATH problem — add a one-line project `.mcp.json` with the bare command instead:

```json
{
  "mcpServers": {
    "twining": {
      "command": "npx",
      "args": ["-y", "twining-mcp@^2.0.0", "--project", "."]
    }
  }
}
```

### Standalone (non-plugin) installs in agent teams and GUI-spawned sessions

Sessions spawned with a minimal environment may lack the `PATH` entry that holds `npx` (Homebrew, nvm); a bare-`npx` `.mcp.json` server then fails to spawn in ~10ms and twining is **silently absent** — the MCP log (`~/Library/Caches/claude-cli-nodejs/<project>/mcp-logs-twining/`) shows `Executable not found in $PATH: "npx"`. Wrap the command in a login shell (macOS/Linux): `"command": "sh", "args": ["-lc", "exec npx -y twining-mcp@latest --project ."]`. The login shell rebuilds `PATH` (`path_helper` on macOS, `/etc/profile` + `~/.profile` on Linux), and `exec` keeps signal delivery pointed at the server process. The plugin's bundled server solves the same problem internally since 1.13.0 — and since 1.24.1 more robustly than this snippet: it merges the login-shell `PATH` ahead of the inherited one and probes well-known install dirs when `node` is still missing, so plugin users need no per-project fix.
