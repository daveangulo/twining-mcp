import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runHook } from "./run-hook";

describe("pre-commit-hook.sh", () => {
  it("exits 0 with no deny JSON when TWINING_DISABLED=true even with a transcript that would otherwise deny", () => {
    const tmpTranscript = path.join(os.tmpdir(), `twining-test-${Date.now()}.jsonl`);
    // A transcript with a git commit but no twining_record after — would normally deny
    fs.writeFileSync(tmpTranscript, '{"toolUse":{"name":"Bash","input":"git commit -m old"}}\n');
    const stdin = JSON.stringify({
      command: "git commit -m new",
      transcript_path: tmpTranscript,
    });
    try {
      const result = runHook({
        script: "pre-commit-hook.sh",
        stdin,
        env: { TWINING_DISABLED: "true" },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain("permissionDecision");
    } finally {
      fs.unlinkSync(tmpTranscript);
    }
  });

  it("runs normally when TWINING_DISABLED is unset (no transcript = silent allow)", () => {
    const result = runHook({
      script: "pre-commit-hook.sh",
      stdin: JSON.stringify({
        command: "git commit -m 'test'",
        transcript_path: "/tmp/nonexistent-transcript.jsonl",
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});
