// test/hooks/ensure-claude-md-gates.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "./run-hook";

describe("ensure-claude-md-gates.sh", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-cmd-"));
    fs.mkdirSync(path.join(tmpDir, ".twining"));
    fs.mkdirSync(path.join(tmpDir, ".git"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("TWINING_DISABLED guard", () => {
    it("does not write CLAUDE.md when TWINING_DISABLED=true", () => {
      const result = runHook({
        script: "ensure-claude-md-gates.sh",
        cwd: tmpDir,
        env: { TWINING_DISABLED: "true" },
      });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(false);
    });
  });

  describe("opt-out flag", () => {
    it("skips writing when .twining/.no-claude-md-gates exists", () => {
      fs.writeFileSync(path.join(tmpDir, ".twining", ".no-claude-md-gates"), "");
      const result = runHook({
        script: "ensure-claude-md-gates.sh",
        cwd: tmpDir,
      });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(false);
    });

    it("writes CLAUDE.md when flag is absent", () => {
      const result = runHook({
        script: "ensure-claude-md-gates.sh",
        cwd: tmpDir,
        env: { HOME: tmpDir }, // empty fake home — no global marker
      });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf8")).toContain("Twining Lifecycle Gates");
    });
  });

  describe("broad marker search", () => {
    const MARKER_CONTENT = "## Coordination — Twining Lifecycle Gates\n";

    it("skips when marker is in CLAUDE.md", () => {
      fs.writeFileSync(path.join(tmpDir, "CLAUDE.md"), MARKER_CONTENT);
      const before = fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf8");
      const result = runHook({
        script: "ensure-claude-md-gates.sh",
        cwd: tmpDir,
        env: { HOME: tmpDir },
      });
      expect(result.exitCode).toBe(0);
      // File unchanged
      expect(fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf8")).toBe(before);
    });

    it("skips when marker is in CLAUDE.local.md (project root)", () => {
      fs.writeFileSync(path.join(tmpDir, "CLAUDE.local.md"), MARKER_CONTENT);
      const result = runHook({
        script: "ensure-claude-md-gates.sh",
        cwd: tmpDir,
        env: { HOME: tmpDir },
      });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(false);
    });

    it("skips when marker is in .claude/CLAUDE.local.md", () => {
      fs.mkdirSync(path.join(tmpDir, ".claude"));
      fs.writeFileSync(path.join(tmpDir, ".claude", "CLAUDE.local.md"), MARKER_CONTENT);
      const result = runHook({
        script: "ensure-claude-md-gates.sh",
        cwd: tmpDir,
        env: { HOME: tmpDir },
      });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(false);
    });

    it("skips when marker is in $HOME/.claude/CLAUDE.md", () => {
      // Use a fake HOME to avoid touching the real one
      const fakeHome = path.join(tmpDir, "fake-home");
      fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(fakeHome, ".claude", "CLAUDE.md"), MARKER_CONTENT);
      const result = runHook({
        script: "ensure-claude-md-gates.sh",
        cwd: tmpDir,
        env: { HOME: fakeHome },
      });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(false);
    });

    it("appends to project CLAUDE.md when marker is nowhere", () => {
      const result = runHook({
        script: "ensure-claude-md-gates.sh",
        cwd: tmpDir,
        env: { HOME: tmpDir }, // empty fake home — no global marker
      });
      expect(result.exitCode).toBe(0);
      expect(fs.existsSync(path.join(tmpDir, "CLAUDE.md"))).toBe(true);
      expect(fs.readFileSync(path.join(tmpDir, "CLAUDE.md"), "utf8")).toContain("Twining Lifecycle Gates");
    });
  });
});
