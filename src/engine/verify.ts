/**
 * Verification engine — checks rigor of agent work.
 * Implements 5 checks: test_coverage, warnings, assembly, drift, constraints.
 * Auto-posts a finding with the verification summary.
 */
import { execSync, execFileSync } from "node:child_process";
import type { DecisionStore } from "../storage/decision-store.js";
import type { BlackboardStore } from "../storage/blackboard-store.js";
import type { BlackboardEngine } from "./blackboard.js";
import type { GraphEngine } from "./graph.js";
import type {
  VerifyResult,
  TestCoverageCheck,
  WarningsCheck,
  AssemblyCheck,
  DriftCheck,
  ConstraintsCheck,
} from "../utils/types.js";

const ALL_CHECKS = [
  "test_coverage",
  "warnings",
  "assembly",
  "drift",
  "constraints",
] as const;
type CheckName = (typeof ALL_CHECKS)[number];

export class VerifyEngine {
  private readonly decisionStore: DecisionStore;
  private readonly blackboardStore: BlackboardStore;
  private readonly blackboardEngine: BlackboardEngine;
  private readonly graphEngine: GraphEngine | null;
  private readonly projectRoot: string;
  private assemblyChecker?: (agentId: string) => boolean;

  constructor(
    decisionStore: DecisionStore,
    blackboardStore: BlackboardStore,
    blackboardEngine: BlackboardEngine,
    graphEngine: GraphEngine | null,
    projectRoot: string,
  ) {
    this.decisionStore = decisionStore;
    this.blackboardStore = blackboardStore;
    this.blackboardEngine = blackboardEngine;
    this.graphEngine = graphEngine;
    this.projectRoot = projectRoot;
  }

  /** Set the function that checks assembly status for an agent. */
  setAssemblyChecker(checker: (agentId: string) => boolean): void {
    this.assemblyChecker = checker;
  }

  /** Run verification checks on the given scope. */
  async verify(input: {
    scope: string;
    checks?: string[];
    agent_id?: string;
    fail_on?: string[];
  }): Promise<VerifyResult> {
    const checksToRun: Set<CheckName> = new Set(
      input.checks
        ? (input.checks.filter((c) =>
            ALL_CHECKS.includes(c as CheckName),
          ) as CheckName[])
        : [...ALL_CHECKS],
    );

    const result: VerifyResult = {
      scope: input.scope,
      verified_at: new Date().toISOString(),
      checks: {},
      summary: "",
    };

    // Load decisions in scope
    const allDecisions = await this.decisionStore.getByScope(input.scope);
    const activeDecisions = allDecisions.filter(
      (d) => d.status === "active" || d.status === "provisional",
    );

    if (checksToRun.has("test_coverage")) {
      result.checks.test_coverage = await this.checkTestCoverage(activeDecisions);
    }

    if (checksToRun.has("warnings")) {
      result.checks.warnings = await this.checkWarnings(input.scope);
    }

    if (checksToRun.has("assembly")) {
      result.checks.assembly = this.checkAssembly(activeDecisions, input.agent_id);
    }

    if (checksToRun.has("drift")) {
      result.checks.drift = await this.checkDrift(activeDecisions, input.scope);
    }

    if (checksToRun.has("constraints")) {
      result.checks.constraints = await this.checkConstraints(input.scope);
    }

    // Build summary
    const parts: string[] = [];
    for (const [name, check] of Object.entries(result.checks)) {
      if (check) {
        parts.push(`${name}: ${check.status}`);
      }
    }
    result.summary = parts.join(", ");

    // Auto-post finding
    try {
      await this.blackboardEngine.post({
        entry_type: "finding",
        summary: `Verification: ${result.summary}`,
        detail: JSON.stringify(result.checks, null, 2),
        tags: ["verify"],
        scope: input.scope,
        agent_id: input.agent_id ?? "verify-engine",
      });
    } catch {
      // Non-fatal — verification result is still returned
    }

    return result;
  }

