# Data flow — every path that can leave this machine

What this covers: every way Twining can send bytes off the computer it runs on (or open a local port, or launch a local program that might), the switch for each, how to see it for yourself, and what a traffic observation can and cannot prove. Requirements R09, R18, R20; acceptance C28 A24 ("every outbound destination and first-use model download, confirmed by observed traffic, not configuration values").

It describes `foundation/v3` at **`0f9fd985`** (`package.json` 2.16.1, plugin 1.34.1). Commands below use `V` = a checkout of that commit with `dist/` built, and `W` = an empty working directory holding the three drivers in §8. Every command runs with `TWINING_OFFLINE=1`; the one run that would download a model is deliberately not run (§7). A statement not backed by a command here is labelled **(from source, not a run)**.

## Known defects and limits at this commit

| # | What the operator sees | Reproduce | Impact | Workaround |
| --- | --- | --- | --- | --- |
| D1 | `twining sync --remote origin` returns `ok:true` but `"carrier":"fs:<repo>/.twining/exchange-fs"`; no `.twining/exchange/` worktree, no `refs/heads/twining/exchange` on either side. Cause: `src/cli/v3-verbs.ts` sync verb calls `new GitTransport(projectRoot, remote)` positionally against an options-object constructor, and a bare `catch {}` swallows the `TypeError` | `bash W/sync-exp.sh <new dir> $V` (§5) | `twining sync` cannot exchange with another machine; the only tell is the `carrier` field | none for git; the fs carrier on a shared directory (`--path` / `TWINING_EXCHANGE_DIR`) is the only working carrier |
| D2 | The MCP server is **online by default**: first semantic use on an empty model cache downloads the embedding model from `huggingface.co` | (from source, not a run) `src/server.ts` calls `createTwiningContext(projectRoot)` with no options; the positive control is not run (§7) | model bytes fetched without asking | set `TWINING_OFFLINE=1` or config `embeddings.offline: true` (§2) |
| D3 | The committed plugin bundle `plugin/server/twining-server.mjs` (last committed `242eb529`, 2.16.1) and the installed plugin cache 1.34.1 contain **no** `TWINING_OFFLINE` and no `offline` token: a client running that bundle ignores the switch | `grep -c TWINING_OFFLINE $V/plugin/server/twining-server.mjs` → `0` (`$V/dist/core/context.js` → `2`) | an operator who sets `TWINING_OFFLINE=1` under the shipped plugin still gets row 1's download | none in that bundle; a rebuilt bundle or a `dist/` from this commit |
| D4 | The same bundle does not carry the token-calibration table | `grep -c calibration $V/plugin/server/twining-server.mjs` → `0` (`dist/retrieval/tokenizer.js` → `10`) | plugin users run older retrieval code than `dist/` | rebuild the bundle |
| D5 | `.twining/.gitignore` ignores `store/`, `exchange/`, `models/`, `twining.db*` but **not `exchange-fs/`** | after D1's run: `cat <repo>/.twining/.gitignore` | the default fs-carrier directory is committable | add `exchange-fs/` by hand |
| D6 | `twining-mcp migrate --to 3` on a store that `identity init` created (or on a v2 store) exits 0, then every write from the **same** 2.16.1 CLI is refused: `FORMAT_VERSION_TOO_NEW`, exit 1. Cause: `src/migrate/v3-forward.ts` writes `config.yml` `version: 3`; `src/config.ts:formatVersionRefusal` refuses anything above 2. `store.json` also gains `migrated_from: 1` on a store that was never v1 | `MIGRATE=1 bash W/sync-exp.sh <new dir> $V` (§5) | store becomes read-only; outside data flow, recorded for the `src/migrate/` owner | do not run `migrate --to 3` on a store `identity init` created |
| D7 | `twining-mcp --help` does not print help: it boots the server, creates `.twining/` in the cwd and, unless `TWINING_DASHBOARD=0`, binds a loopback port (and per the code opens a browser) | §4 | a store, a port and possibly a browser tab from a command expected to be inert | `twining --help` (the CLI: prints usage, exit 0, creates nothing) or `twining-mcp --version` |
| D8 | `twining doctor`'s `bindings.source_cwd` and `bindings.source.worktree`/`.branch`/`.commit`/`.dirty` describe the **process cwd**, not the `--project` store (`bindings.source.repo` and `repo_ids_cited` do show the store's repo id) | run doctor from another checkout with `--project <B>/repo` (§5) | misleading binding report | run doctor from inside the project |
| D9 | `scripts/measure/observe-traffic.sh`: its embedder probe crashes (`TypeError … at modelCacheDir (src/embeddings/embedder.ts:24:15)`), so the download path is never reached; its `npx tsx` launcher opens a TLS socket to `registry.npmjs.org` that the report lists as Twining's, and on a cold npx cache installs `tsx` from the registry at run time; no `--block` mode; no DNS capture; the endpoint block includes the local side of each socket | §6 | the script's report is not evidence about Twining's traffic | use the stdio driver `W/probe.mjs` (§2) |
| D10 | `scripts/qualify/c28-remote/c28-scenario.ts` still says `src/exchange/git-transport.ts` "is absent" (A14 reason) while the file exists | `grep -n "is absent" $V/scripts/qualify/c28-remote/c28-scenario.ts` | stale qualification text | none |
| L1 | Browser auto-open on server start | — | NOT DEMONSTRATED (§7) | `TWINING_DASHBOARD_NO_OPEN=1` |
| L2 | Any exchange over a real network remote | — | UNAVAILABLE (§7) | — |

