/**
 * MCP tool handler for twining_record — the unified recording tool.
 * Collapses twining_decide + twining_post(status) into one natural-language call.
 * Always creates a status post; optionally creates decision records and findings.
 */
import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BlackboardEngine } from "../engine/blackboard.js";
import type { DecisionEngine } from "../engine/decisions.js";
import { parseDecision } from "../engine/record-parser.js";
import { toolResult, toolError, TwiningError } from "../utils/errors.js";
import { writeRecordSentinel } from "../utils/record-sentinel.js";

// One quality nudge per server process (i.e. per session) — see #18.
let qualityNudgeSent = false;

/** Blackboard enforces a 200-char summary cap (see BlackboardEngine.post). */
const SUMMARY_MAX_LENGTH = 200;

/**
 * Truncate a summary to the blackboard's 200-char cap, preserving the full
 * text for the caller to fold into the entry's detail. Nothing is lost —
 * unlike a rejected post, a truncated one still succeeds.
 */
function truncateSummary(summary: string): {
  summary: string;
  truncated: boolean;
} {
  if (summary.length <= SUMMARY_MAX_LENGTH) {
    return { summary, truncated: false };
  }
  return { summary: summary.slice(0, 197) + "…", truncated: true };
}

/**
 * Infer scope from git diff when not explicitly provided.
 * Finds the common path prefix of changed files.
 */