  private async checkTestCoverage(
    decisions: Array<{
      id: string;
      summary: string;
      affected_files: string[];
    }>,
  ): Promise<TestCoverageCheck> {
    if (!this.graphEngine) {
      return {
        status: "warn",
        decisions_in_scope: decisions.length,
        decisions_with_tested_by: 0,
        uncovered: decisions.map((d) => ({
          decision_id: d.id,
          summary: d.summary,
          affected_files: d.affected_files,
        })),
      };
    }

    const coverage = await this.graphEngine.getTestCoverage(decisions);

    let status: "pass" | "warn" | "fail" = "pass";
    if (coverage.uncovered.length > 0) {
      const ratio =
        coverage.decisions_with_tested_by / Math.max(coverage.decisions_in_scope, 1);
      status = ratio >= 0.5 ? "warn" : "fail";
    }

    return {
      status,
      decisions_in_scope: coverage.decisions_in_scope,
      decisions_with_tested_by: coverage.decisions_with_tested_by,
      uncovered: coverage.uncovered,
    };
  }

  private async checkWarnings(scope: string): Promise<WarningsCheck> {
    const { entries: warnings } = await this.blackboardStore.read({
      entry_types: ["warning"],
      scope,
    });

    // Check which warnings have been acknowledged (have relates_to references from other entries)
    const { entries: allEntries } = await this.blackboardStore.read({ scope });
    const acknowledgedIds = new Set<string>();
    const resolvedIds = new Set<string>();

    for (const entry of allEntries) {
      if (entry.relates_to) {
        for (const refId of entry.relates_to) {
          if (entry.entry_type === "answer" || entry.entry_type === "finding") {
            acknowledgedIds.add(refId);
          }
          if (entry.entry_type === "status") {
            resolvedIds.add(refId);
          }
        }
      }
    }

    const acknowledged = warnings.filter((w) => acknowledgedIds.has(w.id)).length;
    const resolved = warnings.filter((w) => resolvedIds.has(w.id)).length;
    const silentlyIgnored = warnings.filter(
      (w) => !acknowledgedIds.has(w.id) && !resolvedIds.has(w.id),
    );

    const status: "pass" | "warn" | "fail" =
      silentlyIgnored.length === 0
        ? "pass"
        : silentlyIgnored.length <= 2
          ? "warn"
          : "fail";

    return {
      status,
      warnings_in_scope: warnings.length,
      acknowledged,
      resolved,
      silently_ignored: silentlyIgnored.length,
      ignored_details: silentlyIgnored.map((w) => ({
        id: w.id,
        summary: w.summary,
      })),
    };
  }

  private checkAssembly(
    decisions: Array<{
      id: string;
      summary: string;
      agent_id: string;
      assembled_before?: boolean;
    }>,
    agentId?: string,
  ): AssemblyCheck {
    // Filter by agent if specified
    const filtered = agentId
      ? decisions.filter((d) => d.agent_id === agentId)
      : decisions;

    const assembledCount = filtered.filter((d) => d.assembled_before === true).length;
    const blindDecisions = filtered.filter((d) => d.assembled_before !== true);

    const status: "pass" | "warn" | "fail" =
      blindDecisions.length === 0
        ? "pass"
        : assembledCount >= filtered.length / 2
          ? "warn"
          : "fail";

    return {
      status,
      decisions_by_agent: filtered.length,
      assembled_before: assembledCount,
      blind_decisions: blindDecisions.map((d) => ({
        decision_id: d.id,
        summary: d.summary,
        agent_id: d.agent_id,
      })),
    };
  }

