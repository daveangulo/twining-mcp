/**
 * The minimum git plumbing the exchange carrier needs (ADR §8.2).
 *
 * Kept apart from `git-transport.ts` so the transport reads as policy and this
 * reads as mechanism, and so the non-interference rule is enforceable in ONE
 * place: every invocation names its own working directory explicitly and runs
 * with a sanitized environment, so an inherited `GIT_DIR`/`GIT_WORK_TREE` from
 * the caller's shell can never redirect a command at the user's checkout.
 *
 * Nothing here is ever run by the MCP server: `twining sync` is an explicit
 * CLI verb (ADR §8.2, §0).
 */
import { spawnSync } from "node:child_process";

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = "GitError";
  }
}

/**
 * Environment for every git invocation.
 *
 * - `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE` are stripped: an inherited value
 *   would silently retarget a command at whatever repository the caller's shell
 *   was pointing at, which is precisely the R09 non-interference failure.
 * - hooks and signing are off: publishing must never run someone's pre-commit
 *   hook or block on a GPG passphrase.
 * - identity is fixed so a machine commit does not depend on user config
 *   (and so a repo with no user.email configured still works).
 */
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR", "GIT_CONFIG"]) {
    delete env[k];
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "echo",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "twining",
    GIT_AUTHOR_EMAIL: "twining@localhost",
    GIT_COMMITTER_NAME: "twining",
    GIT_COMMITTER_EMAIL: "twining@localhost",
    ...extra,
  };
}

export function gitTry(cwd: string, args: string[], input?: string): GitResult {
  const r = spawnSync("git", ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
    ...(input === undefined ? {} : { input }),
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

export function git(cwd: string, args: string[], input?: string): string {
  const r = gitTry(cwd, args, input);
  if (r.status !== 0) throw new GitError(args, r);
  return r.stdout;
}

export function isGitRepo(dir: string): boolean {
  return gitTry(dir, ["rev-parse", "--git-dir"]).status === 0;
}

export function revParse(cwd: string, rev: string): string | null {
  const r = gitTry(cwd, ["rev-parse", "--quiet", "--verify", `${rev}^{commit}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Is `ancestor` reachable from `descendant`? False when either is unknown. */
export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return gitTry(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).status === 0;
}

export interface TreeEntry {
  path: string;
  oid: string;
}

/** Every blob in a commit's tree, as (path, oid). The union invariant is checked over this. */
export function treeEntries(cwd: string, commit: string): TreeEntry[] {
  const out = gitTry(cwd, ["ls-tree", "-r", "--full-tree", "-z", commit]);
  if (out.status !== 0) return [];
  return out.stdout
    .split("\0")
    .filter((l) => l !== "")
    .map((line) => {
      // "<mode> <type> <oid>\t<path>"
      const tab = line.indexOf("\t");
      const meta = line.slice(0, tab).split(/\s+/);
      return { path: line.slice(tab + 1), oid: meta[2] ?? "" };
    })
    .filter((e) => e.oid !== "");
}

/** Paths ADDED or MODIFIED by a single commit (its first-parent diff). */
export function commitPaths(cwd: string, sha: string): string[] {
  const r = gitTry(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "-z", sha]);
  if (r.status !== 0) return [];
  return r.stdout.split("\0").filter((p) => p !== "");
}

export function showBlob(cwd: string, commit: string, relPath: string): string | null {
  const r = gitTry(cwd, ["show", `${commit}:${relPath}`]);
  return r.status === 0 ? r.stdout : null;
}

/** Commits from `from` (exclusive) to `to` (inclusive), oldest first. */
export function revListRange(cwd: string, from: string | null, to: string): string[] {
  const spec = from ? `${from}..${to}` : to;
  const r = gitTry(cwd, ["rev-list", "--reverse", spec]);
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter((l) => l.trim() !== "");
}

/**
 * Create a branch pointing at an EMPTY root commit (an orphan history) without
 * checking anything out. `git worktree add --orphan` exists only on newer git,
 * and `checkout --orphan` inside a freshly added worktree would first
 * materialize the source tree — which is exactly the interference we forbid.
 */
export function createOrphanBranch(repoDir: string, branch: string, message: string): string {
  const empty = git(repoDir, ["mktree"], "").trim();
  const commit = git(repoDir, ["commit-tree", empty, "-m", message]).trim();
  git(repoDir, ["update-ref", `refs/heads/${branch}`, commit]);
  return commit;
}
