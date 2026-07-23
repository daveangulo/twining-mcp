/**
 * Project-root resolution (#46): --project arg > TWINING_PROJECT env > cwd.
 *
 * TWINING_PROJECT exists so the plugin-contributed server can target a
 * shared store (e.g. a fleet of sibling repos coordinating through one
 * ../chassis/.twining) with a single version-agnostic env line in
 * .claude/settings.json — replacing the old per-repo .mcp.json override
 * plus exact-command deniedMcpServers block, which silently went inert on
 * every plugin version bump.
 *
 * Worktree awareness (blackboard finding 01KY66434W): when the cwd default
 * lands inside a linked git worktree (cwd/.git is a FILE pointing at
 * <main>/.git/worktrees/<name>), the store redirects to the main checkout
 * root — cmux --worktree teammates were each forking a private .twining
 * instead of sharing coordination state. Redirection applies ONLY to the
 * cwd-default branch: explicit --project and TWINING_PROJECT are deliberate
 * user targeting and are never redirected. Set TWINING_WORKTREE_LOCAL=true
 * to opt out and keep a worktree-local store. Submodule gitdirs
 * (".git/modules/...") never redirect. The server redirects whenever the
 * main root directory exists — its .twining may be created fresh (a
 * worktree of a twining project shares by default).
 */
import fs from "node:fs";
import path from "node:path";

/**
 * If `dir` is the root of a linked git worktree, return the main checkout
 * root; otherwise null. Pure lookup — never throws (any read/parse failure
 * yields null).
 */
export function resolveWorktreeMain(dir: string): string | null {
  try {
    const dotGit = path.join(dir, ".git");
    if (!fs.statSync(dotGit).isFile()) return null;

    const firstLine = fs.readFileSync(dotGit, "utf8").split("\n")[0] ?? "";
    if (!firstLine.startsWith("gitdir: ")) return null;
    // Paths may contain spaces — take the whole rest of the line.
    const rawGitdir = firstLine.slice("gitdir: ".length).replace(/\r$/, "");
    if (!rawGitdir) return null;

    const gitdir = path.resolve(dir, rawGitdir);

    // Only linked-worktree admin dirs (<main>/.git/worktrees/<name>)
    // redirect; submodule gitdirs (".git/modules/...") do not. Cut at the
    // LAST occurrence — admin names are single path components, so if the
    // main checkout's own path pathologically contains the marker, the last
    // occurrence is still the correct boundary.
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const markerIndex = gitdir.lastIndexOf(marker);
    if (markerIndex === -1) return null;

    const mainRoot = gitdir.slice(0, markerIndex);
    if (!mainRoot) return null;

    // Guard: redirect only when the main root directory still exists (the
    // .twining inside it may be created fresh).
    if (!fs.statSync(mainRoot).isDirectory()) return null;

    return mainRoot;
  } catch {
    return null;
  }
}

export function resolveProjectRoot(
  argv: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): string {
  // Explicit --project wins, passed through verbatim (pre-#46 contract).
  // Never worktree-redirected: it is deliberate user targeting.
  const argIndex = argv.indexOf("--project");
  if (argIndex !== -1 && argv[argIndex + 1]) {
    return argv[argIndex + 1]!;
  }

  // Env var next; relative values resolve against cwd (the repo root when
  // Claude Code spawns the server) — absolute paths recommended for
  // multi-machine setups. Never worktree-redirected either.
  const fromEnv = env["TWINING_PROJECT"];
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(cwd, fromEnv);
  }

  // cwd default: redirect linked worktrees to the main checkout root unless
  // the user opted out with TWINING_WORKTREE_LOCAL=true.
  if (env["TWINING_WORKTREE_LOCAL"] === "true") {
    return cwd;
  }
  return resolveWorktreeMain(cwd) ?? cwd;
}
