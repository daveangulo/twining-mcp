/**
 * The command registry: every Twining verb, once, independent of transport.
 *
 * The MCP server registers these as tools (src/tools/*.ts are now thin loops
 * over the same definitions); the CLI dispatches them from argv. A name may
 * appear exactly once — duplicate registration is a build-time-ish error
 * raised on first construction, not a silently shadowed tool.
 */
import type { TwiningContext } from "./context.js";
import type { CommandDef } from "./command-def.js";
import { recordCommands } from "./commands/record.js";
import { housekeepingCommands } from "./commands/housekeeping.js";
import { blackboardCommands } from "./commands/blackboard.js";
import { decisionCommands } from "./commands/decisions.js";
import { contextCommands } from "./commands/context.js";
import { verifyCommands } from "./commands/verify.js";
import { coordinationCommands } from "./commands/coordination.js";
import { exportCommands } from "./commands/export.js";
import { triageCommands } from "./commands/triage.js";
import { lifecycleCommands } from "./commands/lifecycle.js";
import { graphCommands } from "./commands/graph.js";

export * from "./command-def.js";

/**
 * Every command, in the order src/server.ts registers the corresponding tool
 * modules. The narrow per-module context types are all satisfied by
 * TwiningContext.
 */
export const ALL_COMMANDS: ReadonlyArray<CommandDef<TwiningContext>> = [
  ...recordCommands,
  ...housekeepingCommands,
  ...blackboardCommands,
  ...decisionCommands,
  ...contextCommands,
  ...verifyCommands,
  ...coordinationCommands,
  ...exportCommands,
  ...triageCommands,
  ...lifecycleCommands,
  ...graphCommands,
];

export class CommandRegistry {
  private readonly byName = new Map<string, CommandDef<TwiningContext>>();

  constructor(defs: ReadonlyArray<CommandDef<TwiningContext>> = ALL_COMMANDS) {
    for (const def of defs) {
      if (this.byName.has(def.name)) {
        throw new Error(`Duplicate Twining command: ${def.name}`);
      }
      this.byName.set(def.name, def);
    }
  }

  get(name: string): CommandDef<TwiningContext> | undefined {
    return this.byName.get(name);
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** All command names, sorted. */
  names(): string[] {
    return [...this.byName.keys()].sort();
  }

  /** All commands, sorted by name. */
  list(): CommandDef<TwiningContext>[] {
    return this.names().map((n) => this.byName.get(n)!);
  }
}

/** The process-wide registry over ALL_COMMANDS. */
export const commandRegistry = new CommandRegistry();