## 1. Components

- **MCP stdio server** `dist/index.js`: store, embedder, telemetry client, loopback dashboard; never runs the Git carrier (from source, not a run: the only `src/` importer of `git-transport.ts` is `src/cli/v3-verbs.ts`).
- **`twining` CLI** `dist/cli/twining.js`: context always `offline: true` (from source, not a run); owns `sync`, `identity`, `doctor`, `hook`.
- **Host hooks**: `plugin/hooks/hooks.json` wires `v3-capture-hook.sh claude-code <Event>` for SessionStart, UserPromptSubmit, PreCompact, SubagentStart, Stop, SubagentStop, SessionEnd; the script regex-extracts `session_id` and `prompt_id|turn_id` and pipes the unmodified JSON to `twining hook` (from source, not a run).
- **Store** `.twining/`: `events/ records/ cursors/ store.json` tracked; `store/ twining.db* models/ exchange/` gitignored; `exchange-fs/` not (D5).
- **Exchange** `src/exchange/`: `fs-transport.ts`; `git-transport.ts` (ref `refs/heads/twining/exchange`, worktree `.twining/exchange/`, added in `e22fc6d3` per `git log --diff-filter=A`); `git.ts` (sanitized git env). **Retrieval** `src/retrieval/tokenizer.ts` (guarded `countExact`) + shipped `calibration.json`. **Git connector** `src/adapters/connectors/git.ts` (`ls-remote`, `gh pr view`), imported only by `test/adapters/git-connector.test.ts`.

## 2. Every outbound path

