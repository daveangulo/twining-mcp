import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { GraphStore } from "../src/storage/graph-store.js";
import { Exporter } from "../src/engine/exporter.js";

let tmpDir: string;
let blackboardStore: BlackboardStore;
let decisionStore: DecisionStore;
let graphStore: GraphStore;
let exporter: Exporter;

/** Set up stores in a temp directory with proper structure. */
function setupStores(dir: string) {
  // Create directory structure matching ensureInitialized
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
  fs.mkdirSync(path.join(dir, "graph"), { recursive: true });

  // Empty data files
  fs.writeFileSync(path.join(dir, "blackboard.jsonl"), "");
  fs.writeFileSync(
    path.join(dir, "decisions", "index.json"),
    JSON.stringify([], null, 2),
  );
  fs.writeFileSync(
    path.join(dir, "graph", "entities.json"),
    JSON.stringify([], null, 2),
  );
  fs.writeFileSync(
    path.join(dir, "graph", "relations.json"),
    JSON.stringify([], null, 2),
  );

  const bb = new BlackboardStore(dir);
  const ds = new DecisionStore(dir);
  const gs = new GraphStore(dir);
  return { blackboardStore: bb, decisionStore: ds, graphStore: gs };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-exporter-test-"));
  const stores = setupStores(tmpDir);
  blackboardStore = stores.blackboardStore;
  decisionStore = stores.decisionStore;
  graphStore = stores.graphStore;
  exporter = new Exporter(blackboardStore, decisionStore, graphStore);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Exporter.exportMarkdown", () => {
  it("exports empty state with all section headers and zeroed stats", async () => {
    const { markdown, stats } = await exporter.exportMarkdown();

    // Verify all section headers are present
    expect(markdown).toContain("# Twining State Export");
    expect(markdown).toContain("## Summary");
    expect(markdown).toContain("## Decisions");
    expect(markdown).toContain("## Blackboard");
    expect(markdown).toContain("## Knowledge Graph");
    expect(markdown).toContain("### Entities");
    expect(markdown).toContain("### Relations");

    // Verify empty placeholders
    expect(markdown).toContain("*No decisions recorded.*");
    expect(markdown).toContain("*No blackboard entries.*");
    expect(markdown).toContain("*No entities.*");
    expect(markdown).toContain("*No relations.*");

    // Verify zeroed stats
    expect(stats.blackboard_entries).toBe(0);
    expect(stats.decisions).toBe(0);
    expect(stats.graph_entities).toBe(0);
    expect(stats.graph_relations).toBe(0);
    expect(stats.scope).toBe("all");
  });

  it("exports decisions with full details", async () => {
    await decisionStore.create({
      agent_id: "test-agent",
      domain: "architecture",
      scope: "src/auth/",
      summary: "Use JWT for authentication",
      context: "Need auth for API endpoints",
      rationale: "JWT is stateless and scalable",
      constraints: [],
      alternatives: [
        {
          option: "Session cookies",
          pros: ["Simple"],
          cons: ["Stateful"],
          reason_rejected: "Not suitable for microservices",
        },
      ],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: ["src/auth/jwt.ts"],
      affected_symbols: ["JwtMiddleware"],
      commit_hashes: ["abc123"],
    });

    await decisionStore.create({
      agent_id: "test-agent",
      domain: "database",
      scope: "src/db/",
      summary: "Use PostgreSQL",
      context: "Need relational DB",
      rationale: "Best for structured data",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "medium",
      reversible: false,
      affected_files: ["src/db/connection.ts"],
      affected_symbols: [],
      commit_hashes: [],
    });

    const { markdown, stats } = await exporter.exportMarkdown();

    // Both decision summaries appear as headers
    expect(markdown).toContain("### Use JWT for authentication");
    expect(markdown).toContain("### Use PostgreSQL");

    // Full decision details
    expect(markdown).toContain("| Domain | architecture |");
    expect(markdown).toContain("| Scope | src/auth/ |");
    expect(markdown).toContain("| Confidence | high |");
    expect(markdown).toContain("**Context:** Need auth for API endpoints");
    expect(markdown).toContain("**Rationale:** JWT is stateless and scalable");
    expect(markdown).toContain("| Commits | abc123 |");

    // Alternatives
    expect(markdown).toContain("**Alternatives considered:**");
    expect(markdown).toContain("- Session cookies: Not suitable for microservices");

    // Second decision has no commits
    expect(markdown).toContain("| Commits | none |");

    // Stats
    expect(stats.decisions).toBe(2);
  });

  it("exports blackboard entries in a table", async () => {
    await blackboardStore.append({
      agent_id: "agent-1",
      entry_type: "finding",
      tags: ["test"],
      scope: "src/api/",
      summary: "API endpoint found",
      detail: "Details here",
    });

    await blackboardStore.append({
      agent_id: "agent-2",
      entry_type: "warning",
      tags: ["security"],
      scope: "src/auth/",
      summary: "Missing auth check",
      detail: "No auth on /admin",
    });

    await blackboardStore.append({
      agent_id: "agent-1",
      entry_type: "need",
      tags: ["feature"],
      scope: "project",
      summary: "Need rate limiting",
      detail: "Prevent abuse",
    });

    const { markdown, stats } = await exporter.exportMarkdown();

    // Verify table headers
    expect(markdown).toContain("| Timestamp | Type | Summary | Scope |");

    // Verify all three entries appear
    expect(markdown).toContain("| finding | API endpoint found | src/api/ |");
    expect(markdown).toContain("| warning | Missing auth check | src/auth/ |");
    expect(markdown).toContain("| need | Need rate limiting | project |");

    expect(stats.blackboard_entries).toBe(3);
  });

  it("exports graph entities and relations with resolved names", async () => {
    const entityA = await graphStore.addEntity({
      name: "AuthService",
      type: "class",
      properties: { file: "src/auth/service.ts" },
    });
    const entityB = await graphStore.addEntity({
      name: "UserModel",
      type: "class",
      properties: { file: "src/models/user.ts" },
    });

    await graphStore.addRelation({
      source: entityA.id,
      target: entityB.id,
      type: "depends_on",
    });

    const { markdown, stats } = await exporter.exportMarkdown();

    // Entities table (sorted alphabetically)
    expect(markdown).toContain("| AuthService | class |");
    expect(markdown).toContain("| UserModel | class |");

    // Relations table with resolved names (not IDs)
    expect(markdown).toContain("| AuthService | depends_on | UserModel |");

    expect(stats.graph_entities).toBe(2);
    expect(stats.graph_relations).toBe(1);
  });

  it("filters by scope to show only matching subset", async () => {
    // Create decisions in different scopes
    await decisionStore.create({
      agent_id: "test",
      domain: "auth",
      scope: "src/auth/",
      summary: "Auth decision",
      context: "ctx",
      rationale: "reason",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: ["src/auth/jwt.ts"],
      affected_symbols: [],
      commit_hashes: [],
    });

    await decisionStore.create({
      agent_id: "test",
      domain: "api",
      scope: "src/api/",
      summary: "API decision",
      context: "ctx",
      rationale: "reason",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "medium",
      reversible: true,
      affected_files: ["src/api/routes.ts"],
      affected_symbols: [],
      commit_hashes: [],
    });

    // Create blackboard entries in different scopes
    await blackboardStore.append({
      agent_id: "test",
      entry_type: "finding",
      tags: [],
      scope: "src/auth/",
      summary: "Auth finding",
      detail: "",
    });

    await blackboardStore.append({
      agent_id: "test",
      entry_type: "finding",
      tags: [],
      scope: "src/api/",
      summary: "API finding",
      detail: "",
    });

    // Export with scope filter
    const { markdown, stats } = await exporter.exportMarkdown("src/auth/");

    // Auth items should appear
    expect(markdown).toContain("### Auth decision");
    expect(markdown).toContain("Auth finding");

    // API items should NOT appear
    expect(markdown).not.toContain("### API decision");
    expect(markdown).not.toContain("API finding");

    // Stats reflect filtered counts
    expect(stats.decisions).toBe(1);
    expect(stats.blackboard_entries).toBe(1);
    expect(stats.scope).toBe("src/auth/");
  });

  it("exports all data together with correct stats", async () => {
    // Populate all three stores
    await blackboardStore.append({
      agent_id: "test",
      entry_type: "finding",
      tags: ["test"],
      scope: "project",
      summary: "Finding 1",
      detail: "detail",
    });

    await blackboardStore.append({
      agent_id: "test",
      entry_type: "warning",
      tags: ["test"],
      scope: "project",
      summary: "Warning 1",
      detail: "detail",
    });

    await decisionStore.create({
      agent_id: "test",
      domain: "arch",
      scope: "project",
      summary: "Decision 1",
      context: "ctx",
      rationale: "reason",
      constraints: [],
      alternatives: [],
      depends_on: [],
      confidence: "high",
      reversible: true,
      affected_files: [],
      affected_symbols: [],
      commit_hashes: [],
    });

    const entityA = await graphStore.addEntity({
      name: "ModuleA",
      type: "module",
    });
    const entityB = await graphStore.addEntity({
      name: "ModuleB",
      type: "module",
    });
    await graphStore.addRelation({
      source: entityA.id,
      target: entityB.id,
      type: "imports",
    });

    const { markdown, stats } = await exporter.exportMarkdown();

    // All data appears
    expect(markdown).toContain("Finding 1");
    expect(markdown).toContain("Warning 1");
    expect(markdown).toContain("### Decision 1");
    expect(markdown).toContain("| ModuleA | module |");
    expect(markdown).toContain("| ModuleB | module |");
    expect(markdown).toContain("| ModuleA | imports | ModuleB |");

    // Summary counts
    expect(markdown).toContain("- Blackboard entries: 2");
    expect(markdown).toContain("- Decisions: 1 (1 active, 0 provisional, 0 superseded, 0 overridden)");
    expect(markdown).toContain("- Graph entities: 2");
    expect(markdown).toContain("- Graph relations: 1");

    // Stats match
    expect(stats.blackboard_entries).toBe(2);
    expect(stats.decisions).toBe(1);
    expect(stats.graph_entities).toBe(2);
    expect(stats.graph_relations).toBe(1);
    expect(stats.scope).toBe("all");
  });
});
