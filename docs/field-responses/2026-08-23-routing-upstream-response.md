# Response: TWINING-ROUTING-UPSTREAM.md — four routing proposals, verdicts and vehicles

**STATUS: LIVE — dispositions final; code unshipped (W3 / W5); GitHub filing PREPARED, gated on the project owner's go.**
Authored 2026-08-25 by the Twining project in response to `TWINING-ROUTING-UPSTREAM.md`
(your "verified against plugin 1.33.0" revision). This answers the internal cover note (the `bcs/wfos-chassis#58` claim, the
1.33.0 delta table, the recommended order, the honest caveat) AND the four issues — the
cover note carries facts the issues do not. Verdicts are against HEAD `0f65ef0` =
2.16.0 / plugin 1.34.0. Nothing in 2.16.0 touched routing: `src/utils/project-root.ts`
still has exactly the two commits you found (`17dc716`, `8cc23e8`), and all five hook
copies still carry the cwd-relative line. Your 1.33.0 delta table is correct as written.

**How to read this:** §0 is where the four issues stand on GitHub and why that is not the
disposition of record. §1–§4 are one section per proposal: verdict, what we verified,
what we correct, what ships in which wave. §5 is what we need from you. Wave names:
W3 = 2.18.0, W4 = 2.19.0, W5 = 2.20.0 (new, created for the P1 flip); a 2.18.1 point
release is pre-agreed as W3's relief valve. Dates are absent for anything unshipped:
a stated date that slips is the stale literal your own standard names.

| Proposal | Verdict | Vehicle |
|---|---|---|
| P1 relative `TWINING_PROJECT` vs cwd | Diagnosis accepted in full; your composition corrected on two technical points; your migration design adopted as the shape | W3 warn phase (dual-base notice, TS + all five hooks) → W5 default flip |
| P2 silent cross-repo bind | Accepted, reworded to the real server-side rule: creation at cwd, not an ancestor walk | W3 |
| P3 `expect_project` + trace + store identity | Accepted, merged with our read-audit S1-F into one bundle | W3 bundle; 2.18.1 valve for warning / `expect_project` / P1-warn; `store_id` + echo never split |
| P4 store-side write policy | Accepted as a design question, not patched — named decision DD-11; per-call `project` declined on your grounds | DD-11 design doc; `TWINING_ROLE` echo in W3; enforcement no earlier than W5 |
| GitHub filing ask | Four issues prepared essentially verbatim; filing gated on the owner's go | §0 |

On your order: Issues 1 (warn phase), 2 and 3 ship together in W3 — they share the resolver
trace, so splitting them buys nothing; Issue 1's default flip is deliberately last among the
routing items (W5), because it is the only semantics change; Issue 4 is last or later, as
you ranked it.

---

## 0. Filing status, and what the issues are for

The four issues are PREPARED — `docs/field-responses/2026-08-23-routing-issues-prepared.md`
carries your text essentially verbatim plus a maintainer comment per issue slotting it by
wave name — and filing is gated on the project owner's go, the same gate as this send. Once
filed, a line appended to the end of this doc maps your `#(F1)`–`#(F4)` placeholders to
issue numbers; nothing else in this doc changes.

Be clear about what filing means here. GitHub is not this project's tracking surface: the
tracker has had no activity since #46 closed (2026-07-21), and everything since 2.7.0 —
the whole 2.8.0–2.16.0 train, both field memos, the read-audit response — landed as
direct commits to `main` (zero merge commits since `v2.7.0`) with `docs/field-responses/`
as the artifact. Filing is therefore a deliberate choice — you asked for a public
cross-reference an EMU account cannot create — not the default. The numbered issues carry
the proposal text and a wave-name slot for anyone arriving from outside; this doc is the
disposition of record; the per-wave breakdown docs specify the code. One #46 correction
rides along (§1.4).

---

## 1. P1 — relative `TWINING_PROJECT` resolves against cwd

### 1.1 Your diagnosis: accepted in full

- Server: `src/utils/project-root.ts:81-84` — `path.resolve(cwd, fromEnv)`, the line you
  quoted. Its comment (`:78-80`) says "relative values resolve against cwd (the repo root
  when Claude Code spawns the server) — absolute paths recommended for multi-machine
  setups"; that premise is what you are attacking, and it is wrong for the reason you gave.
