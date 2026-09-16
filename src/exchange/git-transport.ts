/**
 * The Git carrier (ADR §8.2, DP11) — the default transport.
 *
 * Events, conflicts and consumer cursors live on a DEDICATED exchange ref
 * (`refs/heads/twining/exchange`, orphan history) checked out in a dedicated
 * worktree at `<store>/exchange/`. Publishing stages only paths under that
 * worktree, commits with a machine message, fetches, merges and pushes. The
 * user's source checkout is never reset, stashed, switched, rebased or
 * auto-committed (R09 non-interference) — the only structural guarantee that
 * makes that true is that every git invocation here names the EXCHANGE
 * worktree as its cwd and runs with a sanitized environment (see git.ts).
 *
 * Two properties this carrier is built around:
 *
 *  1. **Union by construction.** A file is written exactly once and never
 *     rewritten: an event's path is keyed by its id, and the same id arriving
 *     with different bytes goes to `conflicts/<id>.<digest12>.json` instead of
 *     overwriting the incumbent. So `git merge` can only ever add files, and
 *     the merge is verified against that claim (`assertUnion`) rather than
 *     trusted — a merge that rewrote or dropped a blob raises
 *     `UnionViolationError` instead of silently becoming the authority, which
 *     is the exact failure mode ADR §9.1's steelman identified.
 *
 *  2. **A rewind changes the RECEIVED set, not the ADMITTED set.** `poll` is
 *     the only thing that reads history, and when its cursor is no longer
 *     reachable from the carrier head (reset, force-push, rebase, branch
 *     deletion) it reports a gap and rescans instead of concluding that the
 *     missing events were deleted. The journal keeps what it admitted; the
 *     store reports `checkout_behind_journal` (C14).
 *
 * Carrier identity is the COMMIT SHA per event digest. A rewrite or a layout
 * change necessarily produces a different commit, so the same event acquires a
 * second representation and the first is marked unreachable — one event id,
 * many representations (C14 A-EV4/A-EV7).
 */
import fs from "node:fs";
import path from "node:path";

import { computeEventDigest, eventEnvelopeSchema, type EventEnvelope } from "../contracts/index.js";
import type { CarrierGap, Cursor, MalformedArtifact, PublishReceipt, Transport, TransportHealth } from "../contracts/store-api.js";
import type { TransportFaults } from "./fs-transport.js";
import { LostReceiptError } from "./fs-transport.js";
import {
  commitPaths,
  createOrphanBranch,
  git,
  gitTry,
  isAncestor,
  isGitRepo,
  revListRange,
  revParse,
  showBlob,
  treeEntries,
  type TreeEntry,
} from "./git.js";

export const EXCHANGE_BRANCH = "twining/exchange";
export const EXCHANGE_REF = `refs/heads/${EXCHANGE_BRANCH}`;

/** A merge that did not preserve every blob on both sides. Never swallowed. */
export class UnionViolationError extends Error {
  constructor(
    readonly kind: "rewritten" | "dropped" | "merge_conflict",
    readonly paths: string[],
    detail?: string,
  ) {
    super(`git exchange union violated (${kind}): ${paths.slice(0, 5).join(", ")}${detail ? ` — ${detail}` : ""}`);
    this.name = "UnionViolationError";
  }
}

/** An artifact the carrier held but could not decode — surfaced, never swallowed (C17). */
// Moved into the contract at draft.3 (src/contracts/store-api.ts) so a status
// reader can type the carrier's self-report without importing this module.
export type { MalformedArtifact };

/**
 * Strip userinfo from a remote before it becomes an identity.
 *
 * The transport id is written into cursor FILES that are committed to the
 * exchange ref and pushed to every replica, so a remote configured as
 * `https://x-access-token:<token>@host/org/repo.git` would publish the token to
 * everyone who can read the branch. Redaction happens once, at construction, so
 * the id stays stable for the cursors that already reference it.
 */
export function redactRemote(remote: string): string {
  try {
    const u = new URL(remote);
    if (u.username === "" && u.password === "") return remote;
    u.username = "";
    u.password = "";
    return `${u.protocol}//***@${u.host}${u.pathname}${u.search}`;
  } catch {
    // Not a URL (a remote NAME, or scp-style user@host:path). The scp form can
    // carry a user but never a password, and a bare name carries nothing.
    return remote.replace(/^[^@/\s]*:[^@/\s]*@/, "***@");
  }
}

