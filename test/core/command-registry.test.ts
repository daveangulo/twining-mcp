import { describe, it, expect } from "vitest";
import type { ZodRawShape } from "zod";

import { ALL_COMMANDS, CommandRegistry, commandRegistry } from "../../src/core/commands.js";
import { registerRecordTools } from "../../src/tools/record-tools.js";
import { registerHousekeepingTools } from "../../src/tools/housekeeping-tools.js";
import { registerBlackboardTools } from "../../src/tools/blackboard-tools.js";
import { registerDecisionTools } from "../../src/tools/decision-tools.js";
import { registerContextTools } from "../../src/tools/context-tools.js";
import { registerVerifyTools } from "../../src/tools/verify-tools.js";
import { registerCoordinationTools } from "../../src/tools/coordination-tools.js";
import { registerExportTools } from "../../src/tools/export-tools.js";
import { registerTriageTools } from "../../src/tools/triage-tools.js";
import { registerLifecycleTools } from "../../src/tools/lifecycle-tools.js";
import { registerGraphTools } from "../../src/tools/graph-tools.js";

/**
 * 2.17.0 moved every tool handler into a transport-agnostic command registry
 * (src/core/commands/*), leaving src/tools/*.ts as registration loops. The
 * risk that introduces is DRIFT: a command whose MCP description or schema no
 * longer matches what the CLI dispatches, or a tool that registers twice.
 *
 * Registration only touches server.registerTool — engine arguments are
 * captured by handler closures and never dereferenced at registration time —
 * so a recording stub with null engines enumerates the real MCP surface,
 * config objects included.
 */
interface Recorded {
  description: string;
  inputSchema?: ZodRawShape;
}

function collectTools(fullSurface: boolean): Map<string, Recorded> {
  const recorded = new Map<string, Recorded>();
  const server = {
    registerTool(name: string, config: Recorded) {
      if (recorded.has(name)) {
        throw new Error(`Tool registered twice: ${name}`);
      }
      recorded.set(name, config);
    },
  } as never;
  const n = null as never;
  const opts = { fullSurface };

  // Mirrors the registration order and gating in createServer().
  registerRecordTools(server, n, n, "/tmp/p", "/tmp/p/.twining", opts);
  registerHousekeepingTools(server, n, n, n, "/tmp/p/.twining");
  registerBlackboardTools(server, n, "/tmp/p/.twining", {
    ...opts,
    decisionEngine: n,
    decisionStore: n,
  } as never);
  registerDecisionTools(server, n, "/tmp/p/.twining", opts);
  registerContextTools(server, n, opts);
  if (fullSurface) registerVerifyTools(server, n);
  registerCoordinationTools(server, n, n, {} as never, n, opts);
  if (fullSurface) registerExportTools(server, n);
  if (fullSurface) {
    registerTriageTools(server, { decisionStore: n, blackboardStore: n } as never);
  }
  // toolMode defaults to "full"
  registerLifecycleTools(server, "/tmp/p/.twining", n, n, n, n, {} as never, n);
  registerGraphTools(server, n);

  return recorded;
}

const DEFAULT_SURFACE = collectTools(false);
const FULL_SURFACE = collectTools(true);

describe("command registry ↔ MCP tool surface parity", () => {
  it("registers no command name twice", () => {
    const names = ALL_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    // The registry constructor is the enforcement point.
    expect(() => new CommandRegistry([...ALL_COMMANDS, ALL_COMMANDS[0]!])).toThrow(
      /Duplicate Twining command/,
    );
  });

  it("every MCP tool has exactly one command with an identical description", () => {
    for (const [name, config] of FULL_SURFACE) {
      const def = commandRegistry.get(name);
      expect(def, `no command for registered tool ${name}`).toBeDefined();
      expect(def!.description, `description drift on ${name}`).toBe(
        config.description,
      );
    }
  });

  it("every command is reachable on the full MCP surface", () => {
    expect(commandRegistry.names()).toEqual([...FULL_SURFACE.keys()].sort());
  });

  it("input schema keys match between the registry and the registered tool", () => {
    for (const [name, config] of FULL_SURFACE) {
      const def = commandRegistry.get(name)!;
      const registered = Object.keys(config.inputSchema ?? {}).sort();
      const fromRegistry = Object.keys(def.input ?? {}).sort();
      expect(fromRegistry, `schema key drift on ${name}`).toEqual(registered);
    }
  });

  it("twining_status still registers with NO inputSchema (advertised shape is load-bearing)", () => {
    expect(FULL_SURFACE.get("twining_status")!.inputSchema).toBeUndefined();
    expect(commandRegistry.get("twining_status")!.input).toBeUndefined();
  });

  it("surface flags agree with what the default surface actually registers", () => {
    for (const def of commandRegistry.list()) {
      const onDefault = DEFAULT_SURFACE.has(def.name);
      expect(onDefault, `${def.name} surface=${def.surface}`).toBe(
        def.surface === "default",
      );
    }
  });

  it("the default surface is a strict subset of the full surface", () => {
    for (const name of DEFAULT_SURFACE.keys()) {
      expect(FULL_SURFACE.has(name), `${name} missing from full surface`).toBe(true);
    }
    expect(DEFAULT_SURFACE.size).toBeLessThan(FULL_SURFACE.size);
  });

  it("the record sentinel is written by the commands, not the MCP layer (Gate 2 works on both fronts)", async () => {
    const sentinelWriters = ["twining_record", "twining_post", "twining_decide"];
    for (const name of sentinelWriters) {
      expect(commandRegistry.has(name)).toBe(true);
    }
    const src = await import("node:fs");
    for (const file of [
      "src/core/commands/record.ts",
      "src/core/commands/blackboard.ts",
      "src/core/commands/decisions.ts",
    ]) {
      expect(src.readFileSync(file, "utf-8")).toContain("writeRecordSentinel");
    }
  });
});
