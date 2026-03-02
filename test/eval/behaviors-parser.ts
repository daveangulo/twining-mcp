/**
 * Line-by-line state machine parser for plugin/BEHAVIORS.md.
 *
 * Transforms the structured markdown behavioral specification into typed
 * BehaviorSpec objects conforming to test/eval/types.ts.
 *
 * This is a format-specific extractor for a controlled document,
 * NOT a general markdown parser. No markdown AST libraries are used.
 */
import type {
  BehaviorSpec,
  ToolBehavior,
  BehaviorRule,
  CodeExample,
  WorkflowScenario,
  WorkflowStep,
  AntiPattern,
  QualityCriterion,
  QualityLevel,
} from "./types";

// ---------------------------------------------------------------------------
// Top-level section detection
// ---------------------------------------------------------------------------
type Section =
  | "none"
  | "tool-behaviors"
  | "workflows"
  | "anti-patterns"
  | "quality-criteria";

// Sub-section within a tool behavior
type ToolSubsection =
  | "none"
  | "context"
  | "rules"
  | "correct-usage"
  | "incorrect-usage";

// ---------------------------------------------------------------------------
// Helper: parse a markdown table (rows only, skip header + separator)
// ---------------------------------------------------------------------------
interface TableResult {
  headers: string[];
  rows: string[][];
  endIdx: number;
}

function parseMarkdownTable(lines: string[], startIdx: number): TableResult {
  const headers: string[] = [];
  const rows: string[][] = [];
  let i = startIdx;

  // Find header row (first line with |)
  while (i < lines.length && !lines[i].trim().startsWith("|")) {
    i++;
  }
  if (i >= lines.length) return { headers, rows, endIdx: i };

  // Parse header
  const headerCells = lines[i]
    .split("|")
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  headers.push(...headerCells);
  i++;

  // Skip separator row (|---|---|...)
  if (i < lines.length && /^\|[\s-|]+\|$/.test(lines[i].trim())) {
    i++;
  }

  // Parse data rows
  while (i < lines.length && lines[i].trim().startsWith("|")) {
    const cells = lines[i]
      .split("|")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cells.length > 0) {
      rows.push(cells);
    }
    i++;
  }

  return { headers, rows, endIdx: i };
}

// ---------------------------------------------------------------------------
// Helper: extract a fenced code block
// ---------------------------------------------------------------------------
interface CodeBlockResult {
  code: string;
  language: string;
  endIdx: number;
}

function extractCodeBlock(
  lines: string[],
  startIdx: number,
): CodeBlockResult | null {
  let i = startIdx;

  // Find opening fence
  while (i < lines.length && !lines[i].trim().startsWith("```")) {
    i++;
  }
  if (i >= lines.length) return null;

  const openLine = lines[i].trim();
  const language = openLine.replace(/^```/, "").trim() || "text";
  i++;

  const codeLines: string[] = [];
  while (i < lines.length && !lines[i].trim().startsWith("```")) {
    codeLines.push(lines[i]);
    i++;
  }

  // Skip closing fence
  if (i < lines.length) i++;

  return { code: codeLines.join("\n"), language, endIdx: i };
}

