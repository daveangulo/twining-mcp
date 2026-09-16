/**
 * Real-git fixtures for the exchange carrier tests.
 *
 * Disposable bare repositories stand in for remotes (no network, no
 * credentials); the "user's source checkout" is a real working tree with real
 * commits, a real index and — in the non-interference fixtures — real dirt.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { git, gitTry } from "../../src/exchange/git.js";

let roots: string[] = [];

export function gitTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `twining-git-${prefix}-`));
  roots.push(dir);
  return dir;
}

export function cleanupGitTempDirs(): void {
  for (const dir of roots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  roots = [];
}

/** A bare repository that plays the remote. */
export function bareRemote(name = "remote"): string {
  const dir = gitTempDir(name);
  git(dir, ["init", "--bare", "--initial-branch=main", "."]);
  return dir;
}

export interface SourceCheckout {
  /** The user's working tree. */
  repoDir: string;
  /** `<repoDir>/.twining` — the store directory, gitignored in the source repo. */
  twiningDir: string;
}

/**
 * A source checkout with one commit, `.twining/` gitignored (so the store and
 * its exchange worktree are invisible to the user's `git status`), and the
 * store directory created.
 */
export function sourceCheckout(name = "src"): SourceCheckout {
  const repoDir = gitTempDir(name);
  git(repoDir, ["init", "--initial-branch=main", "."]);
  git(repoDir, ["config", "user.name", "Dev"]);
  git(repoDir, ["config", "user.email", "dev@localhost"]);
  fs.writeFileSync(path.join(repoDir, ".gitignore"), ".twining/\n");
  fs.mkdirSync(path.join(repoDir, "src", "pay"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "pay", "settle.ts"), "export const retries = 3;\n");
  git(repoDir, ["add", "-A"]);
  git(repoDir, ["commit", "--no-verify", "-m", "initial"]);
  const twiningDir = path.join(repoDir, ".twining");
  fs.mkdirSync(twiningDir, { recursive: true });
  return { repoDir, twiningDir };
}

/** Modified tracked file + untracked file + a staged-but-uncommitted change. */
export function dirtyTheCheckout(repoDir: string): void {
  fs.writeFileSync(path.join(repoDir, "src", "pay", "settle.ts"), "export const retries = 5; // work in progress\n");
  fs.writeFileSync(path.join(repoDir, "scratch.md"), "notes I have not committed\n");
  fs.mkdirSync(path.join(repoDir, "src", "ledger"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "ledger", "post.ts"), "export const staged = true;\n");
  git(repoDir, ["add", "--", "src/ledger/post.ts"]);
}

export interface CheckoutFingerprint {
  head: string;
  branch: string;
  /** `git ls-files -s`: mode, blob oid, stage and path for every index entry. */
  index: string;
  status: string;
  /** sha256 over every working-tree file outside .git/ and .twining/. */
  worktree: string;
  /** Commits on the user's own branch — a publish must add none. */
  commits: string;
}

/**
 * Everything about the user's checkout that a carrier must not move.
 *
 * `.git/worktrees/<name>` and `refs/heads/twining/exchange` are DELIBERATELY
 * excluded: adding a linked worktree and its orphan ref is the carrier doing
 * its declared job, and neither is part of the user's checkout. HEAD, the
 * index, the working files and the user's branch history are.
 */
export function fingerprintCheckout(repoDir: string): CheckoutFingerprint {
  const hash = createHash("sha256");
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === ".git" || entry.name === ".twining") continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else hash.update(`${rel}\0`).update(fs.readFileSync(abs)).update("\0");
    }
  };
  walk(repoDir, "");
  return {
    head: git(repoDir, ["rev-parse", "HEAD"]).trim(),
    branch: git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
    index: git(repoDir, ["ls-files", "-s"]),
    status: git(repoDir, ["status", "--porcelain=v1", "-uall"]),
    worktree: hash.digest("hex"),
    commits: gitTry(repoDir, ["log", "--format=%H %s", "HEAD"]).stdout,
  };
}
