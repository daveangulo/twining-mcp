/**
 * Persisted blackboard lifecycle (field defect D2).
 *
 * An open need/question/warning previously left the board only via a
 * relates_to back-reference (derived, fragile — archiving the resolver
 * reopened the obligation) or twining_dismiss (hard delete). These tests
 * pin the explicit lifecycle: store.resolve() persists status "resolved"
 * with audit fields, computeResolvedIds unions explicit status with
 * back-references, and every predicate consumer (triage, archiver) honors
 * it. Parameterized over both backends.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openDatabase, type SqliteDatabase } from "../src/storage/sqlite/db.js";
import { SqliteBlackboardStore } from "../src/storage/sqlite/sqlite-stores.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { GraphStore } from "../src/storage/graph-store.js";
import { AgentStore } from "../src/storage/agent-store.js";
import { HandoffStore } from "../src/storage/handoff-store.js";
import { withRecordExport } from "../src/storage/sync/record-export.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { Archiver } from "../src/engine/archiver.js";
import { computeResolvedIds } from "../src/engine/resolution.js";
import { buildTriage } from "../src/engine/triage.js";
import { registerBlackboardTools } from "../src/tools/blackboard-tools.js";
import type { IBlackboardStore } from "../src/storage/interfaces.js";
import type { StoreSet } from "../src/storage/backend-factory.js";

const require = createRequire(import.meta.url);
const HAS_SQLITE = (() => {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
})();

interface Fixture {
  dir: string;
  store: IBlackboardStore;
  cleanup(): void;
}

function makeFileFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-resolve-file-"));
  fs.writeFileSync(path.join(dir, "blackboard.jsonl"), "");
  fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "decisions", "index.json"), "[]");
  return {
    dir,
    store: new BlackboardStore(dir),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function makeSqliteFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-resolve-sqlite-"));
  fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "decisions", "index.json"), "[]");
  const db: SqliteDatabase = openDatabase(dir);
  return {
    dir,
    store: new SqliteBlackboardStore(db),
    cleanup: () => {
      try {
        db.close();
      } catch {
        // already closed
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const BACKENDS = [
  { name: "file", skip: false, make: makeFileFixture },
  { name: "sqlite", skip: !HAS_SQLITE, make: makeSqliteFixture },
];

for (const backend of BACKENDS) {
  describe.skipIf(backend.skip)(`blackboard resolve — ${backend.name} backend`, () => {
    let fx: Fixture;

    beforeEach(() => {
      fx = backend.make();
    });

    afterEach(() => {
      fx.cleanup();
    });

    it("persists status, resolved_at, resolved_by, and resolution_note on resolved entries", async () => {
      const need = await fx.store.append({
        entry_type: "need",
        summary: "an open need",
        detail: "",
        tags: [],
        scope: "src/",
        agent_id: "main",
      });

      const result = await fx.store.resolve([need.id, "missing-id"], {
        by: "resolver-agent",
        note: "handled in PR #12",
      });

      expect(result.resolved).toEqual([need.id]);
      expect(result.not_found).toEqual(["missing-id"]);

      const { entries } = await fx.store.read();
      const updated = entries.find((e) => e.id === need.id)!;
      expect(updated.status).toBe("resolved");
      expect(updated.resolved_by).toBe("resolver-agent");
      expect(updated.resolution_note).toBe("handled in PR #12");
      expect(Date.parse(updated.resolved_at!)).not.toBeNaN();
    });

    it("is idempotent: re-resolving keeps the original audit stamp", async () => {
      const need = await fx.store.append({
        entry_type: "need",
        summary: "resolve me twice",
        detail: "",
        tags: [],
        scope: "src/",
        agent_id: "main",
      });

      await fx.store.resolve([need.id], { by: "first" });
      const { entries: after1 } = await fx.store.read();
      const stamp = after1.find((e) => e.id === need.id)!.resolved_at;

      const second = await fx.store.resolve([need.id], { by: "second" });
      expect(second.resolved).toEqual([need.id]);
      const { entries: after2 } = await fx.store.read();
      const final = after2.find((e) => e.id === need.id)!;
      expect(final.resolved_by).toBe("first");
      expect(final.resolved_at).toBe(stamp);
    });

    it("computeResolvedIds unions explicit status with relates_to back-references", async () => {
      const explicit = await fx.store.append({
        entry_type: "warning",
        summary: "explicitly resolved",
        detail: "",
        tags: [],
        scope: "src/",
        agent_id: "main",
      });
      const backRef = await fx.store.append({
        entry_type: "warning",
        summary: "back-referenced",
        detail: "",
        tags: [],
        scope: "src/",
        agent_id: "main",
      });
      const open = await fx.store.append({
        entry_type: "warning",
        summary: "still open",
        detail: "",
        tags: [],
        scope: "src/",
        agent_id: "main",
      });
      await fx.store.append({
        entry_type: "status",
        summary: "resolver",
        detail: "",
        tags: [],
        relates_to: [backRef.id],
        scope: "src/",
        agent_id: "main",
      });
      await fx.store.resolve([explicit.id], {});

      const { entries } = await fx.store.read();
      const resolved = computeResolvedIds(entries);
      expect(resolved.has(explicit.id)).toBe(true);
      expect(resolved.has(backRef.id)).toBe(true);
      expect(resolved.has(open.id)).toBe(false);
    });

    it("explicitly resolved items leave the triage open lane", async () => {
      const open = await fx.store.append({
        entry_type: "need",
        summary: "open need",
        detail: "",
        tags: [],
        scope: "src/",
        agent_id: "main",
      });
      const handled = await fx.store.append({
        entry_type: "need",
        summary: "handled need",
        detail: "",
        tags: [],
        scope: "src/",
        agent_id: "main",
      });
      await fx.store.resolve([handled.id], { by: "main" });

      const result = await buildTriage({
        blackboardStore: fx.store,
        decisionStore: new DecisionStore(fx.dir),
      });

      const openIds = (result.open ?? []).map((i) => i.id);
      expect(openIds).toContain(open.id);
      expect(openIds).not.toContain(handled.id);
    });

    it("archiver drains explicitly resolved needs/warnings (the #40 exemption no longer shields them)", async () => {
      const engine = new BlackboardEngine(fx.store);
      const archiver = new Archiver(fx.dir, fx.store, engine, null);

      const openNeed = await fx.store.append({
        entry_type: "need",
        summary: "open — must be kept",
        detail: "",
        tags: [],
        scope: "src/",
        agent_id: "main",
      });
      const resolvedNeed = await fx.store.append({
        entry_type: "need",
        summary: "resolved — must drain",
        detail: "",
        tags: [],
        scope: "src/",
        agent_id: "main",
      });
      await fx.store.resolve([resolvedNeed.id], { by: "main" });

      // Explicit future cutoff — the default (now) can equal a same-
      // millisecond append's timestamp, making isOldEnough false flakily.
      const plan = await archiver.plan({
        before: new Date(Date.now() + 1000).toISOString(),
      });
      const planned = plan.to_archive.map((e) => e.id);
      expect(planned).toContain(resolvedNeed.id);
      expect(planned).not.toContain(openNeed.id);
      expect(plan.kept_open_count).toBe(1);
    });
  });
}

describe("ExportingBlackboardStore — resolve re-exports the mutated record", () => {
  it("rewrites the exported post JSON with the lifecycle fields", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-resolve-export-"));
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), "");
    try {
      const stores: StoreSet = {
        backend: "files",
        reason: "explicit",
        legacy_unread: false,
        records_unread: false,
        blackboardStore: new BlackboardStore(dir),
        decisionStore: new DecisionStore(dir),
        graphStore: new GraphStore(dir),
        agentStore: new AgentStore(dir),
        handoffStore: new HandoffStore(dir),
        indexManager: null as never,
      };
      const wrapped = withRecordExport(stores, dir);

      const entry = await wrapped.blackboardStore.append({
        entry_type: "warning",
        summary: "exported warning",
        detail: "",
        tags: [],
        scope: "src/",
        agent_id: "main",
      });
      const exportPath = path.join(
        dir,
        "records",
        "posts",
        entry.timestamp.slice(0, 7),
        `${entry.id}.json`,
      );
      expect(fs.existsSync(exportPath)).toBe(true);

      await wrapped.blackboardStore.resolve([entry.id], { by: "main", note: "done" });

      const exported = JSON.parse(fs.readFileSync(exportPath, "utf-8"));
      expect(exported.status).toBe("resolved");
      expect(exported.resolved_by).toBe("main");
      expect(exported.resolution_note).toBe("done");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("twining_resolve tool + dismiss tombstone", () => {
  let dir: string;
  let server: McpServer;
  let store: BlackboardStore;
  let engine: BlackboardEngine;

  function registeredTools(): Record<
    string,
    { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
  > {
    return (
      server as unknown as {
        _registeredTools: Record<
          string,
          { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools;
  }

  async function callTool(name: string, args: Record<string, unknown>) {
    const tool = registeredTools()[name];
    if (!tool) throw new Error(`Tool ${name} not found`);
    return (await tool.handler(args, {} as unknown)) as {
      content: Array<{ type: string; text: string }>;
    };
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-resolve-tools-"));
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), "");
    store = new BlackboardStore(dir);
    engine = new BlackboardEngine(store);
    server = new McpServer({ name: "test-server", version: "1.0.0" });
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("registers twining_resolve on the DEFAULT surface (fullSurface: false)", async () => {
    registerBlackboardTools(server, engine, dir, { fullSurface: false });
    expect(registeredTools()["twining_resolve"]).toBeDefined();
    // dismiss stays full-surface — the destructive verb is not the everyday exit
    expect(registeredTools()["twining_dismiss"]).toBeUndefined();
  });

  it("twining_resolve marks entries resolved with the caller's agent_id and note", async () => {
    registerBlackboardTools(server, engine, dir, { fullSurface: false });
    const need = await store.append({
      entry_type: "need",
      summary: "tool-resolved need",
      detail: "",
      tags: [],
      scope: "src/",
      agent_id: "main",
    });

    const response = await callTool("twining_resolve", {
      ids: [need.id],
      note: "shipped",
      agent_id: "worker-1",
    });
    const parsed = JSON.parse(response.content[0]!.text);
    expect(parsed.resolved).toEqual([need.id]);

    const { entries } = await store.read();
    const updated = entries.find((e) => e.id === need.id)!;
    expect(updated.status).toBe("resolved");
    expect(updated.resolved_by).toBe("worker-1");
    expect(updated.resolution_note).toBe("shipped");
  });

  it("twining_dismiss appends a tombstone with the reason to the archive (reason no longer dropped)", async () => {
    registerBlackboardTools(server, engine, dir, { fullSurface: true });
    const noise = await store.append({
      entry_type: "warning",
      summary: "false positive",
      detail: "",
      tags: [],
      scope: "src/",
      agent_id: "main",
    });

    await callTool("twining_dismiss", {
      ids: [noise.id],
      reason: "false positive from broken probe",
    });

    const archiveDir = path.join(dir, "archive");
    const files = fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : [];
    expect(files.length).toBe(1);
    const lines = fs
      .readFileSync(path.join(archiveDir, files[0]!), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe(noise.id);
    expect(lines[0].dismissed).toEqual(
      expect.objectContaining({ reason: "false positive from broken probe" }),
    );
    expect(Date.parse(lines[0].dismissed.dismissed_at)).not.toBeNaN();
  });
});
