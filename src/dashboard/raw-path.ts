/**
 * Path resolution for the read-only raw-file route (TRIAGE-SPEC §8).
 * Root-jailed: repo-relative paths only; dotted segments denied (blocks
 * .git, .twining, dotfiles); symlink escapes rejected by realpath
 * containment; files only.
 */
import fs from "node:fs";
import path from "node:path";

export const RAW_FILE_MAX_BYTES = 1_000_000;

/**
 * Resolve a repo-relative path to a real absolute file path, or null when
 * denied for any reason (traversal, dotted segment, symlink escape, missing,
 * not a regular file). Callers treat null as 404 — deny reasons are not
 * distinguished to the client.
 */
export function resolveRawPath(projectRoot: string, rel: string): string | null {
  if (typeof rel !== "string" || rel.length === 0 || rel.length > 1024) return null;
  if (path.isAbsolute(rel) || rel.includes("\\") || rel.includes("\0")) return null;
  const segments = rel.split("/");
  if (segments.some((s) => s === "" || s.startsWith("."))) return null;

  let rootReal: string;
  let real: string;
  try {
    rootReal = fs.realpathSync(projectRoot);
    real = fs.realpathSync(path.resolve(rootReal, rel));
  } catch {
    return null;
  }
  if (!real.startsWith(rootReal + path.sep)) return null;
  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return real;
}
