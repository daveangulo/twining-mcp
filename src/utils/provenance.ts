import { execFileSync } from "node:child_process";

/**
 * Recording provenance — captured synchronously at write time so blackboard
 * entries and decisions know which branch / commit they were recorded against.
 * Used by the staleness detector to flag entries originating from
 * deleted/merged branches or stale repo states. All git fields optional —
 * non-git directories and detached HEAD states leave them undefined.
 */
export interface Provenance {
  recorded_at: string;
  branch?: string;
  commit_sha?: string;
}

export function captureProvenance(projectRoot: string | null | undefined): Provenance {
  const recorded_at = new Date().toISOString();
  if (!projectRoot) return { recorded_at };

  const result: Provenance = { recorded_at };
  const branch = safeGit(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && branch !== "HEAD") result.branch = branch;
  const commit_sha = safeGit(projectRoot, ["rev-parse", "HEAD"]);
  if (commit_sha) result.commit_sha = commit_sha;
  return result;
}

function safeGit(cwd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}