function inferScopeFromGit(projectRoot: string): string | null {
  try {
    const output = execFileSync("git", ["diff", "--name-only", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    if (!output) return null;
    const files = output.split("\n").filter(Boolean);
    if (files.length === 0) return null;
    // Find common path prefix
    const parts = files[0]!.split("/");
    let prefix = "";
    for (let i = 0; i < parts.length - 1; i++) {
      const candidate = parts.slice(0, i + 1).join("/") + "/";
      if (files.every((f) => f.startsWith(candidate))) {
        prefix = candidate;
      } else {
        break;
      }
    }
    return prefix || null;
  } catch {
    return null;
  }
}

interface DecideInput {
  domain: string;
  summary: string;
  context: string;
  rationale: string;
  rationale_source?: "authored" | "derived";
  alternatives: Array<{
    option: string;
    pros?: string[];
    cons?: string[];
    reason_rejected?: string;
  }>;
  assumptions?: string[];
  constraints?: string[];
  confidence: "high" | "medium" | "low";
  status?: "active" | "provisional";
}

function buildFromNaturalLanguage(
  text: string,
  sessionSummary: string,
): DecideInput {
  const parsed = parseDecision(text);
  return {
    domain: parsed.domain,
    summary: parsed.summary,
    context: sessionSummary,
    rationale: parsed.rationale,
    rationale_source: parsed.rationale_source,
    // A rejected option whose reason the prose never stated is recorded with
    // no reason at all. The old placeholder ("Not chosen") filled the why-not
    // field with a tautology on every NL-derived alternative — 217 of 217 in
    // this project's own store — which is worse than an honest absence.
    alternatives: parsed.rejected_alternatives.map((alt) =>
      alt.reason_rejected
        ? { option: alt.option, reason_rejected: alt.reason_rejected }
        : { option: alt.option },
    ),
    confidence: "medium",
  };
}

interface StructuredDecision {
  summary: string;
  rationale?: string;
  context?: string;
  domain?: string;
  alternatives?: Array<{
    option: string;
    pros?: string[];
    cons?: string[];
    reason_rejected?: string;
  }>;
  assumptions?: string[];
  constraints?: string[];
  confidence?: "high" | "medium" | "low";
  status?: "active" | "provisional";
}

function buildFromStructured(
  item: StructuredDecision,
  sessionSummary: string,
): DecideInput {
  // Fill in defaults. Rationale defaults to the summary so decide() validation
  // passes; domain defaults to "implementation" when caller doesn't specify.
  const result: DecideInput = {
    domain: item.domain ?? "implementation",
    summary: item.summary,
    context: item.context ?? sessionSummary,
    rationale: item.rationale ?? item.summary,
    // The structured builder owns most laundering in practice: a caller that
    // supplies no rationale gets the summary echoed back, which reads as a
    // stated WHY unless it is marked.
    rationale_source: item.rationale ? "authored" : "derived",
    alternatives: item.alternatives ?? [],
    confidence: item.confidence ?? "medium",
  };
  if (item.assumptions !== undefined) result.assumptions = item.assumptions;
  if (item.constraints !== undefined) result.constraints = item.constraints;
  if (item.status !== undefined) result.status = item.status;
  return result;
}

/**
 * Parse a finding string, detecting "warning:" or "need:" prefixes for entry_type.
 * Default entry_type is "finding".
 */
function parseFinding(text: string): { entry_type: string; summary: string } {
  const lower = text.toLowerCase();
  if (lower.startsWith("warning:")) {
    return { entry_type: "warning", summary: text.slice("warning:".length).trim() };
  }
  if (lower.startsWith("need:")) {
    return { entry_type: "need", summary: text.slice("need:".length).trim() };
  }
  return { entry_type: "finding", summary: text };
}

export function registerRecordTools(
  server: McpServer,
  blackboardEngine: BlackboardEngine,
  decisionEngine: DecisionEngine,
  projectRoot: string,
  twiningDir: string,
  options: { fullSurface?: boolean } = {},
): void {
  const fullSurface = options.fullSurface ?? false;
  server.registerTool(
    "twining_record",
    {
      description:
        "Record what you did, any choices you made, and anything you discovered. Call before committing or ending a session. " +
        "The summary becomes a status post. Decisions become tracked records with rationale. " +
        "Findings become blackboard entries visible to future agents. Scope is auto-inferred from git diff if omitted.",
      inputSchema: {
        summary: z
          .string()
          .describe(
            "What you did this session — one or two sentences. Kept to 200 characters — " +
              "longer text is truncated with the full text preserved in the entry detail. " +
              "Lead with the most important information: similarity search weighs the " +
              "opening of the text most heavily.",
          ),
        decisions: z
          .array(
            z.union([
              z.string(),
              z.object({
                summary: z.string().describe("One-line decision statement"),
                rationale: z
                  .string()
                  .optional()
                  .describe(
                    "Reasoning for the choice. Skips the NL parser when provided.",
                  ),
                context: z
                  .string()
                  .optional()
                  .describe(
                    "Situation that prompted this decision (falls back to the session summary)",
                  ),
                domain: z
                  .string()
                  .optional()
                  .describe(
                    'Decision domain (e.g., "architecture", "implementation"). Inferred from content when omitted.',
                  ),
                alternatives: z
                  .array(
                    z.object({
                      option: z.string(),
                      pros: z.array(z.string()).optional(),
                      cons: z.array(z.string()).optional(),
                      reason_rejected: z.string(),
                    }),
                  )
                  .optional()
                  .describe("Alternatives that were considered and rejected"),
                assumptions: z
                  .array(z.string())
                  .optional()
                  .describe(
                    "Assumptions this decision depends on (overrides the session-level assumptions for this decision)",
                  ),
                constraints: z
                  .array(z.string())
                  .optional()
                  .describe(
                    "What limited the options (overrides the session-level constraints for this decision)",
                  ),
                confidence: z
                  .enum(["high", "medium", "low"])
                  .optional()
                  .describe('Confidence level (default: "medium")'),
                status: z
                  .enum(["active", "provisional"])
                  .optional()
                  .describe(
                    'Initial lifecycle status for THIS decision (default: "active"). "provisional" records it as awaiting ratification — it sits in the triage open lane until confirmed (twining_promote) or vetoed (twining_override). Requires tools.full_surface: true (the drain tools are full-surface). Cannot be combined with supersedes — the target would be retired before ratification. WARNING: twining_housekeeping with promote_provisionals + execute bulk-promotes provisionals older than 7 days with NO per-item review; leave that flag off if provisional is serving as your ratification queue.',
                  ),
              }),
            ]),
          )
          .optional()
          .describe(
            'Choices you made. Each item is either a natural-language sentence ' +
              '("Chose X over Y — reason") or a structured object ' +
              '({ summary, rationale, alternatives: [{ option, reason_rejected }] }) ' +
              'when the content is too long or too structured for the NL parser to split cleanly.',
          ),
        findings: z
          .array(z.string())
          .optional()
          .describe(
            'Discoveries, warnings, needs, and surprises — anything the next session would want to know that is not visible from the diff: odd patterns you noticed, fragile spots, dead ends you ruled out, things that did not work as expected. Prefix with "warning:" or "need:" for severity. ' +
            'E.g. ["Auth tokens stored in localStorage — fails SOC2", "warning: No token rotation exists", "need: Add rate limiting before launch"]. ' +
            'A substantial change with zero findings is usually under-recording, not a clean run. ' +
            'Lead each finding with the most important information — the first ~200 characters carry the most weight in similarity search.',
          ),
        assumptions: z
          .array(z.string())
          .optional()
          .describe(
            'Conditions your decisions depend on. E.g. ["Data is relational", "No strict ordering required"]',
          ),
        constraints: z
          .array(z.string())
          .optional()
          .describe(
            'What limited your options. E.g. ["Must support Node 18+", "Cannot add new dependencies"]',
          ),
        affected_files: z
          .array(z.string())
          .optional()
          .describe(
            "File paths you changed or that are affected by your decisions",
          ),
        affected_symbols: z
          .array(z.string())
          .optional()
          .describe(
            "Function/class/method names affected by your decisions",
          ),
        depends_on: z
          .array(z.string())
          .optional()
          .describe(
            "IDs of prior decisions that your decisions depend on (from twining_assemble or twining_why output)",
          ),
        supersedes: z
          .string()
          .optional()
          .describe(
            "ID of a prior decision that your work replaces or invalidates",
          ),
        reversible: z
          .boolean()
          .optional()
          .describe("Whether your decisions are easily reversible (default: true)"),
        commit_hash: z
          .string()
          .optional()
          .describe("Git commit hash to associate with these decisions"),
        scope: z
          .string()
          .optional()
          .describe('Area of codebase affected. Auto-inferred from git diff if omitted.'),
        agent_id: z
          .string()
          .optional()
          .describe("Agent identifier (default: main)"),
      },
    },
    async (args) => {
      try {
        // Auto-infer scope from git diff if not provided
        const scope = args.scope ?? inferScopeFromGit(projectRoot) ?? "project";
        const agentId = args.agent_id ?? "main";
        const createdDecisions: Array<{ id: string; summary: string }> = [];
        const createdFindings: Array<{ id: string; entry_type: string; summary: string }> = [];

        // 1. Always create a status post. A too-long summary is truncated
        // rather than rejected — the full text is prepended to detail so
        // nothing is lost (see decision B, 2026-07 field findings).
        const { summary: statusSummary, truncated: summaryTruncated } =
          truncateSummary(args.summary);
        const detailParts: string[] = [];
        if (summaryTruncated) {
          detailParts.push(`Full summary: ${args.summary}`);
        }
        if (args.decisions?.length) detailParts.push(`Decisions: ${args.decisions.join("; ")}`);
        if (args.findings?.length) detailParts.push(`Findings: ${args.findings.join("; ")}`);

        const statusEntry = await blackboardEngine.post({
          entry_type: "status",
          summary: statusSummary,
          detail: detailParts.join("\n"),
          // "session-record" marks the auto-emitted narration ONLY; findings
          // carry "session-finding" + origin "discovery" so consumers can
          // tell what the session did from what it found (field defect D1).
          tags: ["session-record"],
          origin: "narration",
          scope,
          agent_id: agentId,
        });

        // 2. Create decision records — each item is either NL (string) or structured object.
        const decisionErrors: string[] = [];
        const droppedDependsOnIds = new Set<string>();
        if (args.decisions?.length) {
          for (const item of args.decisions) {
            const input =
              typeof item === "string"
                ? buildFromNaturalLanguage(item, args.summary)
                : buildFromStructured(item, args.summary);

            // Provisional minting is full-surface only: every per-item drain
            // (twining_promote/twining_override/twining_reconsider) is gated
            // behind full_surface, so a default-surface provisional would be
            // unratifiable and unvetoable on the surface that created it.
            if (!fullSurface && input.status !== undefined) {
              decisionErrors.push(
                `"${input.summary}": status requires tools.full_surface: true — the provisional lifecycle tools (twining_promote/twining_override) are full-surface; this decision was NOT recorded`,
              );
              continue;
            }

            try {
              const decision = await decisionEngine.decide({
                ...input,
                scope,
                assumptions: input.assumptions ?? args.assumptions,
                constraints: input.constraints ?? args.constraints,
                depends_on: args.depends_on,
                supersedes: args.supersedes,
                reversible: args.reversible,
                affected_files: args.affected_files ?? [],
                affected_symbols: args.affected_symbols ?? [],
                commit_hash: args.commit_hash,
                agent_id: agentId,
              });
              createdDecisions.push({
                id: decision.id,
                summary: input.summary,
              });
              if (decision.dropped_depends_on?.length) {
                for (const id of decision.dropped_depends_on) {
                  droppedDependsOnIds.add(id);
                }
              }
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              decisionErrors.push(
                `"${input.summary.slice(0, 80)}${input.summary.length > 80 ? "…" : ""}": ${message}`,
              );
            }
          }
        }

        // 3. Create finding/warning/need entries. Over-length findings are
        // truncated (full text preserved in detail) rather than rejected,
        // and a post that genuinely fails is surfaced in findingErrors
        // instead of vanishing into a bare catch (see decision C).
        const findingErrors: string[] = [];
        if (args.findings?.length) {
          for (const text of args.findings) {
            const parsed = parseFinding(text);
            const { summary: findingSummary, truncated: findingTruncated } =
              truncateSummary(parsed.summary);
            try {
              const entry = await blackboardEngine.post({
                entry_type: parsed.entry_type,
                summary: findingSummary,
                detail: findingTruncated
                  ? `Full summary: ${parsed.summary}`
                  : "",
                tags: ["session-finding"],
                origin: "discovery",
                scope,
                agent_id: agentId,
              });
              createdFindings.push({
                id: entry.id,
                entry_type: parsed.entry_type,
                summary: findingSummary,
              });
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              findingErrors.push(
                `"${parsed.summary.slice(0, 80)}${parsed.summary.length > 80 ? "…" : ""}": ${message}`,
              );
            }
          }
        }

        const parts: string[] = ["Recorded status"];
        if (createdDecisions.length > 0) parts.push(`${createdDecisions.length} decision(s)`);
        if (createdFindings.length > 0) parts.push(`${createdFindings.length} finding(s)`);
        if (decisionErrors.length > 0)
          parts.push(`${decisionErrors.length} decision error(s)`);
        if (findingErrors.length > 0)
          parts.push(`${findingErrors.length} finding(s) failed`);
        if (droppedDependsOnIds.size > 0)
          parts.push(
            `ignored ${droppedDependsOnIds.size} unknown depends_on id(s): ${[...droppedDependsOnIds].join(", ")}`,
          );

        const response: Record<string, unknown> = {
          status_entry_id: statusEntry.id,
          decisions_created: createdDecisions,
          findings_created: createdFindings,
          scope,
          message: parts.join(" + "),
        };
        if (decisionErrors.length > 0) response.decision_errors = decisionErrors;
        if (findingErrors.length > 0) response.finding_errors = findingErrors;
        if (droppedDependsOnIds.size > 0)
          response.dropped_depends_on = [...droppedDependsOnIds];
        if (summaryTruncated) {
          response.message = `${response.message as string} (summary truncated to 200 chars — full text in detail)`;
        }

        // #18: one deterministic quality nudge per server lifetime — a
        // substantial record with zero findings usually means discoveries
        // went unrecorded, not that there were none. Never repeated:
        // repeated nagging is what degrades record quality in the first place.
        if (
          !qualityNudgeSent &&
          createdFindings.length === 0 &&
          ((args.affected_files?.length ?? 0) >= 5 ||
            createdDecisions.length >= 2)
        ) {
          qualityNudgeSent = true;
          response.quality_nudge =
            "No findings recorded for a substantial change. If anything surprised you — an odd pattern, a fragile spot, a dead end you ruled out — record it with one more twining_record({ findings: [...] }) call. If there was genuinely nothing notable, ignore this.";
        }

        writeRecordSentinel(twiningDir);
        return toolResult(response);
      } catch (e) {
        if (e instanceof TwiningError) {
          return toolError(e.message, e.code);
        }
        return toolError(
          e instanceof Error ? e.message : "Unknown error",
          "INTERNAL_ERROR",
        );
      }
    },
  );
}
