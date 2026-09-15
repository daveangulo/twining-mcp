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
import type { Cursor, PublishReceipt, Transport, TransportHealth } from "../contracts/store-api.js";
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
export interface MalformedArtifact {
  carrier_id: string;
  path: string;
  bytes: string;
  observed_bytes: number;
  reason: "unparseable" | "conflict_markers" | "truncated";
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
function isCarriedArtifact(rel: string): boolean {
  return rel.endsWith(".json") && !rel.startsWith("cursors/");
}

interface PollGap {
  gap: boolean;
  reason?: string;
  /** The cursor position the carrier could no longer resolve. */
  unreachable_from?: string;
}

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
  private readonly worktreeDir: string;
  private readonly now: () => string;
  private ensured = false;

  constructor(opts: GitTransportOptions) {
    this.repoDir = opts.repoDir;
    this.branch = opts.branch ?? EXCHANGE_BRANCH;
    this.mode = opts.mode ?? "exchange_ref";
    if (opts.remote !== undefined) this.remote = opts.remote;
    this.worktreeDir =
      this.mode === "exchange_ref"
        ? path.join(opts.twiningDir, "exchange")
        : path.join(opts.repoDir, opts.sourcePath ?? "twining-exchange");
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  id(): string {
    return `git:${this.remote ?? this.repoDir}/${this.branch}`;
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
      // A stale administrative record from a previously removed directory would
      // make `worktree add` refuse; pruning is safe and touches no working tree.
      gitTry(this.repoDir, ["worktree", "prune"]);
      git(this.repoDir, ["worktree", "add", this.worktreeDir, this.branch]);
    }
    this.ensured = true;
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
      if (fs.existsSync(abs)) {
        pathByDigest[ev.digest] = rel;
        continue; // already carried at this path with these bytes
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, bytes);
      staged.push(rel);
      pathByDigest[ev.digest] = rel;
    }

    this.faultHook?.("export_staged");

    const before = this.head();
    if (staged.length > 0) {
      git(wt, ["add", "--", ...staged]);
      if (this.mode === "exchange_ref") {
        this.assertOnlyStaged(wt, staged);
        git(wt, ["commit", "--no-verify", "-m", this.commitMessage(staged.length)]);
      } else {
        // source_branch mode shares the user's index, so a plain commit would
        // sweep up whatever they had staged. A pathspec-limited commit narrows
        // the damage — it does NOT restore non-interference, which this mode
        // forfeits by definition (ADR §8.2).
        git(wt, ["commit", "--no-verify", "-m", this.commitMessage(staged.length), "--", ...staged]);
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
    const abs = path.join(this.worktreeDir, primary);
    if (!fs.existsSync(abs)) return primary;
    const held = this.readEnvelopeFile(abs);
    if (held && held.digest === ev.digest) return primary;
    return path.posix.join("conflicts", `${ev.id}.${ev.digest.slice(7, 19)}.json`);
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
    const after = new Map(treeEntries(wt, merged).map((e: TreeEntry) => [e.path, e.oid]));
    const dropped: string[] = [];
    const rewritten: string[] = [];
    for (const side of sides) {
      for (const e of treeEntries(wt, side)) {
        const got = after.get(e.path);
        if (got === undefined) dropped.push(e.path);
        else if (got !== e.oid) rewritten.push(e.path);
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
        const conflicted = gitTry(wt, ["diff", "--name-only", "--diff-filter=U", "-z"])
          .stdout.split("\0")
          .filter((p) => p !== "");
        gitTry(wt, ["merge", "--abort"]);
        throw new UnionViolationError("merge_conflict", conflicted, r.stderr.trim());
      }
    }
    const merged = this.head();
    if (merged) this.assertUnion(wt, [localHead, remoteHead], merged);
  }

  private pushBranch(): void {
    if (!this.remote) return;
    const dir = this.mode === "exchange_ref" ? this.wt : this.repoDir;
    const src = this.mode === "exchange_ref" ? "HEAD" : "HEAD";
    const r = gitTry(dir, ["push", this.remote, `${src}:refs/heads/${this.branch}`]);
    if (r.status !== 0) throw new Error(`git exchange: push failed — ${r.stderr.trim()}`);
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
    const wt = this.wt;
    const rel = path.posix.join("cursors", `${consumer}.json`);
    const abs = path.join(wt, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${JSON.stringify(cursor, null, 2)}\n`);
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
    const abs = path.join(this.worktreeDir, "cursors", `${principal}.json`);
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
      ...(reachable ? {} : { last_error: probe.stderr.trim() || `git ls-remote exited ${probe.status}` }),
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
