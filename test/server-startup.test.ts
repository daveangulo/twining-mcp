import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync, spawn } from "node:child_process";
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

  it("does NOT exit early when TWINING_DISABLED is unset", () => {
    return runWithLiveStdin({
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "TWINING_DISABLED")),
    });
  });

  it("does NOT exit early when TWINING_DISABLED is set to a non-true value", () => {
    return runWithLiveStdin({
      env: { ...process.env, TWINING_DISABLED: "1" },
    });
  });
});

// Spawn the server with stdin held open (no Readable.pipe — that triggers EOF
// on Linux when the source Readable enters 'end' state). The pipe stays open
// for the lifetime of the parent process. After 1500ms we SIGTERM the child
// and verify it was actually running (code: null, signal: "SIGTERM"), proving
// the gate did NOT fire.
function runWithLiveStdin(opts: { env: Record<string, string | undefined> }): Promise<void> {
  const proc = spawn("node", [ENTRY], {
    env: opts.env as NodeJS.ProcessEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
    }, 1500);

    proc.on("exit", (code, signal) => {
      clearTimeout(timeout);
      try {
        expect(code).toBe(null);
        expect(signal).toBe("SIGTERM");
        resolve();
      } catch (e) {
        reject(e as Error);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
