import { describe, it, expect } from "vitest";
import {
  ScenarioSchema,
  type NormalizedToolCall,
  type ScorerInput,
  normalizeScenario,
  type Scenario,
} from "./scenario-schema.js";

describe("ScenarioSchema", () => {
  const validScenario = {
    name: "Test scenario",
    description: "A test scenario for validation",
    category: "decide",
    tags: ["test"],
    tool_calls: [
      { tool: "twining_decide", arguments: { title: "Test decision" } },
    ],
    expected_scores: { decision_quality: true },
  };

  it("validates a complete valid scenario", () => {
    const result = ScenarioSchema.parse(validScenario);
    expect(result.name).toBe("Test scenario");
    expect(result.category).toBe("decide");
    expect(result.tool_calls).toHaveLength(1);
  });

  it("applies defaults for optional fields", () => {
    const minimal = {
      name: "Minimal",
      description: "Minimal scenario",
      category: "orient",
      tool_calls: [{ tool: "twining_assemble_context" }],
    };
    const result = ScenarioSchema.parse(minimal);
    expect(result.tags).toEqual([]);
    expect(result.expected_scores).toEqual({});
    expect(result.tool_calls[0].arguments).toEqual({});
  });

  it("rejects invalid category values", () => {
    expect(() =>
      ScenarioSchema.parse({ ...validScenario, category: "invalid" }),
    ).toThrow();
  });

  it("rejects empty tool_calls arrays", () => {
    expect(() =>
      ScenarioSchema.parse({ ...validScenario, tool_calls: [] }),
    ).toThrow();
  });

  it("rejects tool names not starting with twining_", () => {
    expect(() =>
      ScenarioSchema.parse({
        ...validScenario,
        tool_calls: [{ tool: "bad_tool" }],
      }),
    ).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() => ScenarioSchema.parse({ name: "Only name" })).toThrow();
  });
});

describe("NormalizedToolCall", () => {
  it("has required tool, arguments, and index fields", () => {
    const call: NormalizedToolCall = {
      tool: "twining_decide",
      arguments: { title: "test" },
      index: 0,
    };
    expect(call.tool).toBe("twining_decide");
    expect(call.index).toBe(0);
  });
});

describe("ScorerInput", () => {
  it("has calls array and optional metadata", () => {
    const input: ScorerInput = {
      calls: [
        { tool: "twining_decide", arguments: { title: "test" }, index: 0 },
      ],
    };
    expect(input.calls).toHaveLength(1);
    expect(input.metadata).toBeUndefined();
  });

  it("accepts metadata", () => {
    const input: ScorerInput = {
      calls: [],
      metadata: { source: "test" },
    };
    expect(input.metadata?.source).toBe("test");
  });
});

describe("normalizeScenario", () => {
  it("converts scenario tool_calls to ScorerInput with indices", () => {
    const scenario: Scenario = ScenarioSchema.parse({
      name: "Test",
      description: "Test normalization",
      category: "decide",
      tool_calls: [
        { tool: "twining_decide", arguments: { title: "Decision 1" } },
        { tool: "twining_post", arguments: { content: "Result" } },
      ],
    });

    const input = normalizeScenario(scenario);
    expect(input.calls).toHaveLength(2);
    expect(input.calls[0].index).toBe(0);
    expect(input.calls[1].index).toBe(1);
    expect(input.calls[0].tool).toBe("twining_decide");
    expect(input.calls[1].tool).toBe("twining_post");
  });
});
