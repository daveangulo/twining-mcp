import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";
import { TWINING_INSTRUCTIONS } from "../../src/instructions.js";
import { DEFAULT_CONFIG, loadConfig } from "../../src/config.js";

describe("TWINING_INSTRUCTIONS", () => {
  it("is exported as a non-empty string", () => {
    expect(typeof TWINING_INSTRUCTIONS).toBe("string");
    expect(TWINING_INSTRUCTIONS.length).toBeGreaterThan(0);
  });

  it("contains Gate 1 section", () => {
    expect(TWINING_INSTRUCTIONS).toContain("Gate 1");
  });

  it("contains Gate 2 section", () => {
    expect(TWINING_INSTRUCTIONS).toContain("Gate 2");
  });

  it("contains Gate 3 section", () => {
    expect(TWINING_INSTRUCTIONS).toContain("Gate 3");
  });

  it("contains Tool Groups section", () => {
    expect(TWINING_INSTRUCTIONS).toContain("Tool Groups");
  });

  it("mentions twining_assemble", () => {
    expect(TWINING_INSTRUCTIONS).toContain("twining_assemble");
  });

  it("mentions twining_decide", () => {
    expect(TWINING_INSTRUCTIONS).toContain("twining_decide");
  });

  it("mentions twining_verify", () => {
    expect(TWINING_INSTRUCTIONS).toContain("twining_verify");
  });
});

describe("instructions config defaults", () => {
  it("DEFAULT_CONFIG has instructions.auto_inject set to true", () => {
    expect(DEFAULT_CONFIG.instructions).toBeDefined();
    expect(DEFAULT_CONFIG.instructions!.auto_inject).toBe(true);
  });

  describe("loadConfig with instructions overrides", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "twining-instructions-test-"),
      );
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("defaults to auto_inject true when no config file exists", () => {
      const config = loadConfig(tmpDir);
      expect(config.instructions?.auto_inject).toBe(true);
    });

    it("respects auto_inject = false from config file", () => {
      const partial = {
        instructions: {
          auto_inject: false,
        },
      };
      fs.writeFileSync(path.join(tmpDir, "config.yml"), yaml.dump(partial));
      const config = loadConfig(tmpDir);
      expect(config.instructions?.auto_inject).toBe(false);
    });

    it("preserves auto_inject true when config file has unrelated settings", () => {
      const partial = {
        project_name: "test-project",
      };
      fs.writeFileSync(path.join(tmpDir, "config.yml"), yaml.dump(partial));
      const config = loadConfig(tmpDir);
      expect(config.instructions?.auto_inject).toBe(true);
    });
  });
});
