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

import { GitTransport, UnionViolationError, EXCHANGE_BRANCH } from "../../src/exchange/git-transport.js";
import { git, gitTry, revParse, treeEntries } from "../../src/exchange/git.js";
import { buildEvent, created, makeIdentity, makeWorld, type World } from "../acceptance/slice/harness.js";
import { bareRemote, cleanupGitTempDirs, dirtyTheCheckout, fingerprintCheckout, sourceCheckout } from "./git-fixtures.js";
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

    expect(t.consumerCursor(w.hostB.principal)).toEqual(cursor);
    const carried = treeEntries(path.join(twiningDir, "exchange"), "HEAD").map((e) => e.path);
    expect(carried.filter((p) => p.startsWith("cursors/"))).toEqual([`cursors/${w.hostB.principal}.json`]);
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
