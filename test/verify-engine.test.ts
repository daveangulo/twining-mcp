/**
 * Tests for the VerifyEngine class.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { GraphStore } from "../src/storage/graph-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { GraphEngine } from "../src/engine/graph.js";
import { VerifyEngine } from "../src/engine/verify.js";

let tmpDir: string;
let blackboardStore: BlackboardStore;
let decisionStore: DecisionStore;
let graphStore: GraphStore;
let blackboardEngine: BlackboardEngine;
let graphEngine: GraphEngine;
let verifyEngine: VerifyEngine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-verify-test-"));
  fs.writeFileSync(path.join(tmpDir, "blackboard.jsonl"), "");
  fs.mkdirSync(path.join(tmpDir, "decisions"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "decisions", "index.json"),
    JSON.stringify([]),
  );
  blackboardStore = new BlackboardStore(tmpDir);
  decisionStore = new DecisionStore(tmpDir);
  graphStore = new GraphStore(tmpDir);
  blackboardEngine = new BlackboardEngine(blackboardStore);
  graphEngine = new GraphEngine(graphStore);
  verifyEngine = new VerifyEngine(
    decisionStore,
    blackboardStore,
    blackboardEngine,
    graphEngine,
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function validDecision(overrides: Record<string, unknown> = {}) {
  return {
    domain: "architecture",
    scope: "project",
    summary: "Use JWT",
    context: "Need auth",
    rationale: "Stateless",
    agent_id: "main",
    constraints: [] as string[],
    alternatives: [],
    depends_on: [] as string[],
    confidence: "medium" as const,
    reversible: true,
    affected_files: ["src/auth.ts"],
    affected_symbols: [] as string[],
    commit_hashes: [] as string[],
    ...overrides,
  };
}

describe("VerifyEngine.verify", () => {
  it("returns correct structure with all checks", async () => {
    const result = await verifyEngine.verify({ scope: "project" });
    expect(result.scope).toBe("project");
    expect(result.verified_at).toBeTruthy();
    expect(result.checks).toBeDefined();
    expect(result.summary).toBeTruthy();
  });

  it("returns stub status for drift and constraints", async () => {
    const result = await verifyEngine.verify({ scope: "project" });
    expect(result.checks.drift?.status).toBe("skip");
    expect(result.checks.constraints?.status).toBe("skip");
  });

  it("runs only requested checks", async () => {
    const result = await verifyEngine.verify({
      scope: "project",
      checks: ["warnings"],
    });
    expect(result.checks.warnings).toBeDefined();
    expect(result.checks.test_coverage).toBeUndefined();
    expect(result.checks.assembly).toBeUndefined();
  });

  it("auto-posts finding to blackboard", async () => {
    await verifyEngine.verify({ scope: "project" });
    const { entries } = await blackboardStore.read({ entry_types: ["finding"] });
    expect(entries.some((e) => e.summary.startsWith("Verification:"))).toBe(true);
  });
});

describe("test_coverage check", () => {
  it("returns pass when no decisions exist", async () => {
    const result = await verifyEngine.verify({
      scope: "project",
      checks: ["test_coverage"],
    });
    expect(result.checks.test_coverage?.status).toBe("pass");
    expect(result.checks.test_coverage?.decisions_in_scope).toBe(0);
  });

  it("returns fail when decisions have no tested_by relations", async () => {
    await decisionStore.create(validDecision());
    // No graph entities/relations created
    const result = await verifyEngine.verify({
      scope: "project",
      checks: ["test_coverage"],
    });
    expect(result.checks.test_coverage?.status).toBe("fail");
    expect(result.checks.test_coverage?.uncovered).toHaveLength(1);
  });

  it("returns pass when all affected files have tested_by", async () => {
    const decision = await decisionStore.create(validDecision());
    // Create entity for the affected file
    const entity = await graphEngine.addEntity({
      name: "src/auth.ts",
      type: "file",
    });
    // Add tested_by relation
    const testEntity = await graphEngine.addEntity({
      name: "test/auth.test.ts",
      type: "file",
    });
    await graphEngine.addRelation({
      source: entity.id,
      target: testEntity.id,
      type: "tested_by",
    });

    const result = await verifyEngine.verify({
      scope: "project",
      checks: ["test_coverage"],
    });
    expect(result.checks.test_coverage?.status).toBe("pass");
    expect(result.checks.test_coverage?.decisions_with_tested_by).toBe(1);
  });
});

describe("warnings check", () => {
  it("returns pass when no warnings exist", async () => {
    const result = await verifyEngine.verify({
      scope: "project",
      checks: ["warnings"],
    });
    expect(result.checks.warnings?.status).toBe("pass");
  });

  it("returns fail when many warnings are silently ignored", async () => {
    for (let i = 0; i < 4; i++) {
      await blackboardEngine.post({
        entry_type: "warning",
        summary: `Warning ${i}`,
        detail: "",
        tags: [],
        scope: "project",
      });
    }
    const result = await verifyEngine.verify({
      scope: "project",
      checks: ["warnings"],
    });
    expect(result.checks.warnings?.status).toBe("fail");
    expect(result.checks.warnings?.silently_ignored).toBe(4);
  });

  it("counts acknowledged warnings correctly", async () => {
    const warning = await blackboardEngine.post({
      entry_type: "warning",
      summary: "Watch out",
      detail: "",
      tags: [],
      scope: "project",
    });
    // Acknowledge it with an answer
    await blackboardEngine.post({
      entry_type: "answer",
      summary: "Understood",
      detail: "",
      tags: [],
      scope: "project",
      relates_to: [warning.id],
    });
    const result = await verifyEngine.verify({
      scope: "project",
      checks: ["warnings"],
    });
    expect(result.checks.warnings?.acknowledged).toBe(1);
    expect(result.checks.warnings?.silently_ignored).toBe(0);
    expect(result.checks.warnings?.status).toBe("pass");
  });
});

describe("assembly check", () => {
  it("returns pass when no decisions exist", async () => {
    const result = await verifyEngine.verify({
      scope: "project",
      checks: ["assembly"],
    });
    expect(result.checks.assembly?.status).toBe("pass");
    expect(result.checks.assembly?.decisions_by_agent).toBe(0);
  });

  it("detects blind decisions (assembled_before not set)", async () => {
    await decisionStore.create(validDecision());
    const result = await verifyEngine.verify({
      scope: "project",
      checks: ["assembly"],
    });
    expect(result.checks.assembly?.blind_decisions).toHaveLength(1);
  });

  it("returns pass when all decisions have assembled_before", async () => {
    await decisionStore.create(
      validDecision({ assembled_before: true }),
    );
    const result = await verifyEngine.verify({
      scope: "project",
      checks: ["assembly"],
    });
    expect(result.checks.assembly?.status).toBe("pass");
    expect(result.checks.assembly?.assembled_before).toBe(1);
  });

  it("filters by agent_id when specified", async () => {
    await decisionStore.create(validDecision({ agent_id: "agent-a", assembled_before: true }));
    await decisionStore.create(validDecision({ agent_id: "agent-b" }));

    const result = await verifyEngine.verify({
      scope: "project",
      checks: ["assembly"],
      agent_id: "agent-a",
    });
    expect(result.checks.assembly?.decisions_by_agent).toBe(1);
    expect(result.checks.assembly?.assembled_before).toBe(1);
    expect(result.checks.assembly?.status).toBe("pass");
  });
});
