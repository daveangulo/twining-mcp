import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface HookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunHookOptions {
  /** Hook script filename relative to plugin/hooks/, e.g. "stop-hook.sh" */
  script: string;
  /** JSON to pipe in via stdin. Pass undefined for empty stdin. */
  stdin?: string;
  /** Extra env vars to set. PATH and HOME are inherited. */
  env?: Record<string, string>;
  /** CWD to spawn the hook from. Defaults to a tmp dir created by the caller. */
  cwd?: string;
}

const HOOK_DIR = path.resolve(__dirname, "..", "..", "plugin", "hooks");

export interface WorktreeFixture {
  /** Tmp root containing main/ (and wt/ as a sibling unless nested). */
  root: string;
  /** Main checkout root — has .git/worktrees/<name>/ (and .twining/ by default). */
  main: string;
  /** Linked worktree root — .git is a FILE pointing at main's admin dir. */
  wt: string;
  cleanup: () => void;
}

export interface WorktreeFixtureOptions {
  /**
   * Place the worktree INSIDE the main checkout (main/wts/feat) — the layout
   * `git worktree add ./wts/feat` produces — instead of as a sibling. A naive
   * walk-up from a nested worktree reaches the main checkout, so this layout
   * exercises the linked-worktree walk BOUNDARY.
   */
  nested?: boolean;
  /** Create main/.twining (default true). */
  mainTwining?: boolean;
}

/**
 * Fake linked-worktree layout (no git binary needed): a main checkout with a
 * .twining store plus the .git/worktrees/<name> admin dir, and a worktree
 * (sibling by default, nested inside main with `nested: true`) whose .git is
 * a regular FILE with a "gitdir: <abs path>" line — exactly what the hooks'
 * worktree redirect parses. The worktree has no .twining of its own unless
 * the caller creates one.
 */
export function makeWorktreeFixture(
  prefix: string,
  opts: WorktreeFixtureOptions = {},
): WorktreeFixture {
  const { nested = false, mainTwining = true } = opts;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const main = path.join(root, "main");
  const name = nested ? "feat" : "wt";
  const wt = nested ? path.join(main, "wts", "feat") : path.join(root, "wt");
  if (mainTwining) {
    fs.mkdirSync(path.join(main, ".twining"), { recursive: true });
  }
  fs.mkdirSync(path.join(main, ".git", "worktrees", name), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(
    path.join(wt, ".git"),
    `gitdir: ${path.join(main, ".git", "worktrees", name)}\n`,
  );
  return {
    root,
    main,
    wt,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

export function runHook(opts: RunHookOptions): HookResult {
  const scriptPath = path.join(HOOK_DIR, opts.script);
  const result = spawnSync("bash", [scriptPath], {
    cwd: opts.cwd ?? process.cwd(),
    input: opts.stdin ?? "",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...opts.env },
    encoding: "utf8",
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
