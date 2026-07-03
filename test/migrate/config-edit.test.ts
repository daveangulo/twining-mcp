// test/migrate/config-edit.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yaml from "js-yaml";
import { setStorageBackend } from "../../src/migrate/config-edit.js";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-cfg-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const cfgPath = () => path.join(dir, "config.yml");

describe("setStorageBackend", () => {
  it("sets storage.backend while preserving every other key", () => {
    fs.writeFileSync(cfgPath(), yaml.dump({
      version: 1,
      project_name: "demo",
      context_assembly: { default_max_tokens: 9999 },
    }));
    const result = setStorageBackend(dir, "sqlite");
    const parsed = yaml.load(fs.readFileSync(cfgPath(), "utf-8")) as Record<string, unknown>;
    expect((parsed.storage as Record<string, unknown>).backend).toBe("sqlite");
    expect(parsed.version).toBe(1); // v2 flip is gated — never touched here
    expect(parsed.project_name).toBe("demo");
    expect((parsed.context_assembly as Record<string, unknown>).default_max_tokens).toBe(9999);
    expect(result.hadComments).toBe(false);
  });

  it("backs up the previous config next to it", () => {
    fs.writeFileSync(cfgPath(), yaml.dump({ version: 1, project_name: "demo" }));
    const before = fs.readFileSync(cfgPath(), "utf-8");
    const result = setStorageBackend(dir, "sqlite");
    expect(result.backedUpTo).toBe(cfgPath() + ".pre-migrate.bak");
    expect(fs.readFileSync(result.backedUpTo!, "utf-8")).toBe(before);
  });

  it("updates an existing storage block without clobbering siblings", () => {
    fs.writeFileSync(cfgPath(), yaml.dump({
      version: 1, storage: { backend: "sqlite", export_records: false },
    }));
    setStorageBackend(dir, "files");
    const parsed = yaml.load(fs.readFileSync(cfgPath(), "utf-8")) as {
      storage: { backend: string; export_records: boolean };
    };
    expect(parsed.storage.backend).toBe("files");
    expect(parsed.storage.export_records).toBe(false);
  });

  it("creates a minimal config when none exists, and flags comments for the warning", () => {
    const created = setStorageBackend(dir, "sqlite");
    expect(created.backedUpTo).toBeNull();
    const parsed = yaml.load(fs.readFileSync(cfgPath(), "utf-8")) as Record<string, unknown>;
    expect((parsed.storage as Record<string, unknown>).backend).toBe("sqlite");
    expect(parsed.version).toBe(1);

    fs.writeFileSync(cfgPath(), "# my note\nversion: 1\n");
    const commented = setStorageBackend(dir, "files");
    expect(commented.hadComments).toBe(true); // caller prints the comment-loss warning
  });

  it("throws on an array YAML root and leaves config.yml untouched", () => {
    const before = "- one\n- two\n";
    fs.writeFileSync(cfgPath(), before);
    expect(() => setStorageBackend(dir, "sqlite")).toThrow(/non-object YAML root/);
    expect(fs.readFileSync(cfgPath(), "utf-8")).toBe(before);
  });

  it("throws on a scalar YAML root", () => {
    fs.writeFileSync(cfgPath(), "42\n");
    expect(() => setStorageBackend(dir, "sqlite")).toThrow(/non-object YAML root/);
  });

  it("treats an empty file as an empty config", () => {
    fs.writeFileSync(cfgPath(), "");
    expect(() => setStorageBackend(dir, "sqlite")).not.toThrow();
    const parsed = yaml.load(fs.readFileSync(cfgPath(), "utf-8")) as Record<string, unknown>;
    expect((parsed.storage as Record<string, unknown>).backend).toBe("sqlite");
  });

  it("does not overwrite an existing backup on a second run (first-wins)", () => {
    const configA = yaml.dump({ version: 1, project_name: "original" });
    fs.writeFileSync(cfgPath(), configA);
    const first = setStorageBackend(dir, "sqlite");
    expect(fs.readFileSync(first.backedUpTo!, "utf-8")).toBe(configA);

    fs.writeFileSync(cfgPath(), yaml.dump({ version: 1, project_name: "modified" }));
    const second = setStorageBackend(dir, "files");
    expect(second.backedUpTo).toBe(first.backedUpTo);
    expect(fs.readFileSync(second.backedUpTo!, "utf-8")).toBe(configA); // still the original
  });
});
