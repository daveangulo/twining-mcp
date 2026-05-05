import { describe, it, expect } from "vitest";
import { runHook } from "./run-hook";

describe("subagent-stop-hook.sh", () => {
  it("exits 0 with no output when TWINING_DISABLED=true", () => {
    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({ transcript_path: "/tmp/nonexistent.jsonl" }),
      env: { TWINING_DISABLED: "true" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });

  it("runs without error when TWINING_DISABLED is unset", () => {
    const result = runHook({
      script: "subagent-stop-hook.sh",
      stdin: JSON.stringify({ transcript_path: "/tmp/nonexistent.jsonl" }),
    });
    expect(result.exitCode).toBe(0);
  });
});
