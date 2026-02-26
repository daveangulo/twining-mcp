import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { AnalyticsEngine } from "../../src/analytics/analytics-engine.js";
import { BlackboardStore } from "../../src/storage/blackboard-store.js";
import { DecisionStore } from "../../src/storage/decision-store.js";
import { GraphStore } from "../../src/storage/graph-store.js";
import { HandoffStore } from "../../src/storage/handoff-store.js";
import { appendJSONL, writeJSON } from "../../src/storage/file-store.js";

let tmpDir: string;
let twiningDir: string;
let engine: AnalyticsEngine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-analytics-test-"));
  twiningDir = path.join(tmpDir, ".twining");
  fs.mkdirSync(path.join(twiningDir, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "graph"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(twiningDir, "handoffs"), { recursive: true });
  fs.writeFileSync(path.join(twiningDir, "blackboard.jsonl"), "");
  fs.writeFileSync(
    path.join(twiningDir, "decisions", "index.json"),
    JSON.stringify([], null, 2),
  );
  fs.writeFileSync(
    path.join(twiningDir, "graph", "entities.json"),
    JSON.stringify([], null, 2),
  );
  fs.writeFileSync(
    path.join(twiningDir, "graph", "relations.json"),
    JSON.stringify([], null, 2),
  );
  fs.writeFileSync(
    path.join(twiningDir, "agents", "registry.json"),
    JSON.stringify([], null, 2),
  );

  const bbStore = new BlackboardStore(twiningDir);
  const decStore = new DecisionStore(twiningDir);
  const graphStore = new GraphStore(twiningDir);
  const handoffStore = new HandoffStore(twiningDir);
  engine = new AnalyticsEngine(bbStore, decStore, graphStore, handoffStore);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("AnalyticsEngine", () => {
  it("returns zero stats for empty project", async () => {
    const stats = await engine.computeValueStats();
    expect(stats.blind_decisions_prevented.total_decisions).toBe(0);
    expect(stats.blind_decisions_prevented.prevention_rate).toBe(0);
    expect(stats.warnings_surfaced.total).toBe(0);
    expect(stats.test_coverage.coverage_rate).toBe(0);
    expect(stats.knowledge_graph.entities).toBe(0);
    expect(stats.agent_coordination.total_handoffs).toBe(0);
  });

  it("computes blind decision prevention rate", async () => {
    // Create 3 decisions: 2 with assembled_before=true, 1 without
    const decisions = [
      { id: "d1", timestamp: "2024-01-01T00:00:00Z", domain: "arch", scope: "src/", summary: "dec1", confidence: "high", status: "active", affected_files: [], affected_symbols: [], commit_hashes: [], assembled_before: true },
      { id: "d2", timestamp: "2024-01-02T00:00:00Z", domain: "arch", scope: "src/", summary: "dec2", confidence: "high", status: "active", affected_files: [], affected_symbols: [], commit_hashes: [], assembled_before: true },
      { id: "d3", timestamp: "2024-01-03T00:00:00Z", domain: "arch", scope: "src/", summary: "dec3", confidence: "medium", status: "active", affected_files: [], affected_symbols: [], commit_hashes: [] },
    ];

    // Write index
    await writeJSON(
      path.join(twiningDir, "decisions", "index.json"),
      decisions.map((d) => ({
        id: d.id, timestamp: d.timestamp, domain: d.domain, scope: d.scope,
        summary: d.summary, confidence: d.confidence, status: d.status,
        affected_files: d.affected_files, affected_symbols: d.affected_symbols,
        commit_hashes: d.commit_hashes,
      })),
    );

    // Write individual decision files
    for (const d of decisions) {
      await writeJSON(
        path.join(twiningDir, "decisions", `${d.id}.json`),
        d,
      );
    }

    const stats = await engine.computeValueStats();
    expect(stats.blind_decisions_prevented.total_decisions).toBe(3);
    expect(stats.blind_decisions_prevented.assembled_before).toBe(2);
    expect(stats.blind_decisions_prevented.prevention_rate).toBe(0.67);
  });

  it("computes warning stats with acknowledged/resolved/ignored", async () => {
    const bbPath = path.join(twiningDir, "blackboard.jsonl");
    await appendJSONL(bbPath, {
      id: "w1", entry_type: "warning", summary: "Warning 1", detail: "",
      scope: "src/", agent_id: "a1", timestamp: "2024-01-01T00:00:00Z", tags: ["acknowledged"],
      relates_to: [],
    });
    await appendJSONL(bbPath, {
      id: "w2", entry_type: "warning", summary: "Warning 2", detail: "",
      scope: "src/", agent_id: "a1", timestamp: "2024-01-02T00:00:00Z", tags: ["resolved"],
      relates_to: [],
    });
    await appendJSONL(bbPath, {
      id: "w3", entry_type: "warning", summary: "Warning 3", detail: "",
      scope: "src/", agent_id: "a1", timestamp: "2024-01-03T00:00:00Z", tags: [],
      relates_to: [],
    });

    const stats = await engine.computeValueStats();
    expect(stats.warnings_surfaced.total).toBe(3);
    expect(stats.warnings_surfaced.acknowledged).toBe(1);
    expect(stats.warnings_surfaced.resolved).toBe(1);
    expect(stats.warnings_surfaced.ignored).toBe(1);
  });

  it("computes test coverage via graph relations", async () => {
    // Two decisions
    const index = [
      { id: "d1", timestamp: "2024-01-01T00:00:00Z", domain: "arch", scope: "src/", summary: "dec1", confidence: "high", status: "active", affected_files: [], affected_symbols: [], commit_hashes: [] },
      { id: "d2", timestamp: "2024-01-02T00:00:00Z", domain: "arch", scope: "src/", summary: "dec2", confidence: "high", status: "active", affected_files: [], affected_symbols: [], commit_hashes: [] },
    ];
    await writeJSON(path.join(twiningDir, "decisions", "index.json"), index);
    for (const d of index) {
      await writeJSON(path.join(twiningDir, "decisions", `${d.id}.json`), d);
    }

    // One tested_by relation
    const relations = [
      { id: "r1", source: "d1", target: "test1", type: "tested_by", properties: {} },
    ];
    await writeJSON(path.join(twiningDir, "graph", "relations.json"), relations);

    const stats = await engine.computeValueStats();
    expect(stats.test_coverage.total_decisions).toBe(2);
    expect(stats.test_coverage.with_tested_by).toBe(1);
    expect(stats.test_coverage.coverage_rate).toBe(0.5);
  });

  it("computes decision lifecycle counts", async () => {
    const index = [
      { id: "d1", timestamp: "2024-01-01T00:00:00Z", domain: "arch", scope: "src/", summary: "s1", confidence: "high", status: "active", affected_files: [], affected_symbols: [], commit_hashes: [] },
      { id: "d2", timestamp: "2024-01-02T00:00:00Z", domain: "arch", scope: "src/", summary: "s2", confidence: "high", status: "active", affected_files: [], affected_symbols: [], commit_hashes: [] },
      { id: "d3", timestamp: "2024-01-03T00:00:00Z", domain: "arch", scope: "src/", summary: "s3", confidence: "low", status: "provisional", affected_files: [], affected_symbols: [], commit_hashes: [] },
      { id: "d4", timestamp: "2024-01-04T00:00:00Z", domain: "arch", scope: "src/", summary: "s4", confidence: "high", status: "superseded", affected_files: [], affected_symbols: [], commit_hashes: [] },
    ];
    await writeJSON(path.join(twiningDir, "decisions", "index.json"), index);
    for (const d of index) {
      await writeJSON(path.join(twiningDir, "decisions", `${d.id}.json`), d);
    }

    const stats = await engine.computeValueStats();
    expect(stats.decision_lifecycle.active).toBe(2);
    expect(stats.decision_lifecycle.provisional).toBe(1);
    expect(stats.decision_lifecycle.superseded).toBe(1);
    expect(stats.decision_lifecycle.overridden).toBe(0);
  });

  it("computes commit traceability", async () => {
    const index = [
      { id: "d1", timestamp: "2024-01-01T00:00:00Z", domain: "arch", scope: "src/", summary: "s1", confidence: "high", status: "active", affected_files: [], affected_symbols: [], commit_hashes: ["abc123"] },
      { id: "d2", timestamp: "2024-01-02T00:00:00Z", domain: "arch", scope: "src/", summary: "s2", confidence: "high", status: "active", affected_files: [], affected_symbols: [], commit_hashes: [] },
    ];
    await writeJSON(path.join(twiningDir, "decisions", "index.json"), index);
    for (const d of index) {
      await writeJSON(path.join(twiningDir, "decisions", `${d.id}.json`), d);
    }

    const stats = await engine.computeValueStats();
    expect(stats.commit_traceability.total_decisions).toBe(2);
    expect(stats.commit_traceability.with_commits).toBe(1);
    expect(stats.commit_traceability.traceability_rate).toBe(0.5);
  });

  it("computes knowledge graph entity/relation counts by type", async () => {
    const entities = [
      { id: "e1", name: "AuthModule", type: "module", properties: {} },
      { id: "e2", name: "UserService", type: "module", properties: {} },
      { id: "e3", name: "loginFunc", type: "function", properties: {} },
    ];
    const relations = [
      { id: "r1", source: "e1", target: "e3", type: "contains", properties: {} },
      { id: "r2", source: "e2", target: "e1", type: "depends_on", properties: {} },
    ];
    await writeJSON(path.join(twiningDir, "graph", "entities.json"), entities);
    await writeJSON(path.join(twiningDir, "graph", "relations.json"), relations);

    const stats = await engine.computeValueStats();
    expect(stats.knowledge_graph.entities).toBe(3);
    expect(stats.knowledge_graph.relations).toBe(2);
    expect(stats.knowledge_graph.entities_by_type).toEqual({ module: 2, function: 1 });
    expect(stats.knowledge_graph.relations_by_type).toEqual({ contains: 1, depends_on: 1 });
  });

  it("computes agent coordination from handoff index", async () => {
    const indexPath = path.join(twiningDir, "handoffs", "index.jsonl");
    await appendJSONL(indexPath, {
      id: "h1", created_at: "2024-01-01T00:00:00Z", source_agent: "a1",
      target_agent: "a2", scope: "src/", summary: "handoff 1",
      result_status: "completed", acknowledged: true,
    });
    await appendJSONL(indexPath, {
      id: "h2", created_at: "2024-01-02T00:00:00Z", source_agent: "a2",
      target_agent: "a3", scope: "src/", summary: "handoff 2",
      result_status: "partial", acknowledged: false,
    });

    const stats = await engine.computeValueStats();
    expect(stats.agent_coordination.total_handoffs).toBe(2);
    expect(stats.agent_coordination.by_result_status).toEqual({ completed: 1, partial: 1 });
    expect(stats.agent_coordination.acknowledgment_rate).toBe(0.5);
  });
});