/** Remove any credential-bearing URL from text that will be shown or stored. */
export function redactText(text: string, ...remotes: Array<string | undefined>): string {
  let out = text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*:[^@/\s]*@/gi, "$1***@");
  for (const r of remotes) {
    if (r === undefined || r === "") continue;
    const red = redactRemote(r);
    if (red !== r) out = out.split(r).join(red);
  }
  return out;
}

export type GitExchangeMode = "exchange_ref" | "source_branch";

export interface GitTransportOptions {
  /** The store directory (`.twining/`). The exchange worktree lives at `<twiningDir>/exchange/`. */
  twiningDir: string;
  /** The git repository that hosts the exchange worktree — the user's source checkout. */
  repoDir: string;
  /** Remote name or URL to fetch/push against. Omit for a purely local carrier. */
  remote?: string;
  /** Exchange branch. Default `twining/exchange`. */
  branch?: string;
  /**
   * `exchange_ref` (default, ADR §8.2) or `source_branch` — the migration-window
   * option in which events ride the working branch as `.twining/records/` does
   * today. `source_branch` FORFEITS non-interference and says so: it commits on
   * the branch the user is working on.
   */
  mode?: GitExchangeMode;
  /** Directory (relative to repoDir) holding events in `source_branch` mode. */
  sourcePath?: string;
  /** Injected clock for commit messages only — never an ordering input. */
  now?: () => string;
}

/**
 * Which carried paths are candidate EVENT artifacts.
 *
 * Deliberately not `events/**` only: C14 T4 is a LAYOUT CHANGE — the same bytes
 * arriving under `v2/events/` or under a cherry-pick's own prefix. Keying the
 * scan on the layout would make a relayout look like a deletion plus a new
 * event, which is the identity failure the case is written against. Cursors are
 * the one excluded subtree: they are consumer state, not events.
 */
/**
 * A principal rendered as exactly one filesystem-safe path segment.
 *
 * Injective: percent-encoding is reversible and encodes `/`, `.` and `:`, so
 * two distinct principals can never collide on one cursor file — the property
 * ADR §5's single-writer cursors depend on.
 */
export function cursorFileName(principal: string): string {
  return encodeURIComponent(principal).replace(/\*/g, "%2A");
}

function isCarriedArtifact(rel: string): boolean {
  return rel.endsWith(".json") && !rel.startsWith("cursors/");
}

type PollGap = CarrierGap;

export class GitTransport implements Transport {
  readonly faults: TransportFaults = {};
  /** digest → commit sha for the most recent poll (the carrier's identity). */
  readonly lastCarrierIds: Record<string, string> = {};
  /** Artifacts the last poll could not decode (C17): retained, never dropped. */
  lastMalformed: MalformedArtifact[] = [];
  /** Whether the last poll found its cursor unreachable (rewind / force-push). */
  lastGap: PollGap = { gap: false };
  /** Named crash points for the C18 fault suite; a hook may never return. */
  faultHook?: (step: string) => void;

  readonly repoDir: string;
  readonly branch: string;
  readonly mode: GitExchangeMode;
  private readonly remote?: string;
  /** The remote with any userinfo stripped — the only form that leaves this object. */
  private readonly remoteLabel?: string;
  private readonly worktreeDir: string;
  /** Where cursors live when the carrier has no worktree of its own. */
  private readonly cursorFallbackDir: string;
  private readonly now: () => string;
  private ensured = false;
  /**
   * Sticky: set when a union violation was detected. Once set, this carrier
   * refuses to push, because republishing a tree we know has lost a blob would
   * make the loss authoritative for every other replica.
   */
  private unionViolated: UnionViolationError | null = null;

