import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadScenario, loadScenarios } from "./scenario-loader.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const VALID_YAML = `
name: Test scenario
description: A basic test scenario
category: decide
tags:
  - test
  - decision
tool_calls:
  - tool: twining_decide
    arguments:
      title: Test decision
      rationale: Because testing
expected_scores:
  decision_quality: true
`;

const VALID_YAML_2 = `
name: Another scenario
description: Second test scenario
category: orient
tags:
  - test
tool_calls:
  - tool: twining_assemble_context
    arguments:
      scope: full
`;

const INVALID_YAML_MISSING_TOOL_CALLS = `
name: Bad scenario
description: Missing tool_calls field
category: decide
`;

const INVALID_YAML_BAD_CATEGORY = `
name: Bad category
description: Invalid category value
category: nonexistent
tool_calls:
  - tool: twining_decide
    arguments:
      title: Test
`;

describe("loadScenario", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-loader-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads and validates a valid YAML scenario file", () => {
    const filePath = path.join(tmpDir, "test.yaml");
    fs.writeFileSync(filePath, VALID_YAML);

    const scenario = loadScenario(filePath);
    expect(scenario.name).toBe("Test scenario");
    expect(scenario.category).toBe("decide");
    expect(scenario.tool_calls).toHaveLength(1);
    expect(scenario.tool_calls[0].tool).toBe("twining_decide");
    expect(scenario.tags).toEqual(["test", "decision"]);
  });

  it("throws with filename in error when validation fails (missing tool_calls)", () => {
    const filePath = path.join(tmpDir, "bad.yaml");
    fs.writeFileSync(filePath, INVALID_YAML_MISSING_TOOL_CALLS);

    expect(() => loadScenario(filePath)).toThrow(/bad\.yaml/);
  });

  it("throws with filename in error when category is invalid", () => {
    const filePath = path.join(tmpDir, "bad-category.yaml");
    fs.writeFileSync(filePath, INVALID_YAML_BAD_CATEGORY);

    expect(() => loadScenario(filePath)).toThrow(/bad-category\.yaml/);
  });
});

describe("loadScenarios", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-scenarios-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loads all .yaml files from a directory", () => {
    fs.writeFileSync(path.join(tmpDir, "scenario-a.yaml"), VALID_YAML);
    fs.writeFileSync(path.join(tmpDir, "scenario-b.yaml"), VALID_YAML_2);

    const scenarios = loadScenarios(tmpDir);
    expect(scenarios).toHaveLength(2);
  });

  it("returns scenarios sorted by name", () => {
    fs.writeFileSync(path.join(tmpDir, "z-file.yaml"), VALID_YAML);
    fs.writeFileSync(path.join(tmpDir, "a-file.yaml"), VALID_YAML_2);

    const scenarios = loadScenarios(tmpDir);
    expect(scenarios[0].name).toBe("Another scenario");
    expect(scenarios[1].name).toBe("Test scenario");
  });

  it("ignores non-yaml files", () => {
    fs.writeFileSync(path.join(tmpDir, "scenario.yaml"), VALID_YAML);
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "not a scenario");
    fs.writeFileSync(path.join(tmpDir, "data.json"), "{}");

    const scenarios = loadScenarios(tmpDir);
    expect(scenarios).toHaveLength(1);
  });

  it("throws with filename context when a scenario is invalid", () => {
    fs.writeFileSync(path.join(tmpDir, "good.yaml"), VALID_YAML);
    fs.writeFileSync(
      path.join(tmpDir, "bad.yaml"),
      INVALID_YAML_MISSING_TOOL_CALLS,
    );

    expect(() => loadScenarios(tmpDir)).toThrow(/bad\.yaml/);
  });

  it("returns empty array when directory has no yaml files", () => {
    const scenarios = loadScenarios(tmpDir);
    expect(scenarios).toEqual([]);
  });
});