| # | Path → destination | Default | Switch | How to see it |
| --- | --- | --- | --- | --- |
| 1 | Embedding model download → `https://huggingface.co/` (`dig +short huggingface.co A` → `18.164.174.x`), model `Xenova/all-MiniLM-L6-v2`, first use with no `.twining/models/` cache | **ON** for the server (D2); **OFF** for the CLI | any of: `TWINING_OFFLINE` = `1`/`true`/`yes` (any case; empty is not a switch), config `embeddings.offline: true`, or the caller's option; ORed, so `offline:false` in code cannot override the operator (from source, not a run: `src/core/context.ts`). Ignored by the committed plugin bundle (D3) | off: probe below. On: not run (§7) |
| 2 | Telemetry → `https://us.i.posthog.com` (→ `3.41.202.x`), batched events, identity `sha256(hostname+projectRoot)[0:16]` | **OFF** | needs `telemetry.enabled: true` **and** a key (`POSTHOG_API_KEY` env > config `telemetry.posthog_api_key` > key baked at publish); `DO_NOT_TRACK=1` or `CI=true` force off (from source, not a run: `src/analytics/telemetry-client.ts`) | not exercised (no opt-in). Key check: §3 |
| 3 | Git network verbs → whatever the remote points at: `fetch`/`push`/`ls-remote` on `refs/heads/twining/exchange` in `git-transport.ts`; `ls-remote` in the connector | **not reachable** from any CLI or server path (D1; connector has no importer) | `twining sync --remote` (intended) | §5 shows no exchange ref reaches a bare local remote |
| 4 | `gh pr view` → `api.github.com` (connector, 20 s timeout) | **not reachable** | — | `grep -rn connectors/git src test` → test file only |
| 5 | Anthropic count-tokens → `api.anthropic.com` (→ `160.79.104.10`). Runtime: `countExact()` only with `allow_network: true` **and** `ANTHROPIC_API_KEY`; no `src/` caller passes `allow_network` (`grep -rln allow_network src test` → `tokenizer.ts` and one test). `@anthropic-ai/sdk` is a devDependency (present in a dev tree). Dev time: `scripts/calibrate-tokenizer.mjs` sends the calibration corpus | **unreachable** at runtime | no key / no flag | `env -u ANTHROPIC_API_KEY node --input-type=module -e 'const m=await import("'$V'/dist/retrieval/tokenizer.js"); console.log(await m.countExact("hello",{allow_network:true}), await m.countExact("hello"))'` → `null null` |
| 6 | Dashboard → `127.0.0.1:24282`, loopback only; if busy it probes each port in the retry window and binds the next free one | **ON** | env only: `TWINING_DASHBOARD=0`, `TWINING_DASHBOARD_PORT`, `TWINING_DASHBOARD_NO_OPEN=1` | §4 |
| 6′ | Browser auto-open via the `open` package (a local subprocess, outside any traffic observation) | **ON** (from source, not a run) | `TWINING_DASHBOARD_NO_OPEN=1` or `TWINING_DASHBOARD=0` | NOT DEMONSTRATED (§7) |
| 7 | Exchange: fs carrier writes a local directory; Git carrier as row 3 | fs | `--path` / `TWINING_EXCHANGE_DIR` | §5 |
| 8 | Hooks / host adapters | **none** | — | §5 hook run; grep below |

No other network primitive: outside `src/dashboard/` (which serves loopback), `grep -rnE 'fetch\(|node:https?|node:net|node:dns|node:tls|WebSocket|undici|axios' src --include='*.ts' | grep -v '^src/dashboard/'` prints exactly one line, a type annotation with no runtime effect: `src/index.ts:83:  let dashboardServer: import("node:http").Server | null = null;`. The remaining network-capable code is the git/gh subprocesses (rows 3–4) and the dynamic imports of `@huggingface/transformers`, `posthog-node` and `@anthropic-ai/sdk`. Environment variables `src/` reads — 21: `grep -rhoE 'process\.env\.[A-Z_][A-Z0-9_]*|\benv\.[A-Z_][A-Z0-9_]+\b|env\["[A-Z_][A-Z0-9_]*"\]' src | sed -E 's/.*[.\["]([A-Z_][A-Z0-9_]*)"?\]?$/\1/' | sort -u | tr '\n' ' '` → `ANTHROPIC_API_KEY CI DO_NOT_TRACK HOME POSTHOG_API_KEY TWINING_AGENT_CONTEXT TWINING_AUTO_MIGRATE TWINING_DASHBOARD TWINING_DASHBOARD_NO_OPEN TWINING_DASHBOARD_PORT TWINING_DISABLED TWINING_EXCHANGE_DIR TWINING_HUMAN_PASSPHRASE TWINING_IDENTITY_HOME TWINING_INGRESS TWINING_OFFLINE TWINING_PROJECT TWINING_SESSION_ID TWINING_TURN_ID TWINING_WORKTREE_LOCAL VITEST`.

### Run the server fully offline and check it