  constructor(opts: GitTransportOptions) {
    this.repoDir = opts.repoDir;
    this.branch = opts.branch ?? EXCHANGE_BRANCH;
    this.mode = opts.mode ?? "exchange_ref";
    if (opts.remote !== undefined) {
      this.remote = opts.remote;
      this.remoteLabel = redactRemote(opts.remote);
    }
    this.worktreeDir =
      this.mode === "exchange_ref"
        ? path.join(opts.twiningDir, "exchange")
        : path.join(opts.repoDir, opts.sourcePath ?? "twining-exchange");
    this.cursorFallbackDir = path.join(opts.twiningDir, "exchange-cursors");
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  id(): string {
    return `git:${this.remoteLabel ?? this.repoDir}/${this.branch}`;
  }

  /** Whether this carrier has refused to push because it detected a loss. */
  get violation(): UnionViolationError | null {
    return this.unionViolated;
  }

  /**
   * Clear the sticky refusal after an operator has repaired the branch.
   * Deliberately explicit: nothing clears it automatically, because the whole
   * point is that a detected loss must not be able to leave this host.
   */
  clearViolation(): void {
    this.unionViolated = null;
  }

  /** Where the carrier's own checkout lives — the ONLY tree publish may touch. */
  get exchangeDir(): string {
    return this.worktreeDir;
  }

  setFaults(faults: TransportFaults): void {
    Object.assign(this.faults, faults);
  }

  // ------------------------------------------------------------------ setup

  /**
   * Create the exchange worktree if it is missing.
   *
   * The orphan branch is built with plumbing (empty tree → commit-tree →
   * update-ref) rather than `checkout --orphan` inside a freshly added
   * worktree, because the latter would first materialize the SOURCE tree into
   * the exchange directory — an unsolicited write into a path the user did not
   * ask for, and one that `git rm -rf .` would then have to undo.
   *
   * When the remote already carries the branch, the local branch is created
   * FROM it, so two replicas do not diverge into unrelated histories on the
   * first publish.
   */
  ensureWorktree(): void {
    if (this.ensured) return;
    if (!isGitRepo(this.repoDir)) throw new Error(`git exchange: ${this.repoDir} is not a git repository`);

    if (this.mode === "source_branch") {
      fs.mkdirSync(this.worktreeDir, { recursive: true });
      this.ensured = true;
      return;
    }

    const alreadyCheckedOut = fs.existsSync(path.join(this.worktreeDir, ".git"));
    if (!alreadyCheckedOut) {
      if (revParse(this.repoDir, `refs/heads/${this.branch}`) === null) {
        const fromRemote = this.remote ? this.fetchBranch() : null;
        if (fromRemote) git(this.repoDir, ["update-ref", `refs/heads/${this.branch}`, fromRemote]);
        else createOrphanBranch(this.repoDir, this.branch, "twining exchange: genesis");
      }
      fs.mkdirSync(path.dirname(this.worktreeDir), { recursive: true });
      this.ensureIgnored();
      // Remove only OUR OWN stale administrative record. A bare
      // `git worktree prune` prunes EVERY linked worktree whose directory is
      // momentarily absent — an unmounted volume, a directory being moved, a
      // sibling agent lane — and leaves those as dead husks. The blast radius
      // in a repo full of `.claude/worktrees/` lanes is not hypothetical.
      gitTry(this.repoDir, ["worktree", "remove", "--force", this.worktreeDir]);
      git(this.repoDir, ["worktree", "add", this.worktreeDir, this.branch]);
    }
    this.ensured = true;
    // A half-written publish must not poison the next one: anything uncommitted
    // in the EXCHANGE worktree is residue by definition, because every carried
    // file is written and committed in the same call.
    this.cleanResidue();
  }


  /**
   * Discard uncommitted state in the EXCHANGE worktree only.
   *
   * Scoped with an explicit cwd and `-- .`, so it can touch nothing outside the
   * carrier's own checkout. This is not a working-tree reset of the user's
   * repository; the exchange worktree holds no human-authored state.
   */
  private cleanResidue(): void {
    if (this.mode !== "exchange_ref") return;
    gitTry(this.worktreeDir, ["reset", "--quiet", "--", "."]);
    gitTry(this.worktreeDir, ["checkout", "--", "."]);
    gitTry(this.worktreeDir, ["clean", "-qfd", "--", "."]);
  }

  /**
   * Make sure the exchange worktree is invisible to the user's `git status`.
   *
   * A project that TRACKS `.twining/` (this one does) would otherwise see the
   * carrier's linked worktree as an untracked embedded repository, and a
   * routine `git add -A` would sweep it into the source branch as a gitlink to
   * an orphan commit nothing can resolve. `.git/info/exclude` is local, is not
   * part of the working tree, and is not shared — so writing there changes
   * nothing the user would commit. The canonical fix is an `exchange/` entry in
   * the store's own .gitignore; this is the belt-and-braces that makes the
   * carrier safe on a store that predates it.
   */
  private ensureIgnored(): void {
    if (gitTry(this.repoDir, ["check-ignore", "-q", this.worktreeDir]).status === 0) return;
    const gitDir = gitTry(this.repoDir, ["rev-parse", "--git-common-dir"]).stdout.trim();
    if (gitDir === "") return;
    const abs = path.isAbsolute(gitDir) ? gitDir : path.join(this.repoDir, gitDir);
    const excludeFile = path.join(abs, "info", "exclude");
    const rel = path.relative(this.repoDir, this.worktreeDir).split(path.sep).join("/");
    if (rel.startsWith("..")) return; // outside the repo: nothing to ignore
    try {
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
      if (!current.split("\n").includes(`/${rel}`)) {
        fs.appendFileSync(excludeFile, `${current.endsWith("\n") || current === "" ? "" : "\n"}# twining exchange worktree (not part of the source tree)\n/${rel}\n`);
      }
    } catch {
      /* an unwritable .git is not a reason to refuse to exchange */
    }
  }

  /** Fetch the exchange branch into a remote-tracking ref; returns its sha. */
  private fetchBranch(): string | null {
    if (!this.remote) return null;
    const trackRef = `refs/remotes/twining-exchange/${this.branch}`;
    const dir = fs.existsSync(path.join(this.worktreeDir, ".git")) ? this.worktreeDir : this.repoDir;
    gitTry(dir, ["fetch", "--no-tags", this.remote, `+refs/heads/${this.branch}:${trackRef}`]);
    return revParse(dir, trackRef);
  }

  private get wt(): string {
    this.ensureWorktree();
    return this.worktreeDir;
  }

  private head(): string | null {
    return this.mode === "exchange_ref" ? revParse(this.wt, "HEAD") : revParse(this.repoDir, "HEAD");
  }

  // ---------------------------------------------------------------- publish

  /**
   * Idempotent by id + digest. A file is written once and never rewritten:
   * a conflicting digest under a known id is carried in `conflicts/` so the
   * consumer can refuse it for itself rather than never seeing it (R07).
   */
  async publish(events: EventEnvelope[]): Promise<PublishReceipt> {
    const wt = this.wt;
    const staged: string[] = [];
    const pathByDigest: Record<string, string> = {};

    for (const ev of events) {
      const rel = this.relPathFor(ev);
      const abs = path.join(wt, rel);
      const bytes = `${JSON.stringify(ev, null, 2)}\n`;
      pathByDigest[ev.digest] = rel;
      // Idempotence is decided against what is COMMITTED, never against what
      // happens to be sitting in the working tree. A crash between the write
      // and the commit used to leave the bytes on disk uncommitted; the retry
      // then saw the file, staged nothing, committed nothing, and returned no
      // carrier id — so the outbox read it as uncertain and retried into the
      // same short-circuit for ever. An uncommitted file is not carried.
      if (this.committedAt(rel)) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
      staged.push(rel);
    }

    this.faultHook?.("export_staged");

    const before = this.head();
    if (staged.length > 0) {
      if (this.mode === "exchange_ref") {
        git(wt, ["add", "--", ...staged]);
        this.assertOnlyStaged(wt, staged);
        git(wt, ["commit", "--no-verify", "-m", this.commitMessage(staged.length)]);
      } else {
        // source_branch mode shares the user's index, so `git add` would leave
        // the carrier's paths staged in it afterwards — a gratuitous mutation,
        // since a pathspec-limited commit takes working-tree contents without
        // the index. It still does NOT restore non-interference, which this
        // mode forfeits by definition (ADR §8.2): it commits on the user's
        // branch. It just does not also dirty their index.
        // `git add` is unavoidable — a pathspec commit cannot name an untracked
        // path — but the entries are removed again straight afterwards, so the
        // carrier leaves the user's index exactly as it found it.
        git(wt, ["add", "--", ...staged]);
        git(wt, ["commit", "--no-verify", "-m", this.commitMessage(staged.length), "--", ...staged]);
        gitTry(wt, ["reset", "--quiet", "HEAD", "--", ...staged]);
      }
      this.faultHook?.("committed");
      const after = this.head();
      if (before && after) this.assertUnion(wt, [before], after);
    }

    this.mergeRemote();
    this.pushBranch();
    this.faultHook?.("pushed");

    const carrier_ids: Record<string, string> = {};
    for (const [digest, rel] of Object.entries(pathByDigest)) {
      const sha = this.commitCarrying(rel);
      if (sha) carrier_ids[digest] = sha;
    }

    if (this.faults.dropNextPublishReceipt) {
      this.faults.dropNextPublishReceipt = false;
      throw new LostReceiptError(this.id());
    }
    return { transport: this.id(), carrier_ids };
  }

  /**
   * Where an event's bytes live on the carrier. An id already present with
   * different bytes is carried beside the incumbent, never over it.
   */
  private relPathFor(ev: EventEnvelope): string {
    const shard = ev.occurred_at.slice(0, 7);
    const primary = path.posix.join("events", shard, `${ev.id}.json`);
    // Same rule as publish(): only COMMITTED bytes own a path. An uncommitted
    // file left by a crashed publish must not divert a retry into conflicts/.
    const committed = this.committedBlob(primary);
    if (committed === null) return primary;
    const held = this.decode(committed, primary, "");
    if (held && held.digest === ev.digest) return primary;
    return path.posix.join("conflicts", `${ev.id}.${ev.digest.slice(7, 19)}.json`);
  }

  /** Is this path present in the exchange branch's committed tree? */
  private committedAt(rel: string): boolean {
    const head = this.head();
    if (!head) return false;
    return gitTry(this.worktreeDir, ["cat-file", "-e", `${head}:${rel}`]).status === 0;
  }

  /** The committed bytes at a path, or null when the carrier does not hold it. */
  private committedBlob(rel: string): string | null {
    const head = this.head();
    if (!head) return null;
    const r = gitTry(this.worktreeDir, ["show", `${head}:${rel}`]);
    return r.status === 0 ? r.stdout : null;
  }

  private commitMessage(n: number): string {
    return `twining exchange: ${n} event${n === 1 ? "" : "s"} (${this.now()})`;
  }

  /** The index must contain exactly what we staged — nothing from the source tree. */
  private assertOnlyStaged(wt: string, staged: string[]): void {
    const cached = gitTry(wt, ["diff", "--cached", "--name-only", "--relative", "-z"])
      .stdout.split("\0")
      .filter((p) => p !== "");
    const extra = cached.filter((p) => !staged.includes(p));
    if (extra.length > 0) throw new UnionViolationError("rewritten", extra, "unexpected paths staged in the exchange worktree");
  }

  /** Every (path, oid) present on any input side must be present afterwards. */
  private assertUnion(wt: string, sides: string[], merged: string): void {
    const entries = treeEntries(wt, merged);
    const after = new Map(entries.map((e: TreeEntry) => [e.path, e.oid]));
    // Where each blob ENDED UP, by content. The union is a statement about
    // bytes, not about paths: an add/add resolution relocates the losing side's
    // bytes into `conflicts/` on purpose, and that is retention, not loss. Any
    // other relocation — or a blob that is nowhere at all — is the violation.
    const relocated = new Map<string, string[]>();
    for (const e of entries) {
      const at = relocated.get(e.oid);
      if (at) at.push(e.path);
      else relocated.set(e.oid, [e.path]);
    }
    const dropped: string[] = [];
    const rewritten: string[] = [];
    for (const side of sides) {
      for (const e of treeEntries(wt, side)) {
        if (after.get(e.path) === e.oid) continue; // kept in place
        const elsewhere = (relocated.get(e.oid) ?? []).filter((p) => p.startsWith("conflicts/"));
        if (elsewhere.length > 0) continue; // retained under conflicts/, by design
        if (after.has(e.path)) rewritten.push(e.path);
        else dropped.push(e.path);
      }
    }
    if (rewritten.length > 0) throw new UnionViolationError("rewritten", rewritten);
    if (dropped.length > 0) throw new UnionViolationError("dropped", dropped);
  }

  /**
   * Fetch and merge the remote exchange branch. Because no file is ever
   * rewritten, this can only ever be an add/add union; a textual conflict means
   * the invariant broke and is raised rather than resolved.
   */
  private mergeRemote(): void {
    if (!this.remote || this.mode !== "exchange_ref") return;
    const wt = this.wt;
    const remoteHead = this.fetchBranch();
    if (!remoteHead) return;
    const localHead = this.head();
    if (!localHead) return;
    if (localHead === remoteHead || isAncestor(wt, remoteHead, localHead)) return;

    if (isAncestor(wt, localHead, remoteHead)) {
      git(wt, ["merge", "--ff-only", remoteHead]);
    } else {
      const r = gitTry(wt, ["merge", "--no-edit", "--allow-unrelated-histories", "-m", "twining exchange: union merge", remoteHead]);
      if (r.status !== 0) {
        // An add/add on the SAME event path with different bytes: two replicas
        // minted the same id offline. Resolvable without losing anything — keep
        // the incumbent at its path and carry BOTH sides under conflicts/, which
        // is exactly what the single-replica case already does. Aborting here
        // wedged the carrier permanently: mergeRemote runs from publish AND
        // poll, so the replica could neither send nor receive again.
        if (!this.resolveAddAdd(wt)) {
          const conflicted = gitTry(wt, ["diff", "--name-only", "--diff-filter=U", "-z"])
            .stdout.split("\0")
            .filter((p) => p !== "");
          gitTry(wt, ["merge", "--abort"]);
          this.unionViolated = new UnionViolationError("merge_conflict", conflicted, redactText(r.stderr.trim(), this.remote));
          throw this.unionViolated;
        }
      }
    }
    const merged = this.head();
    if (!merged) return;
    try {
      this.assertUnion(wt, [localHead, remoteHead], merged);
    } catch (err) {
      // A CLEAN merge that dropped or rewrote a blob is the case this check
      // exists for, and git has already committed it. Roll the exchange
      // worktree back to the pre-merge tip — the rollback `merge --abort` gives
      // the conflict path — and refuse to push until an operator repairs it.
      // Without the reset the violation never recurs (the next mergeRemote
      // sees remoteHead as an ancestor and returns early) and the next publish
      // pushes the loss upstream, where it becomes authoritative for everyone.
      gitTry(wt, ["reset", "--hard", localHead]);
      this.unionViolated = err instanceof UnionViolationError ? err : new UnionViolationError("dropped", [], String(err));
      throw this.unionViolated;
    }
  }

  /**
   * Resolve an add/add conflict on carried artifacts without losing bytes.
   *
   * Every conflicted path keeps OUR side at its own path and gains BOTH sides
   * under `conflicts/<id>.<digest12>.json`, so the union invariant holds by
   * construction and the consumer gets to refuse the rival copy for itself
   * (R07) rather than never seeing it. Returns false when a conflict is on a
   * path this rule does not own, in which case the caller aborts.
   */
  private resolveAddAdd(wt: string): boolean {
    const conflicted = gitTry(wt, ["diff", "--name-only", "--diff-filter=U", "-z"])
      .stdout.split("\0")
      .filter((p) => p !== "");
    if (conflicted.length === 0) return false;
    if (!conflicted.every((rel) => isCarriedArtifact(rel))) return false;

    for (const rel of conflicted) {
      const ours = gitTry(wt, ["show", `:2:${rel}`]).stdout;
      const theirs = gitTry(wt, ["show", `:3:${rel}`]).stdout;
      if (ours === "" && theirs === "") return false;
      const keep = ours !== "" ? ours : theirs;
      fs.writeFileSync(path.join(wt, rel), keep);
      git(wt, ["add", "--", rel]);
      for (const side of [ours, theirs]) {
        if (side === "" || side === keep) continue;
        const decoded = this.decode(side, rel, "");
        if (!decoded) continue;
        const crel = path.posix.join("conflicts", `${decoded.envelope.id}.${decoded.digest.slice(7, 19)}.json`);
        const cabs = path.join(wt, crel);
        if (fs.existsSync(cabs)) continue;
        fs.mkdirSync(path.dirname(cabs), { recursive: true });
        fs.writeFileSync(cabs, side);
        git(wt, ["add", "--", crel]);
      }
    }
    git(wt, ["commit", "--no-verify", "-m", "twining exchange: union merge (add/add resolved, both sides retained)"]);
    return true;
  }

  private pushBranch(): void {
    if (!this.remote) return;
    // A carrier that has SEEN a union violation must never publish again until
    // an operator repairs it: pushing a tree we know has lost a blob makes the
    // loss authoritative for every replica that fetches it.
    if (this.unionViolated) {
      throw new Error(`git exchange: refusing to push — a union violation was detected and not repaired (${this.unionViolated.message})`);
    }
    const dir = this.mode === "exchange_ref" ? this.wt : this.repoDir;
    const r = gitTry(dir, ["push", this.remote, `HEAD:refs/heads/${this.branch}`]);
    if (r.status !== 0) throw new Error(`git exchange: push failed — ${redactText(r.stderr.trim(), this.remote)}`);
  }

  /** The commit that last touched a carried path — the event's carrier id. */
  private commitCarrying(rel: string): string | null {
    const r = gitTry(this.wt, ["log", "-1", "--format=%H", "--", rel]);
    const sha = r.stdout.trim();
    return r.status === 0 && sha !== "" ? sha : null;
  }

  // ------------------------------------------------------------------- poll

  /**
   * Fetch, then hand back everything the carrier holds beyond the cursor.
   *
   * A cursor that is no longer reachable from the carrier head is a REWIND,
   * not a deletion: the carrier says so (`lastGap`) and rescans the whole tree,
   * so redelivery is idempotent at the store and nothing is concluded to be
   * gone. This is the single place where C14's "no silent revoke" is decided.
   */
  async poll(cursor: Cursor | null): Promise<{ events: EventEnvelope[]; cursor: Cursor }> {
    const wt = this.wt;
    this.lastMalformed = [];
    this.lastGap = { gap: false };

    const remoteHead = this.remote ? this.fetchBranch() : null;
    if (remoteHead && this.mode === "exchange_ref") this.mergeRemote();
    const head = this.head();
    if (!head) return { events: [], cursor: { transport: this.id(), position: "" } };

    const from = cursor?.position && cursor.position !== "" ? cursor.position : null;
    const reachable = from !== null && revParse(wt, from) !== null && isAncestor(wt, from, head);

    // A rewind is detected on BOTH sides, because they are different facts.
    //  - the LOCAL head no longer contains our cursor: this checkout was rewound;
    //  - the REMOTE head no longer contains it: upstream was force-pushed or
    //    reset under us. The second is invisible in the local head (a clone is
    //    itself a retained copy, which is the property that makes the rewind
    //    non-destructive) and would otherwise pass silently — the exact
    //    "no silent loss" reporting C14 requires.
    if (from !== null && !reachable) {
      this.lastGap = { gap: true, reason: "cursor unreachable from the local carrier head (rewind or force-push)", unreachable_from: from };
    } else if (from !== null && this.remote) {
      if (remoteHead === null) {
        this.lastGap = { gap: true, reason: "the exchange branch is absent on the remote (deleted); nothing is concluded to be revoked", unreachable_from: from };
      } else if (!isAncestor(wt, from, remoteHead)) {
        this.lastGap = {
          gap: true,
          reason: "the remote exchange ref no longer contains the position this consumer had reached (force-push or reset upstream)",
          unreachable_from: from,
        };
      }
    }

    let reads: Array<{ rel: string; sha: string }>;
    if (from !== null && !reachable) {
      reads = this.fullScan(head);
    } else if (from === null) {
      reads = this.fullScan(head);
    } else {
      reads = [];
      for (const sha of revListRange(wt, from, head)) {
        for (const rel of commitPaths(wt, sha)) {
          if (!isCarriedArtifact(rel)) continue;
          reads.push({ rel, sha });
        }
      }
    }

    let events: EventEnvelope[] = [];
    for (const { rel, sha } of reads) {
      const text = showBlob(wt, head, rel) ?? showBlob(wt, sha, rel);
      if (text === null) continue; // the path was removed by a later rewrite; the journal still holds it
      const parsed = this.decode(text, rel, sha);
      if (parsed === null) continue;
      this.lastCarrierIds[parsed.digest] = this.commitCarrying(rel) ?? sha;
      events.push(parsed.envelope);
    }

    if (this.faults.reorder) events = this.faults.reorder(events);
    if (this.faults.duplicateNext) {
      this.faults.duplicateNext = false;
      events = [...events, ...events];
    }
    return { events, cursor: { transport: this.id(), position: head } };
  }

  /** Every carried artifact at `head`, path-ordered — the rewind-safe read. */
  private fullScan(head: string): Array<{ rel: string; sha: string }> {
    return treeEntries(this.wt, head)
      .filter((e) => isCarriedArtifact(e.path))
      .sort((a, b) => (a.path < b.path ? -1 : 1))
      .map((e) => ({ rel: e.path, sha: head }));
  }

  /**
   * Decode one carried artifact. A truncated file, a merge-conflict block or
   * any other undecodable bytes are RETAINED and reported (`lastMalformed`) so
   * the store can quarantine them with a reason — a carrier that returns null
   * and moves on is the silent-loss shape C17 exists to catch.
   */
  private decode(text: string, rel: string, sha: string): { envelope: EventEnvelope; digest: string } | null {
    const markers = /^(<{7} |={7}$|>{7} )/m.test(text);
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      this.lastMalformed.push({
        carrier_id: sha,
        path: rel,
        bytes: text,
        observed_bytes: Buffer.byteLength(text, "utf8"),
        reason: markers ? "conflict_markers" : text.trimEnd().endsWith("}") ? "unparseable" : "truncated",
      });
      return null;
    }
    const parsed = eventEnvelopeSchema.safeParse(raw);
    if (!parsed.success) {
      this.lastMalformed.push({
        carrier_id: sha,
        path: rel,
        bytes: text,
        observed_bytes: Buffer.byteLength(text, "utf8"),
        reason: "unparseable",
      });
      return null;
    }
    const digest = typeof (raw as Record<string, unknown>).digest === "string" ? String((raw as Record<string, unknown>).digest) : computeEventDigest(raw as Record<string, unknown>);
    return { envelope: parsed.data, digest };
  }

