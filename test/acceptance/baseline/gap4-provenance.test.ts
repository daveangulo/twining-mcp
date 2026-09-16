/**
 * Gap 4 — provenance is captured against the resolved project root, not the
 * working checkout (requirements R01, R02, R12).
 *
 * The server resolves a linked git worktree's cwd to the MAIN checkout root
 * (src/utils/project-root.ts, resolveWorktreeMain — so worktree teammates
 * share one .twining store), then hands that resolved root to
 * captureProvenance (src/utils/provenance.ts), which shells out to
 * `git rev-parse` with cwd = the resolved root. Consequence: every record
 * written from a worktree on branch "feature-x" is stamped with the main
 * checkout's branch and commit sha. Provenance therefore describes the store
 * location, not the code the agent was actually working on.
 *
 * Positive control: captureProvenance(worktreePath) — the same function, the
 * same repo, just the unresolved path — does report "feature-x" and the
 * worktree's own sha. That proves the instrument (temp repo, worktree, git
 * plumbing, assertions) works and isolates the defect to which path the
 * server passes in.
 *
 * Setup idioms mirror test/project-root.test.ts (real git repos under
 * mkdtemp, realpathSync for darwin's /var -> /private/var symlink).
 *
 * FLIPPED BY LANE 03 (runtime integration, 2026-09-15). The 2.x defect is
 * preserved verbatim below as a control — captureProvenance(resolvedRoot) does
 * still stamp the main checkout, because the 2.x write path is untouched. The
 * flip is that v3 no longer captures provenance that way at all: `source` is
 * a separate field captured by src/adapters/source.ts against the PRODUCING
 * checkout (a hook's own cwd), while the store location stays a property of
 * the store. ADR §3: "store_id says where the bytes live; source.repo /
 * worktree / commit say where the producer was working. They are recorded
 * separately and never inferred from one another."
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveProjectRoot, resolveWorktreeMain } from "../../../src/utils/project-root.js";
import { captureProvenance } from "../../../src/utils/provenance.js";
import { captureSource } from "../../../src/adapters/source.js";
import { ensureStoreDescriptor } from "../../../src/adapters/identity.js";
import { openRuntime } from "../../../src/adapters/runtime.js";
import { STORE_FORMAT_VERSION } from "../../../src/contracts/index.js";

describe("gap 4 — provenance follows the resolved root, not the worktree", () => {
  let tmpDir: string;

  function git(args: string[], cwd: string): void {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
  }

  function gitOut(args: string[], cwd: string): string {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  }

  /**
   * Real repo with one commit on its default branch, plus a linked worktree
   * on branch "feature-x" carrying its own extra commit.
   */
  function makeRepoWithFeatureWorktree(): {
    main: string;
    worktree: string;
    mainBranch: string;
    mainSha: string;
    featureSha: string;
  } {
    const main = path.join(tmpDir, "main");
    const worktree = path.join(tmpDir, "wt");
    fs.mkdirSync(main);
    git(["init"], main);
    git(
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      main,
    );
    git(["worktree", "add", "-b", "feature-x", worktree], main);
    fs.writeFileSync(path.join(worktree, "feature.txt"), "feature work\n");
    git(["add", "feature.txt"], worktree);
    git(
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "feature-x work"],
      worktree,
    );
    return {
      main,
      worktree,
      mainBranch: gitOut(["rev-parse", "--abbrev-ref", "HEAD"], main),
      mainSha: gitOut(["rev-parse", "HEAD"], main),
      featureSha: gitOut(["rev-parse", "HEAD"], worktree),
    };
  }

  beforeEach(() => {
    // realpath: on darwin os.tmpdir() is /var/... which symlinks to
    // /private/var/... — git resolves symlinks, so match it up front.
    tmpDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "twining-gap4-")),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("fixture sanity: worktree really is on feature-x with its own commit", () => {
    const { main, worktree, mainBranch, mainSha, featureSha } =
      makeRepoWithFeatureWorktree();
    expect(gitOut(["rev-parse", "--abbrev-ref", "HEAD"], worktree)).toBe("feature-x");
    expect(mainBranch).not.toBe("feature-x");
    expect(featureSha).not.toBe(mainSha);
    // The server's resolution really does redirect to the main checkout.
    expect(resolveWorktreeMain(worktree)).toBe(main);
    expect(resolveProjectRoot([], {}, worktree)).toBe(main);
  });

  it("POSITIVE CONTROL: captureProvenance(worktreePath) reports feature-x and its own sha", () => {
    const { worktree, featureSha } = makeRepoWithFeatureWorktree();

    const prov = captureProvenance(worktree);

    expect(prov.recorded_at).toBeTypeOf("string");
    expect(prov.branch).toBe("feature-x");
    expect(prov.commit_sha).toBe(featureSha);
  });

  it("CONTROL (lane 03): the 2.x path still stamps the MAIN checkout — unchanged on purpose", () => {
    const { main, worktree, mainBranch, mainSha, featureSha } =
      makeRepoWithFeatureWorktree();

    // Exactly what the server does: resolve the project root from the
    // worktree cwd, then capture provenance against that resolved root.
    const resolvedRoot = resolveProjectRoot([], {}, worktree);
    expect(resolvedRoot).toBe(main);

    const prov = captureProvenance(resolvedRoot);

    // The defect, asserted positively: provenance describes the main
    // checkout, not the worktree the agent is actually working in.
    expect(prov.branch).toBe(mainBranch);
    expect(prov.commit_sha).toBe(mainSha);

    // ...and therefore does NOT describe feature-x. This is the 2.x behavior,
    // kept intact: the v3 path below does not use captureProvenance at all.
    expect(prov.branch).not.toBe("feature-x");
    expect(prov.commit_sha).not.toBe(featureSha);
  });

  it("CLOSED (lane 03): the v3 adapter captures `source` from the PRODUCING worktree", () => {
    const { main, worktree, mainBranch, mainSha, featureSha } =
      makeRepoWithFeatureWorktree();

    // Exactly what a hook does: the store is resolved as before (main), and
    // the producing checkout is the hook's own cwd (the worktree).
    const resolvedRoot = resolveProjectRoot([], {}, worktree);
    expect(resolvedRoot).toBe(main);

    const source = captureSource(worktree, "r_01ARZ3NDEKTSV4RRFFQ69G5FAV");

    // THE FLIP — provenance now describes the code being worked on.
    expect(source.branch).toBe("feature-x");
    expect(source.commit).toBe(featureSha);
    expect(source.branch).not.toBe(mainBranch);
    expect(source.commit).not.toBe(mainSha);

    // And the two checkouts are distinguishable without either PATH appearing
    // in the event: a worktree token is a hash, because a path is a label (R01).
    const mainSource = captureSource(main, "r_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(source.worktree).toBeTruthy();
    expect(mainSource.worktree).toBeTruthy();
    expect(source.worktree).not.toBe(mainSource.worktree);
    expect(JSON.stringify(source)).not.toContain(worktree);
  });

  it("CLOSED (lane 03): a runtime opened for the main store still sources from the hook's cwd", () => {
    const { main, worktree, featureSha } = makeRepoWithFeatureWorktree();
    const identityHome = path.join(tmpDir, "identity");
    fs.mkdirSync(identityHome, { recursive: true });
    fs.mkdirSync(path.join(main, ".twining"), { recursive: true });
    ensureStoreDescriptor(path.join(main, ".twining"), { format: STORE_FORMAT_VERSION });

    // The store binds to the MAIN checkout (worktree teammates share one
    // store, as before) while `source` describes the worktree — the exact
    // split the gap said did not exist.
    const runtime = openRuntime({
      projectRoot: main,
      sourceCwd: worktree,
      env: { ...process.env, HOME: tmpDir, TWINING_IDENTITY_HOME: identityHome },
    });
    try {
      expect(runtime.twiningDir).toBe(path.join(main, ".twining"));
      expect(runtime.source.branch).toBe("feature-x");
      expect(runtime.source.commit).toBe(featureSha);
      expect(runtime.storeId).toMatch(/^s_/);
    } finally {
      runtime.close();
    }
  });
});
