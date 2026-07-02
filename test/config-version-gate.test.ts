import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatVersionRefusal,
  loadConfig,
  SUPPORTED_CONFIG_VERSION,
} from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-vgate-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("format version gate", () => {
  it("accepts the current format version", () => {
    fs.writeFileSync(
      path.join(dir, "config.yml"),
      `version: ${SUPPORTED_CONFIG_VERSION}\nproject_name: test\n`,
    );
    const config = loadConfig(dir);
    expect(config.version).toBe(SUPPORTED_CONFIG_VERSION);
    expect(formatVersionRefusal(config)).toBeNull();
  });

  it("accepts a missing config file (defaults)", () => {
    const config = loadConfig(dir);
    expect(formatVersionRefusal(config)).toBeNull();
  });

  it("refuses a newer on-disk format version", () => {
    fs.writeFileSync(
      path.join(dir, "config.yml"),
      `version: ${SUPPORTED_CONFIG_VERSION + 1}\nproject_name: migrated\n`,
    );
    const config = loadConfig(dir);
    expect(config.version).toBe(SUPPORTED_CONFIG_VERSION + 1);
    const refusal = formatVersionRefusal(config);
    expect(refusal).toBeTruthy();
    expect(refusal).toContain("newer");
    expect(refusal).toContain(String(SUPPORTED_CONFIG_VERSION));
  });
});
