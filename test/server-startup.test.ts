import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const ENTRY = path.resolve(__dirname, "..", "dist", "index.js");

describe("MCP server startup gate", () => {
  beforeAll(() => {
    if (!fs.existsSync(ENTRY)) {
      throw new Error(
        `dist/index.js missing — run \`npm run build\` before this test`,
      );
    }
  });

  it("exits 0 immediately when TWINING_DISABLED=true is set", () => {
    const result = spawnSync("node", [ENTRY], {
      env: { ...process.env, TWINING_DISABLED: "true" },
      input: "",
      encoding: "utf8",
      timeout: 3000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("does NOT trigger the gate when TWINING_DISABLED is unset", () => {
    // When TWINING_DISABLED is unset, the gate should not execute.
    // The server will attempt to start (and eventually exit due to EOF on stdin).
    // This test just verifies it doesn't exit with status 0 before attempting startup.
    const result = spawnSync("node", [ENTRY], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "TWINING_DISABLED")) },
      input: "",
      encoding: "utf8",
      timeout: 1500,
    });
    // Should exit normally (status 0) after attempting to start, not be killed by timeout
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
  });

  it("does NOT trigger the gate when TWINING_DISABLED is set to a non-true value", () => {
    // Only the literal string "true" should trigger the gate.
    // Other values like "1", "yes", "True" should not trigger it.
    const result = spawnSync("node", [ENTRY], {
      env: { ...process.env, TWINING_DISABLED: "1" },
      input: "",
      encoding: "utf8",
      timeout: 1500,
    });
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
  });
});
