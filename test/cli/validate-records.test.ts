import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  runValidateRecordsCli,
  validateRecordsTree,
} from "../../src/cli/validate-records.js";

const GOOD = "01M088JCGYRWPX8EYYQNG3G5DB";
const EMPTY = "01M088JCGYRWPX8EYYQNG3G5DC";
const MARKERS = "01M088JCGYRWPX8EYYQNG3G5DD";
const BADID = "01M088JCGYRWPX8EYYQNG3G5DE";
const MISMATCH = "01M088JCGYRWPX8EYYQNG3G5DF";
const POST = "01M088JCGYRWPX8EYYQNG3G5DG";

let root: string;
const rec = (...p: string[]) => path.join(root, ".twining", "records", ...p);
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const git = (...args: string[]) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "ignore"] },
  );

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "twining-validate-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("validateRecordsTree (2.16.1)", () => {
  it("classifies every unreadable or mis-keyed record file and passes healthy ones", () => {
    write(rec("decisions", `${GOOD}.json`), JSON.stringify({ id: GOOD, status: "active" }));
    write(rec("decisions", `${EMPTY}.json`), "");
    write(
      rec("decisions", `${MARKERS}.json`),
      `<<<<<<< HEAD\n{"id":"${MARKERS}"}\n=======\n{}\n>>>>>>> x\n`,
    );
    write(rec("decisions", `${BADID}.json`), JSON.stringify({ id: 42 }));
    write(rec("decisions", `${MISMATCH}.json`), JSON.stringify({ id: "OTHER" }));
    write(rec("posts", "2026-09", `${POST}.json`), JSON.stringify({ id: POST }));
    const r = validateRecordsTree(root);
    expect(r.records_dir_present).toBe(true);
    expect(r.files_checked).toBe(6);
    expect(r.tracked).toBeNull(); // not a git repo
    expect(
      r.findings.map((f) => [path.basename(f.path), f.kind]).sort(),
    ).toEqual(
      [
        [`${BADID}.json`, "non_string_id"],
        [`${EMPTY}.json`, "empty"],
        [`${MARKERS}.json`, "conflict_markers"],
        [`${MISMATCH}.json`, "id_mismatch"],
      ].sort(),
    );
    expect(r.ok).toBe(false);
  });

  it("a clean tree is ok; no records dir is ok with zero files", () => {
    write(rec("decisions", `${GOOD}.json`), JSON.stringify({ id: GOOD }));
    expect(validateRecordsTree(root)).toMatchObject({
      ok: true,
      files_checked: 1,
      findings: [],
    });
    fs.rmSync(rec(), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, ".twining"), { recursive: true });
    expect(validateRecordsTree(root)).toMatchObject({
      ok: true,
      records_dir_present: false,
      files_checked: 0,
    });
  });

  it("reports tracked *.tmp, twining.db and frozen aggregates in a git repo (sqlite-era store)", () => {
    write(rec("decisions", `${GOOD}.json`), JSON.stringify({ id: GOOD }));
    write(rec("decisions", `${GOOD}.json.123.abc.tmp`), "tmp");
    write(path.join(root, ".twining", "twining.db"), "SQLite format 3\0");
    write(path.join(root, ".twining", "decisions", "index.json"), "[]");
    write(path.join(root, ".twining", "graph", "entities.json"), "[]");
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "init");
    const r = validateRecordsTree(root);
    expect(r.sqlite_era).toBe(true);
    expect(r.tracked).toEqual({
      tmp_files: [`.twining/records/decisions/${GOOD}.json.123.abc.tmp`],
      db_files: [".twining/twining.db"],
      frozen_aggregates_tracked: [
        ".twining/decisions/index.json",
        ".twining/graph/entities.json",
      ],
    });
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(false); // tracked tmp/db fail; frozen aggregates are informational
  });
});

describe("runValidateRecordsCli (2.16.1)", () => {
  let logs: string[];
  let errors: string[];
  beforeEach(() => {
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.join(" "));
    });
  });
  it("exit 0 on a clean tree, 1 on findings, --json prints the report", async () => {
    write(rec("decisions", `${GOOD}.json`), JSON.stringify({ id: GOOD }));
    expect(await runValidateRecordsCli(["--project", root])).toBe(0);
    write(rec("decisions", `${EMPTY}.json`), "");
    expect(await runValidateRecordsCli(["--project", root, "--json"])).toBe(1);
    const report = JSON.parse(logs.at(-1)!);
    expect(report.findings).toHaveLength(1);
  });
  it("exit 2 on usage errors and when there is no .twining/", async () => {
    expect(await runValidateRecordsCli(["--bogus"])).toBe(2);
    expect(errors.at(-1)).toContain("usage");
    expect(await runValidateRecordsCli(["--project", path.join(root, "nope")])).toBe(2);
  });
});
