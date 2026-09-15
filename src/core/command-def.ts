/**
 * Command definition types for the transport-agnostic command core (2.17.0).
 *
 * Before this, every Twining verb existed only as an MCP tool handler: the
 * behavior, the zod schema and the MCP response envelope were fused in one
 * closure inside src/tools/*.ts. A shell front end (Codex sandboxes cannot
 * whitelist an MCP server) would have had to duplicate all three.
 *
 * A CommandDef separates them. The handler returns a plain result object and
 * throws on failure; the transport decides how to frame both. `registerCommands`
 * is the MCP adapter — it reproduces the pre-2.17 `toolResult` / `toolError`
 * wrapping byte for byte, including the surface gate. src/cli/twining.ts is
 * the shell adapter over the same definitions.
 */
import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TwiningError, toolResult, toolError } from "../utils/errors.js";

/** Which MCP tool surface a command appears on (config `tools.full_surface`). */
export type CommandSurface = "default" | "full";

/**
 * How a thrown error becomes a response code.
 *
 * "typed" (the default) maps a TwiningError to its own code — what most
 * pre-2.17 handlers did. "internal-only" reproduces the handlers whose catch
 * block deliberately had no TwiningError branch (twining_why, twining_triage,
 * the blackboard read trio, the housekeeping trio, every coordination tool):
 * for those, everything that escapes the engine becomes INTERNAL_ERROR. The
 * flag exists so the extraction is byte-neutral rather than an opportunistic
 * (if arguably better) widening of those codes.
 */
export type ErrorMode = "typed" | "internal-only";

/**
 * A handler-level failure with a caller-facing code. Always mapped to its own
 * code regardless of ErrorMode — it is the replacement for the pre-2.17
 * `return toolError(msg, code)` early returns, which were never subject to the
 * catch block's mapping.
 */
export class CommandError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export interface CommandDef<C = unknown> {
  /** The MCP tool name, e.g. "twining_assemble" — also the CLI command word. */
  name: string;
  description: string;
  /** The zod shape registered as the tool's inputSchema. Absent = no schema
   *  (twining_status registers with none; adding an empty one would change
   *  its advertised schema). */
  input?: ZodRawShape;
  surface: CommandSurface;
  errors?: ErrorMode;
  /** Method syntax on purpose: it keeps CommandDef<NarrowCtx> assignable to
   *  CommandDef<TwiningContext> (bivariance), so each module can declare the
   *  narrow slice of context it actually uses and still land in one registry. */
  handler(ctx: C, input: never): Promise<unknown>;
}

/**
 * Per-context command factory. Curried because TypeScript has no partial
 * type-argument inference: the context type is named once, the input type is
 * then inferred from each command's zod shape.
 *
 *   const { define, defineNoInput } = commandFactory<BlackboardCtx>();
 */
export function commandFactory<C>(): {
  define<S extends ZodRawShape>(def: {
    name: string;
    description: string;
    input: S;
    surface: CommandSurface;
    errors?: ErrorMode;
    handler(ctx: C, input: z.infer<z.ZodObject<S>>): Promise<unknown>;
  }): CommandDef<C>;
  defineNoInput(def: {
    name: string;
    description: string;
    surface: CommandSurface;
    errors?: ErrorMode;
    handler(ctx: C): Promise<unknown>;
  }): CommandDef<C>;
} {
  return {
    define: (def) => def as unknown as CommandDef<C>,
    defineNoInput: (def) => def as unknown as CommandDef<C>,
  };
}

/** Map a thrown value to the { message, code } pair a transport reports. */
export function mapCommandError(
  e: unknown,
  mode: ErrorMode = "typed",
): { message: string; code: string } {
  if (e instanceof CommandError) {
    return { message: e.message, code: e.code };
  }
  if (mode !== "internal-only" && e instanceof TwiningError) {
    return { message: e.message, code: e.code };
  }
  return {
    message: e instanceof Error ? e.message : "Unknown error",
    code: "INTERNAL_ERROR",
  };
}

/**
 * MCP adapter: register each command as a tool, skipping full-surface
 * commands when the surface is narrowed. The wrapping is exactly what every
 * pre-2.17 handler did inline.
 */
export function registerCommands<C>(
  server: McpServer,
  ctx: C,
  defs: ReadonlyArray<CommandDef<C>>,
  options: { fullSurface?: boolean } = {},
): void {
  const fullSurface = options.fullSurface ?? false;
  for (const def of defs) {
    if (def.surface === "full" && !fullSurface) continue;
    const config = def.input
      ? { description: def.description, inputSchema: def.input }
      : { description: def.description };
    const callback = async (...cbArgs: unknown[]) => {
      try {
        const input = def.input ? (cbArgs[0] ?? {}) : {};
        const result = await def.handler(ctx, input as never);
        return toolResult(result as object);
      } catch (e) {
        const { message, code } = mapCommandError(e, def.errors);
        return toolError(message, code);
      }
    };
    server.registerTool(def.name, config as never, callback as never);
  }
}
