/**
 * The Git carrier (ADR §8.2, DP11).
 *
 * Real git, real commits, real bare remotes — no mocking, because the whole
 * point of the case set is that git's own merge behaviour is the thing under
 * test. The invariants proved here are the ones the rest of lane 02 leans on:
 *
 *   - publish stages ONLY paths under the exchange worktree;
 *   - the user's source checkout is byte-identical before and after, dirt and
 *     staged changes included (R09 non-interference);
 *   - a merge is a union and is VERIFIED to be one, not assumed;
 *   - publish is idempotent by id + digest and never rewrites a carried file;
 *   - a cursor unreachable from the head is a REWIND, reported, never read as
 *     a deletion (the C14 seam);
 *   - source-branch mode exists for the migration window and says plainly that
 *     it forfeits non-interference.
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { GitTransport, UnionViolationError, EXCHANGE_BRANCH, cursorFileName, redactRemote, redactText } from "../../src/exchange/git-transport.js";
import { git, gitTry, revParse, treeEntries } from "../../src/exchange/git.js";
import { buildEvent, created, makeIdentity, makeWorld, type World } from "../acceptance/slice/harness.js";
import { bareRemote, cleanupGitTempDirs, dirtyTheCheckout, fingerprintCheckout, gitTempDir, sourceCheckout } from "./git-fixtures.js";
import type { EventEnvelope } from "../../src/contracts/index.js";

afterAll(cleanupGitTempDirs);

function ev(w: World, summary: string, occurredAt = "2026-09-15T12:00:00.000Z"): EventEnvelope {
  return created("decision", {
    scope: { repo: w.repo, path: "src/pay/" },
    producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
    evidence_class: "proposal",
    occurred_at: occurredAt,
    payload: { summary, rationale: `because ${summary}` },
    signWith: { keyId: w.hostA.keyId, kp: w.hostA.kp },
  }) as unknown as EventEnvelope;
}

describe("GitTransport — worktree topology", () => {
  it("checks the exchange ref out in its own worktree without touching the source tree", async () => {
    const { repoDir, twiningDir } = sourceCheckout();
    const t = new GitTransport({ twiningDir, repoDir });
    t.ensureWorktree();

    // The exchange worktree is a real linked worktree on the orphan branch.
    expect(fs.existsSync(path.join(twiningDir, "exchange", ".git"))).toBe(true);
    expect(git(path.join(twiningDir, "exchange"), ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(EXCHANGE_BRANCH);

    // Orphan: the exchange root commit shares no history with the source branch.
    const exchangeRoot = git(repoDir, ["rev-list", "--max-parents=0", EXCHANGE_BRANCH]).trim();
    const sourceRoot = git(repoDir, ["rev-list", "--max-parents=0", "HEAD"]).trim();
    expect(exchangeRoot).not.toBe(sourceRoot);
    // ...and it is empty, so no source file was ever materialized into it.
    expect(treeEntries(repoDir, exchangeRoot)).toEqual([]);
  });

  it("R09: a full publish leaves a DIRTY source checkout byte-identical", async () => {
    const w = makeWorld();
    const { repoDir, twiningDir } = sourceCheckout();
    const remote = bareRemote();
    dirtyTheCheckout(repoDir);

    const before = fingerprintCheckout(repoDir);
    expect(before.status).toContain("scratch.md"); // the fixture really is dirty
    expect(before.status).toMatch(/^A {2}src\/ledger\/post\.ts$/m); // and really has a staged change

    const t = new GitTransport({ twiningDir, repoDir, remote });
    await t.publish([ev(w, "first"), ev(w, "second")]);
    await t.poll(null);
    await t.ack(w.hostB.principal, { transport: t.id(), position: "0" });

    const after = fingerprintCheckout(repoDir);
    expect(after).toEqual(before);
  });

  it("stages only paths under the exchange worktree, even with the source tree dirty", async () => {
    const w = makeWorld();
    const { repoDir, twiningDir } = sourceCheckout();
    dirtyTheCheckout(repoDir);
    const t = new GitTransport({ twiningDir, repoDir });
    await t.publish([ev(w, "only-exchange-paths")]);

    const wt = path.join(twiningDir, "exchange");
    const carried = treeEntries(wt, "HEAD").map((e) => e.path);
    expect(carried).toHaveLength(1);
    expect(carried[0]).toMatch(/^events\/2026-09\/[0-9A-HJKMNP-TV-Z]{26}\.json$/);
    expect(carried.some((p) => p.includes("settle.ts") || p.includes("scratch.md"))).toBe(false);
  });
});

describe("GitTransport — publish semantics", () => {
  it("is idempotent by id + digest: a retry adds no commit and reuses the carrier id", async () => {
    const w = makeWorld();
    const { repoDir, twiningDir } = sourceCheckout();
    const remote = bareRemote();
    const t = new GitTransport({ twiningDir, repoDir, remote });
    const e = ev(w, "retry me");

    const first = await t.publish([e]);
    const headAfterFirst = revParse(path.join(twiningDir, "exchange"), "HEAD");
    const second = await t.publish([e]);

    expect(second.carrier_ids[e.digest]).toBe(first.carrier_ids[e.digest]);
    expect(revParse(path.join(twiningDir, "exchange"), "HEAD")).toBe(headAfterFirst); // no second commit
    expect(treeEntries(path.join(twiningDir, "exchange"), "HEAD")).toHaveLength(1);
  });

  it("never rewrites a carried file: the same id with different bytes lands beside it", async () => {
    const w = makeWorld();
    const { repoDir, twiningDir } = sourceCheckout();
    const t = new GitTransport({ twiningDir, repoDir });
    const first = ev(w, "original");
    await t.publish([first]);
    const originalOid = treeEntries(path.join(twiningDir, "exchange"), "HEAD")[0]?.oid;

    const clash = buildEvent({
      id: first.id,
      scope: { repo: w.repo, path: "src/pay/" },
      producer: { principal: w.hostA.principal, kind: "agent", host: w.hostA.host },
      evidence_class: "proposal",
      payload: { summary: "different bytes, same id", rationale: "conflict" },
      signWith: { keyId: w.hostA.keyId, kp: w.hostA.kp },
    }) as unknown as EventEnvelope;
    expect(clash.digest).not.toBe(first.digest);
    const receipt = await t.publish([clash]);

    const carried = treeEntries(path.join(twiningDir, "exchange"), "HEAD");
    const incumbent = carried.find((e) => e.path.startsWith("events/"));
    const conflict = carried.find((e) => e.path.startsWith("conflicts/"));
    expect(incumbent?.oid).toBe(originalOid); // the incumbent's bytes are untouched
    expect(conflict?.path).toBe(`conflicts/${first.id}.${clash.digest.slice(7, 19)}.json`);
    expect(receipt.carrier_ids[clash.digest]).toBeTruthy();
  });

  it("merges two replicas as a union and verifies it (no file is ever rewritten)", async () => {
    const w = makeWorld();
    const remote = bareRemote();
    const a = sourceCheckout("a");
    const b = sourceCheckout("b");
    const ta = new GitTransport({ twiningDir: a.twiningDir, repoDir: a.repoDir, remote });
    const tb = new GitTransport({ twiningDir: b.twiningDir, repoDir: b.repoDir, remote });

    const fromA = ev(w, "authored on A");
    const fromB = ev(w, "authored on B");
    await ta.publish([fromA]);
    await tb.publish([fromB]); // B started from A's pushed branch, so this fast-forwards

    // Both sides now converge and neither event is lost or rewritten.
    const polledOnA = await ta.poll(null);
    expect(polledOnA.events.map((e) => e.id).sort()).toEqual([fromA.id, fromB.id].sort());
    expect(ta.carriedEventIds()).toEqual([fromA.id, fromB.id].sort());
  });

  it("merges genuinely unrelated histories (two replicas that each minted a genesis) as a union", async () => {
    const w = makeWorld();
    const remote = bareRemote();
    const a = sourceCheckout("a");
    const b = sourceCheckout("b");
    // Both build their exchange branch offline, so each has its own root commit.
    const ta = new GitTransport({ twiningDir: a.twiningDir, repoDir: a.repoDir });
    const tb = new GitTransport({ twiningDir: b.twiningDir, repoDir: b.repoDir });
    const fromA = ev(w, "offline on A");
    const fromB = ev(w, "offline on B");
    await ta.publish([fromA]);
    await tb.publish([fromB]);

    // Now both acquire the same remote and publish again.
    const ta2 = new GitTransport({ twiningDir: a.twiningDir, repoDir: a.repoDir, remote });
    const tb2 = new GitTransport({ twiningDir: b.twiningDir, repoDir: b.repoDir, remote });
    await ta2.publish([]);
    await tb2.publish([]);
    await ta2.publish([]);

    expect(ta2.carriedEventIds()).toEqual([fromA.id, fromB.id].sort());
    expect(tb2.carriedEventIds()).toEqual([fromA.id, fromB.id].sort());
  });

  it("raises UnionViolationError rather than accepting a merge that rewrote a carried blob", async () => {
    const w = makeWorld();
    const remote = bareRemote();
    const a = sourceCheckout("a");
    const b = sourceCheckout("b");
    const ta = new GitTransport({ twiningDir: a.twiningDir, repoDir: a.repoDir, remote });
    const shared = ev(w, "shared");
    await ta.publish([shared]);

    // B clones the branch, then deliberately REWRITES the carried file — the
    // thing the carrier's design forbids — and pushes it.
    const tb = new GitTransport({ twiningDir: b.twiningDir, repoDir: b.repoDir, remote });
    tb.ensureWorktree();
    const bwt = path.join(b.twiningDir, "exchange");
    const carried = treeEntries(bwt, "HEAD").find((e) => e.path.startsWith("events/"))?.path as string;
    fs.writeFileSync(path.join(bwt, carried), JSON.stringify({ ...shared, payload: { summary: "tampered", rationale: "x" } }, null, 2));
    git(bwt, ["add", "--", carried]);
    git(bwt, ["commit", "--no-verify", "-m", "tamper"]);
    git(bwt, ["push", remote, `HEAD:refs/heads/${EXCHANGE_BRANCH}`]);

    // A publishes again: the fast-forward would silently adopt the rewrite.
    await expect(ta.publish([ev(w, "next")])).rejects.toBeInstanceOf(UnionViolationError);
  });
});

describe("GitTransport — poll, rewind and gaps", () => {
  it("returns only what is new beyond the cursor", async () => {
    const w = makeWorld();
    const { repoDir, twiningDir } = sourceCheckout();
    const t = new GitTransport({ twiningDir, repoDir });
    const e1 = ev(w, "one");
    await t.publish([e1]);
    const first = await t.poll(null);
    expect(first.events.map((e) => e.id)).toEqual([e1.id]);

    const e2 = ev(w, "two");
    await t.publish([e2]);
    const second = await t.poll(first.cursor);
    expect(second.events.map((e) => e.id)).toEqual([e2.id]);
    expect(t.lastGap.gap).toBe(false);

    const third = await t.poll(second.cursor);
    expect(third.events).toEqual([]);
  });

  it("C14: a cursor unreachable after a force-push is a reported REWIND, never a deletion", async () => {
    const w = makeWorld();
    const remote = bareRemote();
    const { repoDir, twiningDir } = sourceCheckout();
    const t = new GitTransport({ twiningDir, repoDir, remote });
    const e1 = ev(w, "kept");
    const e2 = ev(w, "dropped by the rewrite");
    await t.publish([e1]);
    const afterFirst = await t.poll(null);
    await t.publish([e2]);
    const afterSecond = await t.poll(afterFirst.cursor);
    expect(afterSecond.events.map((e) => e.id)).toEqual([e2.id]);

    // Force-push the branch back to the first commit: e2's commit is unreachable.
    const wt = path.join(twiningDir, "exchange");
    const rewound = revParse(wt, "HEAD~1") as string;
    git(wt, ["push", "--force", remote, `${rewound}:refs/heads/${EXCHANGE_BRANCH}`]);
    git(wt, ["reset", "--hard", rewound]);

    const afterRewind = await t.poll(afterSecond.cursor);
    expect(t.lastGap.gap).toBe(true);
    expect(t.lastGap.unreachable_from).toBe(afterSecond.cursor.position);
    // The rescan re-delivers what the carrier still holds; it concludes nothing
    // about what it no longer holds. Redelivery is idempotent at the store.
    expect(afterRewind.events.map((e) => e.id)).toEqual([e1.id]);
    expect(t.carriedEventIds()).toEqual([e1.id]);
  });

  it("C17: a truncated or conflict-marked artifact is surfaced with its bytes, not swallowed", async () => {
    const w = makeWorld();
    const { repoDir, twiningDir } = sourceCheckout();
    const t = new GitTransport({ twiningDir, repoDir });
    const good = ev(w, "complete");
    await t.publish([good]);

    const wt = path.join(twiningDir, "exchange");
    const truncated = "events/2026-09/01JTRUNCATED00000000000000.json";
    const conflicted = "events/2026-09/01JCONFLICTED0000000000000.json";
    fs.mkdirSync(path.join(wt, "events", "2026-09"), { recursive: true });
    fs.writeFileSync(path.join(wt, truncated), JSON.stringify(good, null, 2).slice(0, 120));
    fs.writeFileSync(
      path.join(wt, conflicted),
      `<<<<<<< HEAD\n${JSON.stringify(good)}\n=======\n${JSON.stringify(good)}\n>>>>>>> theirs\n`,
    );
    git(wt, ["add", "--", truncated, conflicted]);
    git(wt, ["commit", "--no-verify", "-m", "bad artifacts"]);

    const polled = await t.poll(null);
    expect(polled.events.map((e) => e.id)).toEqual([good.id]); // the good one still lands
    expect(t.lastMalformed.map((m) => m.reason).sort()).toEqual(["conflict_markers", "truncated"]);
    for (const m of t.lastMalformed) {
      expect(m.observed_bytes).toBeGreaterThan(0);
      expect(m.bytes.length).toBe(m.observed_bytes); // the exact bytes are retained
      expect(m.carrier_id).toMatch(/^[0-9a-f]{40}$/);
    }
  });
});

describe("GitTransport — cursors and health", () => {
  it("writes the consumer's single-writer cursor file and nothing else", async () => {
    const w = makeWorld();
    const remote = bareRemote();
    const { repoDir, twiningDir } = sourceCheckout();
    const t = new GitTransport({ twiningDir, repoDir, remote });
    await t.publish([ev(w, "anything")]);
    const cursor = { transport: t.id(), position: revParse(path.join(twiningDir, "exchange"), "HEAD") as string, last_admitted: "01J" };
    await t.ack(w.hostB.principal, cursor);

    // The cursor round-trips, and the body carries the full principal so an
    // encoded filename never loses the identity it stands for.
    expect(t.consumerCursor(w.hostB.principal)).toMatchObject(cursor);
    expect((t.consumerCursor(w.hostB.principal) as { principal?: string }).principal).toBe(w.hostB.principal);
    const carried = treeEntries(path.join(twiningDir, "exchange"), "HEAD").map((e) => e.path);
    expect(carried.filter((p) => p.startsWith("cursors/"))).toEqual([`cursors/${cursorFileName(w.hostB.principal)}.json`]);
    // A byte-identical re-ack records no second commit.
    const head = revParse(path.join(twiningDir, "exchange"), "HEAD");
    await t.ack(w.hostB.principal, cursor);
    expect(revParse(path.join(twiningDir, "exchange"), "HEAD")).toBe(head);
  });

  it("health() reports an unreachable remote instead of throwing", async () => {
    const { repoDir, twiningDir } = sourceCheckout();
    const t = new GitTransport({ twiningDir, repoDir, remote: path.join(repoDir, "no-such-remote.git") });
    t.ensureWorktree();
    const h = await t.health();
    expect(h.reachable).toBe(false);
    expect(h.credential_state).toBe("unknown");
    expect(h.last_error).toBeTruthy();
  });
});

describe("GitTransport — source-branch mode (migration window)", () => {
  it("rides the working branch and SAYS it forfeits non-interference", async () => {
    const w = makeWorld();
    const { repoDir, twiningDir } = sourceCheckout();
    const t = new GitTransport({ twiningDir, repoDir, mode: "source_branch", sourcePath: "twining-exchange" });
    const before = fingerprintCheckout(repoDir);

    const e = ev(w, "riding the working branch");
    await t.publish([e]);

    // The events are written INTO the user's working tree — that is the
    // forfeit, made observable rather than described.
    const after = fingerprintCheckout(repoDir);
    expect(after.worktree).not.toBe(before.worktree);
    expect(fs.existsSync(path.join(repoDir, "twining-exchange", "events", "2026-09", `${e.id}.json`))).toBe(true);
    expect(t.mode).toBe("source_branch");
    expect(t.id()).toContain("git:");
    // ...but the forfeit is BOUNDED to the commits it declares it makes: the
    // user's index is left as it was found, and the cursor does not litter the
    // source tree.
    expect(git(repoDir, ["diff", "--cached", "--name-only"]).trim()).toBe("");
    await t.ack(w.hostB.principal, { transport: t.id(), position: "1" });
    expect(fs.existsSync(path.join(repoDir, "twining-exchange", "cursors"))).toBe(false);
    expect(t.consumerCursor(w.hostB.principal)?.position).toBe("1");
    // The default mode does NOT do this — proved by the R09 test above.
  });
});

describe("GitTransport — no unsolicited source-repo writes (C14 N10)", () => {
  it("performs no commit, checkout, reset or push on the user's branch across a full cycle", async () => {
    const w = makeWorld();
    const remote = bareRemote();
    const { repoDir, twiningDir } = sourceCheckout();
    dirtyTheCheckout(repoDir);
    const t = new GitTransport({ twiningDir, repoDir, remote });
    const before = fingerprintCheckout(repoDir);

    await t.publish([ev(w, "a"), ev(w, "b")]);
    await t.poll(null);
    const wt = path.join(twiningDir, "exchange");
    git(wt, ["reset", "--hard", "HEAD~1"]); // a rewind of the EXCHANGE checkout
    await t.poll({ transport: t.id(), position: "0".repeat(40) });
    await t.publish([ev(w, "c")]);

    expect(fingerprintCheckout(repoDir)).toEqual(before);
    // The user's branch gained no commits, and the exchange ref is not on it.
    expect(gitTry(repoDir, ["branch", "--contains", EXCHANGE_BRANCH, "--format=%(refname:short)"]).stdout).not.toContain("main");
  });
});

/**
 * ===================== ADVERSARIAL REVIEW REGRESSIONS =======================
 * One test per confirmed finding from the lane-02b review (wf_4c05c821-c52).
 * Each reproduces the defect's mechanism, so a regression brings the old
 * behaviour back as a red test rather than as a silent loss.
 */
