import { spawnSync } from "node:child_process";
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
