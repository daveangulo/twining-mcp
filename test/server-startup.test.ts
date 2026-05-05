import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const ENTRY = path.resolve(__dirname, "..", "dist", "index.js");

// The gate at the top of main() runs `process.exit(0)` BEFORE createServer(),
// the dashboard, and everything else that writes startup messages to stderr.
// So the discriminating signal between "gate fired" and "gate didn't fire" is
// stderr content, not exit code (both yield exit 0 with empty stdin) and not
// signal (platform-dependent timing). Stderr is reliable across macOS/Linux.

function runServer(env: NodeJS.ProcessEnv) {
  return spawnSync("node", [ENTRY], {
    env,
    input: "", // EOF on stdin so the server doesn't hang waiting for JSON-RPC
    encoding: "utf8",
    timeout: 5000,
  });
}

describe("MCP server startup gate", () => {
  beforeAll(() => {
    if (!fs.existsSync(ENTRY)) {
      throw new Error(
        `dist/index.js missing — run \`npm run build\` before this test`,
      );
    }
  });

  it("exits 0 with no startup output when TWINING_DISABLED=true", () => {
    const result = runServer({ ...process.env, TWINING_DISABLED: "true" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("does NOT short-circuit when TWINING_DISABLED is unset (server runs startup)", () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== "TWINING_DISABLED"),
    ) as NodeJS.ProcessEnv;
    const result = runServer(env);
    expect(result.status).toBe(0);
    // Startup runs to completion — stderr contains [twining] messages from the
    // dashboard and/or config loader. Empty stderr would mean the gate fired,
    // which is the failure case for this test.
    expect(result.stderr).toContain("[twining]");
  });

  it("does NOT short-circuit when TWINING_DISABLED is a non-true value (e.g., '1')", () => {
    const result = runServer({ ...process.env, TWINING_DISABLED: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[twining]");
  });
});