- Hooks: the cwd-relative line is in all five copies. Your "line 71" is correct for
  `activity-marker-hook.sh` (still `:71` at plugin 1.34.0); the other four sit at
  different lines because the preambles differ — `session-start-context.sh:34`,
  `stop-hook.sh:54`, `pre-commit-hook.sh:73`, `subagent-stop-hook.sh:41`. Mirrored in
  content, not position — worth knowing when you diff.
- Your three-row measurement (root correct; subdir → nonexistent; linked worktree →
  nonexistent) is what the code does. The two commits do not compose: the env branch
  returns before the worktree branch (`:86-91`) is reached, so a fleet using a shared store
  AND `cmux --worktree` teammates gets neither. `test/project-root.test.ts:32` pins cwd
  semantics and `:114` covers only the absolute-path/worktree intersection. Both confirmed.
  Your caveat — semantics change, not bug fix — is right, and we are changing it (§1.4).

**Worse than you said, on the server side — and different in kind.** The hooks fail closed
(bind only if `$PROJECT_ROOT/.twining` exists), but only until the server has spawned. The
server does not fail closed: `ensureInitialized` (`src/storage/init.ts:135-138`) calls
`initTwiningDir`, which returns early only if `.twining` already exists (`:69-72`) and
otherwise creates it unconditionally — seven recursive `mkdir`s (`:75-81`) plus config, an
empty `blackboard.jsonl`, decisions index, graph, registry, gitignore and gitattributes
files (`:97-129`) — at whatever path resolved, with zero validation of the parent. That runs
inside `createServer` at process spawn (`src/index.ts:52`, before `server.connect` at
`:54`), so a misresolved relative value fabricates a complete, healthy-looking, empty store
at `<subdir>/wfos-chassis/.twining` before any hook has fired. Every hook fired after that
re-resolves from the same cwd, finds its `-d "$PROJECT_ROOT/.twining"` check TRUE for the
spurious path (`activity-marker-hook.sh:72`, `stop-hook.sh:55`), and binds it too. So the
observable is not Gate-2 loss but a coherent misroute: server and hooks agree on the wrong
store, every tool call in the session reports a confident zero, and coherence is exactly
why nothing ever fired. The hook-side silence you describe survives only for a hook that
runs before the server spawns (SessionStart, ordering-dependent) or in a session whose
server never started. One session measures it: start Claude Code in a subdirectory with a
relative `TWINING_PROJECT`, edit a file, call `twining_record`, and look inside the spurious
store — `.sessions/<session-id>` is the hook (`activity-marker-hook.sh:172`), `.last-record`
is the server, both on the same wrong path. Same shape as the read-audit's S0 amnesia, one
layer up.

### 1.2 Two technical corrections to your proposal

**(1) `gitRootOf` does not exist.** Your cover note says Issue 1 "reuses an
already-exported function"; `resolveWorktreeMain` is exported (`project-root.ts:31`), but
`gitRootOf` appears nowhere in `src/`, `plugin/`, or `test/` — the only occurrences in the
repo are our own plan quoting your sketch. It must be written: a pure-fs walk-up that
stops at the first ancestor whose `.git` is a directory OR a file (a linked worktree's
`.git` is a file; a walk that accepts only directories sails through a worktree root),
never throws, returns null at `/`. On the hook side the walk already exists once —
`activity-marker-hook.sh:79-93` ascends from cwd and stops at a `.git` file or directory
(`:91`), in that one hook's `TWINING_PROJECT` branch only — and the mirror is that loop
promoted into all five copies, not new logic.

**(2) Your composition mis-handles a subdirectory of a linked worktree.**
`resolveWorktreeMain(cwd) ?? gitRootOf(cwd) ?? cwd` asks `resolveWorktreeMain` first, but
it does not walk up: it stats exactly `path.join(dir, ".git")` and returns null unless that
is a file (`project-root.ts:33-34`). From `/tmp/wt/wfos-registry/src/lib` it returns null;
`gitRootOf` then finds `/tmp/wt/wfos-registry`; the relative value resolves against the
WORKTREE root — the `/tmp/wt/wfos-chassis` row of your own table, still wrong. Walk first,
then redirect:

```ts
const root = gitRootOf(cwd) ?? cwd;              // declaring repo (or worktree) root
const base = resolveWorktreeMain(root) ?? root;  // prefer the main checkout
return path.resolve(base, fromEnv);
```

