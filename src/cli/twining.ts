#!/usr/bin/env node
/**
 * The `twining` CLI (2.17.0) — every Twining command from a shell.
 *
 * Why it exists: an agent host that cannot whitelist an MCP server (Codex
 * sandboxes: no network, a plugin cannot put anything on PATH, enterprise
 * allowlists match exact command identity) still has a shell. The CLI runs
 * the SAME command core the MCP server runs (src/core/commands/*), over the
 * SAME store resolution (src/utils/project-root.ts), so behavior does not
 * fork between the two front ends.
 *
 * Contract:
 *   stdout  exactly one JSON envelope, newline-terminated, and nothing else
 *   stderr  every diagnostic (store warnings, ingest lines, fallback notices)
 *   exit 0  the command succeeded
 *   exit 1  the command ran and failed (error.code carries the reason)
 *   exit 2  the invocation was wrong: usage, unknown command, unparseable or
 *           schema-invalid input
 *
 * `--version` and `--help` print plain text, not an envelope: they describe
 * the binary rather than invoking a command. Machine-readable version and
 * command metadata live in `twining capabilities`, which IS an envelope.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { PKG_VERSION } from "../version.js";
import { resolveProjectRoot } from "../utils/project-root.js";
import { commandRegistry } from "../core/commands.js";
import { createTwiningContext } from "../core/context.js";
import { mapCommandError, type CommandDef } from "../core/command-def.js";
import type { TwiningContext } from "../core/context.js";
import { classifyCliArgv, TWINING_CLI_USAGE } from "./dispatch.js";

/** Bumped only when the envelope shape changes incompatibly. */
export const CLI_SCHEMA_VERSION = "1";

interface OkEnvelope {
  ok: true;
  schema_version: string;
  server_version: string;
  command: string;
  /** Absolute — which store this call actually read and wrote. Reported on
   *  every success because the linked-worktree redirect (a cwd-default call
   *  inside a worktree targets the MAIN checkout's store) is otherwise
   *  invisible on the happy path, and "wrote to the wrong store" is the one
   *  failure this CLI cannot detect for you. */
  project_root: string;
  store_dir: string;
  result: unknown;
}
interface ErrEnvelope {
  ok: false;
  schema_version: string;
  server_version: string;
  command: string | null;
  error: { code: string; message: string };
}

function writeStdout(text: string): void {
  try {
    fs.writeSync(1, text);
  } catch {
    // Closed pipe (`twining ... | head`) — nothing useful to do.
  }
}

function emitOk(
  command: string,
  store: { projectRoot: string; storeDir: string },
  result: unknown,
): void {
  const envelope: OkEnvelope = {
    ok: true,
    schema_version: CLI_SCHEMA_VERSION,
    server_version: PKG_VERSION,
    command,
    // Absolutized for REPORTING only — resolution already happened against the
    // path the caller gave, and path.resolve here never changes which store is
    // used, only how it is named back.
    project_root: path.resolve(store.projectRoot),
    store_dir: path.resolve(store.storeDir),
    result,
  };
  writeStdout(JSON.stringify(envelope) + "\n");
}

function emitError(
  command: string | null,
  code: string,
  message: string,
): void {
  const envelope: ErrEnvelope = {
    ok: false,
    schema_version: CLI_SCHEMA_VERSION,
    server_version: PKG_VERSION,
    command,
    error: { code, message },
  };
  writeStdout(JSON.stringify(envelope) + "\n");
}

/** Read a flag's value from argv, or undefined. */
function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

/** Flags the command front end understands, and whether each takes a value. */
const COMMAND_FLAGS: Record<string, "value" | "boolean"> = {
  "--json": "value",
  "--input-file": "value",
  "--project": "value",
  "--agent-id": "value",
  "--stdin": "boolean",
};

/**
 * Reject anything the command front end does not understand.
 *
 * Without this, a typo silently changes the call instead of failing it:
 * `twining twining_archive --jsonn '{"retain":200}'` parsed as an
 * argument-free archive, and an argument-free archive sweeps the whole board.
 * A dropped payload must never look like a successful call.
 *
 * Positional tokens are refused for the same reason — `twining post '{...}'`
 * (the `--json` forgotten) would otherwise post nothing and report success.
 */
function validateCommandArgs(
  args: string[],
  allowed: Record<string, "value" | "boolean"> = COMMAND_FLAGS,
): string | null {
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    const kind = allowed[token];
    if (kind === "value") {
      // The next token is this flag's value, whatever it looks like.
      if (i + 1 >= args.length) {
        // A dangling `--project` would otherwise fall through to the cwd
        // default and write to a DIFFERENT store than the caller named.
        return `"${token}" needs a value`;
      }
      i++;
      continue;
    }
    if (kind === "boolean") continue;
    if (token.startsWith("-")) {
      return `unknown option "${token}"`;
    }
    return (
      `unexpected argument "${token}" — pass the payload with ` +
      `--json '<json>', --input-file <f>, or --stdin`
    );
  }
  return null;
}

