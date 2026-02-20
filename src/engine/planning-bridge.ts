/**
 * PlanningBridge - reads .planning/ state for GSD integration.
 * Enables Twining to surface planning context (current phase, progress,
 * blockers, open requirements) in context assembly and summarization.
 *
 * Never throws — returns null on any error for resilient integration.
 */
import fs from "node:fs";
import path from "node:path";
import type { PlanningState } from "../utils/types.js";

export type { PlanningState };

export class PlanningBridge {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Check if .planning/STATE.md exists at the project root.
   */
  isAvailable(): boolean {
    try {
      return fs.existsSync(
        path.join(this.projectRoot, ".planning", "STATE.md"),
      );
    } catch {
      return false;
    }
  }

  /**
   * Read and parse .planning/ state into a PlanningState object.
   * Returns null if .planning/ doesn't exist or on any error.
   * Resilient: missing or malformed sections produce sensible defaults.
   */
  readPlanningState(): PlanningState | null {
    try {
      if (!this.isAvailable()) {
        return null;
      }

      const statePath = path.join(
        this.projectRoot,
        ".planning",
        "STATE.md",
      );
      const stateContent = fs.readFileSync(statePath, "utf-8");

      const current_phase = this.parseCurrentPhase(stateContent);
      const progress = this.parseProgress(stateContent);
      const blockers = this.parseBlockers(stateContent);
      const pending_todos = this.parsePendingTodos(stateContent);
      const open_requirements = this.parseOpenRequirements();

      return {
        current_phase,
        progress,
        blockers,
        pending_todos,
        open_requirements,
      };
    } catch {
      return null;
    }
  }

  /**
   * Update the progress line in STATE.md.
   * No-op if .planning/ doesn't exist.
   */
  writeProgressUpdate(progress: string): void {
    try {
      const statePath = path.join(this.projectRoot, ".planning", "STATE.md");
      if (!fs.existsSync(statePath)) return;

      let content = fs.readFileSync(statePath, "utf-8");
      // Replace existing "Progress: ..." line
      content = content.replace(/^Progress:\s*.+$/m, `Progress: ${progress}`);
      fs.writeFileSync(statePath, content, "utf-8");
    } catch {
      // Resilient: no-op on error
    }
  }