Two edges the sketch leaves unstated, pinned here so the W5 breakdown does not invent
them: `TWINING_WORKTREE_LOCAL=true` is honoured in this branch exactly as in the
cwd-default branch (`project-root.ts:88-90`; the hooks' walk honours it at
`activity-marker-hook.sh:106`) — `base` stays the worktree root, because a worktree-local
sibling is what the opt-out asks for. And when the main checkout directory no longer
exists, `resolveWorktreeMain` returns null (`:58`) and the worktree root is the base —
today's failure mode, reachable only in that edge; a declared root is exempt from the P2
warning (§2), so what catches it is the P3 trace's `created: true` and the `expect_project`
refusal on it (§3).

Your four tests are adopted verbatim (subdir → the repo's sibling, not the subdir's;
linked worktree → the MAIN checkout; absolute unchanged; `--project` still wins). We add a
fifth, the case the corrected composition exists for: a relative `TWINING_PROJECT` from a
SUBDIRECTORY of a linked worktree resolves against the main checkout; and a sixth, the
opt-out: the same with `TWINING_WORKTREE_LOCAL=true` resolves against the worktree root.
The hook mirror gets the same six in its own harness. `test/project-root.test.ts:32` flips
to the new spec in W5, not before.

### 1.3 Your migration design: adopted as the shape