/**
 * Resolve the command word to a registry entry. The twining_ prefix is
 * optional so `twining assemble` works as well as `twining twining_assemble`;
 * the canonical twining_* name is what the envelope reports.
 */
function resolveCommand(word: string): CommandDef<TwiningContext> | undefined {
  return (
    commandRegistry.get(word) ?? commandRegistry.get(`twining_${word}`)
  );
}

function readStdinSync(): string {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

/** Where the store for this project root lives, and whether we may write it. */
export function probeStore(projectRoot: string): {
  storeDir: string;
  exists: boolean;
  writable: boolean;
  /** The directory whose permissions decided the answer. */
  probed: string;
} {
  const storeDir = path.join(projectRoot, ".twining");
  const exists = fs.existsSync(storeDir);
  // An existing store is written directly; a missing one is created inside
  // the project root, so that is what must be writable.
  const probed = exists ? storeDir : projectRoot;
  let writable = false;
  try {
    fs.accessSync(probed, fs.constants.W_OK);
    writable = true;
  } catch {
    writable = false;
  }
  return { storeDir, exists, writable, probed };
}

function storeUnwritableMessage(
  projectRoot: string,
  probe: ReturnType<typeof probeStore>,
): string {
  const missing = !fs.existsSync(probe.probed);
  const cause = missing
    ? `${probe.probed} does not exist`
    : `${probe.probed} is not writable by this process`;
  return (
    `Twining store ${probe.storeDir} is unusable: ${cause}. ` +
    `Project root resolved to ${projectRoot}. ` +
    "Twining will NOT silently fall back to another store. Fix it by pointing " +
    "at a writable project (--project <dir> or TWINING_PROJECT=<dir>), or — if " +
    "this is a git worktree whose main checkout is read-only (a common sandbox " +
    "shape) — keep the store worktree-local with TWINING_WORKTREE_LOCAL=true."
  );
}

function buildCapabilities(projectRoot: string): Record<string, unknown> {
  const probe = probeStore(projectRoot);
  return {
    name: "twining",
    server_version: PKG_VERSION,
    schema_version: CLI_SCHEMA_VERSION,
    // Absolutized for REPORTING only: a relative --project still resolves
    // exactly as it did, it is just not echoed back as a path that means
    // something different from another directory.
    project_root: path.resolve(projectRoot),
    store_dir: path.resolve(probe.storeDir),
    store_exists: probe.exists,
    store_writable: probe.writable,
    // The CLI dispatches every command regardless of surface; `surface` says
    // which MCP tool surface the same command appears on (config
    // tools.full_surface), so a caller can tell why an MCP peer may not see it.
    commands: commandRegistry.list().map((def) => ({
      name: def.name,
      surface: def.surface,
      // Second registration gate: absent unless config tools.mode must be
      // "full" for an MCP peer to have this command at all.
      ...(def.requiresMode ? { requires_mode: def.requiresMode } : {}),
      description: def.description,
      input_schema: def.input
        ? zodToJsonSchema(z.object(def.input), { $refStrategy: "none" })
        : { type: "object" },
    })),
  };
}

async function readInput(
  args: string[],
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; message: string }> {
  const sources = [
    hasFlag(args, "--json"),
    hasFlag(args, "--input-file"),
    hasFlag(args, "--stdin"),
  ].filter(Boolean).length;
  if (sources > 1) {
    return {
      ok: false,
      message: "pass at most one of --json, --input-file, --stdin",
    };
  }

  let raw: string | undefined;
  if (hasFlag(args, "--json")) {
    raw = flagValue(args, "--json");
    if (raw === undefined) {
      return { ok: false, message: "--json needs a JSON object argument" };
    }
  } else if (hasFlag(args, "--input-file")) {
    const file = flagValue(args, "--input-file");
    if (file === undefined) {
      return { ok: false, message: "--input-file needs a path argument" };
    }
    try {
      raw = fs.readFileSync(file, "utf-8");
    } catch (e) {
      return {
        ok: false,
        message: `cannot read --input-file ${file}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  } else if (hasFlag(args, "--stdin")) {
    raw = readStdinSync();
  }

  if (raw === undefined || raw.trim().length === 0) return { ok: true, value: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return {
      ok: false,
      message: `input is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "input must be a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export async function runTwiningCli(argv: string[]): Promise<number> {
  const dispatch = classifyCliArgv(argv);

  if (dispatch.kind === "version") {
    writeStdout(`twining ${PKG_VERSION}\n`);
    return 0;
  }
  if (dispatch.kind === "help") {
    writeStdout(TWINING_CLI_USAGE + "\n");
    return 0;
  }
  if (dispatch.kind === "usage") {
    console.error(`twining: ${dispatch.reason}\n${TWINING_CLI_USAGE}`);
    emitError(null, "USAGE", dispatch.reason);
    return 2;
  }

  // The two pre-2.17 subcommands keep their own output and exit codes
  // verbatim — they are not command-core commands and print no envelope.
  if (dispatch.kind === "subcommand") {
    if (dispatch.name === "migrate") {
      const { runMigrateCli } = await import("../migrate/cli.js");
      return await runMigrateCli(dispatch.args);
    }
    const { runValidateRecordsCli } = await import("./validate-records.js");
    return await runValidateRecordsCli(dispatch.args);
  }

  // Store resolution is identical to the server's (--project > TWINING_PROJECT
  // > cwd, with the linked-worktree redirect on the cwd branch only).
  const projectRoot = resolveProjectRoot(argv, process.env, process.cwd());

  if (dispatch.kind === "capabilities") {
    const capsError = validateCommandArgs(dispatch.args, { "--project": "value" });
    if (capsError) {
      console.error(`twining: ${capsError}\n${TWINING_CLI_USAGE}`);
      emitError("capabilities", "USAGE", capsError);
      return 2;
    }
    // Deliberately does NOT build a context: listing commands must never
    // create a .twining/ directory, and must work in an unwritable tree so
    // store_writable can report the bad news instead of crashing on it.
    emitOk(
      "capabilities",
      { projectRoot, storeDir: probeStore(projectRoot).storeDir },
      buildCapabilities(projectRoot),
    );
    return 0;
  }

  const def = resolveCommand(dispatch.name);
  if (!def) {
    const message =
      `unknown command "${dispatch.name}" — run \`twining capabilities\` for the list`;
    console.error(`twining: ${message}`);
    emitError(null, "UNKNOWN_COMMAND", message);
    return 2;
  }

  const argError = validateCommandArgs(dispatch.args);
  if (argError) {
    const message = `${argError}\n${TWINING_CLI_USAGE}`;
    console.error(`twining: ${message}`);
    emitError(def.name, "USAGE", argError);
    return 2;
  }

  const input = await readInput(dispatch.args);
  if (!input.ok) {
    console.error(`twining: ${input.message}`);
    emitError(def.name, "INVALID_JSON", input.message);
    return 2;
  }

  // --agent-id is a convenience for shells and hooks: it fills agent_id when
  // the command takes one and the payload did not already set it.
  const agentId = flagValue(dispatch.args, "--agent-id");
  if (agentId && def.input && "agent_id" in def.input && input.value.agent_id === undefined) {
    input.value.agent_id = agentId;
  }

  // Validate exactly as the MCP transport does, so a payload the server would
  // reject is not silently accepted here.
  let parsedInput: Record<string, unknown> = input.value;
  if (def.input) {
    const result = z.object(def.input).safeParse(input.value);
    if (!result.success) {
      const message = result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      console.error(`twining: invalid input for ${def.name} — ${message}`);
      emitError(def.name, "INVALID_ARGUMENTS", message);
      return 2;
    }
    parsedInput = result.data as Record<string, unknown>;
  }

  const probe = probeStore(projectRoot);
  if (!probe.writable) {
    const message = storeUnwritableMessage(projectRoot, probe);
    console.error(`twining: ${message}`);
    emitError(def.name, "STORE_UNWRITABLE", message);
    return 1;
  }

  let ctx: TwiningContext | null = null;
  try {
    // background: false — a process that exits in milliseconds must not start
    // fire-and-forget writes it cannot finish. offline: true — no network,
    // ever, from a CLI invocation.
    ctx = createTwiningContext(projectRoot, { background: false, offline: true });
    // Same pre-dispatch git-staleness probe the MCP server runs before every
    // tool call, so a CLI call after a pull sees the pulled records.
    ctx.maybeResync();
    const result = await def.handler(ctx, parsedInput as never);
    emitOk(
      def.name,
      { projectRoot: ctx.projectRoot, storeDir: ctx.twiningDir },
      result,
    );
    return 0;
  } catch (e) {
    const { message, code } = mapCommandError(e, def.errors);
    emitError(def.name, code, message);
    return 1;
  } finally {
    try {
      ctx?.stopBackgroundWork();
      ctx?.closeDb();
    } catch {
      // Teardown is best-effort; the envelope is already written.
    }
  }
}

// Run only when invoked as the `twining` binary — importing this module (from
// tests, or from another entry point) must not execute anything. npm installs
// bins as symlinks, so argv[1] is realpath'd before the comparison.
const invokedDirectly = ((): boolean => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return fs.realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

/**
 * Set the exit code and let the event loop drain — never process.exit().
 *
 * When the ONNX model is cached, loading it starts onnxruntime-node's native
 * thread pool, and process.exit() tears the process down underneath it:
 * `libc++abi: terminating due to uncaught exception ... mutex lock failed`,
 * SIGABRT, exit 134 — on a call that SUCCEEDED and already wrote its envelope.
 * Reproduced 3/3 against a real model cache. The envelope goes out through a
 * synchronous fs.writeSync(1, …), so nothing is buffered and waiting for the
 * loop to drain costs only the teardown itself: everything this process opened
 * (the sqlite handle, the drain timer) is closed in runTwiningCli's finally.
 */
function finish(code: number): void {
  process.exitCode = code;
}

if (invokedDirectly) {
  runTwiningCli(process.argv)
    .then(finish)
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`twining: fatal: ${message}`);
      emitError(null, "INTERNAL_ERROR", message);
      finish(1);
    });
}
