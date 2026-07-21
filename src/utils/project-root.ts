/**
 * Project-root resolution (#46): --project arg > TWINING_PROJECT env > cwd.
 *
 * TWINING_PROJECT exists so the plugin-contributed server can target a
 * shared store (e.g. a fleet of sibling repos coordinating through one
 * ../chassis/.twining) with a single version-agnostic env line in
 * .claude/settings.json — replacing the old per-repo .mcp.json override
 * plus exact-command deniedMcpServers block, which silently went inert on
 * every plugin version bump.
 */
import path from "node:path";

export function resolveProjectRoot(
  argv: string[],
  env: Record<string, string | undefined>,
  cwd: string,
): string {
  // Explicit --project wins, passed through verbatim (pre-#46 contract).
  const argIndex = argv.indexOf("--project");
  if (argIndex !== -1 && argv[argIndex + 1]) {
    return argv[argIndex + 1]!;
  }

  // Env var next; relative values resolve against cwd (the repo root when
  // Claude Code spawns the server) — absolute paths recommended for
  // multi-machine setups.
  const fromEnv = env["TWINING_PROJECT"];
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(cwd, fromEnv);
  }

  return cwd;
}
