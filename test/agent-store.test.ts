import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AgentStore } from "../src/storage/agent-store.js";

let tmpDir: string;
let store: AgentStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-agent-test-"));
  fs.mkdirSync(path.join(tmpDir, "agents"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "agents", "registry.json"),
    JSON.stringify([]),
  );
  store = new AgentStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("AgentStore.upsert", () => {
  it("creates new agent with all fields and timestamps", async () => {
    const agent = await store.upsert({
      agent_id: "agent-1",
      capabilities: ["code", "test"],
      role: "developer",
      description: "A coding agent",
    });
    expect(agent.agent_id).toBe("agent-1");
    expect(agent.capabilities).toEqual(["code", "test"]);
    expect(agent.role).toBe("developer");
    expect(agent.description).toBe("A coding agent");
    expect(agent.registered_at).toBeTruthy();
    expect(agent.last_active).toBeTruthy();
  });

  it("merges capabilities on re-registration (union, no dupes)", async () => {
    await store.upsert({
      agent_id: "agent-1",
      capabilities: ["code", "test"],
    });
    const updated = await store.upsert({
      agent_id: "agent-1",
      capabilities: ["test", "deploy"],
    });
    expect(updated.capabilities).toEqual(["code", "test", "deploy"]);
  });

  it("overwrites role when provided on re-registration", async () => {
    await store.upsert({
      agent_id: "agent-1",
      role: "developer",
    });
    const updated = await store.upsert({
      agent_id: "agent-1",
      role: "reviewer",
    });
    expect(updated.role).toBe("reviewer");
  });

  it("does NOT overwrite role when role is undefined on re-registration", async () => {
    await store.upsert({
      agent_id: "agent-1",
      role: "developer",
    });
    const updated = await store.upsert({
      agent_id: "agent-1",
      capabilities: ["new-cap"],
    });
    expect(updated.role).toBe("developer");
  });

  it("overwrites description when provided on re-registration", async () => {
    await store.upsert({
      agent_id: "agent-1",
      description: "original",
    });
    const updated = await store.upsert({
      agent_id: "agent-1",
      description: "updated",
    });
    expect(updated.description).toBe("updated");
  });

  it("does NOT overwrite description when undefined on re-registration", async () => {
    await store.upsert({
      agent_id: "agent-1",
      description: "original",
    });
    const updated = await store.upsert({
      agent_id: "agent-1",
      capabilities: ["cap"],
    });
    expect(updated.description).toBe("original");
  });

  it("normalizes capability tags (lowercase, trim, dedup)", async () => {
    const agent = await store.upsert({
      agent_id: "agent-1",
      capabilities: ["  Code ", "TEST", "code", " "],
    });
    expect(agent.capabilities).toEqual(["code", "test"]);
  });

  it("defaults capabilities to empty array", async () => {
    const agent = await store.upsert({
      agent_id: "agent-1",
    });
    expect(agent.capabilities).toEqual([]);
  });
});

describe("AgentStore.touch", () => {
  it("creates minimal record for unknown agent", async () => {
    const agent = await store.touch("unknown-agent");
    expect(agent.agent_id).toBe("unknown-agent");
    expect(agent.capabilities).toEqual([]);
    expect(agent.role).toBeUndefined();
    expect(agent.description).toBeUndefined();
    expect(agent.registered_at).toBeTruthy();
    expect(agent.last_active).toBeTruthy();
  });

  it("updates last_active for known agent without changing capabilities/role", async () => {
    const original = await store.upsert({
      agent_id: "agent-1",
      capabilities: ["code"],
      role: "developer",
    });
    // Small delay to ensure timestamps differ
    await new Promise((resolve) => setTimeout(resolve, 10));
    const touched = await store.touch("agent-1");
    expect(touched.capabilities).toEqual(["code"]);
    expect(touched.role).toBe("developer");
    expect(touched.registered_at).toBe(original.registered_at);
    expect(new Date(touched.last_active).getTime()).toBeGreaterThanOrEqual(
      new Date(original.last_active).getTime(),
    );
  });
});

describe("AgentStore.get", () => {
  it("returns null for unknown agent_id", async () => {
    const result = await store.get("nonexistent");
    expect(result).toBeNull();
  });

  it("returns agent for known agent_id", async () => {
    await store.upsert({ agent_id: "agent-1", role: "dev" });
    const result = await store.get("agent-1");
    expect(result).not.toBeNull();
    expect(result!.agent_id).toBe("agent-1");
    expect(result!.role).toBe("dev");
  });
});

describe("AgentStore.getAll", () => {
  it("returns empty array on fresh store", async () => {
    const all = await store.getAll();
    expect(all).toEqual([]);
  });

  it("returns all agents after multiple upserts", async () => {
    await store.upsert({ agent_id: "agent-1" });
    await store.upsert({ agent_id: "agent-2" });
    await store.upsert({ agent_id: "agent-3" });
    const all = await store.getAll();
    expect(all).toHaveLength(3);
    const ids = all.map((a) => a.agent_id);
    expect(ids).toContain("agent-1");
    expect(ids).toContain("agent-2");
    expect(ids).toContain("agent-3");
  });
});

describe("AgentStore.findByCapabilities", () => {
  it("returns matching agents (OR match)", async () => {
    await store.upsert({ agent_id: "agent-1", capabilities: ["code", "test"] });
    await store.upsert({ agent_id: "agent-2", capabilities: ["deploy"] });
    await store.upsert({ agent_id: "agent-3", capabilities: ["code", "deploy"] });
    const results = await store.findByCapabilities(["code"]);
    expect(results).toHaveLength(2);
    const ids = results.map((a) => a.agent_id);
    expect(ids).toContain("agent-1");
    expect(ids).toContain("agent-3");
  });

  it("returns empty array when no match", async () => {
    await store.upsert({ agent_id: "agent-1", capabilities: ["code"] });
    const results = await store.findByCapabilities(["deploy"]);
    expect(results).toEqual([]);
  });

  it("normalizes input tags before matching", async () => {
    await store.upsert({ agent_id: "agent-1", capabilities: ["code"] });
    const results = await store.findByCapabilities(["  CODE  "]);
    expect(results).toHaveLength(1);
    expect(results[0]!.agent_id).toBe("agent-1");
  });

  it("returns empty array with empty tags input", async () => {
    await store.upsert({ agent_id: "agent-1", capabilities: ["code"] });
    const results = await store.findByCapabilities([]);
    expect(results).toEqual([]);
  });
});

describe("AgentStore concurrent operations", () => {
  it("sequential upserts don't corrupt data", async () => {
    await store.upsert({ agent_id: "agent-1", capabilities: ["a"] });
    await store.upsert({ agent_id: "agent-2", capabilities: ["b"] });
    const all = await store.getAll();
    expect(all).toHaveLength(2);
    const a1 = all.find((a) => a.agent_id === "agent-1");
    const a2 = all.find((a) => a.agent_id === "agent-2");
    expect(a1!.capabilities).toEqual(["a"]);
    expect(a2!.capabilities).toEqual(["b"]);
  });
});