```
$ TWINING_OFFLINE=1 node W/probe.mjs $V/dist/index.js W/offline/project
{ "serverInfo": { "name": "twining-mcp", "version": "2.16.1" },
  "calls": { "twining_post": "ok", "twining_assemble": "ok",
             "twining_query": "MCP error -32602: Tool twining_query not found" },
  "exit": 0, "lsof_samples": 8, "sockets": [], "models_dir_after": false,
  "stderr": "[twining] No local embedding model at <W>/offline/project/.twining/models/Xenova/all-MiniLM-L6-v2 — using keyword search (offline mode: no download attempted).\n" }
$ ls -a W/offline/project/.twining
.  ..  .gitignore  .last-record  metrics.jsonl  records  twining.db
```

The built server declined the download, said so, and held no IP socket in 8 samples over ~4 s while serving a write and an assemble. (`twining_query` is on the `full` surface, not the default stdio surface — unrelated to networking.) It does not show absence between samples, nor what happens without the switch.

**Caveat for older clients (D3):** the switch exists in `dist/` at this commit. A client running the committed 2.16.1 plugin bundle has no code that reads it, so `TWINING_OFFLINE=1` there does nothing; check with the `grep -c` in D3 before relying on it.

## 3. Telemetry key — baked at publish

The PostHog key is written into `_generated-posthog-key` at build time from `POSTHOG_API_KEY` (from source, not a run: `scripts/inject-posthog-key.mjs`). In this tree it is empty:

```
$ grep -oE 'POSTHOG_API_KEY\s*=\s*"[^"]*"' $V/dist/analytics/_generated-posthog-key.js $V/plugin/server/twining-server.mjs
dist/analytics/_generated-posthog-key.js:POSTHOG_API_KEY = ""
plugin/server/twining-server.mjs:POSTHOG_API_KEY = ""
```

With no key the client returns before sending, even if opted in. The artifact that matters is the **CI-published npm package**, which is not on this machine: run the same `grep` against `<install>/dist/analytics/_generated-posthog-key.js` and quote the output. If a key is present there, "no telemetry" rests on the opt-in flag alone.

## 4. Dashboard and the `--help` boot

```
$ cd <empty dir>      # zsh; 24282 already held by another process
$ { sleep 4 | env -u TWINING_DASHBOARD TWINING_OFFLINE=1 TWINING_DASHBOARD_NO_OPEN=1 node $V/dist/index.js --help 2>err & }
$ sleep 2; lsof -n -P -i -a -p "$(pgrep -nf 'dist/index.js --help')" | awk 'NR>1{print $8,$9,$10}'
TCP 127.0.0.1:<eph>->127.0.0.1:24282 (ESTABLISHED)
TCP 127.0.0.1:24283 (LISTEN)
$ wait; cat err; ls -a .twining
[twining] Dashboard: http://127.0.0.1:24283
.gitattributes .gitignore agents archive blackboard.jsonl config.yml decisions embeddings graph handoffs twining.db
$ lsof -n -P -iTCP:24283 -sTCP:LISTEN; echo $?          # after exit
1
```

The `ESTABLISHED` line is the single-instance guard probing the busy port; it probes every busy port it hops over, so the landing port depends on what else is listening. All sockets are loopback; the port is released on exit.

```
$ TWINING_OFFLINE=1 TWINING_DASHBOARD=0 node $V/dist/index.js --help </dev/null   # empty dir
(exit 0, empty stdout, empty stderr; .twining/ created with the eleven entries above)
$ TWINING_OFFLINE=1 node $V/dist/index.js --version </dev/null
twining-mcp 2.16.1                       (exit 0; nothing created)
$ node $V/dist/cli/twining.js capabilities --json
{"ok":false,…,"command":"capabilities","error":{"code":"USAGE","message":"unknown option \"--json\""}}   (exit 2)
```

## 5. Exchange, sync and hooks

`W/sync-exp.sh` builds a bare **local** repository as `origin` — a one-machine stand-in, not a network — then runs `identity init`, `post`, `sync --remote origin`, and `doctor`.