  private readEnvelopeFile(abs: string): { envelope: EventEnvelope; digest: string } | null {
    try {
      return this.decode(fs.readFileSync(abs, "utf8"), abs, "");
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------- ack

  /**
   * Consumer cursors are SINGLE-WRITER files (ADR §5): only this principal ever
   * rewrites its own, so they union-merge across clones exactly like events do.
   */
  async ack(consumer: string, cursor: Cursor): Promise<void> {
    if (this.faults.dropNextAck) {
      this.faults.dropNextAck = false;
      return; // the carrier never learns this consumer moved
    }
    // In source_branch mode the "worktree" IS the user's checkout, and the
    // cursor is consumer state rather than source: it goes beside the store, so
    // the mode's forfeit stays bounded to the commits it declares it makes.
    const wt = this.mode === "exchange_ref" ? this.wt : this.cursorFallbackDir;
    fs.mkdirSync(wt, { recursive: true });
    // ONE path segment, always. `path.posix.join` normalizes, so a principal
    // like `agent://peer` collapsed onto the same file as `agent:/peer` — two
    // distinct consumers silently sharing one single-writer cursor — and a
    // principal containing `../` escaped the worktree entirely and landed a
    // file in the user's source checkout.
    const rel = path.posix.join("cursors", `${cursorFileName(consumer)}.json`);
    const abs = path.join(wt, rel);
    if (path.relative(wt, abs).startsWith("..")) throw new Error(`git exchange: refusing to write a cursor outside the exchange worktree (${consumer})`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // The full principal is stored INSIDE the body, so an encoded filename
    // never loses the identity it stands for.
    fs.writeFileSync(abs, `${JSON.stringify({ ...cursor, principal: consumer }, null, 2)}\n`);
    if (this.mode === "source_branch") return;
    git(wt, ["add", "--", rel]);
    const staged = gitTry(wt, ["diff", "--cached", "--name-only", "--relative", "-z"]).stdout.split("\0").filter((p) => p !== "");
    if (staged.length === 0) return; // byte-identical cursor: nothing to record
    this.assertOnlyStaged(wt, [rel]);
    git(wt, ["commit", "--no-verify", "-m", `twining exchange: cursor ${consumer}`]);
    this.mergeRemote();
    this.pushBranch();
  }

  consumerCursor(principal: string): Cursor | null {
    const abs = path.join(this.mode === "exchange_ref" ? this.worktreeDir : this.cursorFallbackDir, "cursors", `${cursorFileName(principal)}.json`);
    if (!fs.existsSync(abs)) return null;
    try {
      return JSON.parse(fs.readFileSync(abs, "utf8")) as Cursor;
    } catch {
      return null;
    }
  }

  async health(): Promise<TransportHealth> {
    if (!isGitRepo(this.repoDir)) return { reachable: false, last_error: "not a git repository", credential_state: "unknown" };
    const head = this.head();
    const carried = head ? treeEntries(this.wt, head).filter((e) => e.path.startsWith("events/")).length : 0;
    if (!this.remote) return { reachable: true, lag_events: carried, credential_state: "ok" };
    const probe = gitTry(this.wt, ["ls-remote", "--exit-code", this.remote, `refs/heads/${this.branch}`]);
    // exit 2 = the remote answered but has no such ref: reachable, just empty.
    const reachable = probe.status === 0 || probe.status === 2;
    return {
      reachable,
      lag_events: carried,
      ...(reachable ? {} : { last_error: redactText(probe.stderr.trim() || `git ls-remote exited ${probe.status}`, this.remote) }),
      credential_state: reachable ? "ok" : "unknown",
    };
  }

  /** Carried event ids at the current head — the "what the checkout can still see" set. */
  carriedEventIds(): string[] {
    const head = this.head();
    if (!head) return [];
    return treeEntries(this.wt, head)
      .filter((e) => e.path.startsWith("events/"))
      .map((e) => path.basename(e.path, ".json"))
      .sort();
  }
}
