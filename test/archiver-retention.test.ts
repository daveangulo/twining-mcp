/**
 * Count-based archive retention + safe housekeeping defaults (field D4).
 *
 * The archive pass used to default cutoff=now with the housekeeping archive
 * flag defaulting true — so housekeeping({execute:true}) swept the ENTIRE
 * live board as a side effect of any maintenance call. These tests pin:
 * retention keeps the newest K non-exempt entries; open questions joined
 * the #40 exemption; the trigger count and sweep share one partition
 * (mirror-by-construction, the #35 lesson); and housekeeping no longer
 * archives by default.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  partitionArchivable,
  Archiver,
} from "../src/engine/archiver.js";
import { computeResolvedIds } from "../src/engine/resolution.js";
import { BlackboardStore } from "../src/storage/blackboard-store.js";
import { DecisionStore } from "../src/storage/decision-store.js";
import { BlackboardEngine } from "../src/engine/blackboard.js";
import { HousekeepingEngine } from "../src/engine/housekeeping.js";
import type { BlackboardEntry } from "../src/utils/types.js";

function entry(
  id: string,
  entry_type: BlackboardEntry["entry_type"],
  timestamp: string,
  extra: Partial<BlackboardEntry> = {},
): BlackboardEntry {
  return {
    id,
    timestamp,
    agent_id: "main",
    entry_type,
    tags: [],
    scope: "src/",
    summary: `${id} summary`,
    detail: "",
    ...extra,
  };
}

const FUTURE = "9999-12-31T23:59:59.999Z";

describe("partitionArchivable", () => {
  it("retains the newest K non-exempt entries; older ones archive", () => {
    const entries = [
      entry("f1", "finding", "2026-01-01T00:00:00.000Z"),
      entry("f2", "finding", "2026-01-02T00:00:00.000Z"),
      entry("f3", "finding", "2026-01-03T00:00:00.000Z"),
      entry("f4", "finding", "2026-01-04T00:00:00.000Z"),
    ];
    const p = partitionArchivable(entries, new Set(), {
      before: FUTURE,
      retain: 2,
    });
    expect(p.to_archive.map((e) => e.id).sort()).toEqual(["f1", "f2"]);
    expect(p.retained_count).toBe(2);
  });

  it("retention is a floor of recent working memory — exempt entries do not consume it", () => {
    const entries = [
      entry("open-need", "need", "2026-01-09T00:00:00.000Z"),
      entry("f1", "finding", "2026-01-01T00:00:00.000Z"),
      entry("f2", "finding", "2026-01-02T00:00:00.000Z"),
    ];
    const p = partitionArchivable(entries, new Set(), {
      before: FUTURE,
      retain: 1,
    });
    // The open need is exempt (not retained-from-quota); f2 is retained; f1 archives.
    expect(p.to_archive.map((e) => e.id)).toEqual(["f1"]);
    expect(p.kept_open_count).toBe(1);
    expect(p.retained_count).toBe(1);
  });

  it("open questions are exempt like needs/warnings; resolved questions drain (D4 aligns #40 with triage)", () => {
    const entries = [
      entry("open-q", "question", "2026-01-01T00:00:00.000Z"),
      entry("answered-q", "question", "2026-01-02T00:00:00.000Z"),
      entry("answer", "answer", "2026-01-03T00:00:00.000Z", {
        relates_to: ["answered-q"],
      }),
      entry("resolved-q", "question", "2026-01-04T00:00:00.000Z", {
        status: "resolved",
      }),
    ];
    const resolved = computeResolvedIds(entries);
    const p = partitionArchivable(entries, resolved, { before: FUTURE });
    const archived = p.to_archive.map((e) => e.id).sort();
    expect(archived).toContain("answered-q");
    expect(archived).toContain("resolved-q");
    expect(archived).not.toContain("open-q");
    expect(p.kept_open_count).toBe(1);
  });

  it("retain: 0 (default) preserves legacy full-sweep semantics", () => {
    const entries = [
      entry("f1", "finding", "2026-01-01T00:00:00.000Z"),
      entry("f2", "finding", "2026-01-02T00:00:00.000Z"),
    ];
    const p = partitionArchivable(entries, new Set(), { before: FUTURE });
    expect(p.to_archive).toHaveLength(2);
    expect(p.retained_count).toBe(0);
  });
});

describe("trigger/sweep mirror + housekeeping defaults", () => {
  let dir: string;
  let store: BlackboardStore;
  let engine: BlackboardEngine;
  let archiver: Archiver;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-retention-"));
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), "");
    fs.mkdirSync(path.join(dir, "decisions"), { recursive: true });
    fs.writeFileSync(path.join(dir, "decisions", "index.json"), "[]");
    store = new BlackboardStore(dir);
    engine = new BlackboardEngine(store);
    archiver = new Archiver(dir, store, engine, null);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("Archiver.plan and the shared partition agree exactly (mirror-by-construction)", async () => {
    for (let i = 0; i < 6; i++) {
      await store.append({
        entry_type: "finding",
        summary: `finding ${i}`,
        detail: "",
        tags: [],
        scope: "src/",
        agent_id: "main",
      });
    }
    await store.append({
      entry_type: "need",
      summary: "open need",
      detail: "",
      tags: [],
      scope: "src/",
      agent_id: "main",
    });

    const { entries } = await store.read();
    const resolved = computeResolvedIds(entries);
    const direct = partitionArchivable(entries, resolved, {
      before: FUTURE,
      retain: 2,
    });
    const viaPlan = await archiver.plan({ before: FUTURE, retain: 2 });

    expect(viaPlan.to_archive.map((e) => e.id)).toEqual(
      direct.to_archive.map((e) => e.id),
    );
    expect(viaPlan.kept_open_count).toBe(direct.kept_open_count);
    expect(viaPlan.retained_count).toBe(direct.retained_count);
    // 6 findings, retain 2 → 4 archive; the open need is exempt.
    expect(viaPlan.to_archive).toHaveLength(4);
  });

  it("archive() honors retention end-to-end: newest K survive on the board", async () => {
    for (let i = 0; i < 5; i++) {
      await store.append({
        entry_type: "finding",
        summary: `finding ${i}`,
        detail: "",
        tags: [],
        scope: "src/",
        agent_id: "main",
      });
    }
    const result = await archiver.archive({
      before: FUTURE,
      retain: 2,
      summarize: false,
    });
    expect(result.archived_count).toBe(3);
    expect(result.retained_count).toBe(2);
    const { entries } = await store.read();
    expect(entries.filter((e) => e.entry_type === "finding")).toHaveLength(2);
  });

  it("housekeeping({execute:true}) with defaults NO LONGER sweeps the board (D4 default flip)", async () => {
    for (let i = 0; i < 5; i++) {
      await store.append({
        entry_type: "finding",
        summary: `finding ${i}`,
        detail: "",
        tags: [],
        scope: "src/",
        agent_id: "main",
      });
    }
    const hk = new HousekeepingEngine(
      dir,
      store,
      new DecisionStore(dir),
      archiver,
      null,
    );
    const result = await hk.run({ execute: true });
    expect(result.archived.count).toBe(0);
    const { entries } = await store.read();
    expect(entries.length).toBeGreaterThanOrEqual(5); // board untouched
  });

  it("housekeeping archive:true applies the configured retention symmetrically in preview and execute", async () => {
    // Seed with fixed PAST timestamps so cutoff=now cannot race a same-
    // millisecond append (flaked under parallel-suite load with append()).
    const lines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify(
        entry(`hf${i}`, "finding", `2026-01-0${i + 1}T00:00:00.000Z`),
      ),
    );
    fs.writeFileSync(path.join(dir, "blackboard.jsonl"), lines.join("\n") + "\n");

    const mkHk = () =>
      new HousekeepingEngine(
        dir,
        new BlackboardStore(dir),
        new DecisionStore(dir),
        archiver,
        null,
        null,
        undefined as unknown as number,
        2, // archiveRetain
      );

    const preview = await mkHk().run({ archive: true });
    expect(preview.archived.count).toBe(3); // 5 findings, retain newest 2

    const executed = await mkHk().run({ archive: true, execute: true });
    expect(executed.archived.count).toBe(3);

    const { entries } = await new BlackboardStore(dir).read();
    expect(entries.filter((e) => e.entry_type === "finding").map((e) => e.id).sort()).toEqual(
      ["hf3", "hf4"],
    ); // newest 2 retained
  });
});