```
$ bash W/sync-exp.sh <new dir B> $V
### identity init      {"ok":true,…,"store":{…,"format":3,"created":true,…}}   exit=0
### post               [twining] No local embedding model at <B>/repo/.twining/models/… (offline mode: no download attempted).
                       {"ok":true,…,"command":"twining_post",…}   exit=0
### sync --remote origin
{"ok":true,…,"result":{"carrier":"fs:<B>/repo/.twining/exchange-fs","transport":"fs:<B>/repo/.twining/exchange-fs",
 "published":{"attempted":1,"transferred":1,"uncertain":[]},"received":{"polled":1,"admitted":1,"duplicates":1,…}}}   exit=0
### layout   .gitignore .last-record cursors events exchange-fs records store store.json twining.db
             ls: <B>/repo/.twining/exchange: No such file or directory
### refs     repo: refs/heads/main refs/remotes/origin/main     remote.git: refs/heads/main
### doctor   {"ok":true,…,"bindings":{…,"source_cwd":"<B>/repo",…,"store_format":3,
             "repo_ids":["r_X"],"repo_ids_cited":["r_X"],"repo_ids_undeclared":[],"v3_enabled":true},
             "capture_coverage":{"claude-code":{…,"captured":7,…},"codex":{…,"captured":7,…}}, …}   exit=0
```

The CLI honours the offline switch; `sync` reports success on the **fs** carrier and nothing reaches the remote (D1). Generated `.gitignore`: `embeddings/*.index archive/ models/ metrics.jsonl pending-posts.jsonl pending-actions.jsonl .last-record .last-known-branches.json .sessions/ twining.db twining.db-wal twining.db-shm records/**/*.tmp store/ exchange/` — no `exchange-fs/` (D5). `doctor`'s `capture_coverage` 7/7 describes what each **adapter** captures ("not that a host is currently installed"). (`r_X` = the `repo_id` that `identity init` printed.) D8, the same store's doctor run from a different checkout:

```
$ cd <another git checkout>     # here: the twining-mcp checkout at foundation/v3, with uncommitted changes
$ TWINING_OFFLINE=1 TWINING_IDENTITY_HOME=<B>/identity-home node $V/dist/cli/twining.js doctor --project <B>/repo   # exit 0
bindings keys: project_root store_dir source_cwd source store_format store_id repo_ids repo_ids_cited repo_ids_undeclared v3_enabled
"project_root":"<B>/repo", "source_cwd":"<another checkout>",
"source":{"repo":"r_X","worktree":"wt_<that checkout's id>","branch":"foundation/v3","commit":"0f9fd985…","dirty":true},
"repo_ids":["r_X"], "repo_ids_cited":["r_X"], "repo_ids_undeclared":[]
```

`source_cwd` and `source.worktree`/`branch`/`commit`/`dirty` describe the checkout the command ran from, not `<B>/repo` (whose only commit is `init` on `main`); `source.repo` and `repo_ids_cited` show the store's own repo id.

The constructor failure behind D1, on the built module:

```
$ node --input-type=module -e 'const m=await import("'$V'/dist/exchange/git-transport.js"); try{new m.GitTransport("/p","origin")}catch(e){console.log("positional:",e.constructor.name+": "+e.message)}; const t=new m.GitTransport({twiningDir:"/p/.twining",repoDir:"/p",remote:"origin"}); console.log("options: exchangeDir =",t.exchangeDir,"EXCHANGE_REF =",m.EXCHANGE_REF)'
positional: TypeError: The "path" argument must be of type string. Received undefined
options: exchangeDir = /p/.twining/exchange EXCHANGE_REF = refs/heads/twining/exchange
```

D6, the migrate-then-refuse path (same script with `MIGRATE=1`, which runs `twining-mcp migrate --to 3` after `identity init`):

```
### migrate --to 3     twining migrate --to 3 — forward migration
                       legacy files: 0  records: 0  created: 0  derived: 0  rivals: 0  damaged: 0  conflicts: 0
### post               [twining] .twining/ format version 3 is newer than this twining-mcp release supports (2). …
                       {"ok":false,…,"error":{"code":"FORMAT_VERSION_TOO_NEW",…}}   exit=1
### sync --remote origin   … "published":{"attempted":0,"transferred":0,…}   exit=0
```

`store.json` keeps the `identity init` ids (`repo_ids` = the original `repo_id`) and gains `"migrated_from": 1`; `config.yml` becomes `version: 3`. A v2 store made by a dashboard-off `twining-mcp --help` behaves the same: `migrate --to 3` exits 0 (`legacy files: 4`), then `post` → `FORMAT_VERSION_TOO_NEW`, exit 1; `twining migrate-status` reports `"migration": "complete"`.