  /** Execute a git command in the project root. Returns null on failure. */
  private execGit(args: string[]): string | null {
    try {
      return execFileSync("git", args, {
        cwd: this.projectRoot,
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    } catch {
      return null;
    }
  }

  /** Check whether decisions have drifted from the codebase via git history. */
  private async checkDrift(
    decisions: Array<{
      id: string;
      summary: string;
      timestamp: string;
      affected_files: string[];
      status: string;
      domain: string;
      scope: string;
    }>,
    scope: string,
  ): Promise<DriftCheck> {
    // Check if git is available
    const gitCheck = this.execGit(["rev-parse", "--is-inside-work-tree"]);
    if (gitCheck === null) {
      return { status: "skip", decisions_checked: 0, stale: [] };
    }

    const stale: DriftCheck["stale"] = [];
    let decisionsChecked = 0;

    for (const decision of decisions) {
      if (!decision.affected_files || decision.affected_files.length === 0) {
        continue;
      }
      decisionsChecked++;

      for (const file of decision.affected_files) {
        const logOutput = this.execGit(["log", "--format=%aI %H", "-1", "--", file]);
        if (!logOutput) continue;

        const spaceIdx = logOutput.indexOf(" ");
        if (spaceIdx === -1) continue;

        const fileDate = logOutput.substring(0, spaceIdx);
        const commitHash = logOutput.substring(spaceIdx + 1);

        // Compare: if file was modified after the decision was made
        if (new Date(fileDate) > new Date(decision.timestamp)) {
          // Check for superseding decisions — a newer active decision in same domain+scope
          const allDecisions = await this.decisionStore.getByScope(scope);
          const superseded = allDecisions.some(
            (d) =>
              d.id !== decision.id &&
              (d.status === "active" || d.status === "provisional") &&
              d.domain === decision.domain &&
              new Date(d.timestamp) > new Date(decision.timestamp) &&
              (d.scope === decision.scope || d.scope.startsWith(decision.scope) || decision.scope.startsWith(d.scope)) &&
              d.affected_files.some((f) => f === file),
          );

          if (!superseded) {
            stale.push({
              decision_id: decision.id,
              summary: decision.summary,
              affected_file: file,
              decision_timestamp: decision.timestamp,
              last_file_modification: fileDate,
              modifying_commit: commitHash,
            });
          }
        }
      }
    }

    return {
      status: stale.length > 0 ? "warn" : "pass",
      decisions_checked: decisionsChecked,
      stale,
    };
  }

  /**
   * Dangerous characters for command validation.
   * Rejects null bytes and newlines which could be used for command injection.
   * Note: shell operators like pipes are intentionally allowed since constraint
   * check_commands are designed to be shell commands (e.g. grep ... | wc -l).
   * These commands come from agents/users who already have code execution ability.
   */
  private static readonly DANGEROUS_CHAR_PATTERN = /[\x00\n\r]/;

  /** Check constraints posted to the blackboard. */
  private async checkConstraints(scope: string): Promise<ConstraintsCheck> {
    const { entries: constraints } = await this.blackboardStore.read({
      entry_types: ["constraint"],
      scope,
    });

    const failed: ConstraintsCheck["failed"] = [];
    let checkable = 0;
    let passed = 0;

    for (const constraint of constraints) {
      // Try to parse detail as JSON with check_command + expected
      let parsed: { check_command?: string; expected?: string } | null = null;
      try {
        parsed = JSON.parse(constraint.detail || "");
      } catch {
        continue; // Not checkable — skip
      }

      if (!parsed || typeof parsed.check_command !== "string" || typeof parsed.expected !== "string") {
        continue; // Not checkable
      }

      const { check_command, expected } = parsed;

      // Security: reject null bytes and newlines (command injection vectors)
      if (VerifyEngine.DANGEROUS_CHAR_PATTERN.test(check_command)) {
        failed.push({
          constraint_id: constraint.id,
          summary: constraint.summary,
          check_command,
          actual: "REJECTED: command contains dangerous characters (null bytes or newlines)",
          expected,
        });
        checkable++;
        continue;
      }

      // Reject excessively long commands
      if (check_command.length > 1000) {
        failed.push({
          constraint_id: constraint.id,
          summary: constraint.summary,
          check_command: check_command.slice(0, 100) + "...",
          actual: "REJECTED: command exceeds 1000 character limit",
          expected,
        });
        checkable++;
        continue;
      }

      checkable++;

      try {
        const actual = execSync(check_command, {
          cwd: this.projectRoot,
          timeout: 5000,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        }).trim();

        if (actual === expected) {
          passed++;
        } else {
          failed.push({
            constraint_id: constraint.id,
            summary: constraint.summary,
            check_command,
            actual,
            expected,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failed.push({
          constraint_id: constraint.id,
          summary: constraint.summary,
          check_command,
          actual: `ERROR: ${message}`,
          expected,
        });
      }
    }

    if (checkable === 0) {
      return { status: "skip", checkable: 0, passed: 0, failed: [] };
    }

    const status: ConstraintsCheck["status"] =
      failed.length === 0
        ? "pass"
        : failed.length < checkable
          ? "warn"
          : "fail";

    return { status, checkable, passed, failed };
  }
}
