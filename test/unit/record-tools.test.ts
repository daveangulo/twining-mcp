import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BlackboardStore } from "../../src/storage/blackboard-store.js";
import { DecisionStore } from "../../src/storage/decision-store.js";
import { BlackboardEngine } from "../../src/engine/blackboard.js";
import { DecisionEngine } from "../../src/engine/decisions.js";
import { registerRecordTools } from "../../src/tools/record-tools.js";

let tmpDir: string;
let server: McpServer;
let bbEngine: BlackboardEngine;
let dcsnEngine: DecisionEngine;
let bbStore: BlackboardStore;
let dcsnStore: DecisionStore;

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const registered = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools;
  const tool = registered[name];
  if (!tool) throw new Error(`Tool ${name} not found`);
  return (await tool.handler(args, {} as unknown)) as {
    content: Array<{ type: string; text: string }>;
  };
}

function parseToolResponse(response: {
  content: Array<{ type: string; text: string }>;
}): unknown {
  return JSON.parse(response.content[0]!.text);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "twining-record-tools-test-"));
  fs.writeFileSync(path.join(tmpDir, "blackboard.jsonl"), "");
  fs.mkdirSync(path.join(tmpDir, "decisions"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "decisions", "index.json"),
    JSON.stringify([]),
  );

  bbStore = new BlackboardStore(tmpDir);
  dcsnStore = new DecisionStore(tmpDir);
  bbEngine = new BlackboardEngine(bbStore);
  dcsnEngine = new DecisionEngine(dcsnStore, bbEngine);

  server = new McpServer({ name: "test-server", version: "1.0.0" });
  registerRecordTools(server, bbEngine, dcsnEngine, tmpDir, tmpDir, {
    fullSurface: true,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function loadDecisionFile(id: string): Record<string, unknown> {
  const filePath = path.join(tmpDir, "decisions", `${id}.json`);
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

describe("twining_record — structured fields (bug fix)", () => {
  it("accepts structured alternatives directly and bypasses the NL parser", async () => {
    const alternatives = [
      {
        option: "Exploration-efficiency ROI as primary wedge",
        reason_rejected:
          "Demoted to Phase 1 supporting result; used as a context-reconstitution proxy, not the headline claim.",
      },
      {
        option: "Shared-markdown-hurts-in-conflict/recovery as headline",
        reason_rejected:
          "Absorbed into the broader macro-loop scorecard as one finding among several.",
      },
      {
        option: "Minimal coordination budget / lite-matches-full as headline",
        reason_rejected:
          "Weakened by current sprint-sim data at n=16 (d=2.12 full vs 1.19 lite); not strong enough to anchor on.",
      },
      {
        option: "Agent Teams as primary condition",
        reason_rejected:
          "Wrong layer — Agent Teams is intra-loop parallelism, not sprint-over-sprint coordination.",
      },
    ];

    const resp = (await callTool("twining_record", {
      summary: "Session recorded macro-loop decision",
      scope: "research/direction",
      decisions: [
        {
          summary: "Benchmark scope is the macro loop",
          rationale:
            "No existing benchmark measures sustained-codebase coordination across sprints and releases.",
          alternatives,
        },
      ],
    })) as { content: Array<{ type: string; text: string }> };

    const body = parseToolResponse(resp) as {
      decisions_created: Array<{ id: string; summary: string }>;
    };

    expect(body.decisions_created.length).toBe(1);
    const stored = loadDecisionFile(body.decisions_created[0]!.id);
    expect(stored.summary).toBe("Benchmark scope is the macro loop");
    expect(stored.alternatives).toEqual(
      alternatives.map((a) => ({
        option: a.option,
        pros: [],
        cons: [],
        reason_rejected: a.reason_rejected,
      })),
    );
  });

  it("preserves a 1500-char rationale via the structured path with no truncation", async () => {
    const longRationale = "Z".repeat(1500);
    const resp = await callTool("twining_record", {
      summary: "Recording long rationale",
      scope: "test/long/",
      decisions: [
        {
          summary: "Chose a long-winded approach",
          rationale: longRationale,
        },
      ],
    });
    const body = parseToolResponse(resp) as {
      decisions_created: Array<{ id: string }>;
    };
    expect(body.decisions_created.length).toBe(1);
    const stored = loadDecisionFile(body.decisions_created[0]!.id);
    expect((stored.rationale as string).length).toBe(1500);
    expect(stored.rationale).toBe(longRationale);
  });

  it("persists structured assumptions and constraints per-decision", async () => {
    const resp = await callTool("twining_record", {
      summary: "Session recorded",
      scope: "src/x/",
      decisions: [
        {
          summary: "Chose the thing",
          rationale: "It is the correct thing.",
          assumptions: ["data is relational", "no strict ordering"],
          constraints: ["node >=18", "no new deps"],
        },
      ],
    });
    const body = parseToolResponse(resp) as {
      decisions_created: Array<{ id: string }>;
    };
    const stored = loadDecisionFile(body.decisions_created[0]!.id);
    expect(stored.assumptions).toEqual([
      "data is relational",
      "no strict ordering",
    ]);
    expect(stored.constraints).toEqual(["node >=18", "no new deps"]);
  });

  it("accepts both NL strings and structured objects in a mixed decisions array", async () => {
    const resp = await callTool("twining_record", {
      summary: "Mixed decisions session",
      scope: "src/mix/",
      decisions: [
        "Chose Redis over Memcached — need persistence",
        {
          summary: "Structured choice",
          rationale: "because structured",
          alternatives: [{ option: "alt1", reason_rejected: "because alt1" }],
        },
      ],
    });
    const body = parseToolResponse(resp) as {
      decisions_created: Array<{ id: string; summary: string }>;
    };
    expect(body.decisions_created.length).toBe(2);
    const nl = loadDecisionFile(body.decisions_created[0]!.id);
    const structured = loadDecisionFile(body.decisions_created[1]!.id);
    expect(nl.summary).toBe("Chose Redis over Memcached");
    expect(structured.summary).toBe("Structured choice");
    expect(
      (structured.alternatives as Array<{ option: string }>)[0]!.option,
    ).toBe("alt1");
  });
});

describe("twining_record — decisions_created response accuracy (bug fix)", () => {
  it("reports decisions_created for an NL decision whose parsed summary exceeds the 200-char blackboard limit", async () => {
    // Long summary (>200 chars). Before the fix, this caused decide() to throw
    // after the file was written (cross-post rejected by blackboard) and the
    // response returned decisions_created: [].
    const longSummary =
      "Benchmark scope is the macro loop: multi-sprint, multi-release coordination for sustained software engineering. " +
      "No existing benchmark measures sustained-codebase coordination across sprints and releases. " +
      "This is a long summary well beyond two hundred characters.";
    expect(longSummary.length).toBeGreaterThan(200);

    const resp = await callTool("twining_record", {
      summary: "Recording a long NL decision",
      scope: "research/long/",
      decisions: [longSummary],
    });

    const body = parseToolResponse(resp) as {
      decisions_created: Array<{ id: string }>;
    };
    expect(body.decisions_created.length).toBe(1);

    // Decision file must actually be on disk with full summary preserved.
    const stored = loadDecisionFile(body.decisions_created[0]!.id);
    expect(typeof stored.summary).toBe("string");
    expect((stored.summary as string).length).toBeGreaterThan(200);
  });

  it("reports decisions_created for a structured decision whose summary exceeds the 200-char blackboard limit", async () => {
    const longSummary = "A".repeat(500);
    const resp = await callTool("twining_record", {
      summary: "Recording a structured long-summary decision",
      scope: "research/long/",
      decisions: [
        {
          summary: longSummary,
          rationale: "Because reasons.",
        },
      ],
    });
    const body = parseToolResponse(resp) as {
      decisions_created: Array<{ id: string }>;
    };
    expect(body.decisions_created.length).toBe(1);
    const stored = loadDecisionFile(body.decisions_created[0]!.id);
    expect((stored.summary as string).length).toBe(500);
  });
});

describe("twining_record — regression (structured path)", () => {
  it("end-to-end: structured path with multi-sentence rationale + 4 rejected alternatives round-trips exactly", async () => {
    const rationale =
      "No existing benchmark measures sustained-codebase coordination across sprints and releases. " +
      "LongMemEval and LoCoMo measure long-conversation retrieval; tau-bench and CooperBench measure tool-use and task completion; REP measures non-coding coordination. " +
      "Memory-framework comparisons report retrieval scores on conversational data, not task outcomes on sustained codebases. " +
      "Agent Teams (Anthropic, Feb 2026) operates inside the inner loop and is reframed as orthogonal to substrate choice.";

    const alternatives = [
      {
        option: "Exploration-efficiency ROI as primary wedge",
        reason_rejected:
          "Demoted to Phase 1 supporting result; used as a context-reconstitution proxy, not the headline claim.",
      },
      {
        option: "Shared-markdown-hurts-in-conflict/recovery as headline",
        reason_rejected:
          "Absorbed into the broader macro-loop scorecard as one finding among several.",
      },
      {
        option: "Minimal coordination budget / lite-matches-full as headline",
        reason_rejected:
          "Weakened by current sprint-sim data at n=16 (d=2.12 full vs 1.19 lite); not strong enough to anchor on.",
      },
      {
        option: "Agent Teams as primary condition",
        reason_rejected:
          "Wrong layer — Agent Teams is intra-loop parallelism, not sprint-over-sprint coordination.",
      },
    ];

    const resp = await callTool("twining_record", {
      summary: "Structured regression check",
      scope: "research/direction/",
      decisions: [
        {
          summary:
            "Benchmark scope is the macro loop: multi-sprint, multi-release coordination for sustained software engineering",
          rationale,
          alternatives,
          confidence: "high",
        },
      ],
    });

    const body = parseToolResponse(resp) as {
      decisions_created: Array<{ id: string }>;
    };
    expect(body.decisions_created.length).toBe(1);

    const stored = loadDecisionFile(body.decisions_created[0]!.id) as {
      summary: string;
      rationale: string;
      confidence: string;
      alternatives: Array<{ option: string; reason_rejected: string }>;
    };
    expect(stored.summary).toContain("Benchmark scope is the macro loop");
    expect(stored.rationale).toBe(rationale);
    expect(stored.confidence).toBe("high");
    expect(stored.alternatives.length).toBe(4);
    stored.alternatives.forEach((alt, i) => {
      expect(alt.option).toBe(alternatives[i]!.option);
      expect(alt.reason_rejected).toBe(alternatives[i]!.reason_rejected);
    });
  });
});

describe("twining_record — regression (existing NL path)", () => {
  it("end-to-end: NL path with multi-sentence rationale + 4 numbered rejected alternatives round-trips", async () => {
    const nlDecision =
      "Benchmark scope is the macro loop — multi-sprint, multi-release coordination across a sustained codebase. " +
      "Rationale: no existing benchmark measures this category. " +
      "Rejected alternatives: (1) Exploration-efficiency ROI as primary wedge, " +
      "(2) Shared-markdown-hurts-in-conflict as headline, " +
      "(3) Minimal coordination budget / lite-matches-full as headline, " +
      "(4) Agent Teams as primary condition.";

    const resp = await callTool("twining_record", {
      summary: "NL regression check",
      scope: "research/direction/",
      decisions: [nlDecision],
    });

    const body = parseToolResponse(resp) as {
      decisions_created: Array<{ id: string }>;
    };
    expect(body.decisions_created.length).toBe(1);

    const stored = loadDecisionFile(body.decisions_created[0]!.id) as {
      summary: string;
      rationale: string;
      alternatives: Array<{ option: string }>;
    };
    // The "Rationale:" marker wins over fallback separators, so summary is
    // everything before it (em-dash and following clause included) and the
    // rationale starts after it and preserves the full tail including the
    // numbered alternatives list.
    expect(stored.summary).toContain("Benchmark scope is the macro loop");
    expect(stored.summary).toContain("multi-release coordination");
    expect(stored.rationale).toContain("no existing benchmark");
    expect(stored.alternatives.length).toBe(4);
    expect(stored.alternatives[0]!.option).toContain("Exploration-efficiency ROI");
    expect(stored.alternatives[3]!.option).toContain("Agent Teams");
  });
});

describe("twining_record — status summary truncation (decision B)", () => {
  it("succeeds with a 250-char summary: stored entry is truncated, full text in detail, response notes truncation", async () => {
    const longSummary = "S".repeat(250);
    const resp = await callTool("twining_record", {
      summary: longSummary,
      scope: "src/x/",
    });

    const body = parseToolResponse(resp) as {
      status_entry_id: string;
      message: string;
    };
    expect(body.status_entry_id).toBeTruthy();
    expect(body.message).toContain("summary truncated to 200 chars");

    const { entries } = await bbEngine.read({ entry_types: ["status"] });
    const entry = entries.find((e) => e.id === body.status_entry_id)!;
    expect(entry.summary.length).toBeLessThanOrEqual(200);
    expect(entry.summary).toBe(longSummary.slice(0, 197) + "…");
    expect(entry.summary.endsWith("…")).toBe(true);
    expect(entry.detail).toContain(`Full summary: ${longSummary}`);
  });

  it("does not truncate a summary within the 200-char limit", async () => {
    const resp = await callTool("twining_record", {
      summary: "A short summary",
      scope: "src/x/",
    });
    const body = parseToolResponse(resp) as { message: string };
    expect(body.message).not.toContain("truncated");
  });
});

describe("twining_record — finding truncation and error surfacing (decision C)", () => {
  it("creates a finding with a 250-char summary: truncated summary, full text in detail", async () => {
    const longFinding = "F".repeat(250);
    const resp = await callTool("twining_record", {
      summary: "Session with a long finding",
      scope: "src/x/",
      findings: [longFinding],
    });

    const body = parseToolResponse(resp) as {
      findings_created: Array<{ id: string; summary: string }>;
    };
    expect(body.findings_created.length).toBe(1);
    expect(body.findings_created[0]!.summary.length).toBeLessThanOrEqual(200);
    expect(body.findings_created[0]!.summary).toBe(
      longFinding.slice(0, 197) + "…",
    );
    expect(body.findings_created[0]!.summary.endsWith("…")).toBe(true);

    const { entries } = await bbEngine.read({ entry_types: ["finding"] });
    const entry = entries.find((e) => e.id === body.findings_created[0]!.id)!;
    expect(entry.detail).toContain(`Full summary: ${longFinding}`);
  });

  it("surfaces a genuinely failed finding post in the response without dropping other findings", async () => {
    const originalPost = bbEngine.post.bind(bbEngine);
    let calls = 0;
    bbEngine.post = (async (input: Parameters<typeof originalPost>[0]) => {
      calls++;
      // First call is the status post; second call is the first finding — fail only that one.
      if (calls === 2) {
        throw new Error("simulated post failure");
      }
      return originalPost(input);
    }) as typeof bbEngine.post;

    const resp = await callTool("twining_record", {
      summary: "Session with one failing finding",
      scope: "src/x/",
      findings: ["this one fails", "this one succeeds"],
    });

    bbEngine.post = originalPost;

    const body = parseToolResponse(resp) as {
      findings_created: Array<{ id: string; summary: string }>;
      finding_errors?: string[];
      message: string;
    };
    expect(body.findings_created.length).toBe(1);
    expect(body.findings_created[0]!.summary).toBe("this one succeeds");
    expect(body.finding_errors).toBeDefined();
    expect(body.finding_errors!.length).toBe(1);
    expect(body.finding_errors![0]).toContain("simulated post failure");
    expect(body.message).toContain("1 finding(s) failed");
  });
});

describe("twining_record — depends_on validation surfacing (decision F)", () => {
  it("mentions ignored unknown depends_on ids when a decision references them", async () => {
    const resp = await callTool("twining_record", {
      summary: "Session with a decision that depends on a fake id",
      scope: "src/x/",
      decisions: [
        {
          summary: "Chose the thing",
          rationale: "Because reasons.",
        },
      ],
      depends_on: ["01NOTREALDECISIONIDXXXXXXX", "01ALSOFAKEDECISIONIDXXXXXX"],
    });

    const body = parseToolResponse(resp) as {
      message: string;
      dropped_depends_on?: string[];
    };
    expect(body.dropped_depends_on).toBeDefined();
    expect(body.dropped_depends_on!.length).toBe(2);
    expect(body.message).toContain("ignored 2 unknown depends_on id(s)");
  });
});

describe("twining_record — sentinel for pre-commit hook", () => {
  it("writes .last-record with a current unix timestamp on success", async () => {
    const before = Math.floor(Date.now() / 1000);
    await callTool("twining_record", { summary: "did some work" });
    const sentinelPath = path.join(tmpDir, ".last-record");
    expect(fs.existsSync(sentinelPath)).toBe(true);
    const ts = parseInt(fs.readFileSync(sentinelPath, "utf-8"), 10);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  });
});

describe("twining_record — per-decision creation-time status (2.5.0)", () => {
  it("persists status: provisional via the structured path; NL strings stay active", async () => {
    const resp = await callTool("twining_record", {
      summary: "Session recorded",
      scope: "src/x/",
      decisions: [
        {
          summary: "Adopt the irreversible storage layout",
          rationale: "Awaiting lead ratification before build.",
          status: "provisional",
        },
        "Chose Y over Z — simpler and reversible",
      ],
    });
    const body = parseToolResponse(resp) as {
      decisions_created: Array<{ id: string }>;
    };
    expect(body.decisions_created.length).toBe(2);
    expect(loadDecisionFile(body.decisions_created[0]!.id).status).toBe("provisional");
    expect(loadDecisionFile(body.decisions_created[1]!.id).status).toBe("active");
  });
});

describe("twining_record — status error paths (2.5.0 review fixes)", () => {
  it("reports an invalid status via decision_errors while persisting the valid sibling", async () => {
    const resp = await callTool("twining_record", {
      summary: "Session recorded",
      scope: "src/x/",
      decisions: [
        { summary: "bad status decision", rationale: "r", status: "superseded" },
        "Chose Y over Z — simpler",
      ],
    });
    const body = parseToolResponse(resp) as {
      decisions_created: Array<{ id: string }>;
      decision_errors?: string[];
    };
    expect(body.decisions_created.length).toBe(1);
    expect(loadDecisionFile(body.decisions_created[0]!.id).status).toBe("active");
    expect(body.decision_errors?.length).toBe(1);
    expect(body.decision_errors![0]).toContain(
      'status must be "active" or "provisional"',
    );
  });

  it("rejects provisional minting on the default surface with a clear per-decision error", async () => {
    const defaultServer = new McpServer({ name: "t", version: "1.0.0" });
    registerRecordTools(defaultServer, bbEngine, dcsnEngine, tmpDir, tmpDir);
    const registered = (
      defaultServer as unknown as {
        _registeredTools: Record<
          string,
          { handler: (a: Record<string, unknown>, e: unknown) => Promise<unknown> }
        >;
      }
    )._registeredTools;
    const resp = (await registered["twining_record"]!.handler(
      {
        summary: "Session recorded",
        scope: "src/x/",
        decisions: [
          { summary: "wants ratification", rationale: "r", status: "provisional" },
        ],
      },
      {},
    )) as { content: Array<{ type: string; text: string }> };
    const body = parseToolResponse(resp) as {
      decisions_created: Array<{ id: string }>;
      decision_errors?: string[];
    };
    expect(body.decisions_created.length).toBe(0);
    expect(body.decision_errors![0]).toContain("full_surface");
  });

  it("rejects provisional + supersedes at creation (engine guard)", async () => {
    const target = await dcsnEngine.decide({
      domain: "architecture",
      scope: "src/x/",
      summary: "the incumbent",
      context: "c",
      rationale: "r",
    });
    const resp = await callTool("twining_record", {
      summary: "Session recorded",
      scope: "src/x/",
      supersedes: target.id,
      decisions: [
        { summary: "proposed replacement", rationale: "r", status: "provisional" },
      ],
    });
    const body = parseToolResponse(resp) as {
      decisions_created: Array<{ id: string }>;
      decision_errors?: string[];
    };
    expect(body.decisions_created.length).toBe(0);
    expect(body.decision_errors![0]).toContain("cannot supersede at creation");
    // the incumbent must be untouched
    const incumbent = loadDecisionFile(target.id);
    expect(incumbent.status).toBe("active");
  });
});

describe("twining_record — origin marker and tag split (field defect D1)", () => {
  it("stamps the status post with tag session-record and origin narration", async () => {
    await callTool("twining_record", {
      summary: "Session narration summary",
      findings: ["Discovered something load-bearing"],
    });

    const { entries } = await bbStore.read();
    const status = entries.find((e) => e.entry_type === "status");
    expect(status).toBeDefined();
    expect(status!.tags).toContain("session-record");
    expect(status!.origin).toBe("narration");
  });

  it("stamps fanned-out findings with tag session-finding (NOT session-record) and origin discovery", async () => {
    await callTool("twining_record", {
      summary: "Session narration summary",
      findings: [
        "Plain finding text",
        "warning: something risky",
        "need: something owed",
      ],
    });

    const { entries } = await bbStore.read();
    const fanned = entries.filter((e) => e.entry_type !== "status");
    expect(fanned).toHaveLength(3);
    for (const entry of fanned) {
      expect(entry.tags).toContain("session-finding");
      expect(entry.tags).not.toContain("session-record");
      expect(entry.origin).toBe("discovery");
    }
    const types = fanned.map((e) => e.entry_type).sort();
    expect(types).toEqual(["finding", "need", "warning"]);
  });

  it("leaves origin absent on plain twining_post entries (absent = unknown, mirroring rationale_source)", async () => {
    await bbEngine.post({ entry_type: "finding", summary: "direct post" });
    const { entries } = await bbStore.read();
    expect(entries[0]!.origin).toBeUndefined();
  });
});

describe("twining_record resolves[] — ordering and failure containment (review fixes)", () => {
  it("resolves BEFORE posting the status entry, so stamps persist before any post-triggered sweep", async () => {
    const { vi } = await import("vitest");
    const need = await bbEngine.post({ entry_type: "need", summary: "race target" });
    const resolveSpy = vi.spyOn(bbEngine, "resolve");
    const postSpy = vi.spyOn(bbEngine, "post");

    await callTool("twining_record", {
      summary: "Handled the race target",
      resolves: [need.id],
    });

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(postSpy).toHaveBeenCalled();
    const resolveOrder = resolveSpy.mock.invocationCallOrder[0]!;
    const firstPostOrder = postSpy.mock.invocationCallOrder[0]!;
    expect(resolveOrder).toBeLessThan(firstPostOrder);

    const { entries } = await bbStore.read();
    const target = entries.find((e) => e.id === need.id)!;
    expect(target.status).toBe("resolved");
    resolveSpy.mockRestore();
    postSpy.mockRestore();
  });

  it("a throwing resolve degrades to resolve_errors instead of aborting the record", async () => {
    const { vi } = await import("vitest");
    const resolveSpy = vi
      .spyOn(bbEngine, "resolve")
      .mockRejectedValueOnce(new Error("lock contention"));

    const parsed = parseToolResponse(
      await callTool("twining_record", {
        summary: "Record survives resolve failure",
        resolves: ["some-id"],
      }),
    ) as { status_entry_id?: string; resolve_errors?: string[]; message: string };

    expect(parsed.status_entry_id).toBeDefined();
    expect(parsed.resolve_errors).toEqual(["lock contention"]);
    expect(parsed.message).toContain("resolve failed");
    resolveSpy.mockRestore();
  });
});

describe("twining_record — per-decision affected_files/affected_symbols (field D7)", () => {
  it("persists per-decision affected_files and affected_symbols from a structured decision", async () => {
    const body = parseToolResponse(
      await callTool("twining_record", {
        summary: "Session fixing the governance carrier",
        scope: "src/engine/",
        decisions: [
          {
            summary: "Fixed GOVERN-2.1 to name both carriers",
            rationale: "The spec named only one carrier site.",
            affected_files: ["specs/compliance-projection/spec.md"],
            affected_symbols: ["GovernanceKernel.emitMask"],
          },
        ],
      }),
    ) as { decisions_created: Array<{ id: string }> };

    expect(body.decisions_created.length).toBe(1);
    const stored = loadDecisionFile(body.decisions_created[0]!.id);
    expect(stored.affected_files).toEqual([
      "specs/compliance-projection/spec.md",
    ]);
    expect(stored.affected_symbols).toEqual(["GovernanceKernel.emitMask"]);
  });

  it("prefers per-decision affected_files over the session-level list, falling back when absent", async () => {
    const body = parseToolResponse(
      await callTool("twining_record", {
        summary: "Session touching two areas",
        scope: "src/",
        affected_files: ["src/session-level.ts"],
        decisions: [
          {
            summary: "Decision with its own file list",
            rationale: "Governs a different artifact than the session diff.",
            affected_files: ["specs/own-target.md"],
          },
          {
            summary: "Decision without a file list",
            rationale: "Falls back to the session-level list.",
          },
        ],
      }),
    ) as { decisions_created: Array<{ id: string }> };

    expect(body.decisions_created.length).toBe(2);
    const first = loadDecisionFile(body.decisions_created[0]!.id);
    const second = loadDecisionFile(body.decisions_created[1]!.id);
    expect(first.affected_files).toEqual(["specs/own-target.md"]);
    expect(second.affected_files).toEqual(["src/session-level.ts"]);
  });

  it("keeps the session-level affected_files for NL string decisions", async () => {
    const body = parseToolResponse(
      await callTool("twining_record", {
        summary: "Session with an NL decision",
        scope: "src/",
        affected_files: ["src/nl-target.ts"],
        decisions: ["Chose X over Y — session-level files apply"],
      }),
    ) as { decisions_created: Array<{ id: string }> };

    const stored = loadDecisionFile(body.decisions_created[0]!.id);
    expect(stored.affected_files).toEqual(["src/nl-target.ts"]);
  });

  it("inputSchema retains per-decision affected_files instead of stripping them (D7 zod half)", async () => {
    const registered = (
      server as unknown as {
        _registeredTools: Record<
          string,
          { inputSchema?: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } }
        >;
      }
    )._registeredTools;
    const schema = registered["twining_record"]!.inputSchema!;
    const result = schema.safeParse({
      summary: "Schema round-trip",
      scope: "src/",
      decisions: [
        {
          summary: "Carries its own files",
          affected_files: ["specs/spec.md"],
          affected_symbols: ["Klass.method"],
        },
      ],
    });
    expect(result.success).toBe(true);
    const decisions = (result.data as { decisions: Array<Record<string, unknown>> })
      .decisions;
    expect(decisions[0]!.affected_files).toEqual(["specs/spec.md"]);
    expect(decisions[0]!.affected_symbols).toEqual(["Klass.method"]);
  });
});

describe("twining_record — supersedes fan-out guard (field D10)", () => {
  async function createTarget(): Promise<string> {
    const body = parseToolResponse(
      await callTool("twining_record", {
        summary: "Session creating the target",
        scope: "src/",
        decisions: ["Chose the original approach — it worked"],
      }),
    ) as { decisions_created: Array<{ id: string }> };
    return body.decisions_created[0]!.id;
  }

  it("skips the supersession and says so when supersedes is combined with multiple decisions", async () => {
    const targetId = await createTarget();
    const body = parseToolResponse(
      await callTool("twining_record", {
        summary: "Session with ambiguous supersession",
        scope: "src/",
        supersedes: targetId,
        decisions: [
          "Chose A over B — first reason",
          "Chose C over D — second reason",
        ],
      }),
    ) as {
      decisions_created: Array<{ id: string }>;
      supersedes_skipped?: boolean;
      message: string;
    };

    expect(body.decisions_created).toHaveLength(2);
    expect(body.supersedes_skipped).toBe(true);
    expect(body.message).toContain("supersede");
    // The target must NOT have been flipped N times — it stays active.
    const target = loadDecisionFile(targetId);
    expect(target.status).toBe("active");
    expect(target.superseded_by).toBeUndefined();
  });

  it("applies the supersession normally with a single decision", async () => {
    const targetId = await createTarget();
    const body = parseToolResponse(
      await callTool("twining_record", {
        summary: "Session with unambiguous supersession",
        scope: "src/",
        supersedes: targetId,
        decisions: ["Chose the replacement — the original aged out"],
      }),
    ) as { decisions_created: Array<{ id: string }>; supersedes_skipped?: boolean };

    expect(body.supersedes_skipped).toBeUndefined();
    const target = loadDecisionFile(targetId);
    expect(target.status).toBe("superseded");
    expect(target.superseded_by).toBe(body.decisions_created[0]!.id);
  });
});

describe("twining_record — dangling supersedes surfaces on the default surface (review finding)", () => {
  it("reports supersedes_dangling in the response and message for a typo'd target", async () => {
    const body = parseToolResponse(
      await callTool("twining_record", {
        summary: "Session superseding a ghost",
        scope: "src/",
        supersedes: "01GHOST00000000000000000000",
        decisions: ["Chose the replacement — target id was mistyped"],
      }),
    ) as {
      decisions_created: Array<{ id: string }>;
      supersedes_dangling?: string;
      message: string;
    };

    expect(body.decisions_created).toHaveLength(1);
    expect(body.supersedes_dangling).toBe("01GHOST00000000000000000000");
    expect(body.message).toContain("NOT retired");
  });

  it("does not set supersedes_dangling when the target exists", async () => {
    const target = parseToolResponse(
      await callTool("twining_record", {
        summary: "Session creating the target",
        scope: "src/",
        decisions: ["Chose the original — it worked"],
      }),
    ) as { decisions_created: Array<{ id: string }> };

    const body = parseToolResponse(
      await callTool("twining_record", {
        summary: "Session superseding for real",
        scope: "src/",
        supersedes: target.decisions_created[0]!.id,
        decisions: ["Chose the replacement — the original aged out"],
      }),
    ) as { supersedes_dangling?: string };
    expect(body.supersedes_dangling).toBeUndefined();
  });
});

// HYG-record-fail-rate residue (2026-08-15 field audit S4-2): the engine has
// always accepted alternatives without reason_rejected; the tool schema
// rejecting them made the strictest field (a nicety) the failure cause. And
// an empty summary must fail with a repairable message, not a bare zod error.
describe("twining_record — input ergonomics (wave 1)", () => {
  it("rejects an empty summary with a named, repairable message", async () => {
    const response = await callTool("twining_record", { summary: "   " });
    const data = parseToolResponse(response) as {
      error: boolean;
      message: string;
      code: string;
    };
    expect(data.code).toBe("INVALID_INPUT");
    expect(data.message).toContain("summary");
    expect(data.message).toContain("non-empty");
  });

  it("accepts structured alternatives without reason_rejected", async () => {
    const response = await callTool("twining_record", {
      summary: "Did the thing",
      decisions: [
        {
          summary: "Chose A over B",
          rationale: "A is simpler",
          alternatives: [{ option: "B" }],
        },
      ],
    });
    const data = parseToolResponse(response) as {
      decisions_created: Array<{ id: string; summary: string }>;
      decision_errors?: unknown[];
    };
    expect(data.decisions_created).toHaveLength(1);
    expect(data.decision_errors ?? []).toEqual([]);
  });
});
