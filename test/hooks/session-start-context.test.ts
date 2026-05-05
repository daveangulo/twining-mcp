// test/hooks/session-start-context.test.ts
import { describe, it, expect } from "vitest";
import { runHook } from "./run-hook";

const EXPECTED_CONTEXT_FRAGMENT = "Twining MCP tools are available";

describe("session-start-context.sh", () => {
  it("emits a JSON envelope with hookSpecificOutput.additionalContext", () => {
    const result = runHook({ script: "session-start-context.sh" });
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(payload.hookSpecificOutput.additionalContext).toContain(EXPECTED_CONTEXT_FRAGMENT);
    expect(payload.hookSpecificOutput.additionalContext).toContain("twining_assemble");
    expect(payload.hookSpecificOutput.additionalContext).toContain("twining_record");
  });

  it("exits 0 with no output when TWINING_DISABLED=true", () => {
    const result = runHook({
      script: "session-start-context.sh",
      env: { TWINING_DISABLED: "true" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});
