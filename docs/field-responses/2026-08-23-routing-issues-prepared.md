# Routing proposals — four GitHub issues and one #46 correction, PREPARED

**STATUS: PREPARED — NOT FILED.** Filing is gated on the project owner's go
(same gate as the batch send). The field's account is an Enterprise Managed
User and cannot create issues on this repo, so filing is ours to do or
decline. Nothing below has been posted anywhere.

What this file is: the four issue bodies from `TWINING-ROUTING-UPSTREAM.md`
(2026-08-18), byte-faithful from each `## Summary` through its `## Related`
list, with exactly one permitted edit — the final attribution line (preceded by
a blank line) — plus a
maintainer comment per issue, written by us, to post immediately after
filing. Every technical claim in the maintainer comments is verified against
HEAD `0f65ef0` (server 2.16.0 / plugin 1.34.0); hook line numbers are plugin
1.34.0. Work is slotted by wave name (W3 = 2.18.0, W5 = 2.20.0; 2.18.1 is the
pre-agreed W3 relief valve), never by date.

**After filing, two edits are mandatory:**

1. Replace the `#(F1)`–`#(F4)` placeholders in all four bodies and all five
   comments with the real numbers (the bodies cross-reference each other, so
   file all four first, then substitute, then `gh issue edit`). The script in
   §6 does this.
2. Append the number map to the end of Doc 3
   (`docs/field-responses/2026-08-23-routing-upstream-response.md`, §0
   promises it). §6 prints the line to append.

**Labels.** The repo carries only GitHub's nine default labels (`bug`,
`documentation`, `duplicate`, `enhancement`, `good first issue`,
`help wanted`, `invalid`, `question`, `wontfix` — `gh label list`, checked
2026-08-25). The field's suggested `breaking-change`, `dx`, and `design` do
not exist. Each issue below names the nearest existing label; §6 carries
commented-out `gh label create` lines if the owner would rather add the
three suggested labels first (owner call — not required to file).

**Extraction markers.** Each body and comment sits between HTML-comment
markers (`<!-- BODY:issue-1 START -->` … `END`, `<!-- COMMENT:issue-1 … -->`,
`<!-- COMMENT:46 … -->`). The §6 recipe extracts by marker; do not edit the
text between `BODY` markers.

---

## 1. Issue 1

**Title (verbatim):** `Relative TWINING_PROJECT resolves against cwd, not the declaring repo — silently wrong in subdirs and worktrees`

**Labels:** `enhancement` (the field suggested `bug` or `enhancement` plus
`breaking-change`; the issue's own text calls it a request to change
specified behavior, which is `enhancement`, and `breaking-change` does not
exist here — the maintainer comment states the default-behavior change and
its wave instead).

**Body (verbatim from the field doc; placeholders intact):**

<!-- BODY:issue-1 START -->
## Summary

A relative `TWINING_PROJECT` resolves against the **process cwd**, not against the repo that declares it. The declaration is therefore correct only when cwd happens to be exactly the repo root — and it is silently wrong everywhere else, including inside a linked worktree.

This is the behavior asserted by `test/project-root.test.ts:32` (`"resolves a relative TWINING_PROJECT against cwd"`), so this is a request to change specified behavior, not a bug report.

## Where

`src/utils/project-root.ts`:

```ts
const fromEnv = env["TWINING_PROJECT"];
if (fromEnv && fromEnv.trim().length > 0) return path.resolve(cwd, fromEnv);
```

Mirrored in the hooks — `hooks/activity-marker-hook.sh` (1.33.0, line 71), which the file states is copied VERBATIM across all five hooks:

```bash
[[ "$PROJECT_ROOT" != /* ]] && PROJECT_ROOT="$(pwd)/$PROJECT_ROOT"
```

## Reproduction

A fleet of sibling repos sharing one coordination store — the exact use case the env var was added for, per the header comment in `project-root.ts` ("a fleet of sibling repos coordinating through one `../chassis/.twining` with a single version-agnostic env line"). Each repo's `.claude/settings.json` carries:

```json
{ "env": { "TWINING_PROJECT": "../wfos-chassis" } }
```

Measured resolution:

| cwd | resolves to | |
|---|---|---|
| `/repos/wfos-registry` | `/repos/wfos-chassis` | correct |
| `/repos/wfos-registry/src/lib` | `/repos/wfos-registry/src/wfos-chassis` | does not exist |
| `/tmp/wt/wfos-registry` (linked worktree) | `/tmp/wt/wfos-chassis` | does not exist |

The hooks fail closed on the bad cases — they bind only if `$PROJECT_ROOT/.twining` already exists, so `TWINING_DIR` stays empty and the hook bails. That is the good outcome, but it means **Gate-2 stamping is silently off**, which is the same class of silent failure that `canonpath()` was added in 1.33.0 to close. The hook comment notes the server's resolution "may create the store fresh," so the server may instead **create** a spurious `<subdir>/wfos-chassis/.twining`.

