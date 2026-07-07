import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";

let dir: string;
let errorSpy: ReturnType<typeof vi.spyOn>;

function writeConfig(weightsYaml: string): void {
  fs.writeFileSync(
    path.join(dir, "config.yml"),
    `version: 1\nproject_name: test\ncontext_assembly:\n  priority_weights:\n${weightsYaml}`,
  );
}

function warningText(): string {
  return errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-weights-"));
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("priority_weights resolution (issue #34)", () => {
  it("treats a partial set summing to 1.0 as complete: user weights apply, missing keys become 0", () => {
    writeConfig("    recency: 0.5\n    relevance: 0.5\n");
    const config = loadConfig(dir);
    expect(config.context_assembly.priority_weights).toEqual({
      recency: 0.5,
      relevance: 0.5,
      decision_confidence: 0,
      warning_boost: 0,
      graph_reachability: 0,
    });
  });

  it("applies the four-key 1.0 set from this repo's own config shape (graph_reachability zeroed, not discarded)", () => {
    writeConfig(
      "    recency: 0.3\n    relevance: 0.4\n    decision_confidence: 0.2\n    warning_boost: 0.1\n",
    );
    const config = loadConfig(dir);
    expect(config.context_assembly.priority_weights).toEqual({
      recency: 0.3,
      relevance: 0.4,
      decision_confidence: 0.2,
      warning_boost: 0.1,
      graph_reachability: 0,
    });
  });

  it("warns actionably when zeroing missing keys: provided weights, action taken, effective weights", () => {
    writeConfig("    recency: 0.5\n    relevance: 0.5\n");
    loadConfig(dir);
    const text = warningText();
    expect(text).toContain("recency=0.5");
    expect(text).toContain("relevance=0.5");
    expect(text).toMatch(/set to 0/);
    expect(text).toContain("graph_reachability");
    expect(text).toMatch(/[Ee]ffective weights/);
  });

  it("rescales the merged set proportionally when it does not sum to 1.0 (never discards user weights)", () => {
    // User overrides recency only: merged = {0.5, 0.2, 0.15, 0.1, 0.35}, sum 1.3
    writeConfig("    recency: 0.5\n");
    const config = loadConfig(dir);
    const w = config.context_assembly.priority_weights;
    expect(w.recency).toBeCloseTo(0.5 / 1.3, 10);
    expect(w.relevance).toBeCloseTo(0.2 / 1.3, 10);
    expect(w.decision_confidence).toBeCloseTo(0.15 / 1.3, 10);
    expect(w.warning_boost).toBeCloseTo(0.1 / 1.3, 10);
    expect(w.graph_reachability).toBeCloseTo(0.35 / 1.3, 10);
    const sum = Object.values(w).reduce((a, b) => (a ?? 0) + (b ?? 0), 0);
    expect(sum).toBeCloseTo(1.0, 10);
    // User's weight remains the largest — proportions preserved
    expect(w.recency).toBeGreaterThan(w.graph_reachability!);
  });

  it("warns actionably when rescaling: provided weights, rescale action, effective weights", () => {
    writeConfig("    recency: 0.5\n");
    loadConfig(dir);
    const text = warningText();
    expect(text).toContain("recency=0.5");
    expect(text).toMatch(/rescal/i);
    expect(text).toMatch(/[Ee]ffective weights/);
  });

  it("leaves a complete valid set untouched with no warning", () => {
    writeConfig(
      "    recency: 0.2\n    relevance: 0.2\n    decision_confidence: 0.2\n    warning_boost: 0.2\n    graph_reachability: 0.2\n",
    );
    const config = loadConfig(dir);
    expect(config.context_assembly.priority_weights).toEqual({
      recency: 0.2,
      relevance: 0.2,
      decision_confidence: 0.2,
      warning_boost: 0.2,
      graph_reachability: 0.2,
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("accepts a complete set within the ±0.01 tolerance without warning", () => {
    writeConfig(
      "    recency: 0.301\n    relevance: 0.4\n    decision_confidence: 0.2\n    warning_boost: 0.1\n    graph_reachability: 0.005\n",
    );
    const config = loadConfig(dir);
    expect(config.context_assembly.priority_weights.recency).toBe(0.301);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("falls back to full defaults on negative weights and says so", () => {
    writeConfig("    recency: -0.5\n    relevance: 1.5\n");
    const config = loadConfig(dir);
    expect(config.context_assembly.priority_weights).toEqual(
      DEFAULT_CONFIG.context_assembly.priority_weights,
    );
    const text = warningText();
    expect(text).toMatch(/invalid/i);
    expect(text).toContain("recency=-0.5");
    expect(text).toMatch(/default/i);
  });

  it("falls back to full defaults on non-numeric weights and says so", () => {
    writeConfig('    recency: "high"\n    relevance: 0.5\n');
    const config = loadConfig(dir);
    expect(config.context_assembly.priority_weights).toEqual(
      DEFAULT_CONFIG.context_assembly.priority_weights,
    );
    expect(warningText()).toMatch(/invalid/i);
  });

  it("falls back to full defaults on an all-zero set and says so", () => {
    writeConfig(
      "    recency: 0\n    relevance: 0\n    decision_confidence: 0\n    warning_boost: 0\n    graph_reachability: 0\n",
    );
    const config = loadConfig(dir);
    expect(config.context_assembly.priority_weights).toEqual(
      DEFAULT_CONFIG.context_assembly.priority_weights,
    );
    expect(warningText()).toMatch(/zero/i);
  });

  it("uses defaults silently when priority_weights is absent", () => {
    fs.writeFileSync(
      path.join(dir, "config.yml"),
      "version: 1\nproject_name: test\n",
    );
    const config = loadConfig(dir);
    expect(config.context_assembly.priority_weights).toEqual(
      DEFAULT_CONFIG.context_assembly.priority_weights,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("uses defaults silently when priority_weights is an empty mapping", () => {
    writeConfig("    {}\n");
    const config = loadConfig(dir);
    expect(config.context_assembly.priority_weights).toEqual(
      DEFAULT_CONFIG.context_assembly.priority_weights,
    );
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("falls back to defaults with a warning when priority_weights is not a mapping", () => {
    fs.writeFileSync(
      path.join(dir, "config.yml"),
      "version: 1\ncontext_assembly:\n  priority_weights: lots\n",
    );
    const config = loadConfig(dir);
    expect(config.context_assembly.priority_weights).toEqual(
      DEFAULT_CONFIG.context_assembly.priority_weights,
    );
    expect(warningText()).toMatch(/default/i);
  });
});