**Hooks.** In the store from the first run:

```
$ echo '{"session_id":"s-df","hook_event_name":"SessionStart","source":"startup"}' \
  | TWINING_OFFLINE=1 node $V/dist/cli/twining.js hook claude-code SessionStart --project <B>/repo
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"## Twining — working set for this scope\n\n- [proposal] finding: seed\n  (does not authorize action on its own)\n\n…"}}
(exit 0, empty stderr)
```

The hook renders the posted finding's body from the local store and never builds an embedder (no offline-model line on stderr). Its behaviour inside a real Claude Code or Codex host is not shown here (§7).

## 6. Observing traffic — and what that proves

**Instrument used: `W/probe.mjs`** (§2) — spawns the built server, drives JSON-RPC, and runs `lsof -n -P -i -a -p <pid>` every 500 ms. No npx, no tsx, no source imports.

**`scripts/measure/observe-traffic.sh` (D9) — do not quote its report as evidence about Twining.**

```
$ TWINING_OFFLINE=1 TWINING_DASHBOARD=0 bash $V/scripts/measure/observe-traffic.sh --out <dir> --duration 25
[traffic] NON-LOOPBACK ENDPOINTS OBSERVED — see the report          (exit 0)
$ sort -u <dir>/connections.txt
node  <pid> dave  18u  IPv4 …  TCP <lan-ip>:<eph>->104.16.3.34:443 (ESTABLISHED)
$ sed -n '/Non-loopback/,+5p' <dir>/report.md        → 104.16.3.34:443 / 104.16.3.34:443 / <lan-ip>:<eph>
$ head -3 <dir>/session.log
[twining] ONNX embedding initialization failed. Falling back to keyword search: TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received an instance of Object
    at Object.join (node:path:…)
    at modelCacheDir (<V>/src/embeddings/embedder.ts:24:15)
$ tail -1 <dir>/session.log
[session] context created (offline flag NOT set - the server default)     # stale: TWINING_OFFLINE makes it offline
$ bash $V/scripts/measure/observe-traffic.sh --block
unknown argument: --block                                                 (exit 2)
$ dig +short registry.npmjs.org A | sort -t. -k3 -n | tr '\n' ' '
104.16.0.34 104.16.1.34 … 104.16.11.34
```

Attribution: the harness launches `( cd "$REPO_ROOT" && VITEST= npx tsx … )`; `tsx` is not installed in the tree (`ls $V/node_modules/.bin/tsx` → `No such file or directory`), so npx resolves it from its own cache in `~/.npm/_npx/` and contacts `registry.npmjs.org`; when that cache is cold or stale it also downloads and installs `tsx` at run time (`session.log` then begins `npm warn exec The following package was not found and will be installed: tsx@…`). The control `W/control.mjs` runs the same launcher on a script that imports no Twining code:

```
$ for i in 1 2 3; do node W/control.mjs $V; done       # each run prints three lines
npx exit=0
[no-twining] done
node <pid> TCP <lan-ip>:<eph>->104.16.10.34:443 (ESTABLISHED)
```

All three runs printed this; only the pid changed. The address is one of the `registry.npmjs.org` A records from the `dig` above, so it can differ between sessions.

The socket is short-lived against a 2 Hz poll, so a control or a harness run can also catch nothing; a clean report is not evidence that no connection was made.

**What an observation can prove:** for the exercised code path, on this machine and configuration, which non-loopback TCP/UDP endpoints the observed process (tree) held during the sampled window. Hostnames are attributed afterwards with `dig`: `huggingface.co` → `18.164.174.x`, `registry.npmjs.org` → `104.16.x.34`, `us.i.posthog.com` → `3.41.202.x`, `api.anthropic.com` → `160.79.104.10`.

**What it cannot prove:**
1. Absence in general — a path not driven is not a path that does not exist, and a connection can open and close between samples. A warm model cache hides the download.
2. Enforcement — nothing is blocked; macOS offers no unprivileged per-process network namespace, and the harness has no `--block`.
3. Content — destinations only, not payloads; that needs a TLS-intercepting proxy, out of scope.
4. Detached subprocesses (the browser of row 6′) and traffic a host makes on Twining's behalf.
5. Which module opened a socket — only a no-Twining control can attribute it.

