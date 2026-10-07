/**
 * `source` — the PRODUCING checkout (ADR §1.2, gap 4, R01/R02/R12).
 *
 * Baseline gap 4: the 2.x server resolved a linked worktree's cwd to the MAIN
 * checkout (so worktree teammates share one store) and then captured
 * provenance against THAT path, so every record written from a worktree on
 * `feature-x` was stamped with the main checkout's branch and sha. Provenance
 * described where the store lived, not the code being worked on.
 *
 * v3 splits the two on purpose: `store_id` (identity.ts) says where the bytes
 * live; `source` says where the producer was standing. This module only ever
 * reads git in the cwd it is HANDED, never in a resolved store root — that is
 * the flip.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { worktreeToken } from "./identity.js";

export interface SourceInfo {
  repo?: string;
  worktree?: string;
  branch?: string;
  commit?: string;
  dirty?: boolean;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Capture `source` from the directory the producer is actually working in.
 *
 * `repoId` is passed in (it comes from the store descriptor, never from the
 * remote URL — a URL is a label). `worktree` is a token over the realpath of
 * the git top level, so a linked worktree and its main checkout are
 * distinguishable without either path appearing in the event.
 */
export function captureSource(cwd: string, repoId?: string): SourceInfo {
  const info: SourceInfo = {};
  if (repoId) info.repo = repoId;

  let top: string | undefined;
  try {
    top = git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    top = undefined;
  }
  if (!top) {
    // Not a git checkout: the worktree token still identifies the directory,
    // which is more than 2.x recorded, and the git fields stay absent rather
    // than being guessed.
    if (fs.existsSync(cwd)) info.worktree = worktreeToken(cwd);
    return info;
  }

  info.worktree = worktreeToken(top);
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && branch !== "HEAD") info.branch = branch;
  const commit = git(cwd, ["rev-parse", "HEAD"]);
  if (commit && /^[0-9a-f]{40}$/.test(commit)) info.commit = commit;
  const status = git(cwd, ["status", "--porcelain"]);
  info.dirty = status !== undefined && status.length > 0;
  return info;
}

/**
 * The directory a hook was fired in. Claude Code and Codex both deliver `cwd`
 * on every hook event; it is the producing worktree, which is exactly what
 * `source` wants and exactly what the resolved store root is not.
 */
export function sourceCwdFromHook(hookInput: { cwd?: unknown }, fallback: string): string {
  const cwd = hookInput.cwd;
  if (typeof cwd === "string" && cwd.length > 0 && fs.existsSync(cwd)) return path.resolve(cwd);
  return fallback;
}
