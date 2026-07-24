import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { registerRecordTools } from "../src/tools/record-tools.js";
import { registerHousekeepingTools } from "../src/tools/housekeeping-tools.js";
import { registerBlackboardTools } from "../src/tools/blackboard-tools.js";
import { registerDecisionTools } from "../src/tools/decision-tools.js";
import { registerContextTools } from "../src/tools/context-tools.js";
import { registerVerifyTools } from "../src/tools/verify-tools.js";
import { registerCoordinationTools } from "../src/tools/coordination-tools.js";
import { registerExportTools } from "../src/tools/export-tools.js";
import { registerTriageTools } from "../src/tools/triage-tools.js";
import { registerLifecycleTools } from "../src/tools/lifecycle-tools.js";
import { registerGraphTools } from "../src/tools/graph-tools.js";

/**
 * Guards against the failure mode found in the 2026-07 deep review: plugin
 * agent frontmatter and skill bodies referenced tool names that no install
 * ever registers (bare `twining_*` names in an MCP `tools:` allowlist, plus
 * full-surface-only names taught as if they were always available). Unmatched
 * allowlist entries are dropped silently, so the twining-aware-worker agent
 * shipped with zero twining tools and nothing failed loudly.
 *
 * Registration only touches `server.registerTool` — engine arguments are
 * captured by the handler closures and never dereferenced at registration
 * time — so a recording stub with null engines enumerates the real surface.
 */
function collectToolNames(fullSurface: boolean): Set<string> {
  const names = new Set<string>();
  const server = {
    registerTool(name: string) {
      names.add(name);
    },
  } as never;
  const n = null as never;
  const opts = { fullSurface };

  registerRecordTools(server, n, n, "/tmp/p", "/tmp/p/.twining", opts);
  registerHousekeepingTools(server, n, n, n);
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
  if (fullSurface) registerTriageTools(server, { decisionStore: n, blackboardStore: n } as never);
  // toolMode defaults to "full"
  registerLifecycleTools(server, "/tmp/p/.twining", n, n, n, n, {} as never, n);
  registerGraphTools(server, n);

  return names;
}

const DEFAULT_SURFACE = collectToolNames(false);
const FULL_SURFACE = collectToolNames(true);

const PLUGIN_DIR = path.resolve(__dirname, "..", "plugin");

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return e.name.endsWith(".md") ? [full] : [];
  });
}

const MD_FILES = [
  ...walk(path.join(PLUGIN_DIR, "agents")),
  ...walk(path.join(PLUGIN_DIR, "skills")),
  ...walk(path.join(PLUGIN_DIR, "commands")),
];

function frontmatter(src: string): string | null {
  const m = /^---\n([\s\S]*?)\n---/.exec(src);
  return m ? m[1] : null;
}

describe("plugin tool references", () => {
  it("registers a non-empty default surface that is a subset of the full surface", () => {
    expect(DEFAULT_SURFACE.size).toBeGreaterThan(0);
    for (const name of DEFAULT_SURFACE) expect(FULL_SURFACE).toContain(name);
    expect(FULL_SURFACE.size).toBeGreaterThan(DEFAULT_SURFACE.size);
  });

  it("keeps the Gate 1 and Gate 2 tools on the default surface", () => {
    // The two mandatory gates must work on a stock install.
    for (const name of ["twining_assemble", "twining_record", "twining_post", "twining_why"]) {
      expect(DEFAULT_SURFACE).toContain(name);
    }
  });

  it("finds plugin markdown to check", () => {
    expect(MD_FILES.length).toBeGreaterThan(0);
  });

  // An MCP tool's live name is prefixed by the server it came from
  // (mcp__plugin_twining_twining__* for a plugin install,
  // mcp__twining__* standalone), so a bare `twining_*` entry in a `tools:`
  // allowlist matches nothing and is dropped without warning. Declaring no
  // allowlist at all is the only prefix-agnostic way to inherit them.
  it.each(MD_FILES.filter((f) => f.includes(`${path.sep}agents${path.sep}`)))(
    "%s does not restrict tools with unmatchable bare twining_* names",
    (file) => {
      const fm = frontmatter(fs.readFileSync(file, "utf8"));
      if (!fm) return;
      const toolsBlock = /^tools:([\s\S]*?)(?=^\S|\Z)/m.exec(fm);
      if (!toolsBlock) return; // no allowlist — inherits everything, which is what we want
      expect(
        toolsBlock[1],
        `${path.basename(file)} declares a tools: allowlist containing bare twining_* names. ` +
          `MCP tools are namespaced at runtime, so these match nothing and the agent silently ` +
          `launches with no twining tools. Remove the tools: key so the agent inherits them.`,
      ).not.toMatch(/\btwining_[a-z_]+/);
    },
  );

  // Docs may legitimately mention a full-surface tool, but must say so nearby,
  // otherwise agents on a stock install follow instructions that cannot work.
  it.each(MD_FILES)("%s does not present full-surface-only tools as always available", (file) => {
    const src = fs.readFileSync(file, "utf8");
    const referenced = new Set(src.match(/\btwining_[a-z_]+/g) ?? []);

    const unknown = [...referenced].filter((n) => !FULL_SURFACE.has(n));
    expect(
      unknown,
      `${path.basename(file)} references tool names that no install registers: ${unknown.join(", ")}`,
    ).toEqual([]);

    const fullOnly = [...referenced].filter((n) => !DEFAULT_SURFACE.has(n));
    if (fullOnly.length > 0) {
      expect(
        /full_surface/.test(src),
        `${path.basename(file)} references full-surface-only tools (${fullOnly.join(", ")}) ` +
          `without mentioning full_surface, so agents on a default install are told to make ` +
          `calls that do not exist.`,
      ).toBe(true);
    }
  });
});
