/**
 * #18 — one-shot quality nudge on twining_record.
 * Lives in its own file: the once-per-process flag is module state, and a
 * dedicated vitest worker gives a deterministic first-call.
 * Test order inside this file is load-bearing for the one-shot assertion.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BlackboardStore } from "../../src/storage/blackboard-store.js";
import { DecisionStore } from "../../src/storage/decision-store.js";
import { BlackboardEngine } from "../../src/engine/blackboard.js";
import { DecisionEngine } from "../../src/engine/decisions.js";
import { registerRecordTools } from "../../src/tools/record-tools.js";

let tmpDir: string;
let server: McpServer;

async function record(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const registered = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools;
  const res = (await registered["twining_record"]!.handler(args, {} as unknown)) as {
    content: Array<{ type: string; text: string }>;
  };
  return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-nudge-test-"));
  fs.writeFileSync(path.join(tmpDir, "blackboard.jsonl"), "");
  fs.mkdirSync(path.join(tmpDir, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, "decisions", "index.json"), JSON.stringify([]));

  const bbStore = new BlackboardStore(tmpDir);
  const dcsnStore = new DecisionStore(tmpDir);
  const bbEngine = new BlackboardEngine(bbStore);
  const dcsnEngine = new DecisionEngine(dcsnStore, bbEngine);
  server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerRecordTools(server, bbEngine, dcsnEngine, tmpDir, tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const MANY_FILES = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];

describe("twining_record quality nudge (#18)", () => {
  it("small record without findings: no nudge", async () => {
    const res = await record({ summary: "Tiny tweak", affected_files: ["a.ts"] });
    expect(res.quality_nudge).toBeUndefined();
  });

  it("substantial record WITH findings: no nudge", async () => {
    const res = await record({
      summary: "Big refactor",
      affected_files: MANY_FILES,
      findings: ["warning: fragile mtime cache in blackboard store"],
    });
    expect(res.quality_nudge).toBeUndefined();
  });

  it("substantial record with zero findings: nudge present, exactly once", async () => {
    const first = await record({
      summary: "Big refactor",
      affected_files: MANY_FILES,
    });
    expect(first.quality_nudge).toBeTypeOf("string");
    expect(String(first.quality_nudge)).toContain("findings");

    // One-shot: an identical follow-up record is never nudged again
    const second = await record({
      summary: "More of the big refactor",
      affected_files: MANY_FILES,
    });
    expect(second.quality_nudge).toBeUndefined();
  });
});