describe("GitTransport — review regressions", () => {
  it("R1: a clean-but-LOSSY merge is rolled back and the carrier refuses to push it upstream", async () => {
    const w = makeWorld();
    const remote = bareRemote();
    const a = sourceCheckout("r1a");
    const ta = new GitTransport({ twiningDir: a.twiningDir, repoDir: a.repoDir, remote });
    const kept = ev(w, "must survive");
    await ta.publish([kept]);
    const awt = path.join(a.twiningDir, "exchange");
    const goodHead = revParse(awt, "HEAD") as string;

    // The remote gains a branch that DELETES the carried file — a merge that
    // succeeds textually and loses a blob, which is the case assertUnion exists
    // for and the one that used to survive.
    const b = sourceCheckout("r1b");
    const tb = new GitTransport({ twiningDir: b.twiningDir, repoDir: b.repoDir, remote });
    tb.ensureWorktree();
    const bwt = path.join(b.twiningDir, "exchange");
    const carried = treeEntries(bwt, "HEAD").find((e) => e.path.startsWith("events/"))?.path as string;
    fs.rmSync(path.join(bwt, carried));
    git(bwt, ["rm", "-q", "--", carried]);
    git(bwt, ["commit", "--no-verify", "-m", "drop the event"]);
    // ...on a sibling commit, so A's merge is a real two-parent merge.
    fs.mkdirSync(path.join(bwt, "events", "2026-09"), { recursive: true });
    fs.writeFileSync(path.join(bwt, "events", "2026-09", "01JZZZZZZZZZZZZZZZZZZZZZZZ.json"), "{}\n");
    git(bwt, ["add", "-A", "--", "events"]);
    git(bwt, ["commit", "--no-verify", "-m", "sibling"]);
    git(bwt, ["push", "--force", remote, `HEAD:refs/heads/${EXCHANGE_BRANCH}`]);

    await expect(ta.publish([ev(w, "next")])).rejects.toBeInstanceOf(UnionViolationError);

    // ROLLED BACK: the exchange worktree is back at the pre-merge tip, so the
    // carried file is still there and nothing lossy is the branch head.
    expect(gitTry(awt, ["cat-file", "-e", `HEAD:${carried}`]).status).toBe(0);
    // The rollback undoes the MERGE, not this replica's own local commits: HEAD
    // is the pre-merge tip, still a single-parent commit descending from the
    // good head, with no merge commit anywhere.
    expect(git(awt, ["rev-list", "--parents", "-1", "HEAD"]).trim().split(/\s+/)).toHaveLength(2);
    expect(gitTry(awt, ["merge-base", "--is-ancestor", goodHead, "HEAD"]).status).toBe(0);

    // ...and STICKY: every later publish refuses rather than pushing the loss.
    expect(ta.violation).toBeInstanceOf(UnionViolationError);
    await expect(ta.publish([ev(w, "later")])).rejects.toThrow(/refusing to push|union violated/);
    ta.clearViolation();
    expect(ta.violation).toBeNull();
  });

  it("R2: a crash between writing an event and committing it does not make the event permanently untransferable", async () => {
    const w = makeWorld();
    const remote = bareRemote();
    const { repoDir, twiningDir } = sourceCheckout("r2");
    const doomed = new GitTransport({ twiningDir, repoDir, remote });
    const e = ev(w, "written but never committed");

    // Die after the bytes are staged and before the commit — the C18 fault point.
    doomed.faultHook = (step) => {
      if (step === "export_staged") throw new Error("simulated crash before commit");
    };
    await expect(doomed.publish([e])).rejects.toThrow("simulated crash");
    const wt = path.join(twiningDir, "exchange");
    expect(fs.existsSync(path.join(wt, "events", "2026-09", `${e.id}.json`))).toBe(true); // residue on disk
    expect(gitTry(wt, ["cat-file", "-e", `HEAD:events/2026-09/${e.id}.json`]).status).not.toBe(0); // not carried

    // A FRESH carrier (the restart) must transfer it: idempotence is decided
    // against the committed tree, and the residue is cleaned at startup.
    const recovered = new GitTransport({ twiningDir, repoDir, remote });
    const receipt = await recovered.publish([e]);
    expect(receipt.carrier_ids[e.digest]).toMatch(/^[0-9a-f]{40}$/);
    expect(recovered.carriedEventIds()).toEqual([e.id]);
    // ...and the consumer really sees it.
    const consumer = sourceCheckout("r2-cons");
    const tc = new GitTransport({ twiningDir: consumer.twiningDir, repoDir: consumer.repoDir, remote });
    expect((await tc.poll(null)).events.map((x) => x.id)).toEqual([e.id]);
  });

  it("R3: a credential-bearing remote never reaches the id, the cursor file, health() or a push error", async () => {
    const w = makeWorld();
    const { repoDir, twiningDir } = sourceCheckout("r3");
    const token = "ghp_SUPERSECRETTOKENVALUE";
    const secretRemote = `https://x-access-token:${token}@example.invalid/org/repo.git`;
    const t = new GitTransport({ twiningDir, repoDir, remote: secretRemote });

    expect(t.id()).not.toContain(token);
    expect(t.id()).toContain("***@example.invalid");
    // The unit is injective on the safe part and total on the unsafe part.
    expect(redactRemote("https://user:pw@h/x.git")).toBe("https://***@h/x.git");
    expect(redactRemote("https://h/x.git")).toBe("https://h/x.git"); // nothing to redact
    expect(redactRemote("git@github.com:org/repo.git")).toBe("git@github.com:org/repo.git"); // scp form, no password
    expect(redactText(`fatal: could not read from ${secretRemote}`, secretRemote)).not.toContain(token);

    // health() on an unreachable credential remote must not echo it.
    const h = await t.health();
    expect(h.reachable).toBe(false);
    expect(JSON.stringify(h)).not.toContain(token);

    // The cursor file is committed and pushed — it must not carry the token.
    await t.ack(w.hostB.principal, { transport: t.id(), position: "0" }).catch(() => undefined);
    const cursorFile = path.join(twiningDir, "exchange", "cursors", `${cursorFileName(w.hostB.principal)}.json`);
    if (fs.existsSync(cursorFile)) expect(fs.readFileSync(cursorFile, "utf8")).not.toContain(token);
  });

  it("R5: ensureWorktree removes only ITS OWN stale record and leaves the user's other worktrees alone", async () => {
    const w = makeWorld();
    const { repoDir, twiningDir } = sourceCheckout("r5");
    // The user has their own linked worktree, and its directory is momentarily
    // absent (an unmounted volume, a rename in flight, a sibling agent lane).
    const theirs = path.join(repoDir, "..", `their-worktree-${Date.now()}`);
    git(repoDir, ["worktree", "add", "-q", "--detach", theirs]);
    const record = path.join(repoDir, ".git", "worktrees", path.basename(theirs));
    expect(fs.existsSync(record)).toBe(true);
    fs.renameSync(theirs, `${theirs}.moved`);

    new GitTransport({ twiningDir, repoDir }).ensureWorktree();

    // A bare `git worktree prune` would have destroyed this record.
    expect(fs.existsSync(record)).toBe(true);
    fs.renameSync(`${theirs}.moved`, theirs);
    expect(gitTry(theirs, ["rev-parse", "--git-dir"]).status).toBe(0); // still a working repo
    void w;
  });

  it("R4: the exchange worktree is ignored even when the store directory is TRACKED", async () => {
    const w = makeWorld();
    const repoDir = gitTempDirForTrackedStore();
    const twiningDir = path.join(repoDir, ".twining");
    // The store is tracked (this project tracks .twining/records), so nothing
    // in .gitignore covers the exchange worktree.
    expect(gitTry(repoDir, ["check-ignore", "-q", path.join(twiningDir, "exchange")]).status).not.toBe(0);

    const t = new GitTransport({ twiningDir, repoDir });
    await t.publish([ev(w, "tracked-store project")]);

    // After the carrier runs, the worktree is invisible to the user's status —
    // so a routine `git add -A` cannot sweep it in as a gitlink.
    expect(gitTry(repoDir, ["check-ignore", "-q", path.join(twiningDir, "exchange")]).status).toBe(0);
    git(repoDir, ["add", "-A"]);
    expect(git(repoDir, ["diff", "--cached", "--name-only"])).not.toContain("exchange");
    expect(git(repoDir, ["status", "--porcelain=v1", "-uall"])).not.toContain(".twining/exchange");
  });

  it("R6: two replicas that minted the SAME id with different bytes converge instead of wedging", async () => {
    const w = makeWorld();
    const remote = bareRemote();
    const a = sourceCheckout("r6a");
    const b = sourceCheckout("r6b");
    const mine = ev(w, "authored on A");
    const rival = buildEvent({
      id: mine.id,
      scope: { repo: w.repo, path: "src/pay/" },
      producer: { principal: w.hostB.principal, kind: "agent", host: w.hostB.host },
      evidence_class: "proposal",
      payload: { summary: "authored on B under the same id", rationale: "collision" },
      signWith: { keyId: w.hostB.keyId, kp: w.hostB.kp },
    }) as unknown as EventEnvelope;
    expect(rival.digest).not.toBe(mine.digest);

    // Both publish OFFLINE, so neither can take the conflicts/ sidestep.
    const ta0 = new GitTransport({ twiningDir: a.twiningDir, repoDir: a.repoDir });
    const tb0 = new GitTransport({ twiningDir: b.twiningDir, repoDir: b.repoDir });
    await ta0.publish([mine]);
    await tb0.publish([rival]);

    // Now they share a remote. The add/add used to abort forever, from BOTH
    // publish and poll, so the replica could neither send nor receive again.
    const ta = new GitTransport({ twiningDir: a.twiningDir, repoDir: a.repoDir, remote });
    const tb = new GitTransport({ twiningDir: b.twiningDir, repoDir: b.repoDir, remote });
    await ta.publish([]);
    await tb.publish([]);
    await ta.publish([]);

    // Neither side lost bytes: one owns the event path, both digests are carried.
    const carried = treeEntries(path.join(a.twiningDir, "exchange"), "HEAD").map((e) => e.path);
    expect(carried.some((p) => p.startsWith("events/"))).toBe(true);
    expect(carried.some((p) => p.startsWith("conflicts/"))).toBe(true);
    // ...and the carrier is not wedged: it still sends and receives.
    const later = ev(w, "after the collision");
    await ta.publish([later]);
    expect((await tb.poll(null)).events.map((e) => e.id)).toContain(later.id);
    expect(ta.violation).toBeNull();
  });

  it("R7: distinct principals never collide on one cursor file, and a traversing principal cannot escape the worktree", async () => {
    const { repoDir, twiningDir } = sourceCheckout("r7");
    const t = new GitTransport({ twiningDir, repoDir });
    t.ensureWorktree();

    // These two normalize to the same path under path.posix.join.
    expect(cursorFileName("agent://peer")).not.toBe(cursorFileName("agent:/peer"));
    await t.ack("agent://peer", { transport: t.id(), position: "1" });
    await t.ack("agent:/peer", { transport: t.id(), position: "2" });
    expect(t.consumerCursor("agent://peer")?.position).toBe("1");
    expect(t.consumerCursor("agent:/peer")?.position).toBe("2");

    // A traversing principal lands inside the worktree or not at all — never in
    // the user's source checkout.
    await t.ack("../../escaped", { transport: t.id(), position: "3" });
    expect(fs.existsSync(path.join(repoDir, "escaped.json"))).toBe(false);
    expect(fs.existsSync(path.join(twiningDir, "escaped.json"))).toBe(false);
    expect(t.consumerCursor("../../escaped")?.position).toBe("3");
  });
});

/** A project whose `.twining/` is TRACKED — the configuration R4 is about. */
function gitTempDirForTrackedStore(): string {
  const dir = gitTempDir("tracked-store");
  git(dir, ["init", "--initial-branch=main", "."]);
  git(dir, ["config", "user.name", "Dev"]);
  git(dir, ["config", "user.email", "dev@localhost"]);
  fs.mkdirSync(path.join(dir, ".twining", "records"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".twining", "records", "keep.json"), "{}\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--no-verify", "-m", "tracked store"]);
  return dir;
}