## The two existing features don't compose

Only two commits have ever touched this file:

- `17dc716 feat: TWINING_PROJECT env var — shared coordination stores across sibling repos`
- `8cc23e8 feat: worktree-aware .twining root resolution — cmux --worktree teammates share the main store`

`TWINING_PROJECT` is documented as never worktree-redirected. So the worktree-awareness added by the second commit is switched off precisely by the flag the first commit added. A fleet that uses both — a shared store *and* `cmux --worktree` teammates — gets neither behavior.

The intersection is untested. `test/project-root.test.ts:114` covers `TWINING_PROJECT` set to an **absolute** worktree path. Nothing covers a **relative** `TWINING_PROJECT` from a worktree cwd, which is the case above.

## Proposed change

Resolve a relative `TWINING_PROJECT` against the declaring repo's root rather than cwd, preferring the main checkout when cwd is a linked worktree:

```ts
if (fromEnv && fromEnv.trim().length > 0) {
  const base = resolveWorktreeMain(cwd) ?? gitRootOf(cwd) ?? cwd;
  return path.resolve(base, fromEnv);
}
```

`resolveWorktreeMain` is already exported at `src/utils/project-root.ts:31`. Absolute `TWINING_PROJECT` values are unaffected. Hooks need the same change in all five copies.

Effect: `../wfos-chassis` means "my sibling" from any depth and from any worktree location, and stays machine-independent — so it survives a checkout at a different path on another operator's machine.

## Cost, and the argument against

For a single-repo user, "relative to the process cwd" is a defensible reading, and it is what the tests currently pin. Changing it silently redirects anyone who was (perhaps unknowingly) relying on cwd-relative semantics.

Suggested migration rather than a flag day: when the cwd-relative and repo-relative bases disagree, and exactly one of them contains a `.twining`, bind that one and emit a deprecation notice naming both. Flip the default once the notices show the cwd-relative form is unused.

**Alternative considered and rejected:** tell operators to write absolute paths. That breaks portability across machines, which is the stated reason the env var exists in the first place — a second operator's checkout lives at a different path.

## Tests to add

- relative `TWINING_PROJECT` from a subdirectory resolves to the repo's sibling, not the subdirectory's
- relative `TWINING_PROJECT` from inside a linked worktree resolves against the **main** checkout
- absolute `TWINING_PROJECT` is unchanged (regression guard)
- `--project` still wins over both (regression guard)

## Related

- #(F2) undeclared cross-repo binds are silent
- #(F3) `expect_project` assertion and resolution trace

Filed on behalf of a field report from a fleet user whose account cannot create issues here.
<!-- BODY:issue-1 END -->

### Maintainer comment (post immediately after filing)

<!-- COMMENT:issue-1 START -->
Accepted. Diagnosis confirmed at 2.16.0 / plugin 1.34.0: the server resolves a relative value against the process cwd at `src/utils/project-root.ts:81-84`, and the cwd-relative line is in all five hook copies (`activity-marker-hook.sh:71`, `session-start-context.sh:34`, `stop-hook.sh:54`, `pre-commit-hook.sh:73`, `subagent-stop-hook.sh:41` — mirrored in content, not in position). Your three-row measurement table is what the code does.

**The server side is worse than the hook side — and the hook side's fail-closed lasts only until the server spawns.** The hooks bind only if `$PROJECT_ROOT/.twining` exists. The server does not check: `ensureInitialized` (`src/storage/init.ts:135-138`) calls `initTwiningDir`, which returns early only when `.twining` already exists (`:69-72`) and otherwise creates it unconditionally — seven recursive `mkdir`s (`:75-81`) plus config, index, graph, registry, gitignore and gitattributes files (`:97-129`) — at whatever path resolved, with no validation of the parent. That runs inside `createServer` at process spawn (`src/index.ts:52`, before `server.connect`), so a misresolved relative value fabricates a complete, empty, healthy-looking store at `<subdir>/wfos-chassis/.twining` before any hook has fired — and every hook fired afterwards re-resolves the same value, finds its `-d "$PROJECT_ROOT/.twining"` check true for the spurious path (`activity-marker-hook.sh:72`), and binds it too. Server and hooks then agree on the wrong store; every call in that session reports a confident zero, and the coherence is why nothing fires.

Two corrections to the proposed change:

