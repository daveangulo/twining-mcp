/**
 * Git source connector — volatile facts and refusal-by-default.
 *
 * Real git, real repos, no network: the remote is another directory on disk,
 * which `git ls-remote` reaches exactly as it reaches a URL. That keeps the
 * test honest (a real remote check really runs) without making it depend on
 * the internet.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  checkPullRequestRange,
  checkRemoteHead,
  checkRemoteRef,
  recordObservation,
  requalify,
} from "../../src/adapters/connectors/git.js";
import { makeFixture, runtimeFor, type Fixture } from "./helpers.js";

let fx: Fixture;
let remote: string;
let clone: string;

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeEach(() => {
  fx = makeFixture("twining-gitconn-");
  remote = path.join(fx.projectRoot, "..", "remote.git");
  clone = path.join(fx.projectRoot, "..", "clone");
  fs.mkdirSync(remote, { recursive: true });
  git(["init", "--bare", "--initial-branch=main"], remote);
  fs.mkdirSync(clone, { recursive: true });
  git(["init", "--initial-branch=main"], clone);
  fs.writeFileSync(path.join(clone, "a.txt"), "one\n");
  git(["add", "a.txt"], clone);
  git(["commit", "-m", "one"], clone);
  git(["remote", "add", "origin", remote], clone);
  git(["push", "origin", "main"], clone);
});
afterEach(() => {
  fx.cleanup();
});

describe("checks record the method that produced the answer", () => {
  it("a present remote ref reports its sha and the command that found it", () => {
    const head = git(["rev-parse", "HEAD"], clone);
    const check = checkRemoteHead(clone, remote, "main");
    expect(check.ok).toBe(true);
    expect(check.result.head).toBe(head);
    expect(check.check_method).toContain("git ls-remote");
  });

  it("an absent ref is `unknown`, not `false` — absence of proof is not proof of absence", () => {
    const check = checkRemoteRef(clone, remote, "refs/heads/does-not-exist");
    expect(check.ok).toBe(false);
    expect(check.result.exists).toBe("unknown");
    expect(check.check_method).toContain("git ls-remote");
  });

  it("an unreachable remote is an unknown answer with the attempted command named", () => {
    const check = checkRemoteHead(clone, path.join(fx.projectRoot, "..", "no-such-remote.git"), "main");
    expect(check.ok).toBe(false);
    expect(check.error).toBeTruthy();
    expect(check.check_method).toContain("git ls-remote");
  });

  it("a missing `gh` is an unknown PR state, never a missing PR", () => {
    // Whether gh exists on this machine or not, an unsuccessful call must
    // report `state: unknown` rather than concluding anything about the PR.
    const check = checkPullRequestRange(clone, "nonexistent/repo-that-does-not-exist", 999999);
    if (!check.ok) {
      expect(check.result.state).toBe("unknown");
      expect(check.check_method).toContain("gh pr view");
    }
  });
});

describe("observations", () => {
  it("a successful check is a verified_observation marked volatile", async () => {
    const runtime = runtimeFor(fx);
    const ev = await recordObservation(runtime, checkRemoteHead(clone, remote, "main"), {
      sourceKind: "branch",
      sourceUri: remote,
    });
    expect(ev!.evidence_class).toBe("verified_observation");
    const p = ev!.payload as Record<string, unknown>;
    expect(p.volatile).toBe(true);
    expect(p.check_method).toContain("git ls-remote");
    expect(p.observed_at).toBeTruthy();
    runtime.close();
  });

  it("a FAILED check is still recorded — as a question, never as a verified observation", async () => {
    const runtime = runtimeFor(fx);
    const ev = await recordObservation(runtime, checkRemoteHead(clone, "/nope.git", "main"), { sourceKind: "branch" });
    expect(ev!.evidence_class).toBe("question");
    expect((ev!.payload as { result: Record<string, unknown> }).result.observed).toBe(false);
    runtime.close();
  });
});

describe("requalification refuses by default", () => {
  it("qualifies against a live check that just ran", async () => {
    const runtime = runtimeFor(fx);
    const head = git(["rev-parse", "HEAD"], clone);
    const q = await requalify(runtime, () => checkRemoteHead(clone, remote, "main"), { expect: { head } });
    expect(q.qualified).toBe(true);
    if (q.qualified) expect(q.observation).toBeTruthy();
    runtime.close();
  });

  it("refuses with `changed` when the remote moved under the caller's belief", async () => {
    const runtime = runtimeFor(fx);
    const stale = git(["rev-parse", "HEAD"], clone);
    fs.writeFileSync(path.join(clone, "b.txt"), "two\n");
    git(["add", "b.txt"], clone);
    git(["commit", "-m", "two"], clone);
    git(["push", "origin", "main"], clone);

    const q = await requalify(runtime, () => checkRemoteHead(clone, remote, "main"), { expect: { head: stale } });
    expect(q.qualified).toBe(false);
    if (!q.qualified) {
      expect(q.reason).toBe("changed");
      expect(q.detail).toContain("head is");
    }
    runtime.close();
  });

  it("refuses with `not_recorded` when the check ran but nothing durable was persisted", async () => {
    // A 2.x store persists no observation, so there is nothing to cite. The
    // earlier version returned qualified:true with a placeholder string in the
    // `observation` field — an unverifiable claim dressed as evidence.
    const legacy = makeFixture("twining-gitconn-2x-", { v3: false });
    try {
      const runtime = runtimeFor(legacy);
      const q = await requalify(runtime, () => checkRemoteHead(clone, remote, "main"));
      expect(q.qualified).toBe(false);
      if (!q.qualified) {
        expect(q.reason).toBe("not_recorded");
        expect(q.detail).toMatch(/no durable evidence/);
      }
      runtime.close();
    } finally {
      legacy.cleanup();
    }
  });

  it("refuses with `unreachable` rather than serving the last known answer", async () => {
    const runtime = runtimeFor(fx);
    // Observe successfully first, so a cached answer genuinely exists.
    await recordObservation(runtime, checkRemoteHead(clone, remote, "main"), { sourceKind: "branch" });

    const q = await requalify(runtime, () => checkRemoteHead(clone, "/gone.git", "main"));
    expect(q.qualified).toBe(false);
    if (!q.qualified) {
      expect(q.reason).toBe("unreachable");
      // The refusal must say WHY, in terms a consumer can act on.
      expect(q.detail).toMatch(/does not know the present state/);
      expect(q.detail).toMatch(/will not assume the last one it saw/);
    }
    runtime.close();
  });
});
