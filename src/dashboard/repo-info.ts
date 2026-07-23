/**
 * Best-effort repo remote info for render-time link derivation
 * (TRIAGE-SPEC §8): the dashboard derives remote doc links at render time
 * instead of ever rewriting stored entries. Links may not exist until the
 * branch is pushed — the local raw link is the authoritative one.
 */
import { execFileSync } from "node:child_process";

export interface RepoInfo {
  web_url: string | null;
  branch: string | null;
}

/** Normalize a git remote URL to a browsable https URL, or null. */
export function remoteToWebUrl(remote: string | null): string | null {
  if (!remote) return null;
  const ssh = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = remote.match(/^https?:\/\/(.+?)(?:\.git)?$/);
  if (https) return `https://${https[1]}`;
  return null;
}

export function computeRepoInfo(projectRoot: string): RepoInfo {
  const run = (args: string[]): string | null => {
    try {
      const out = execFileSync("git", args, {
        cwd: projectRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      }).trim();
      return out || null;
    } catch {
      return null;
    }
  };
  return {
    web_url: remoteToWebUrl(run(["remote", "get-url", "origin"])),
    branch: run(["rev-parse", "--abbrev-ref", "HEAD"]),
  };
}
