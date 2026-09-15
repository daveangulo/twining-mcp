/**
 * `twining hook <host> <Event>` — the CLI front end the shell hooks shim to.
 *
 * STDOUT CONTRACT, and it is different from every other CLI verb: this one
 * prints the HOST's JSON, not Twining's envelope, because the host parses
 * stdout. Nothing else may appear there — diagnostics go to stderr.
 *
 * EXIT CONTRACT: always 0. A memory layer that breaks the user's turn because
 * its own store was unwritable has made itself the problem. Every failure path
 * here degrades to "print nothing, say why on stderr".
 *
 * Why the logic is here and not in bash: a hook has to parse JSON, hash bytes,
 * sign an event and emit JSON. Bash can do the first and last badly and the
 * middle two not at all — and the two hook defects this project has already
 * shipped were both bash string handling. The shell script's whole job is now
 * "find the CLI, pipe stdin through it, never fail".
 */
import fs from "node:fs";

import { handleClaudeCodeHook, type ClaudeHookInput } from "../adapters/claude-code.js";
import { handleCodexHook } from "../adapters/codex.js";
import { openRuntime } from "../adapters/runtime.js";
import { sourceCwdFromHook } from "../adapters/source.js";
import type { HookOutcome } from "../adapters/claude-code.js";

export const HOOK_HOSTS = ["claude-code", "codex"] as const;
export type HookHost = (typeof HOOK_HOSTS)[number];

export interface HookVerbResult {
  /** Raw text for stdout — usually the host's JSON response, or "". */
  stdout: string;
  exitCode: 0;
  /** Diagnostics for stderr. */
  stderr: string;
  /** Exposed for tests: what the adapter actually did. */
  outcome?: HookOutcome;
}

function readStdin(): string {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

/**
 * `legacyGateText` is the 2.x SessionStart instruction block. It is passed
 * through ONLY when the store is not v3-enabled — on a v3 store the injected
 * payload must carry no prose reminder at all (C15 A2-NO-PROSE), because
 * capture that depends on nagging the model is not capture.
 */
export async function runHookVerb(
  args: string[],
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  opts: { stdin?: string; legacyGateText?: string } = {},
): Promise<HookVerbResult> {
  const host = args[0];
  const event = args[1];
  if (!host || !event || !(HOOK_HOSTS as readonly string[]).includes(host)) {
    return {
      stdout: "",
      exitCode: 0,
      stderr: `twining hook: usage: twining hook <${HOOK_HOSTS.join("|")}> <EventName>\n`,
    };
  }

  const raw = opts.stdin ?? readStdin();
  let input: ClaudeHookInput;
  try {
    input = raw.trim().length > 0 ? (JSON.parse(raw) as ClaudeHookInput) : {};
  } catch (e) {
    return {
      stdout: "",
      exitCode: 0,
      stderr: `twining hook: could not parse the host's JSON on stdin (${e instanceof Error ? e.message : String(e)})\n`,
    };
  }

  // Provenance comes from the HOOK's cwd — the producing worktree — never from
  // the resolved store root. This is the flip of baseline gap 4.
  const sourceCwd = sourceCwdFromHook(input, projectRoot);

  let runtime;
  try {
    runtime = openRuntime({
      projectRoot,
      sourceCwd,
      env,
      ...(input.agent_id ? { assertedActor: input.agent_id } : {}),
    });
  } catch (e) {
    return {
      stdout: "",
      exitCode: 0,
      stderr: `twining hook: could not open the store (${e instanceof Error ? e.message : String(e)}); nothing captured\n`,
    };
  }

  try {
    const deps = {
      runtime,
      ingress: "adapter" as const,
      ...(opts.legacyGateText ? { legacyGateText: opts.legacyGateText } : {}),
    };
    const outcome =
      host === "codex"
        ? await handleCodexHook(event, input as Record<string, unknown>, deps)
        : await handleClaudeCodeHook(event, input, deps);

    const stderr = outcome.notes.length > 0 ? outcome.notes.map((n) => `[twining] ${n}\n`).join("") : "";
    return { stdout: outcome.stdout, exitCode: 0, stderr, outcome };
  } catch (e) {
    return {
      stdout: "",
      exitCode: 0,
      stderr: `twining hook: ${event} failed (non-fatal): ${e instanceof Error ? e.message : String(e)}\n`,
      };
  } finally {
    runtime.close();
  }
}
