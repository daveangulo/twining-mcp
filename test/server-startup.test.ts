import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { Readable } from "node:stream";

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

  it("does NOT exit early when TWINING_DISABLED is unset", () => {
    // Without the gate firing, the server starts normally.
    // To verify the gate doesn't fire, we keep the process alive past startup
    // using a manually-piped stdin that never sends EOF. When the timeout kills it,
    // we expect SIGTERM, indicating the server was running normally.
    const proc = spawn("node", [ENTRY], {
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "TWINING_DISABLED")) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Pipe a stream that never ends and never sends EOF — keeps stdin open
    const neverEndingStream = new Readable({
      read() {
        // Never send data or EOF
      }
    });
    neverEndingStream.pipe(proc.stdin);

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
      }, 1500);

      proc.on("exit", (code, signal) => {
        clearTimeout(timeout);
        neverEndingStream.destroy();
        // Server ran to timeout and was killed by SIGTERM, not exited early
        expect(code).toBe(null);
        expect(signal).toBe("SIGTERM");
        resolve();
      });
    });
  });

  it("does NOT exit early when TWINING_DISABLED is set to a non-true value", () => {
    // Only the literal string "true" triggers the gate.
    // With "1" (or other non-true values), the server starts normally.
    // Same test as above: keep it alive and verify SIGTERM on timeout.
    const proc = spawn("node", [ENTRY], {
      env: { ...process.env, TWINING_DISABLED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const neverEndingStream = new Readable({
      read() {
        // Never send data or EOF
      }
    });
    neverEndingStream.pipe(proc.stdin);

    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
      }, 1500);

      proc.on("exit", (code, signal) => {
        clearTimeout(timeout);
        neverEndingStream.destroy();
        expect(code).toBe(null);
        expect(signal).toBe("SIGTERM");
        resolve();
      });
    });
  });
});