  /**
   * Append a blocker to the Blockers/Concerns section.
   * No-op if .planning/ doesn't exist.
   */
  addBlocker(blocker: string): void {
    try {
      const statePath = path.join(this.projectRoot, ".planning", "STATE.md");
      if (!fs.existsSync(statePath)) return;

      const content = fs.readFileSync(statePath, "utf-8");
      const lines = content.split("\n");

      // Find the Blockers/Concerns header
      const headerIdx = lines.findIndex((l) => /^#{1,4}\s*Blockers\/Concerns/i.test(l));
      if (headerIdx === -1) return;

      // Find the end of this section (next header)
      let insertIdx = lines.length;
      for (let i = headerIdx + 1; i < lines.length; i++) {
        if (/^#{1,4}\s/.test(lines[i]!)) {
          insertIdx = i;
          break;
        }
      }

      // Check if section currently says "None." — replace it
      const sectionLines = lines.slice(headerIdx + 1, insertIdx);
      const noneIdx = sectionLines.findIndex((l) => l.trim().toLowerCase() === "none." || l.trim().toLowerCase() === "none");
      if (noneIdx !== -1) {
        lines[headerIdx + 1 + noneIdx] = `- ${blocker}`;
      } else {
        // Walk back over blank lines
        let at = insertIdx;
        while (at > headerIdx + 1 && lines[at - 1]!.trim() === "") at--;
        lines.splice(at, 0, `- ${blocker}`);
      }

      fs.writeFileSync(statePath, lines.join("\n"), "utf-8");
    } catch {
      // Resilient: no-op on error
    }
  }

  /**
   * Remove a blocker from the Blockers/Concerns section.
   * No-op if .planning/ doesn't exist or blocker not found.
   */
  removeBlocker(blocker: string): void {
    try {
      const statePath = path.join(this.projectRoot, ".planning", "STATE.md");
      if (!fs.existsSync(statePath)) return;

      const content = fs.readFileSync(statePath, "utf-8");
      const lines = content.split("\n");

      // Find and remove the line containing this blocker
      const idx = lines.findIndex((l) => {
        const match = l.match(/^[-*]\s+(.+)/);
        return match && match[1]!.trim() === blocker;
      });
      if (idx !== -1) {
        lines.splice(idx, 1);
        fs.writeFileSync(statePath, lines.join("\n"), "utf-8");
      }
    } catch {
      // Resilient: no-op on error
    }
  }

  /**
   * Mark a phase as complete in STATE.md by updating the Status line.
   * No-op if .planning/ doesn't exist.
   */
  writePhaseCompletion(phase: string, summary: string): void {
    try {
      const statePath = path.join(this.projectRoot, ".planning", "STATE.md");
      if (!fs.existsSync(statePath)) return;

      let content = fs.readFileSync(statePath, "utf-8");
      // Update Status line
      content = content.replace(
        /^Status:\s*.+$/m,
        `Status: Phase ${phase} complete — ${summary}`,
      );
      fs.writeFileSync(statePath, content, "utf-8");
    } catch {
      // Resilient: no-op on error
    }
  }

  /**
   * Write a plan file for a phase.
   * Creates `.planning/phases/<phaseName>/plan.md` with the given content.
   * No-op if .planning/ doesn't exist.
   */
  writePlanFile(phaseName: string, content: string): void {
    try {
      const planningDir = path.join(this.projectRoot, ".planning");
      if (!fs.existsSync(planningDir)) return;

      const phaseDir = path.join(planningDir, "phases", phaseName);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, "plan.md"), content, "utf-8");
    } catch {
      // Resilient: no-op on error
    }
  }

  /**
   * Parse "Phase: N of M (name)" from the Current Position section.
   */
  private parseCurrentPhase(content: string): string {
    // Match "Phase: X of Y (name)" or "Phase: X of Y"
    const match = content.match(/Phase:\s*(.+)/);
    if (match) {
      return match[1]!.trim();
    }
    return "unknown";
  }

  /**
   * Parse "Progress: [###...] NN%" line.
   */
  private parseProgress(content: string): string {
    const match = content.match(/Progress:\s*(.+)/);
    if (match) {
      return match[1]!.trim();
    }
    return "unknown";
  }

  /**
   * Parse blockers from the Blockers/Concerns section.
   * Extracts text between the header and the next section (##).
   */
  private parseBlockers(content: string): string[] {
    const section = this.extractSection(
      content,
      "Blockers/Concerns",
    );
    if (!section || section.trim().toLowerCase() === "none." || section.trim().toLowerCase() === "none") {
      return [];
    }
    return this.parseListItems(section);
  }

  /**
   * Parse pending todos from the Pending Todos section.
   */
  private parsePendingTodos(content: string): string[] {
    const section = this.extractSection(content, "Pending Todos");
    if (!section || section.trim().toLowerCase() === "none." || section.trim().toLowerCase() === "none") {
      return [];
    }
    return this.parseListItems(section);
  }

  /**
   * Parse open (unchecked) requirements from .planning/REQUIREMENTS.md.
   * Scans for unchecked `- [ ]` lines.
   */
  private parseOpenRequirements(): string[] {
    try {
      const reqPath = path.join(
        this.projectRoot,
        ".planning",
        "REQUIREMENTS.md",
      );
      if (!fs.existsSync(reqPath)) {
        return [];
      }

      const content = fs.readFileSync(reqPath, "utf-8");
      const lines = content.split("\n");
      const requirements: string[] = [];

      for (const line of lines) {
        // Match unchecked requirement lines: - [ ] **REQ-ID**: description
        const match = line.match(
          /^-\s*\[\s*\]\s*\*\*([A-Z]+-\d+)\*\*:\s*(.+)/,
        );
        if (match && match[1] && match[2]) {
          requirements.push(`${match[1]}: ${match[2].trim()}`);
        }
      }

      return requirements;
    } catch {
      return [];
    }
  }

  /**
   * Extract the text content of a section by its header name.
   * Returns content between the header and the next header of same or higher level.
   */
  private extractSection(
    content: string,
    sectionName: string,
  ): string | null {
    // Find the section header (### level)
    const headerPattern = new RegExp(
      `^#{1,4}\\s*${this.escapeRegex(sectionName)}\\s*$`,
      "m",
    );
    const headerMatch = content.match(headerPattern);
    if (!headerMatch || headerMatch.index === undefined) {
      return null;
    }

    const startIndex = headerMatch.index + headerMatch[0].length;
    const remaining = content.slice(startIndex);

    // Find the next section header (any level)
    const nextHeaderMatch = remaining.match(/^#{1,4}\s+/m);
    const endIndex = nextHeaderMatch?.index ?? remaining.length;

    return remaining.slice(0, endIndex).trim();
  }

  /**
   * Parse list items from a section (lines starting with - or *).
   * Returns non-empty items.
   */
  private parseListItems(section: string): string[] {
    const lines = section.split("\n");
    const items: string[] = [];
    for (const line of lines) {
      const match = line.match(/^[-*]\s+(.+)/);
      if (match) {
        const item = match[1]!.trim();
        if (item) {
          items.push(item);
        }
      }
    }
    // If no list items found but section has content, return it as a single item
    if (items.length === 0 && section.trim()) {
      return [section.trim()];
    }
    return items;
  }

  /**
   * Escape special regex characters in a string.
   */
  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
