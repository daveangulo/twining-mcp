/**
 * Tests for the PlanningBridge class.
 * Validates parsing of .planning/STATE.md and .planning/REQUIREMENTS.md.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PlanningBridge } from "../src/engine/planning-bridge.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const MOCK_STATE_MD = `# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-16)

**Core value:** Agents share *why* decisions were made, not just *what* was done.
**Current focus:** Phase 5 — GSD Bridge

## Current Position

Phase: 5 of 6 (GSD Bridge)
Plan: 0 of 2 in current phase
Status: Phase 4 complete, ready for Phase 5
Last activity: 2026-02-17

Progress: [###-------] 33% (v1.1)

## Accumulated Context

### Decisions

All v1 decisions archived.

v1.1 decisions:
- Serena integration via CLAUDE.md workflow pattern
- GSD bridge is bidirectional

### Pending Todos

- Review auth module test coverage
- Update API documentation

### Blockers/Concerns

- Embedding model load time exceeds 5 seconds
- Need to resolve ONNX compatibility on ARM64
`;

const MOCK_REQUIREMENTS_MD = `# Requirements

## GSD Planning Bridge

- [ ] **GSDB-01**: Context assembly includes planning state
- [x] **GSDB-02**: Summarize includes planning state
- [ ] **GSDB-03**: Decide syncs to STATE.md
- [ ] **GSDB-04**: Assemble scores planning context

## Git Commit Linking

- [x] **GITL-01**: Decide accepts commit_hash
- [ ] **GITL-02**: Link commit tool
`;

function makeTempProject(): string {
  return fs.mkdtempSync(
    path.join(os.tmpdir(), "twining-planning-bridge-test-"),
  );
}

describe("PlanningBridge", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempProject();
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  describe("isAvailable", () => {
    it("should return false when .planning/ does not exist", () => {
      const bridge = new PlanningBridge(projectRoot);
      expect(bridge.isAvailable()).toBe(false);
    });

    it("should return false when .planning/ exists but STATE.md does not", () => {
      fs.mkdirSync(path.join(projectRoot, ".planning"), { recursive: true });
      const bridge = new PlanningBridge(projectRoot);
      expect(bridge.isAvailable()).toBe(false);
    });

    it("should return true when .planning/STATE.md exists", () => {
      const planningDir = path.join(projectRoot, ".planning");
      fs.mkdirSync(planningDir, { recursive: true });
      fs.writeFileSync(path.join(planningDir, "STATE.md"), MOCK_STATE_MD);
      const bridge = new PlanningBridge(projectRoot);
      expect(bridge.isAvailable()).toBe(true);
    });
  });

  describe("readPlanningState", () => {
    it("should return null when .planning/ does not exist", () => {
      const bridge = new PlanningBridge(projectRoot);
      expect(bridge.readPlanningState()).toBeNull();
    });

    it("should parse current_phase correctly", () => {
      setupMockPlanning(projectRoot);
      const bridge = new PlanningBridge(projectRoot);
      const state = bridge.readPlanningState();
      expect(state).not.toBeNull();
      expect(state!.current_phase).toBe("5 of 6 (GSD Bridge)");
    });

    it("should parse progress correctly", () => {
      setupMockPlanning(projectRoot);
      const bridge = new PlanningBridge(projectRoot);
      const state = bridge.readPlanningState();
      expect(state).not.toBeNull();
      expect(state!.progress).toContain("33%");
    });

    it("should parse blockers correctly", () => {
      setupMockPlanning(projectRoot);
      const bridge = new PlanningBridge(projectRoot);
      const state = bridge.readPlanningState();
      expect(state).not.toBeNull();
      expect(state!.blockers).toHaveLength(2);
      expect(state!.blockers[0]).toContain("Embedding model load time");
      expect(state!.blockers[1]).toContain("ONNX compatibility");
    });

    it("should parse pending todos correctly", () => {
      setupMockPlanning(projectRoot);
      const bridge = new PlanningBridge(projectRoot);
      const state = bridge.readPlanningState();
      expect(state).not.toBeNull();
      expect(state!.pending_todos).toHaveLength(2);
      expect(state!.pending_todos[0]).toContain("auth module test coverage");
      expect(state!.pending_todos[1]).toContain("API documentation");
    });

    it("should parse open requirements from REQUIREMENTS.md", () => {
      setupMockPlanning(projectRoot, MOCK_STATE_MD, MOCK_REQUIREMENTS_MD);
      const bridge = new PlanningBridge(projectRoot);
      const state = bridge.readPlanningState();
      expect(state).not.toBeNull();
      // Should only have unchecked items: GSDB-01, GSDB-03, GSDB-04, GITL-02
      expect(state!.open_requirements).toHaveLength(4);
      expect(state!.open_requirements[0]).toContain("GSDB-01");
      expect(state!.open_requirements[1]).toContain("GSDB-03");
      expect(state!.open_requirements[2]).toContain("GSDB-04");
      expect(state!.open_requirements[3]).toContain("GITL-02");
    });

    it("should return empty open_requirements when REQUIREMENTS.md does not exist", () => {
      setupMockPlanning(projectRoot);
      const bridge = new PlanningBridge(projectRoot);
      const state = bridge.readPlanningState();
      expect(state).not.toBeNull();
      expect(state!.open_requirements).toEqual([]);
    });

    it("should handle STATE.md with no blockers section gracefully", () => {
      const minimalState = `# Project State

## Current Position

Phase: 3 of 5 (Testing)
Progress: [#####-----] 50%

## Session Continuity

Last session: 2026-02-17
`;
      setupMockPlanning(projectRoot, minimalState);
      const bridge = new PlanningBridge(projectRoot);
      const state = bridge.readPlanningState();
      expect(state).not.toBeNull();
      expect(state!.current_phase).toBe("3 of 5 (Testing)");
      expect(state!.progress).toContain("50%");
      expect(state!.blockers).toEqual([]);
      expect(state!.pending_todos).toEqual([]);
    });

    it("should handle blockers section with 'None.' gracefully", () => {
      const noneBlockers = `# Project State

## Current Position

Phase: 2 of 4 (Implementation)
Progress: [###-------] 25%

### Blockers/Concerns

None.

### Pending Todos

None.

## Session Continuity
`;
      setupMockPlanning(projectRoot, noneBlockers);
      const bridge = new PlanningBridge(projectRoot);
      const state = bridge.readPlanningState();
      expect(state).not.toBeNull();
      expect(state!.blockers).toEqual([]);
      expect(state!.pending_todos).toEqual([]);
    });

    it("should be resilient to malformed STATE.md", () => {
      const malformed = `This is not a valid STATE.md
Some random content
No proper headers or fields`;
      setupMockPlanning(projectRoot, malformed);
      const bridge = new PlanningBridge(projectRoot);
      const state = bridge.readPlanningState();
      // Should return a PlanningState with defaults, not null
      expect(state).not.toBeNull();
      expect(state!.current_phase).toBe("unknown");
      expect(state!.progress).toBe("unknown");
      expect(state!.blockers).toEqual([]);
      expect(state!.pending_todos).toEqual([]);
    });

    it("should handle empty STATE.md", () => {
      setupMockPlanning(projectRoot, "");
      const bridge = new PlanningBridge(projectRoot);
      const state = bridge.readPlanningState();
      expect(state).not.toBeNull();
      expect(state!.current_phase).toBe("unknown");
      expect(state!.progress).toBe("unknown");
    });
  });
});

/** Helper to set up .planning/ directory with mock files */
function setupMockPlanning(
  projectRoot: string,
  stateContent: string = MOCK_STATE_MD,
  requirementsContent?: string,
): void {
  const planningDir = path.join(projectRoot, ".planning");
  fs.mkdirSync(planningDir, { recursive: true });
  fs.writeFileSync(path.join(planningDir, "STATE.md"), stateContent);
  if (requirementsContent) {
    fs.writeFileSync(
      path.join(planningDir, "REQUIREMENTS.md"),
      requirementsContent,
    );
  }
}
