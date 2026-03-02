/**
 * Shared types and Zod schemas for the parsed Twining behavioral specification.
 *
 * These types define the contract between:
 * - plugin/BEHAVIORS.md (the behavioral specification document)
 * - test/eval/behaviors-parser.ts (the parser, Plan 02)
 * - Phase 16 eval harness (the consumer)
 *
 * Both compile-time interfaces and runtime Zod schemas are exported.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod Schemas (runtime validation)
// ---------------------------------------------------------------------------

export const BehaviorRuleSchema = z.object({
  id: z.string().regex(/^[A-Z]+-\d+$/, "Rule ID must match TOOLNAME-NN pattern"),
  level: z.enum(["MUST", "SHOULD", "MUST_NOT"]),
  rule: z.string().min(10, "Rule text must be at least 10 characters"),
});

export const CodeExampleSchema = z.object({
  code: z.string().min(1),
  language: z.string().min(1),
});

export const ToolBehaviorSchema = z.object({
  name: z.string().startsWith("twining_", "Tool name must start with twining_"),
  tier: z.union([z.literal(1), z.literal(2)]),
  context: z.string().optional(),
  rules: z.array(BehaviorRuleSchema).min(1, "Each tool must have at least one rule"),
  correctUsage: CodeExampleSchema.optional(),
  incorrectUsage: CodeExampleSchema.optional(),
  incorrectReason: z.string().optional(),
});

export const WorkflowStepSchema = z.object({
  order: z.number().int().positive(),
  tool: z.string().startsWith("twining_", "Workflow step tool must start with twining_"),
  purpose: z.string().min(1),
});

export const WorkflowScenarioSchema = z.object({
  name: z.string().min(1),
  steps: z.array(WorkflowStepSchema).min(2, "Workflow must have at least 2 steps"),
});

export const AntiPatternSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  badExample: z.string().min(1),
  goodExample: z.string().min(1),
});

export const QualityLevelSchema = z.object({
  level: z.string().min(1),
  description: z.string().min(1),
  example: z.string().min(1),
});

export const QualityCriterionSchema = z.object({
  name: z.string().min(1),
  levels: z.array(QualityLevelSchema).min(2, "Quality criterion must have at least 2 levels"),
});

export const BehaviorSpecSchema = z.object({
  tools: z
    .array(ToolBehaviorSchema)
    .length(32, "Spec must contain exactly 32 tool entries"),
  workflows: z
    .array(WorkflowScenarioSchema)
    .min(8, "Spec must contain at least 8 workflow scenarios"),
  antiPatterns: z
    .array(AntiPatternSchema)
    .min(4, "Spec must contain at least 4 anti-patterns"),
  qualityCriteria: z
    .array(QualityCriterionSchema)
    .min(3, "Spec must contain at least 3 quality criteria"),
});

// ---------------------------------------------------------------------------
// TypeScript Interfaces (compile-time)
// ---------------------------------------------------------------------------

/** A single behavioral rule for a tool. */
export interface BehaviorRule {
  /** Rule identifier, e.g. "DECIDE-01". Matches /^[A-Z]+-\d+$/ */
  id: string;
  /** Rule severity level. */
  level: "MUST" | "SHOULD" | "MUST_NOT";
  /** Human-readable rule text. */
  rule: string;
}

/** A code example with language annotation. */
export interface CodeExample {
  /** The code content. */
  code: string;
  /** Language identifier (e.g. "json"). */
  language: string;
}

/** Behavioral specification for a single MCP tool. */
export interface ToolBehavior {
  /** Tool name, e.g. "twining_decide". Always starts with "twining_". */
  name: string;
  /** Tier 1 = core tools with full spec depth. Tier 2 = supporting tools with lighter coverage. */
  tier: 1 | 2;
  /** When and why to use this tool. */
  context?: string;
  /** Behavioral rules for this tool. At least one rule per tool. */
  rules: BehaviorRule[];
  /** Example of correct tool invocation. Tier 1 tools only. */
  correctUsage?: CodeExample;
  /** Example of incorrect tool invocation. Tier 1 tools only. */
  incorrectUsage?: CodeExample;
  /** Explanation of why the incorrect usage is wrong. */
  incorrectReason?: string;
}

/** A step in a multi-tool workflow scenario. */
export interface WorkflowStep {
  /** Step order (1-based). */
  order: number;
  /** Tool name to call at this step. */
  tool: string;
  /** Purpose of this step in the workflow. */
  purpose: string;
}

/** A named multi-tool workflow scenario. */
export interface WorkflowScenario {
  /** Workflow name, e.g. "orient" or "new-session-lifecycle". */
  name: string;
  /** Ordered steps in the workflow. At least 2 steps. */
  steps: WorkflowStep[];
}

/** A documented anti-pattern with bad/good examples. */
export interface AntiPattern {
  /** Anti-pattern identifier in kebab-case, e.g. "fire-and-forget-decisions". */
  id: string;
  /** Description of the anti-pattern. */
  description: string;
  /** Example of the bad practice. */
  badExample: string;
  /** Example of the corrected practice. */
  goodExample: string;
}

/** A quality level within a quality criterion. */
export interface QualityLevel {
  /** Level name, e.g. "good", "acceptable", "bad". */
  level: string;
  /** Description of what this quality level looks like. */
  description: string;
  /** Concrete example demonstrating this level. */
  example: string;
}

/** A named quality criterion with graded levels. */
export interface QualityCriterion {
  /** Criterion name in kebab-case, e.g. "scope-precision". */
  name: string;
  /** Quality levels from best to worst. At least 2 levels. */
  levels: QualityLevel[];
}

/** Top-level parsed behavioral specification. */
export interface BehaviorSpec {
  /** All 32 tool behaviors. */
  tools: ToolBehavior[];
  /** Multi-tool workflow scenarios (>= 8). */
  workflows: WorkflowScenario[];
  /** Anti-pattern catalog (>= 4). */
  antiPatterns: AntiPattern[];
  /** Quality criteria (>= 3). */
  qualityCriteria: QualityCriterion[];
}