Warn first, flip later, as you proposed. W3 ships the warn phase with an identical
candidate policy in TS and all five hooks (a hook and the server disagreeing about which
store binds is the split-brain class #46 was opened for). The policy:

| cwd-relative base vs repo-relative base | Action |
|---|---|
| Equal (cwd is the repo root — today's common case) | No-op, no notice |
| Exactly one has a `.twining` | Bind it; notice naming both candidates and which bound |
| Both have a `.twining` | Bind cwd (today's semantics); loud ambiguity warning naming both |
| Neither | Owner ruling pending. Our recommendation: bind the repo-root candidate, because cwd-side creation is the known spurious mode (§1.1) and repo-root is what the declaration meant. If unruled at implementation time, the conservative default preserves cwd semantics until the general flip, recorded as such |

W5 flips the default to the corrected composition, gated on the W3 notices being quiet on
your fleet (§5). If W3's pre-tag review load demands it, the warn phase moves to 2.18.1.

### 1.4 On "prior art" — what the record actually says

Two places said cwd-relative was deliberate: our header comment (`project-root.ts:15-17`,
"explicit --project and TWINING_PROJECT are deliberate user targeting and are never
redirected") and #46's maintainer note in the issue body ("relative TWINING_PROJECT values
resolve against the server's cwd … absolute paths recommended for multi-machine setups"),
repeated by its closing runbook comment ("relative resolves against the repo root and
works, but absolute survives odd cwd cases"). On
re-examination, the decision record behind the comment (`01KY68QN70W0RRWCNMWH57WNEW`,
2026-07-23) *narrates* never-redirect in its context field as implemented behavior, but
what it *decides* — its summary is "document TWINING_PROJECT placement as terminal/session
env only", its rationale that `.claude/settings.json` env was not delivered to plugin MCP
servers and shell-profile exports activate gates machine-wide — is document placement. No
recorded decision reasons about resolution semantics. So P1 is an open design question we
are deciding in your favor, not a reversal of a decision made on evidence. The new record
will say exactly that; it does not supersede `01KY68QN70W0RRWCNMWH57WNEW`, which stands for
what it actually decided, and it does supersede the header comment and #46's premises.

#46's runbook advice — commit absolute `TWINING_PROJECT` paths for a multi-machine fleet —
is wrong for exactly your reason (a second operator's checkout lives elsewhere); and the
same comment's step 2 states that relative values "resolve against the repo root and work"
— wrong as a general statement at every version since 2.2.0: they resolve against cwd
(`project-root.ts:83`) and coincide with the repo root only when the session starts there
— and that sentence is the runbook's reassurance that a relative `../wfos-chassis` is
safe. #46's own body had flagged the relative-path fragility before the note recommended
absolute paths anyway. The #46 correction comment, cross-linking your Issue 1, retracts
both sentences explicitly.

**Your `bcs/wfos-chassis#58` claim** — landing P1 makes the worktree-placement ruling
unnecessary — is consistent with the corrected composition (main-checkout base, any depth,
any worktree location). We cannot see #58. Please confirm after reading §1.2 that the
ruling has no residual content the corrected composition does not cover.

---

## 2. P2 — undeclared cross-repo binds are silent

**Accepted, with the rule reworded to what the server actually does.** Your walk excerpt is
the HOOKS' walk (`activity-marker-hook.sh:95-124` and the four mirrors), and your reading
is right: `.git` as a directory is never inspected, only `.git` as a file, so the hooks
exit a repository without noticing and a `~/.twining` guarantees termination in a bind. But
the SERVER never ancestor-walks. Its cwd-default branch is `resolveWorktreeMain(cwd) ??
cwd` (`project-root.ts:86-91`) — one worktree check at exactly cwd, then cwd itself. No
walk exists anywhere in `src/`. The hook comment you quoted ("matches
`src/utils/project-root.ts`") is true of the env and worktree branches, not of the walk.

So the server-side equivalent of your silent failure is not inheritance of an ancestor
store; it is spurious CREATION at cwd (§1.1). A session launched in
`/Users/…/code/workspace/repo-a` with no declaration does not inherit `workspace/.twining`
on the server side — it creates `repo-a/.twining`. The hooks, which walk from cwd and check
`$DIR/.twining` at cwd before ascending (`activity-marker-hook.sh:118`), then find that
fabricated store first and bind it too, so hooks and server agree — on the spurious store.
Only a hook that runs before the server has spawned can still bind `workspace/.twining`.
Your observed ancestor inheritance is therefore the hooks' behaviour pre-spawn, and the
server's behaviour only when the session's cwd IS the ancestor directory (a session started
in `workspace` itself). The failure is a coherent, silent misroute, not a split — and
coherence is what made it invisible.

The warning ships in W3, fired when `rule = cwd-default` and the resolved root is outside
(or has no) git repository as seen from cwd, with a created-store addendum when
`created: true`. Declared roots (`argv`, `env`) and worktree redirects are exempt, as you
asked. It appears on `twining_status` and `twining_assemble` in the shape you sketched
(store, rule, why, the one-line fix). Your warn-not-refuse reasoning is adopted in full;
`TWINING_STRICT_REPO_BOUNDARY=true` is the W5-or-later second step, calibrated by how
often the W3 trace shows the warning firing (§5). We are not confusing this with
read-audit S1-E (scope-string prefix matching INSIDE a bound store — W3's own
default-behavior change); P2 is about which store binds.

---

## 3. P3 — `expect_project`, resolution trace, store self-identity

**Accepted as one merged design with our read-audit S1-F** (its row in
`2026-08-18-read-audit-response.md` §3 already committed to echoing store identity in every
response through the single result seam; your Issue 3 supplies the identity that echo
needs). The W3 bundle:

1. **Resolution trace** on `twining_status` (and `twining_assemble`):
   `resolution: { rule, candidate, resolved, inside_repo, created }`, `rule ∈ argv | env |
   worktree-redirect | cwd-default` — your five fields, your names. `created` is threaded
   from `ensureInitialized`, which today returns only the path (`init.ts:135-138`).
2. **Stable `store_id`** — a ULID stamped into `config.yml` at creation; existing stores get
   an append-only migration line on next boot, fail-open (a store that cannot be written
   keeps working un-stamped and the trace says so). This is LOGICAL-store identity:
   committed, shared by every clone on every machine, deliberately — two checkouts of the
   chassis store must compare equal and a spurious `<subdir>/wfos-chassis/.twining` must
   not.
3. **Your basename-collision point is proven by our own store.** Status derives `project`
   as `path.basename(path.dirname(twiningDir))` (`src/tools/lifecycle-tools.ts:51-53`) and
   creation stamps `project_name: path.basename(projectRoot)` (`init.ts:94`). This repo's
   `.twining/config.yml:2` literally reads `project_name: .` — stamped at creation
   (2026-02-18, `5cb0049`) from a project root of `.` passed through verbatim. The
   dashboard already carries the fixed derivation `path.basename(path.resolve(projectRoot))`
   (`src/dashboard/api-routes.ts:364`, again `:445`); the tool side never got it.
   Name-based identity was never trustworthy here.
4. **Store echo** `<basename>#<id6>` appended by BOTH `toolResult` (`src/utils/errors.ts:7-11`)
   and `toolError` (`:14-23`) — today neither carries any store identity, and an error path
   that omits it is exactly where a misroute would hide. Byte cost pinned by test; reset in
   `closeDb`.
5. **`expect_project` on `twining_assemble`**: passes on `store_id` match or
   `basename(path.resolve(root))` match; refuses `STORE_MISMATCH` naming both sides, the
   rule that bound, and the fix; ALSO refuses on `created: true` regardless of name match —
   the spurious store carrying the expected name is the case that motivated you, and only
   `created` catches it. The check runs BEFORE `assembleWithStatus`
   (`src/tools/context-tools.ts:38`), because that call records the assembly that
   `hasRecentAssembly` later reports to the decide and verify checkers
   (`src/server.ts:175-177`, `:197-199`); a refusal that ran after it would leave the
   session looking assembled. A refused `expect_project` has zero side effects on that state.

Two constraints, stated so you do not over-read the guarantee:

- **`expect_project` cannot PREVENT creation.** `ensureInitialized` runs inside
  `createServer` (`src/server.ts:67-69`) at process spawn, before any tool call exists. By
  the time `twining_assemble` runs, the spurious store is already on disk. W3 gives you a
  refusal that names it (`created: true`) so the session stops before writing into it and
  the operator deletes an empty directory. The only true prevention is lazy store creation
  (first write creates; reads do not) — a W5 candidate, not a W3 commitment.
- **`TWINING_ROLE` ships in W3 as an observability echo only** (it appears in the trace;
  nothing enforces it). Enforcement is §4.

Vehicle: the W3 bundle. Pre-agreed relief valve: if W3's release review cannot digest the
bundle beside the scope-matcher change, the out-of-repo warning, `expect_project`, and the
P1 warn phase move to 2.18.1; `store_id` and the echo ship together in W3 in every scenario,
because echoing a bare basename would re-open the ambiguity just conceded. Never the
reverse order. (Your `twining_resolve` name-collision note: the trace is a field on
existing tools, not a new tool, so nothing needs renaming.)

---

## 4. P4 — store-side write policy

**Accepted as a design question and deliberately not patched.** It becomes named design
decision DD-11, decided jointly with DD-6 (full read-only server mode — the degenerate
policy `accepts: []`) and DD-4 (agent identity — a role is an identity claim and must not
collide with `AgentRecord.role` or `agent_id`). The facts the design has to sit on, which
your issue could not have had:

- **21 of 39 registered tools mutate**, not the three you named. The 39 are the
  `registerTool` sites in `src/tools/` at HEAD (39 at 2.15.0 too). We cannot reproduce
  your 33 from any surface this code registers — the default `tools.full_surface: false`
  exposes 15 (21 registrations gated in `src/tools/`, plus `verify`/`export`/`triage` at
  `src/server.ts:282-295`), `full_surface: true` exposes 39 — so tell us how you counted;
  the registry, not the visible surface, is what a policy classifies either way. The
  mutating set: `record`, `post`, `decide`, `amend`, `promote`,
  `override`, `reconsider`, `resolve`, `acknowledge`, `dismiss`, `archive`, `unarchive`,
  `archive_stale`, `add_entity`, `add_relation`, `link_commit`, `register`, `handoff`,
  `delegate`, and — argument-gated on `execute: true` — `housekeeping` and `prune_graph`.
  A policy refusing only `record`/`post`/`decide` leaves eighteen doors open.
- **No MCP `readOnlyHint` annotations exist today** — none of the 39 registrations declares
  one. The classification above lives only in this doc; DD-11 must put it on the
  registrations.
- **The right seam is an unconditional pre-handler wrapper.** The only existing wrapper,
  `createInstrumentedServer` (`src/analytics/instrumented-server.ts:12-19`, patches
  `registerTool` to wrap every callback), is installed only when
  `config.analytics.metrics.enabled !== false` (`src/server.ts:255-257`). A policy layer
  cannot share a seam a config flag can remove.
- **The storage-level `assertWritable` is the wrong seam.** It exists
  (`src/storage/sqlite/sqlite-stores.ts:51-58`) but is identity-blind — it checks only the
  format-version read-only flag — gates internal maintenance writes policy must not block,
  and it fires per store write, not per tool call (19 call sites, each at the head of a
  write method): a policy check placed there refuses mid-operation on whichever store it
  reaches first, so the refusal would surface as a storage error from inside a tool rather
  than as a named `STORE_POLICY` refusal at the tool boundary.
- **Two things your sketch fixes early that DD-11 keeps open:** whether the policy lives in
  a separate `policy.json` or beside `store_id` in `config.yml` (one committed
  identity+policy surface, the question shared with the `store_id` migration in §3), and
  the trust model — a policy file in the tree is written by whoever can commit, which is
  the population it constrains.
- **The Gate-2 interaction is commit DENIAL, not deadlock.** The stop hook self-releases
  on `stop_hook_active` (`stop-hook.sh:31-33`); `TWINING_DISABLED=true` bypasses every hook
  (`session-start-context.sh:13`, `activity-marker-hook.sh:15`, `stop-hook.sh:26`,
  `pre-commit-hook.sh:13`, `subagent-stop-hook.sh:6`); the commit sentinel is advanced by
  any successful `record`/`post`/`decide` (`src/utils/record-sentinel.ts:4-10`, imported by
  exactly those three tool files). But a policy refusing all three pins the commit gate
  closed for the session — the hooks deny a commit the operator cannot unblock by
  recording. DD-11 must give the hooks a refusal protocol: the pre-commit hook has to be
  able to read "recording was refused by policy" as distinct from "recording was skipped".
- **Two write paths enter the stores beneath any tool wrapper.** The subagent-stop hook
  appends to `pending-posts.jsonl` (`subagent-stop-hook.sh:80-85`), drained by
  `PendingProcessor` (`src/engine/pending-processor.ts:66-67`); and record-sync ingest
  (`src/storage/sync/record-ingest.ts:1-12`, file wins) writes rows the session never
  authored. DD-11 must state whether each is governed. Ingest is exempt by DD-8 — it copies
  committed truth, and a policy that could refuse it would make a clone diverge from its
  own tree.

**Your per-call `project` argument: adopted as the primary ground.** We had already
declined a per-call project parameter (read-audit response §3, S1-F row) on store
lifecycle and locking cost. We are re-recording that decline with YOUR grounds as primary —
the caller must not be the authority on what it may write to; a per-call target converts a
structural boundary into a convention — and lifecycle/locking cost as secondary. Cost
arguments erode when the cost drops; the architectural one is durable, so it is the one
that goes on record.

**Your open question (free-form vs fixed roles):** our lean is free-form with normalization
(trim, case-fold); an unmatched role — a policy naming a role no session presents, or a
session presenting a role no policy names — surfaced through the P3 trace rather than
silently; fail-closed on a malformed `policy.json` with a named repair (a malformed policy
that fails open is the silent-wrong-answer class this whole set is about). Roles are a
namespace disjoint from `agent_id`.

Enforcement no earlier than W5; DD-11's design session follows W4. Your ordering
("implemented last or never") matches ours; your reason to file early — pre-empting the
per-call `project` proposal — is now served by this doc as well as by the issue.

---

## 5. What we need from you

1. **Confirm the #58 retirement claim** after reading §1.2 — does the corrected composition
   (walk to the declaring root, then prefer the main checkout, from any depth) leave any
   residual content in the worktree-placement ruling?
2. **Once W3's trace ships: how often `rule = cwd-default` with `inside_repo: false` fires
   on your fleet.** That number gates the P1 default flip in W5 and decides whether
   `TWINING_STRICT_REPO_BOUNDARY` is worth building.
3. **Whether the P1 warn-phase notices ever fire on your fleet.** Silent across your eleven
   repos for a release → the flip is safe for you; firing → the payload names which
   candidate-policy row you hit.

Reading order for this batch is in the send wrapper
(`docs/field-responses/2026-08-23-response-send.md`): the read-audit response first, the
wave-2 verification response second, this doc third — and this doc is the one to forward to
the wfos lane, with the issue links once the filing line is appended below.

---

*Version anchors for stale-literal checking: every `file:line` above is HEAD `0f65ef0`
(2.16.0 / plugin 1.34.0). Hook line numbers are plugin 1.34.0; the
`activity-marker-hook.sh:71` cite is unchanged from the 1.33.0 you measured. Routing code
is identical from 2.2.0 to 2.16.0 apart from the worktree commit `8cc23e8`.*
