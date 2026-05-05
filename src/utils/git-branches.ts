import { execFileSync } from "node:child_process";

/**
 * Returns the local branch set, or `null` when enumeration fails (git absent,
 * non-repo, or `for-each-ref` errors). The `null` sentinel lets callers
 * distinguish "we can't check" from "the repo legitimately has no branches".
 */
export function listLocalBranches(projectRoot: string): Set<string> | null {
  try {
    const out = execFileSync(
      "git",
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      {
        cwd: projectRoot,
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return new Set(
      out
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return null;
  }
}