Report any output as *observed destinations for the exercised path*, never as "Twining makes no network calls".

## 7. Not verified / UNAVAILABLE

- **Row 1 positive control** (server without the switch, cold cache): producible here (`node W/probe.mjs $V/dist/index.js <new dir>` with `TWINING_OFFLINE` unset, then `dig`), **NOT RUN** — the operating rule for these docs puts `TWINING_OFFLINE=1` on every command to prevent the download. "ON" in row 1 is a code reading until it runs. Unit coverage `test/core/offline-switch.test.ts` exists, not executed here.
- **D3 in operation** (the plugin bundle actually downloading under `TWINING_OFFLINE=1`): NOT RUN for the same reason; the claim rests on the `grep -c` result.
- **Network half of the exchange** — ssh/https remote, credentials, TLS, remote authentication, key rotation, revocation: **UNAVAILABLE**. It needs a second physical computer and a real network remote (owner's action); pushing to a real hosted remote would be an irreversible external action. The Git carrier is exercised only by `test/exchange/git-transport.test.ts` against bare local repositories (not executed here). The C28 remote bundle uses `FsTransport` plus shell git, not `GitTransport`, and its README says it has never been run on a second machine. A bare local repository is not a network; nothing here may be reported as network-tested.
- **Codex on a real host**: **UNAVAILABLE** — not installed here and the owner has not granted hook trust; `doctor`'s 7/7 is an adapter claim.
- **Hooks inside a real Claude Code session**: **UNAVAILABLE** here; §5 drives the CLI shim directly.
- **CI-published npm package's baked PostHog key**: not on this machine; check command in §3.
- **Browser auto-open** (row 6′): **NOT DEMONSTRATED** — every boot here set `TWINING_DASHBOARD=0` or `TWINING_DASHBOARD_NO_OPEN=1`. The bundle carries one `import("open")` (`grep -c 'import("open")' $V/plugin/server/twining-server.mjs` → `1`) and `open` ^10.2.0 is a dependency; per the code a different project on the busy port does not suppress the open.
- **The dev-time `api.anthropic.com` call that produced `calibration.json`**: **NOT VERIFIED as observed traffic** — inferred from the file's self-description (`reference: anthropic-count-tokens/claude-sonnet-4-5`) and the script's refusal without `ANTHROPIC_API_KEY`; no capture exists. What was sent is the corpus text.
- **Summarize, storage, graph, retrieval**: in-process, no network (from source, not a run: `twining_summarize` aggregates the decision index and blackboard; storage is `node:sqlite` with no native sqlite package in `package.json`; no `rerank` in `src/retrieval/`).

## 8. Drivers

`W/probe.mjs` — stdio probe of the built server:

```js
// Usage: node probe.mjs <dist/index.js> <projectRoot>   (env passes through; dashboard off)
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
const [, , SERVER, root] = process.argv;
fs.mkdirSync(`${root}/.twining`, { recursive: true });
const c = spawn("node", [SERVER, "--project", root], { env: { ...process.env, TWINING_DASHBOARD: "0" } });
let err = "", buf = ""; const res = {};
c.stderr.on("data", (d) => (err += d));
c.stdout.on("data", (d) => { buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1);
    try { const m = JSON.parse(l); if (m.id) res[m.id] = m; } catch {} } });
const send = (m) => c.stdin.write(JSON.stringify(m) + "\n");
const wait = async (id) => { while (!res[id]) await new Promise((r) => setTimeout(r, 50)); return res[id]; };
const samples = [];
const iv = setInterval(() => { try { samples.push(execFileSync("lsof", ["-n", "-P", "-i", "-a", "-p", String(c.pid)], { encoding: "utf8" })); } catch { samples.push(""); } }, 500);
send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "probe", version: "0" } } });
const init = await wait(1);
send({ jsonrpc: "2.0", method: "notifications/initialized" });
const calls = {};
const tools = [["twining_post", { entry_type: "finding", summary: "data-flow probe", scope: "src/embeddings/" }],
  ["twining_assemble", { task: "data-flow probe", scope: "src/embeddings/" }],
  ["twining_query", { query: "embedding model download", limit: 3 }]];
for (const [n, [name, args]] of tools.entries()) {
  send({ jsonrpc: "2.0", id: n + 2, method: "tools/call", params: { name, arguments: args } });
  const r = await wait(n + 2);
  calls[name] = r.error ? r.error.message : r.result?.isError ? r.result.content[0].text : "ok";
}
await new Promise((r) => setTimeout(r, 4000));
clearInterval(iv); c.stdin.end();
const exit = await new Promise((r) => c.on("exit", (code) => r(code)));
const sockets = [...new Set(samples.join("\n").split("\n").filter((l) => /TCP|UDP/.test(l)))];
console.log(JSON.stringify({ serverInfo: init.result.serverInfo, calls, exit, lsof_samples: samples.length, sockets,
  models_dir_after: fs.existsSync(`${root}/.twining/models`), stderr: err }, null, 2));
```

`W/sync-exp.sh` — the §5 one-machine stand-in (`MIGRATE=1` adds the D6 step):

```bash
#!/usr/bin/env bash
# Usage: bash sync-exp.sh <new empty dir> <built checkout>
set -u; B=$1; V=$2
export TWINING_OFFLINE=1 TWINING_DASHBOARD=0 TWINING_IDENTITY_HOME="$B/identity-home"
CLI="node $V/dist/cli/twining.js"; MCP="node $V/dist/index.js"
git init --bare -q -b main "$B/remote.git"; git init -q -b main "$B/repo"
git -C "$B/repo" -c user.email=a@localhost -c user.name=a commit -q --allow-empty -m init
git -C "$B/repo" remote add origin "$B/remote.git"; git -C "$B/repo" push -q origin main
echo "### identity init"; $CLI identity init --label audit --project "$B/repo"; echo "exit=$?"
[ "${MIGRATE:-0}" = 1 ] && { echo "### migrate --to 3"; $MCP migrate --to 3 --project "$B/repo" 2>&1 | head -2; }
echo "### post"; $CLI post --project "$B/repo" --json '{"entry_type":"finding","summary":"seed","scope":"project"}'; echo "exit=$?"
echo "### sync --remote origin"; $CLI sync --remote origin --project "$B/repo"; echo "exit=$?"
echo "### layout"; ls -a "$B/repo/.twining"; ls "$B/repo/.twining/exchange" 2>&1
echo "### refs"; git -C "$B/repo" for-each-ref --format='%(refname)'; git -C "$B/remote.git" for-each-ref --format='%(refname)'
echo "### doctor"; (cd "$B/repo" && $CLI doctor --project "$B/repo"); echo "exit=$?"
```

`W/control.mjs` — the npx attribution control:

```js
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
const script = `${fs.mkdtempSync(`${os.tmpdir()}/ctl-`)}/no-twining.mts`;
fs.writeFileSync(script, `await new Promise((r) => setTimeout(r, 8000)); console.log("[no-twining] done");\n`);
const c = spawn("npx", ["tsx", script], { cwd: process.argv[2], env: { ...process.env, VITEST: "" } });
let log = ""; c.stdout.on("data", (d) => (log += d)); c.stderr.on("data", (d) => (log += d));
const tree = (pid) => { let k = ""; try { k = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }); } catch {}
  return [String(pid), ...k.split("\n").filter(Boolean).flatMap(tree)]; };
let done = false, code; c.on("exit", (x) => { done = true; code = x; });
const lines = new Set();
while (!done) {
  try { execFileSync("lsof", ["-n", "-P", "-i", "-a", "-p", tree(c.pid).join(",")], { encoding: "utf8" })
    .split("\n").filter((l) => /TCP|UDP/.test(l)).forEach((l) => lines.add(l.replace(/^(\S+\s+\d+).*?(TCP|UDP) /, "$1 $2 "))); } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
console.log(`npx exit=${code}\n${log.trim()}\n${[...lines].join("\n") || "(no socket caught)"}`);
```
