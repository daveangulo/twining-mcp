import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "../src/server.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { DecisionEngine } from "../src/engine/decisions.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-integration-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Integration: End-to-end workflow", () => {
  it("creates .twining/ directory on server creation", () => {
    createServer(tmpDir);
    const twiningDir = path.join(tmpDir, ".twining");
    expect(fs.existsSync(twiningDir)).toBe(true);
    expect(fs.existsSync(path.join(twiningDir, "blackboard.jsonl"))).toBe(true);
    expect(
      fs.existsSync(path.join(twiningDir, "decisions", "index.json")),
    ).toBe(true);
    expect(fs.existsSync(path.join(twiningDir, "config.yml"))).toBe(true);
  });

  it("full workflow: post, read, decide, why, status", async () => {
    // Create server (which initializes .twining/)
    createServer(tmpDir);
    const twiningDir = path.join(tmpDir, ".twining");

    // Create stores and engines for direct testing
    const bbStore = new BlackboardStore(twiningDir);
    const dcsnStore = new DecisionStore(twiningDir);
    const bbEngine = new BlackboardEngine(bbStore);
    const dcsnEngine = new DecisionEngine(dcsnStore, bbEngine);

    // 1. Post 3 blackboard entries
    const finding = await bbEngine.post({
      entry_type: "finding",
      summary: "Auth module needs refactoring",
      detail: "Current auth uses sessions but we need stateless",
      tags: ["auth", "refactor"],
      scope: "src/auth/",
    });
    expect(finding.id).toHaveLength(26);

    const warning = await bbEngine.post({
      entry_type: "warning",
      summary: "JWT library has known vulnerability in v1",
      tags: ["auth", "security"],
      scope: "src/auth/",
    });
    expect(warning.id).toHaveLength(26);

    const need = await bbEngine.post({
      entry_type: "need",
      summary: "Need to evaluate JWT libraries",
      tags: ["auth"],
      scope: "src/auth/",
    });
    expect(need.id).toHaveLength(26);

    // 2. Read all entries — expect 3
    const { entries: allEntries, total_count } = await bbEngine.read();
    expect(allEntries).toHaveLength(3);
    expect(total_count).toBe(3);

    // 3. Read filtered by type "warning" — expect 1
    const { entries: warnings } = await bbEngine.read({
      entry_types: ["warning"],
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.summary).toBe(
      "JWT library has known vulnerability in v1",
    );

    // 4. Read recent 2 — expect 2
    const { entries: recent } = await bbEngine.recent(2);
    expect(recent).toHaveLength(2);

    // 5. Create a decision with alternatives
    const decisionResult = await dcsnEngine.decide({
      domain: "architecture",
      scope: "src/auth/",
      summary: "Use JWT with jose library for stateless auth",
      context: "Need stateless auth for horizontal scaling",
      rationale: "jose is well-maintained, has no known vulns, supports all JWT features",
      constraints: ["Must be stateless", "Must support token refresh"],
      alternatives: [
        {
          option: "jsonwebtoken",
          pros: ["Popular", "Simple API"],
          cons: ["Known vulns in older versions"],
          reason_rejected: "Security concerns",
        },
        {
          option: "passport-jwt",
          pros: ["Express integration"],
          cons: ["Heavyweight", "Opinionated"],
          reason_rejected: "Too heavy for our needs",
        },
      ],
      confidence: "high",
      affected_files: ["src/auth/jwt.ts", "src/auth/middleware.ts"],
      affected_symbols: ["verifyToken", "createToken"],
    });
    expect(decisionResult.id).toHaveLength(26);

    // 6. Query why for the decision's scope — expect at least 1 decision
    const whyResult = await dcsnEngine.why("src/auth/");
    expect(whyResult.decisions.length).toBeGreaterThanOrEqual(1);
    expect(whyResult.active_count).toBeGreaterThanOrEqual(1);
    const jwtDecision = whyResult.decisions.find(
      (d) => d.summary === "Use JWT with jose library for stateless auth",
    );
    expect(jwtDecision).toBeDefined();
    expect(jwtDecision!.confidence).toBe("high");
    expect(jwtDecision!.alternatives_count).toBe(2);

    // 7. Verify the decision also appears as a blackboard entry (cross-post)
    const { entries: decisionEntries } = await bbEngine.read({
      entry_types: ["decision"],
    });
    expect(decisionEntries.length).toBeGreaterThanOrEqual(1);
    const crossPosted = decisionEntries.find(
      (e) =>
        e.summary === "Use JWT with jose library for stateless auth",
    );
    expect(crossPosted).toBeDefined();
    expect(crossPosted!.detail).toBe(
      "jose is well-maintained, has no known vulns, supports all JWT features",
    );

    // 8. Verify status counts
    // Total blackboard entries: 3 original + 1 decision cross-post = 4
    const { total_count: bbCount } = await bbEngine.read();
    expect(bbCount).toBe(4);

    // Active decisions: 1
    const index = await dcsnStore.getIndex();
    const activeCount = index.filter((e) => e.status === "active").length;
    expect(activeCount).toBe(1);
  });

  it("supersession workflow: new decision supersedes old", async () => {
    createServer(tmpDir);
    const twiningDir = path.join(tmpDir, ".twining");
    const bbStore = new BlackboardStore(twiningDir);
    const dcsnStore = new DecisionStore(twiningDir);
    const bbEngine = new BlackboardEngine(bbStore);
    const dcsnEngine = new DecisionEngine(dcsnStore, bbEngine);

    // Create first decision
    const first = await dcsnEngine.decide({
      domain: "architecture",
      scope: "src/auth/",
      summary: "Use sessions for auth",
      context: "Need auth",
      rationale: "Simple approach",
    });

    // Supersede with new decision
    const second = await dcsnEngine.decide({
      domain: "architecture",
      scope: "src/auth/",
      summary: "Switch to JWT",
      context: "Need stateless auth for scaling",
      rationale: "Sessions don't scale horizontally",
      supersedes: first.id,
    });

    // Verify first is superseded
    const { decisions } = await dcsnEngine.why("src/auth/");
    const firstDecision = decisions.find((d) => d.id === first.id);
    const secondDecision = decisions.find((d) => d.id === second.id);
    expect(firstDecision!.status).toBe("superseded");
    expect(secondDecision!.status).toBe("active");
  });

  it("server is idempotent on repeated creation", () => {
    createServer(tmpDir);
    // Second call should not fail
    createServer(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, ".twining"))).toBe(true);
  });
});
