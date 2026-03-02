/**
 * Test suite for the BEHAVIORS.md parser.
 *
 * Validates the parser against the ACTUAL plugin/BEHAVIORS.md file,
 * ensuring all 32 tool behaviors, workflows, anti-patterns, and quality
 * criteria are extracted correctly into typed BehaviorSpec objects.
 */
import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseBehaviors } from "./behaviors-parser";
import { BehaviorSpecSchema } from "./types";
import type { BehaviorSpec } from "./types";

describe("behaviors-parser", () => {
  let spec: BehaviorSpec;

  beforeAll(() => {
    const behaviorsPath = path.resolve(
      __dirname,
      "../../plugin/BEHAVIORS.md",
    );
    const content = fs.readFileSync(behaviorsPath, "utf-8");
    spec = parseBehaviors(content);
  });

  describe("top-level structure", () => {
    it("returns a BehaviorSpec with tools, workflows, antiPatterns, qualityCriteria", () => {
      expect(spec).toBeDefined();
      expect(spec.tools).toBeInstanceOf(Array);
      expect(spec.workflows).toBeInstanceOf(Array);
      expect(spec.antiPatterns).toBeInstanceOf(Array);
      expect(spec.qualityCriteria).toBeInstanceOf(Array);
    });

    it("validates against BehaviorSpecSchema", () => {
      const result = BehaviorSpecSchema.safeParse(spec);
      if (!result.success) {
        // Provide detailed error output for debugging
        console.error(
          "Zod validation errors:",
          JSON.stringify(result.error.issues, null, 2),
        );
      }
      expect(result.success).toBe(true);
    });
  });

  describe("tool behaviors", () => {
    it("has exactly 32 tool entries", () => {
      expect(spec.tools).toHaveLength(32);
    });

    it("each tool name starts with twining_", () => {
      for (const tool of spec.tools) {
        expect(tool.name).toMatch(/^twining_/);
      }
    });

    it("each tool has a tier of 1 or 2", () => {
      for (const tool of spec.tools) {
        expect([1, 2]).toContain(tool.tier);
      }
    });

    it("each tool has at least 1 rule", () => {
      for (const tool of spec.tools) {
        expect(tool.rules.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("tier 1 tools have correctUsage and incorrectUsage populated", () => {
      const tier1 = spec.tools.filter((t) => t.tier === 1);
      expect(tier1.length).toBeGreaterThanOrEqual(8);
      for (const tool of tier1) {
        expect(tool.correctUsage).toBeDefined();
        expect(tool.correctUsage!.code.length).toBeGreaterThan(0);
        expect(tool.incorrectUsage).toBeDefined();
        expect(tool.incorrectUsage!.code.length).toBeGreaterThan(0);
      }
    });

    it("tier 2 tools have rules but correctUsage/incorrectUsage may be absent", () => {
      const tier2 = spec.tools.filter((t) => t.tier === 2);
      expect(tier2.length).toBeGreaterThanOrEqual(20);
      for (const tool of tier2) {
        expect(tool.rules.length).toBeGreaterThanOrEqual(1);
      }
    });

    it("rule IDs match /^[A-Z]+-\\d+$/", () => {
      for (const tool of spec.tools) {
        for (const rule of tool.rules) {
          expect(rule.id).toMatch(/^[A-Z]+-\d+$/);
        }
      }
    });

    it("rule levels are MUST, SHOULD, or MUST_NOT", () => {
      for (const tool of spec.tools) {
        for (const rule of tool.rules) {
          expect(["MUST", "SHOULD", "MUST_NOT"]).toContain(rule.level);
        }
      }
    });

    it("total MUST rules count is between 8 and 12", () => {
      const mustCount = spec.tools.reduce(
        (sum, t) =>
          sum +
          t.rules.filter((r) => r.level === "MUST" || r.level === "MUST_NOT")
            .length,
        0,
      );
      expect(mustCount).toBeGreaterThanOrEqual(8);
      expect(mustCount).toBeLessThanOrEqual(12);
    });
  });

  describe("workflows", () => {
    it("has >= 8 workflow entries", () => {
      expect(spec.workflows.length).toBeGreaterThanOrEqual(8);
    });

    it("each workflow has >= 2 steps with order, tool, purpose", () => {
      for (const wf of spec.workflows) {
        expect(wf.steps.length).toBeGreaterThanOrEqual(2);
        for (const step of wf.steps) {
          expect(step.order).toBeGreaterThan(0);
          expect(step.tool).toMatch(/^twining_/);
          expect(step.purpose.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("anti-patterns", () => {
    it("has >= 4 anti-pattern entries", () => {
      expect(spec.antiPatterns.length).toBeGreaterThanOrEqual(4);
    });

    it("each anti-pattern has id, description, badExample, goodExample", () => {
      for (const ap of spec.antiPatterns) {
        expect(ap.id.length).toBeGreaterThan(0);
        expect(ap.description.length).toBeGreaterThan(0);
        expect(ap.badExample.length).toBeGreaterThan(0);
        expect(ap.goodExample.length).toBeGreaterThan(0);
      }
    });
  });

  describe("quality criteria", () => {
    it("has >= 3 quality criteria entries", () => {
      expect(spec.qualityCriteria.length).toBeGreaterThanOrEqual(3);
    });

    it("each criterion has >= 2 levels", () => {
      for (const qc of spec.qualityCriteria) {
        expect(qc.levels.length).toBeGreaterThanOrEqual(2);
        for (const level of qc.levels) {
          expect(level.level.length).toBeGreaterThan(0);
          expect(level.description.length).toBeGreaterThan(0);
          expect(level.example.length).toBeGreaterThan(0);
        }
      }
    });
  });

  describe("parser robustness", () => {
    it("handles blank lines between sections without breaking", () => {
      // The real BEHAVIORS.md has blank lines between sections.
      // If we get here with a valid spec, the parser handles them.
      expect(spec.tools.length).toBe(32);
      expect(spec.workflows.length).toBeGreaterThanOrEqual(8);
    });
  });
});