1. `gitRootOf` does not exist — it appears nowhere in `src/`, `plugin/`, or `test/`. It has to be written: a pure-fs walk-up that stops at the first ancestor whose `.git` is a directory OR a file (a linked worktree's `.git` is a file; a walk accepting only directories sails through a worktree root), never throws, returns null at `/`.
2. `resolveWorktreeMain(cwd) ?? gitRootOf(cwd) ?? cwd` mis-handles a subdirectory of a linked worktree. `resolveWorktreeMain` does not walk up: it stats exactly `path.join(dir, ".git")` and returns null unless that is a file (`project-root.ts:33-34`). From `/tmp/wt/wfos-registry/src/lib` it returns null, `gitRootOf` then finds the worktree root, and the value resolves against the worktree — the `/tmp/wt/wfos-chassis` row of your table, still wrong. Walk first, then redirect:

```ts
const root = gitRootOf(cwd) ?? cwd;              // declaring repo (or worktree) root
const base = resolveWorktreeMain(root) ?? root;  // prefer the main checkout
return path.resolve(base, fromEnv);
```

Tests: your four are adopted as written, plus a fifth — a relative `TWINING_PROJECT` from a subdirectory of a linked worktree resolves against the main checkout — which is the case the corrected composition exists for, and a sixth pinning the opt-out: the same with `TWINING_WORKTREE_LOCAL=true` resolves against the worktree root (the env branch honours the opt-out exactly as the cwd-default branch does at `project-root.ts:88-90`). The hook mirror gets the same six in its own harness. `test/project-root.test.ts:32` flips to the new spec at the default flip, not before.

Migration follows the design in this issue. **W3** (our 2.18.0 release; or a 2.18.1 point release if the W3 bundle in #(F3) has to be split): warn phase — when the cwd-relative and repo-relative bases disagree, an identical candidate policy in the TypeScript resolver and all five hooks (equal: silent; exactly one candidate has a `.twining`: bind it and emit a notice naming both and which rule bound; both: bind cwd — today's semantics — with a loud ambiguity warning; neither: not yet decided — until it is, cwd semantics are preserved as the conservative default). **W5** (2.20.0, two releases after W3): the default flips to the corrected composition, gated on the W3 notices being quiet. This is a default-behavior change and ships in its own wave for that reason.

Cross-reference: #46 introduced `TWINING_PROJECT`; its closing maintainer note recommending absolute paths for multi-machine setups is withdrawn (see the comment there), and the `project-root.ts:15-17` header claim that the env var is "never redirected" is revised by this issue. Related: #(F2), #(F3).
<!-- COMMENT:issue-1 END -->

---

## 2. Issue 2

**Title (verbatim):** `Store resolution crosses repo boundaries silently — warn when an undeclared ancestor store binds`

**Labels:** `enhancement` (the field suggested `enhancement`, `dx`; `dx` does
not exist here).

**Body (verbatim from the field doc; placeholders intact):**

<!-- BODY:issue-2 START -->
## Summary

Store resolution crosses repository boundaries freely and silently. There is no directory layout in which a missing or wrong declaration produces an error — every way of getting it wrong produces a *wrong answer*, quietly.

Asking for a **warning**, not a hard failure. Reasoning for that choice is below.

## Why a git root isn't a boundary

From the resolution walk in `hooks/activity-marker-hook.sh` (1.33.0, and identical in 1.25.0), which the file states is mirrored VERBATIM across all five hooks and matches `src/utils/project-root.ts`:

```bash
DIR="$(pwd)"
while [[ "$DIR" != "/" ]]; do
  if [[ -f "$DIR/.git" ]]; then     # only .git as a FILE — a linked worktree
    ...
  fi
  if [[ -d "$DIR/.twining" ]]; then # the only other break
    TWINING_DIR="$DIR/.twining"
    break
  fi
  DIR="$(dirname "$DIR")"
done
```

`.git` as a **directory** is never inspected. Only `.git` as a **file** (a linked worktree) is, and only that is treated as a redirect. So the walk exits a repository without noticing.

## Consequence

Measured on one host with a nested chain of stores:

```
/Users/…/.twining                       EXISTS (0 decisions)   <- home-directory catch-all
/Users/…/code                           clean
/Users/…/code/workspace/.twining        EXISTS (67 decisions)  <- not a git repo at all
/Users/…/code/other/.twining            EXISTS                 <- parent of a real repo
/Users/…/code/other/project/.twining    EXISTS (4086 decisions)
```

Because `~/.twining` exists, **the walk always terminates in a bind.** A repo with no declaration and no local store inherits the nearest ancestor's store, with no error and no output saying so.

Two consequences worse than untidiness, both observed:

1. Records landed in a directory that **is not a git repository**, so they are unpushable and cannot transfer to another operator — which defeats the point of a durable decision store.
2. Where a decision store is an input to a lint or gate, the records explaining a change are absent from the corpus that gate reads. The gate passes for the wrong reason.

The nastiest variant: a repo that has a `.claude/settings.json` carrying only hooks, and therefore *looks* configured, while declaring no `TWINING_PROJECT`. Presence is not configuration, but it reads as configuration.

## Proposed change

When the bound store is outside the current git repository **and** was not explicitly declared (no `--project`, no `TWINING_PROJECT`), say so in the output of `twining_assemble` and `twining_status`. Something like:

```
store: /Users/…/code/workspace/.twining
note:  bound by ancestor walk from /Users/…/code/workspace/repo-a
       this store is OUTSIDE the current git repository and was not declared
       declare it with env.TWINING_PROJECT in .claude/settings.json to make this intentional
```

Non-breaking: nothing changes about which store binds. It changes only whether the operator finds out.

## Why not fail closed

The obvious hardening is to make a git root a hard walk boundary so an undeclared crossing errors. I looked at that first and think it's wrong as a default:

- A `.twining` in a directory *above* several sibling repos, shared without any declaration, is a plausible and probably common onboarding path — run twining once at the top, everything beneath shares it. Failing closed demands every repo declare before anything works.
- On the host measured above, at least one parent-of-repo store looks deliberate.

Deleting the offending ancestor store is also not a fix: with `~/.twining` present, the walk just falls through to a home-level store shared by every project on the machine — strictly worse.

So: warn first. If the warnings show ancestor inheritance is rare in practice, an opt-in `TWINING_STRICT_REPO_BOUNDARY=true` that turns the warning into a refusal would be a reasonable second step for fleets that want it.

## Related

- #(F1) relative `TWINING_PROJECT` resolves against cwd instead of the repo root
- #(F3) `expect_project` assertion and resolution trace

Filed on behalf of a field report from a fleet user whose account cannot create issues here.
<!-- BODY:issue-2 END -->

### Maintainer comment (post immediately after filing)

<!-- COMMENT:issue-2 START -->
Accepted, with one rewording of the rule. The walk you quoted is the hooks' walk (`plugin/hooks/activity-marker-hook.sh:95-124` and its four mirrors), and your reading of it is right: `.git` as a directory is never inspected, only `.git` as a file, so the hooks leave a repository without noticing, and a `~/.twining` guarantees the walk ends in a bind.

But the server never ancestor-walks. Its cwd-default branch is `resolveWorktreeMain(cwd) ?? cwd` (`src/utils/project-root.ts:86-91`) — one linked-worktree check at exactly cwd, then cwd itself. There is no walk anywhere in `src/`; the hook comment (`activity-marker-hook.sh:36-39`) says the block "matches the server's resolution" — that holds for the precedence order only; the server has no walk, and its env branch creates where the hook's declines to bind. The server-side equivalent of your silent failure is therefore not inheritance of an ancestor store but spurious CREATION at cwd (`src/storage/init.ts:75-81`, unconditional). A session launched in `workspace/repo-a` with no declaration creates `repo-a/.twining` on the server side at spawn; every hook fired after that walks from cwd, checks `$DIR/.twining` at cwd before ascending (`activity-marker-hook.sh:118`), finds the fabricated store first and binds it too. Only a hook that runs before the server has spawned can still bind `workspace/.twining`. So the failure is a coherent, silent misroute — server and hooks agreeing on the wrong store — not a split, and the coherence is what makes it invisible today.

**Ships in W3** (our 2.18.0 release), in the shape you sketched (store, rule, why, the one-line fix), on both `twining_status` and `twining_assemble`: the warning fires when the resolution rule is `cwd-default` and the resolved root is outside — or has no — git repository as seen from cwd, with a created-store addendum when the store was created by this process (`created: true` from #(F3)). Declared roots (`--project`, `TWINING_PROJECT`) and worktree redirects are exempt, as you asked. Nothing changes about which store binds.

Your warn-not-refuse reasoning is adopted in full. `TWINING_STRICT_REPO_BOUNDARY=true` as an opt-in refusal is the second step, considered once the resolution trace in #(F3) shows how often this warning actually fires — W5 (2.20.0, two releases after W3) or later, not before. Related: #(F1), #(F3).
<!-- COMMENT:issue-2 END -->

---

## 3. Issue 3

**Title (verbatim):** `Add expect_project to twining_assemble, and a resolution trace to twining_status`

**Labels:** `enhancement` (as the field suggested).

**Body (verbatim from the field doc; placeholders intact):**

<!-- BODY:issue-3 START -->
## Summary

Every way of misrouting a store is silent (see #(F1), #(F2)). Two additions would convert that silence into noise:

1. An `expect_project` parameter on `twining_assemble` that refuses on mismatch.
2. A resolution trace in `twining_status` reporting *which rule fired* and *what it resolved to*.

## Why a parameter and not a convention

The natural remediation for a misroute is "the agent should check `twining_status.project` at session start and abort if it isn't the expected store." That works exactly once. It's operator discipline, and discipline decays — especially across sessions with no shared memory, which is the condition twining exists to address.

As a parameter it becomes a mechanism, and it can live in the repo's own `.claude/settings.json` alongside `TWINING_PROJECT`, so it is *inherited* by every session in that repo rather than remembered by each one:

```
twining_assemble({ task: "...", scope: "src/", expect_project: "wfos-chassis" })
→ refuses: bound store is "workspace" (bound by ancestor walk), expected "wfos-chassis"
```

Gate 1 is already mandatory and already the first tool call, so this costs nothing extra at runtime. It just makes the gate check the thing it is standing in front of.

## Resolution trace

`twining_status` currently reports `project: "<name>"` and nothing about how it got there. Four rules can produce that name (`--project` argv, `TWINING_PROJECT` env, linked-worktree redirect, ancestor walk) and they fail in different ways, so the name alone is not diagnosable. Proposed additions:

- `rule` — which of the four fired
- `candidate` — the raw declared value, before resolution
- `resolved` — the absolute path bound
- `inside_repo` — whether the store is within the current git repository
- `created` — whether this call created the store or found it existing

`created` matters on its own: a typo'd relative path that causes the server to *create* a fresh empty store is indistinguishable, from the caller's side, from a correctly-bound store that happens to be new.

## Prerequisite: store self-identity

`expect_project` is only as good as the identity it compares. `project` appears to be directory-derived, so two stores whose parent directories share a basename are indistinguishable by name — and a spuriously created store at `<subdir>/wfos-chassis/.twining` would report the *expected* name while being the wrong store.

Writing a stable id into the store at creation time (and comparing that, with the human-readable name as a fallback) makes the check trustworthy. Without it, `expect_project` catches the common case but not the one that motivated it.

## Related

- #(F1) relative `TWINING_PROJECT` resolves against cwd instead of the repo root
- #(F2) undeclared cross-repo binds are silent
- #(F4) store-side write policy

Filed on behalf of a field report from a fleet user whose account cannot create issues here.
<!-- BODY:issue-3 END -->

### Maintainer comment (post immediately after filing)

<!-- COMMENT:issue-3 START -->
Accepted, and merged with a store-identity item already on our roadmap: every tool response (success and error) will carry the identity of the store it came from. Your issue supplies the identity that echo needs. The **W3** (our 2.18.0 release) bundle:

1. **Resolution trace** on `twining_status` and `twining_assemble`: `resolution: { rule, candidate, resolved, inside_repo, created }`, `rule ∈ argv | env | worktree-redirect | cwd-default` — your five fields, your names. `created` is threaded out of `ensureInitialized`, which today returns only the path (`src/storage/init.ts:135-138`).
2. **Stable `store_id`**: a ULID stamped into `config.yml` at creation. Existing stores get an append-only line on next boot, fail-open (a store that cannot be written keeps working un-stamped and the trace says so). This is logical-store identity — committed and shared by every clone on every machine, deliberately — so two checkouts of the chassis store compare equal and a spurious `<subdir>/wfos-chassis/.twining` does not.
3. **Your basename-collision point is proven by our own store.** Status derives `project` as the basename of the store's parent (`src/tools/lifecycle-tools.ts:51-53`); creation stamps `project_name: path.basename(projectRoot)` (`init.ts:94`). This repo's `.twining/config.yml:2` literally reads `project_name: .`, stamped at creation from a project root passed as `--project .` and taken verbatim (`project-root.ts:73-75` passes the argv value through unresolved). The dashboard already uses the fixed derivation, `path.basename(path.resolve(projectRoot))` (`src/dashboard/api-routes.ts:364`, `:445`); the tool side never got it.
4. **Store echo** `<basename>#<id6>` appended by BOTH `toolResult` (`src/utils/errors.ts:7-11`) and `toolError` (`:14-23`) — today neither carries any store identity, and an error path that omits it is exactly where a misroute hides.
5. **`expect_project` on `twining_assemble`**: passes on a `store_id` match or a `basename(path.resolve(root))` match; refuses with `STORE_MISMATCH` naming both sides, the rule that bound, and the fix; ALSO refuses on `created: true` regardless of name match — the spurious store carrying the expected name is your motivating case and only `created` catches it. The check runs before `assembleWithStatus` (`src/tools/context-tools.ts:38`), because that call sets the assembled state that the decide and verify checkers later read (`src/server.ts:175-177`, `:197-199`); a refusal has zero side effects on it.

One honest limit: **`expect_project` cannot prevent creation.** `ensureInitialized` runs inside `createServer` (`src/server.ts:67-69`) at process spawn, before any tool call exists, so by the time `twining_assemble` runs a misrouted store is already on disk. W3 gives you a refusal that names it so the session stops before writing into it; the only true prevention is lazy creation (first write creates, reads do not), a W5 (2.20.0, two releases after W3) candidate, not a W3 commitment.

Vehicle: W3. Fallback, decided now rather than later: if the 2.18.0 review cannot digest the whole bundle, `expect_project`, the #(F2) warning, and the #(F1) warn phase / `TWINING_ROLE` riders move to a 2.18.1 point release; `store_id` and the echo ship together in W3 in every scenario, because echoing a bare basename would re-open the ambiguity just conceded. One naming note: `twining_resolve` already exists (it marks open blackboard items resolved), so the trace ships as a field on `twining_status` / `twining_assemble`, not as a new `resolve` tool. Related: #(F1), #(F2), #(F4).
<!-- COMMENT:issue-3 END -->

---

## 4. Issue 4

**Title (verbatim):** `Store-side write policy — let a store declare who may write to it (and why per-call store targeting is the wrong fix)`

**Labels:** `enhancement` (the field suggested `enhancement`, `design`;
`design` does not exist here — `question` is the nearest default but reads
as "information requested", which this is not; omit it unless the owner
creates `design`).

**Body (verbatim from the field doc; placeholders intact):**

<!-- BODY:issue-4 START -->
## Summary

A setup that deliberately separates two stores by role — agents that write code may not mutate the design store; agents that write design may not write code — currently has that separation enforced by nothing but **which directory a process happens to sit in.**

That is an accident of process startup, not a boundary. Proposal: let a store declare who is allowed to write to it.

This issue also argues **against** the feature that would most obviously "solve" the same problem — a per-call store-targeting parameter — because it would dissolve the boundary rather than enforce it.

## The failure

Observed, not hypothetical. A session rooted in a coordination workspace recorded seven decisions and thirteen findings that belonged to a different repo's design store. They landed in the workspace store instead. No error, no warning, no output that differed in any way from a correct run. The two stores are meant to be write-isolated from each other by role, and the isolation held only as long as every process happened to start in the right directory.

Related mechanics in #(F1) and #(F2), but those are about *which* store binds. This is about *whether the binding was allowed to write*.

## Proposed change

The store declares its own accepted writers. Something like `.twining/policy.json`:

```json
{ "accepts": ["design"] }
```

A session declares a role (`TWINING_ROLE`, or a field in `.claude/settings.json`), and the server refuses writes — `twining_record`, `twining_post`, `twining_decide` — when the role is not accepted. Reads stay open, since the useful direction is that a coding agent can *consult* design decisions without being able to amend them.

Default when no `policy.json` exists: accept everything. Existing stores are unaffected; the constraint is opt-in per store, which is right, because most projects have exactly one store and no roles to separate.

What this buys: the separation becomes a property of the store, which is version-controlled and travels with the repo, rather than a property of a shell's working directory, which does not survive a session restart or transfer to another operator.

## Explicit non-goal: a per-call `project` parameter

The most direct fix for the incident above would be a `project` parameter on `twining_record`, letting a session write to a store other than the one it bound. It would have let that session put its records in the right place with no relaunch.

I think it would be a mistake, and I want it on the record rather than discovered later:

- It converts an architectural boundary into a per-call convention. "Coding agents may not mutate design" stops being enforceable by construction the moment any caller can name any store.
- It makes the caller the authority on what it may write to. The whole value of the separation is that the caller is *not* that authority.
- It is strictly more powerful than needed. The legitimate need is "let a process bind the right store," which #(F1) addresses, and which `--project` already covers for a deliberately launched second server.

If cross-store writes turn out to be genuinely necessary, the safe shape is the inverse: the **target** store names who may write to it — which is this issue — rather than the caller naming its target.

## Open question

Whether roles should be free-form strings or a fixed small set. Free-form is more flexible and typo-prone in exactly the way that fails silently, which is the failure mode this whole set of issues is about. Leaning toward: free-form, but a policy naming a role that no session ever presents should be surfaced by the resolution trace in #(F3) rather than sitting unnoticed.

## Related

- #(F1) relative `TWINING_PROJECT` resolves against cwd instead of the repo root
- #(F2) undeclared cross-repo binds are silent
- #(F3) `expect_project` assertion and resolution trace

Filed on behalf of a field report from a fleet user whose account cannot create issues here.
<!-- BODY:issue-4 END -->

### Maintainer comment (post immediately after filing)

<!-- COMMENT:issue-4 START -->
Accepted as a design discussion and deliberately not patched. It becomes named design decision **DD-11** (our numbered design-decision register, tracked in `docs/plans/`), decided jointly with DD-6 (full read-only server mode — the degenerate policy `accepts: []`) and DD-4 (agent identity — a role is an identity claim and must not collide with `AgentRecord.role` or `agent_id`). The facts the design has to sit on, at 2.16.0:

- **21 of 39 registered tools mutate**, not the three named here. The 39 are the `registerTool` sites in `src/tools/`. Mutating: `record`, `post`, `decide`, `amend`, `promote`, `override`, `reconsider`, `resolve`, `acknowledge`, `dismiss`, `archive`, `unarchive`, `archive_stale`, `add_entity`, `add_relation`, `link_commit`, `register`, `handoff`, `delegate`, and — argument-gated on `execute: true` — `housekeeping` and `prune_graph`. A policy refusing only `record`/`post`/`decide` leaves eighteen doors open. One more is neither: `verify` is read-only by contract but auto-posts a `finding` to the blackboard whenever a check fails (`src/engine/verify.ts:115-128`) — result-gated, so neither an annotation nor an argument predicate classifies it; DD-11 has to rule on it explicitly.
- **No MCP `readOnlyHint` annotations exist today** on any of the 39 registrations; the classification above lives only in prose. DD-11 puts it on the registrations.
- **The seam is an unconditional pre-handler wrapper.** The only existing wrapper, `createInstrumentedServer` (`src/analytics/instrumented-server.ts:12-19`, patches `registerTool` to wrap every callback), is installed only when `config.analytics.metrics.enabled !== false` (`src/server.ts:255-257`). A policy layer cannot share a seam a config flag can remove. The storage-level `assertWritable` (`src/storage/sqlite/sqlite-stores.ts:51-58`) is the wrong seam: identity-blind (it checks only the format-version read-only flag), it gates internal maintenance writes policy must not block, and it fires per store write rather than per tool call, so a refusal placed there surfaces as a storage error from inside a tool instead of a named refusal at the tool boundary.
- **The Gate-2 interaction is commit denial, not deadlock.** The commit sentinel advances only on a successful `record`/`post`/`decide` (`src/utils/record-sentinel.ts:4-10`); `TWINING_DISABLED=true` bypasses every hook and the stop hook self-releases on `stop_hook_active` (`stop-hook.sh:31-33`), so nothing wedges — but a policy refusing all three pins the commit gate closed for the session. DD-11 must give the hooks a refusal protocol ("recording was refused" must be distinguishable from "recording was skipped").
- **Two write paths enter the stores beneath any tool wrapper**: the subagent-stop hook appends to `pending-posts.jsonl` (`subagent-stop-hook.sh:82-85`), drained by `PendingProcessor` (`src/engine/pending-processor.ts:66-67`); and record-sync ingest (`src/storage/sync/record-ingest.ts:1-12`, file wins) writes rows the session never authored. Ingest is exempt — it copies committed truth, and a policy that could refuse it would make a clone diverge from its own tree. The pending queue's treatment is a DD-11 question.

**Per-call `project` parameter: declined**, and the decline is re-recorded with this issue's architectural argument as its primary ground — the caller must not be the authority on what it may write to; a per-call target converts a structural boundary into a convention. We had previously declined this internally on store-lifecycle and locking cost; that reason is now secondary — cost arguments erode when the cost drops, the architectural one does not.

**Open question (roles):** our lean is free-form with normalization (trim, case-fold); an unmatched role in either direction — a policy naming a role no session presents, or a session presenting a role no policy names — surfaced through the #(F3) resolution trace rather than silently; a malformed `policy.json` fails closed with a named repair (a policy that fails open is the silent-wrong-answer class this set is about). Roles are a namespace disjoint from `agent_id`.

Slotting: **W3** (our 2.18.0 release; or its 2.18.1 point release if the W3 bundle in #(F3) has to be split) ships a `TWINING_ROLE` observability echo in the trace only (nothing enforces it). Enforcement no earlier than **W5** (2.20.0); DD-11's design session follows W4 (2.19.0). This is deliberately the last item in this set to get code, and filing it now serves its stated purpose — putting the argument against a per-call `project` parameter on the record before anyone proposes it. Related: #(F1), #(F2), #(F3).
<!-- COMMENT:issue-4 END -->

---

## 5. Comment for #46

Post on `daveangulo/twining-mcp#46` (closed 2026-07-21) after Issue 1 is
filed, with `#(F1)` substituted.

<!-- COMMENT:46 START -->
**Correction to the maintainer note in the body and to step 2 of the runbook comment above.** "Absolute paths recommended for multi-machine setups" is withdrawn. An absolute path cannot be right on two machines whose checkouts live at different paths — and a multi-machine fleet is the env var's own use case, which this issue's body already flagged ("supporting an absolute path (or resolving relative to the repo root) would harden it"). The absolute-path half of that sentence was the wrong half.

The runbook's step 2 parenthetical — "relative resolves against the repo root and works, but absolute survives odd cwd cases" — is withdrawn on both halves: relative resolves against cwd, not the repo root (`src/utils/project-root.ts:81-84`), and absolute does not survive a second machine.

The premise "relative values resolve against the server's cwd (the repo root when spawned by Claude Code)" also does not hold in general: cwd is the repo root only when the session is launched there. From a subdirectory, or from a linked worktree, a relative `TWINING_PROJECT` resolves to a path that does not exist — and the server then creates a spurious empty store at it (`src/storage/init.ts:75-81`, unconditional) at process spawn; the hooks, which bind only where a `.twining` exists, then find that one and bind it too — a coherent misroute, with no output that differs from a correct run. The measured table is in #(F1).

The fix is relative resolution against the declaring repo's root, preferring the main checkout when that root is a linked worktree (walk to the git root first, then apply the worktree redirect — the composition is in #(F1)). It ships as a warn phase first (W3, our 2.18.0 release: a notice whenever the cwd-relative and repo-relative bases disagree, identical policy in the server and all five hooks), then a default flip (W5, 2.20.0, two releases after W3), gated on the notices being quiet. Absolute `TWINING_PROJECT` values are unaffected throughout.

Until the flip: a relative value is correct exactly when the server's cwd is the declaring repo's root — launch sessions at the repo root, not from a subdirectory or a linked worktree. The header comment in `src/utils/project-root.ts:15-17` ("explicit --project and TWINING_PROJECT ... are never redirected") and the inline comment at `:78-80` repeating the absolute-path advice are revised by the same change. The rest of the runbook (steps 1, 3, 4) stands.
<!-- COMMENT:46 END -->

---

## 6. Filing commands (do not run until the owner rules go)

Titles are verbatim from the field doc. Bodies and comments are extracted
from this file by marker into the session scratchpad, filed, then the
placeholders are substituted with the real numbers and each body re-applied
with `gh issue edit`. Everything is `--repo`-qualified so it can run from
any cwd.

```bash
set -euo pipefail
REPO=daveangulo/twining-mcp
SRC=/Users/dave/code/twining-mcp/docs/field-responses/2026-08-23-routing-issues-prepared.md
OUT=/private/tmp/claude-501/-Users-dave-code-twining-mcp/295819f9-cedb-4979-9734-e344baa743a6/scratchpad/issues
mkdir -p "$OUT"

# Extract the text between a START/END marker pair (markers excluded).
extract() {
  awk -v tag="$1" \
    '$0 == "<!-- " tag " START -->" {f=1; next}
     $0 == "<!-- " tag " END -->"   {f=0}
     f' "$SRC"
}
for n in 1 2 3 4; do
  extract "BODY:issue-$n"    > "$OUT/issue-$n.md"
  extract "COMMENT:issue-$n" > "$OUT/comment-$n.md"
done
extract "COMMENT:46" > "$OUT/comment-46.md"
wc -l "$OUT"/*.md   # sanity: no file should be empty

# Optional (owner call): add the three labels the field suggested that do
# not exist here, then add them to the --label lists below.
# gh label create breaking-change --repo "$REPO" --color d93f0b --description "Changes a default behavior"
# gh label create dx              --repo "$REPO" --color 0e8a16 --description "Developer experience"
# gh label create design          --repo "$REPO" --color 5319e7 --description "Design discussion"

# 1. File all four (placeholders still in the bodies). Capture the numbers.
num() { grep -oE '[0-9]+$'; }
N1=$(gh issue create --repo "$REPO" --label enhancement --body-file "$OUT/issue-1.md" \
  --title 'Relative TWINING_PROJECT resolves against cwd, not the declaring repo — silently wrong in subdirs and worktrees' | num)
N2=$(gh issue create --repo "$REPO" --label enhancement --body-file "$OUT/issue-2.md" \
  --title 'Store resolution crosses repo boundaries silently — warn when an undeclared ancestor store binds' | num)
N3=$(gh issue create --repo "$REPO" --label enhancement --body-file "$OUT/issue-3.md" \
  --title 'Add expect_project to twining_assemble, and a resolution trace to twining_status' | num)
N4=$(gh issue create --repo "$REPO" --label enhancement --body-file "$OUT/issue-4.md" \
  --title 'Store-side write policy — let a store declare who may write to it (and why per-call store targeting is the wrong fix)' | num)
echo "F1=#$N1 F2=#$N2 F3=#$N3 F4=#$N4"

# 2. Substitute the placeholders in every body and comment, re-apply bodies.
for f in "$OUT"/issue-*.md "$OUT"/comment-*.md; do
  sed -i '' -e "s/#(F1)/#$N1/g" -e "s/#(F2)/#$N2/g" -e "s/#(F3)/#$N3/g" -e "s/#(F4)/#$N4/g" "$f"
done
gh issue edit "$N1" --repo "$REPO" --body-file "$OUT/issue-1.md"
gh issue edit "$N2" --repo "$REPO" --body-file "$OUT/issue-2.md"
gh issue edit "$N3" --repo "$REPO" --body-file "$OUT/issue-3.md"
gh issue edit "$N4" --repo "$REPO" --body-file "$OUT/issue-4.md"

# 3. The #46 correction first (comment-1 points at it; #(F1) is already $N1
#    after step 2), then the four maintainer comments.
gh issue comment 46    --repo "$REPO" --body-file "$OUT/comment-46.md"
gh issue comment "$N1" --repo "$REPO" --body-file "$OUT/comment-1.md"
gh issue comment "$N2" --repo "$REPO" --body-file "$OUT/comment-2.md"
gh issue comment "$N3" --repo "$REPO" --body-file "$OUT/comment-3.md"
gh issue comment "$N4" --repo "$REPO" --body-file "$OUT/comment-4.md"

# 4. The number map to append to the end of Doc 3 (then commit Doc 3 + this
#    file's status line, and record with twining_record before committing).
printf '\n---\n\n*Filed %s: #(F1) = #%s, #(F2) = #%s, #(F3) = #%s, #(F4) = #%s; the #46 correction comment is posted.*\n' \
  "$(date +%F)" "$N1" "$N2" "$N3" "$N4"
```

After running: change this file's STATUS line to FILED with the number map,
append the printed line to Doc 3, and commit both.
