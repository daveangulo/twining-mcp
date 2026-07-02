import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendJSONL,
  atomicWriteFileSync,
  enterReadOnlyMode,
  exitReadOnlyMode,
  isReadOnly,
  readJSON,
  writeJSON,
  writeJSONL,
} from "../src/storage/file-store.js";
import { TwiningError } from "../src/utils/errors.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-atomic-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  exitReadOnlyMode();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("atomicWriteFileSync", () => {
  it("writes content and leaves no temp files behind", () => {
    const target = path.join(dir, "data.json");
    atomicWriteFileSync(target, '{"a":1}');
    expect(fs.readFileSync(target, "utf-8")).toBe('{"a":1}');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("preserves the previous content when the write fails mid-flight", () => {
    const target = path.join(dir, "data.json");
    atomicWriteFileSync(target, '{"old":true}');

    // Simulate a crash between temp-file write and rename
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated crash");
    });
    expect(() => atomicWriteFileSync(target, '{"new":true}')).toThrow(
      "simulated crash",
    );
    vi.restoreAllMocks();

    // Old content is intact and still valid JSON; no temp litter
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({
      old: true,
    });
    expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("never exposes partial content at the target path", () => {
    const target = path.join(dir, "data.json");
    const observed: string[] = [];
    const realWrite = fs.writeFileSync.bind(fs);
    // Capture what exists at the target the moment the temp write happens —
    // in-place writing would show truncated/empty content here.
    vi.spyOn(fs, "writeFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
      opts?: fs.WriteFileOptions,
    ) => {
      if (fs.existsSync(target)) {
        observed.push(fs.readFileSync(target, "utf-8"));
      }
      return realWrite(file, data, opts);
    }) as typeof fs.writeFileSync);

    atomicWriteFileSync(target, JSON.stringify({ v: 1 }));
    atomicWriteFileSync(target, JSON.stringify({ v: 2 }));

    for (const snapshot of observed) {
      expect(() => JSON.parse(snapshot)).not.toThrow();
    }
    expect(JSON.parse(fs.readFileSync(target, "utf-8"))).toEqual({ v: 2 });
  });
});

describe("writeJSON / writeJSONL atomicity", () => {
  it("writeJSON goes through temp-file + rename", async () => {
    const target = path.join(dir, "store.json");
    const renames = vi.spyOn(fs, "renameSync");
    await writeJSON(target, { hello: "world" });
    expect(renames).toHaveBeenCalled();
    const [from, to] = renames.mock.calls.at(-1)!;
    expect(String(from)).toMatch(/\.tmp$/);
    expect(String(to)).toBe(target);
    expect(await readJSON(target)).toEqual({ hello: "world" });
  });

  it("writeJSONL goes through temp-file + rename", async () => {
    const target = path.join(dir, "store.jsonl");
    const renames = vi.spyOn(fs, "renameSync");
    await writeJSONL(target, [{ a: 1 }, { a: 2 }]);
    expect(renames).toHaveBeenCalled();
    expect(fs.readFileSync(target, "utf-8")).toBe('{"a":1}\n{"a":2}\n');
  });
});

describe("readJSON transient-corruption retry", () => {
  it("retries once and succeeds when the file becomes valid", async () => {
    const target = path.join(dir, "flaky.json");
    fs.writeFileSync(target, '{"truncat'); // torn write from a legacy writer
    setTimeout(() => fs.writeFileSync(target, '{"ok":true}'), 5);
    await expect(readJSON(target)).resolves.toEqual({ ok: true });
  });

  it("throws when the file stays corrupt", async () => {
    const target = path.join(dir, "corrupt.json");
    fs.writeFileSync(target, "not json");
    await expect(readJSON(target)).rejects.toThrow();
  });
});

describe("read-only mode (format version gate)", () => {
  it("refuses writes with FORMAT_VERSION_TOO_NEW but keeps reads working", async () => {
    const target = path.join(dir, "data.json");
    await writeJSON(target, { pre: "existing" });

    enterReadOnlyMode("format v2 is newer than this release supports");
    expect(isReadOnly()).toBe(true);

    await expect(writeJSON(target, { nope: 1 })).rejects.toMatchObject({
      name: "TwiningError",
      code: "FORMAT_VERSION_TOO_NEW",
    });
    await expect(
      appendJSONL(path.join(dir, "log.jsonl"), { nope: 1 }),
    ).rejects.toBeInstanceOf(TwiningError);
    expect(() => atomicWriteFileSync(target, "{}")).toThrow(TwiningError);

    // Reads unaffected; on-disk state untouched
    expect(await readJSON(target)).toEqual({ pre: "existing" });
    expect(fs.existsSync(path.join(dir, "log.jsonl"))).toBe(false);

    exitReadOnlyMode();
    await writeJSON(target, { post: "gate" });
    expect(await readJSON(target)).toEqual({ post: "gate" });
  });
});
