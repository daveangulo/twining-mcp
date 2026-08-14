/**
 * Amend-candidates reporter (re-scoped field D13 ask 1): report-only
 * scope→candidate-file expansion for decisions with empty affected_files.
 * twining_amend is the sole write path — this pass never mutates anything.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DecisionStore } from "../src/storage/decision-store.js";
import { reportAmendCandidates } from "../src/engine/amend-candidates.js";

let projectRoot: string;
let twiningDir: string;
let store: DecisionStore;

const base = {
  agent_id: "t",
  domain: "implementation",
  context: "ctx",
  constraints: [],
  alternatives: [],
  depends_on: [],
  confidence: "medium" as const,
  reversible: true,
  affected_symbols: [],
};

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "twining-amend-cand-"));
  twiningDir = path.join(projectRoot, ".twining");
  fs.mkdirSync(path.join(twiningDir, "decisions"), { recursive: true });
  fs.writeFileSync(
    path.join(twiningDir, "decisions", "index.json"),
    JSON.stringify([]),
  );
  fs.mkdirSync(path.join(projectRoot, "src", "gate"), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, "src", "gate", "alpha-cache.ts"),
    "",
  );
  fs.writeFileSync(
    path.join(projectRoot, "src", "gate", "unrelated-widget.ts"),
    "",
  );
  fs.mkdirSync(path.join(projectRoot, "src", "gate", "node_modules"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(projectRoot, "src", "gate", "node_modules", "alpha-cache.js"),
    "",
  );
  store = new DecisionStore(twiningDir);
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe("reportAmendCandidates", () => {
  it("ranks scope files by term overlap for empty-list decisions and never mutates", async () => {
    const target = await store.create({
      ...base,
      scope: "src/gate/",
      summary: "Adopt the alpha cache eviction strategy",
      rationale: "The alpha cache needs bounded eviction",
      affected_files: [],
    });
    await store.create({
      ...base,
      scope: "src/gate/",
      summary: "Already has files",
      rationale: "r",
      affected_files: ["src/gate/unrelated-widget.ts"],
    });
    const projectScoped = await store.create({
      ...base,
      scope: "project",
      summary: "Repo-wide choice",
      rationale: "r",
      affected_files: [],
    });

    const report = await reportAmendCandidates(store, projectRoot);

    expect(report.decisions_scanned).toBe(1);
    expect(report.skipped_project_scope).toBe(1);
    expect(report.decisions_with_candidates).toHaveLength(1);
    const entry = report.decisions_with_candidates[0]!;
    expect(entry.id).toBe(target.id);
    // alpha-cache.ts shares "alpha"+"cache"; node_modules copy excluded.
    expect(entry.candidates[0]!.file).toBe("src/gate/alpha-cache.ts");
    expect(
      entry.candidates.some((c) => c.file.includes("node_modules")),
    ).toBe(false);
    // Mutation-strength (review finding): the overlap>0 filter is the wall-3
    // guard — a zero-overlap file must never appear as a candidate.
    expect(
      entry.candidates.some((c) => c.file.includes("unrelated-widget")),
    ).toBe(false);
    expect(report.note).toContain("twining_amend");

    // Report-only: the store is untouched.
    const after = await store.get(target.id);
    expect(after!.affected_files).toEqual([]);
    expect(after!.amendments).toBeUndefined();
  });

  it("reports a missing scope directory instead of failing", async () => {
    await store.create({
      ...base,
      scope: "specs/ghost/",
      summary: "Scope moved away",
      rationale: "r",
      affected_files: [],
    });
    const report = await reportAmendCandidates(store, projectRoot);
    expect(report.decisions_scanned).toBe(1);
    expect(report.scope_missing).toBe(1);
    expect(report.decisions_with_candidates).toHaveLength(0);
  });

  it("never walks outside the project root, and root-equivalent scopes join the project skip", async () => {
    fs.mkdirSync(path.join(path.dirname(projectRoot), "sibling-secret"), {
      recursive: true,
    });
    await store.create({
      ...base,
      scope: "../sibling-secret/",
      summary: "Escape attempt",
      rationale: "r",
      affected_files: [],
    });
    await store.create({
      ...base,
      scope: "./",
      summary: "Root equivalent",
      rationale: "r",
      affected_files: [],
    });
    const report = await reportAmendCandidates(store, projectRoot);
    expect(report.scope_outside_root).toBe(1);
    expect(report.skipped_project_scope).toBe(1);
    expect(report.decisions_with_candidates).toHaveLength(0);
  });

  it("scans provisional decisions too", async () => {
    await store.create({
      ...base,
      scope: "src/gate/",
      summary: "Provisional alpha cache choice",
      rationale: "alpha cache",
      affected_files: [],
      status: "provisional",
    });
    const report = await reportAmendCandidates(store, projectRoot);
    expect(report.decisions_with_candidates).toHaveLength(1);
  });
});
