import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "./run-hook";

describe("stop-hook.sh", () => {
  it("exits 0 with no output when TWINING_DISABLED=true", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-stop-"));
    const tmpTranscript = path.join(tmpDir, "transcript.jsonl");
    // Transcript with an Edit — would normally trigger record-required check
    fs.writeFileSync(tmpTranscript, '{"toolUse":{"name":"Edit","input":{"file_path":"/tmp/x"}}}\n');
    try {
      const result = runHook({
        script: "stop-hook.sh",
        stdin: JSON.stringify({ transcript_path: tmpTranscript }),
        env: { TWINING_DISABLED: "true" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs normally when TWINING_DISABLED is unset", () => {
    const result = runHook({
      script: "stop-hook.sh",
      stdin: JSON.stringify({ transcript_path: "/tmp/nonexistent.jsonl" }),
    });
    expect(result.exitCode).toBe(0);
    // Existing behavior: missing transcript yields the "Session complete" approve JSON
    expect(result.stdout).toContain('"decision":"approve"');
  });
});