// ---------------------------------------------------------------------------
// Helper: collect prose lines until a stop pattern
// ---------------------------------------------------------------------------
function collectProse(
  lines: string[],
  startIdx: number,
  stopPattern: RegExp,
): { text: string; endIdx: number } {
  const collected: string[] = [];
  let i = startIdx;
  while (i < lines.length) {
    if (stopPattern.test(lines[i])) break;
    collected.push(lines[i]);
    i++;
  }
  return { text: collected.join("\n").trim(), endIdx: i };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------
export function parseBehaviors(markdown: string): BehaviorSpec {
  const lines = markdown.split("\n");
  const tools: ToolBehavior[] = [];
  const workflows: WorkflowScenario[] = [];
  const antiPatterns: AntiPattern[] = [];
  const qualityCriteria: QualityCriterion[] = [];

  let section: Section = "none";
  let currentTool: ToolBehavior | null = null;
  let toolSubsection: ToolSubsection = "none";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // --- Top-level section detection (## headings) ---
    if (trimmed.startsWith("## ") && !trimmed.startsWith("### ")) {
      const heading = trimmed.replace(/^##\s+/, "").toLowerCase();
      if (heading === "tool behaviors") {
        // Finalize any in-progress tool
        if (currentTool) {
          tools.push(currentTool);
          currentTool = null;
        }
        section = "tool-behaviors";
        toolSubsection = "none";
      } else if (heading === "workflows") {
        if (currentTool) {
          tools.push(currentTool);
          currentTool = null;
        }
        section = "workflows";
      } else if (heading === "anti-patterns") {
        section = "anti-patterns";
      } else if (heading === "quality criteria") {
        section = "quality-criteria";
      }
      i++;
      continue;
    }

    // --- Tool Behaviors section ---
    if (section === "tool-behaviors") {
      // New tool: ### twining_*
      if (trimmed.startsWith("### twining_")) {
        if (currentTool) {
          tools.push(currentTool);
        }
        const toolName = trimmed.replace(/^###\s+/, "");
        currentTool = {
          name: toolName,
          tier: 2, // default, overridden by tier comment
          rules: [],
        };
        toolSubsection = "none";
        i++;
        continue;
      }

      // Tier comment: <!-- tier: N -->
      if (trimmed.startsWith("<!-- tier:") && currentTool) {
        const match = trimmed.match(/tier:\s*(\d)/);
        if (match) {
          currentTool.tier = parseInt(match[1], 10) as 1 | 2;
        }
        i++;
        continue;
      }

      // Sub-section headings within a tool
      if (trimmed.startsWith("#### ") && currentTool) {
        const sub = trimmed.replace(/^####\s+/, "").toLowerCase();
        if (sub === "context") {
          toolSubsection = "context";
          i++;
          // Collect prose until next #### or ### or ##
          const { text, endIdx } = collectProse(
            lines,
            i,
            /^(####|###|##)\s|^---$/,
          );
          currentTool.context = text;
          i = endIdx;
          continue;
        } else if (sub === "rules") {
          toolSubsection = "rules";
          i++;
          // Parse the rules table
          const table = parseMarkdownTable(lines, i);
          for (const row of table.rows) {
            if (row.length >= 3) {
              const rule: BehaviorRule = {
                id: row[0].trim(),
                level: row[1].trim() as "MUST" | "SHOULD" | "MUST_NOT",
                rule: row[2].trim(),
              };
              currentTool.rules.push(rule);
            }
          }
          i = table.endIdx;
          continue;
        } else if (sub === "correct usage") {
          toolSubsection = "correct-usage";
          i++;
          const block = extractCodeBlock(lines, i);
          if (block) {
            currentTool.correctUsage = {
              code: block.code,
              language: block.language,
            };
            i = block.endIdx;
          }
          continue;
        } else if (sub === "incorrect usage") {
          toolSubsection = "incorrect-usage";
          i++;
          const block = extractCodeBlock(lines, i);
          if (block) {
            currentTool.incorrectUsage = {
              code: block.code,
              language: block.language,
            };
            i = block.endIdx;
          }
          continue;
        }
      }

      // **Why incorrect:** line
      if (
        trimmed.startsWith("**Why incorrect:**") &&
        currentTool &&
        toolSubsection === "incorrect-usage"
      ) {
        const reason = trimmed.replace(/^\*\*Why incorrect:\*\*\s*/, "");
        currentTool.incorrectReason = reason;
        i++;
        continue;
      }

      i++;
      continue;
    }

    // --- Workflows section ---
    if (section === "workflows") {
      // ### workflow: name
      if (trimmed.startsWith("### workflow:")) {
        const name = trimmed.replace(/^###\s+workflow:\s*/, "").trim();
        i++;
        // Parse the workflow table
        const table = parseMarkdownTable(lines, i);
        const steps: WorkflowStep[] = [];
        for (const row of table.rows) {
          if (row.length >= 3) {
            steps.push({
              order: parseInt(row[0], 10),
              tool: row[1].trim(),
              purpose: row[2].trim(),
            });
          }
        }
        workflows.push({ name, steps });
        i = table.endIdx;
        continue;
      }
      i++;
      continue;
    }

    // --- Anti-Patterns section ---
    if (section === "anti-patterns") {
      // ### anti-pattern: id
      if (trimmed.startsWith("### anti-pattern:")) {
        const id = trimmed.replace(/^###\s+anti-pattern:\s*/, "").trim();
        i++;

        let description = "";
        let badExample = "";
        let goodExample = "";

        // Parse structured fields until next ### or ## or ---
        while (i < lines.length) {
          const apLine = lines[i].trim();

          // Stop at next anti-pattern, section, or horizontal rule
          if (
            apLine.startsWith("### ") ||
            (apLine.startsWith("## ") && !apLine.startsWith("### ")) ||
            apLine === "---"
          ) {
            break;
          }

          if (apLine.startsWith("**Description:**")) {
            description = apLine
              .replace(/^\*\*Description:\*\*\s*/, "")
              .trim();
            i++;
            continue;
          }

          if (apLine.startsWith("**Bad:**")) {
            i++;
            // Collect until **Good:**
            const parts: string[] = [];
            while (i < lines.length) {
              const bl = lines[i].trim();
              if (bl.startsWith("**Good:**")) break;
              if (bl.length > 0) parts.push(bl);
              i++;
            }
            badExample = parts.join(" ");
            continue;
          }

          if (apLine.startsWith("**Good:**")) {
            i++;
            // Collect until next ### or ## or ---
            const parts: string[] = [];
            while (i < lines.length) {
              const gl = lines[i].trim();
              if (
                gl.startsWith("### ") ||
                (gl.startsWith("## ") && !gl.startsWith("### ")) ||
                gl === "---"
              ) {
                break;
              }
              if (gl.length > 0) parts.push(gl);
              i++;
            }
            goodExample = parts.join(" ");
            continue;
          }

          i++;
        }

        antiPatterns.push({ id, description, badExample, goodExample });
        continue;
      }
      i++;
      continue;
    }

    // --- Quality Criteria section ---
    if (section === "quality-criteria") {
      // ### quality: name
      if (trimmed.startsWith("### quality:")) {
        const name = trimmed.replace(/^###\s+quality:\s*/, "").trim();
        i++;
        // Parse the quality table
        const table = parseMarkdownTable(lines, i);
        const levels: QualityLevel[] = [];
        for (const row of table.rows) {
          if (row.length >= 3) {
            levels.push({
              level: row[0].trim(),
              description: row[1].trim(),
              example: row[2].trim(),
            });
          }
        }
        qualityCriteria.push({ name, levels });
        i = table.endIdx;
        continue;
      }
      i++;
      continue;
    }

    // Default: skip line
    i++;
  }

  // Finalize last tool if still in progress
  if (currentTool) {
    tools.push(currentTool);
  }

  return { tools, workflows, antiPatterns, qualityCriteria };
}
