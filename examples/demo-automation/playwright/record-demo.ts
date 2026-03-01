#!/usr/bin/env npx tsx
/**
 * Twining MCP Demo Recorder — Playwright Orchestrator
 *
 * Automates the full demo: starts dashboard, launches browser with video
 * recording, runs all 4 acts via claude -p, switches tabs when data appears,
 * and injects overlays for visual storytelling.
 *
 * Usage:
 *   npm run demo:record           # Fully automated
 *   npm run demo:record:pause     # Pause before each act for manual timing
 */
import { chromium } from "@playwright/test";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { startDashboardServer, spawnClaudeAct } from "./claude-runner.js";
import { acts, standaloneNarration, type Act } from "./acts.js";
import {
  injectIntro,
  injectTaskOverlay,
  injectSessionBoundary,
  injectClosing,
  removeOverlay,
  showSubtitle,
  hideSubtitle,
} from "./overlays.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../../..");
const DEMO_DIR = resolve(__dirname, "../demo-project");
const DIST = resolve(ROOT, "dist/index.js");
const RECORDINGS_DIR = resolve(__dirname, "../recordings");

const PAUSE_MODE = process.env.DEMO_PAUSE === "1";

// ── Helpers ─────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  process.stderr.write(`[${ts}] ${msg}\n`);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForEnter(prompt: string): Promise<void> {
  if (!PAUSE_MODE) return;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(`⏸  ${prompt} — press Enter to continue...`, () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Poll a stat element until its textContent exceeds minValue.
 */
async function waitForStat(
  page: import("@playwright/test").Page,
  selector: string,
  minValue: number,
  timeout = 120_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const val = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? parseInt(el.textContent || "0", 10) : 0;
    }, selector);
    if (val > minValue) return;
    await sleep(500);
  }
  log(`Warning: timeout waiting for ${selector} > ${minValue}`);
}

async function clickTab(
  page: import("@playwright/test").Page,
  tab: string,
): Promise<void> {
  await page.click(`button[data-tab="${tab}"]`);
  log(`Tab → ${tab}`);
  await sleep(300);
}

async function clickView(
  page: import("@playwright/test").Page,
  dataView: string,
  dataTab: string,
): Promise<void> {
  await page.click(`.view-btn[data-view="${dataView}"][data-tab="${dataTab}"]`);
  log(`View → ${dataView} (${dataTab})`);
  await sleep(300);
}

/** Look up a narration cue by name and show it as a subtitle. */
function narrate(
  page: import("@playwright/test").Page,
  act: Act,
  cue: string,
): Promise<void> {
  const entry = act.narration.find((n) => n.cue === cue);
  if (entry) {
    log(`Subtitle: "${entry.text}"`);
    return showSubtitle(page, entry.text);
  }
  return Promise.resolve();
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Setup ──────────────────────────────────────────────────────
  log("Resetting demo state...");
  execSync(resolve(__dirname, "../reset-demo.sh"), { stdio: "inherit" });

  log("Starting dashboard server...");
  const dashboard = await startDashboardServer(DIST, DEMO_DIR);
  log(`Dashboard ready at ${dashboard.url}`);

  // Ensure cleanup on exit
  const cleanup = () => {
    try {
      dashboard.process.kill();
    } catch {}
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  // ── Browser ────────────────────────────────────────────────────
  log("Launching browser...");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: RECORDINGS_DIR, size: { width: 1920, height: 1080 } },
  });
  const page = await context.newPage();

  const dashboardUrl = `${dashboard.url}/?poll=1000&demo=1`;
  await page.goto(dashboardUrl);
  log("Waiting for dashboard connection...");
  await page.waitForSelector("#connection-dot.connected", { timeout: 15_000 });
  log("Dashboard connected.");

  // ── Intro ──────────────────────────────────────────────────────
  log("Intro title card");
  await injectIntro(page, "twining-mcp", "Persistent memory for AI agents");
  await sleep(4000);
  await removeOverlay(page);

  // ── Cold Open ──────────────────────────────────────────────────
  log("Cold open — Stats tab");
  await clickTab(page, "stats");
  await showSubtitle(page, standaloneNarration.coldOpen);
  await sleep(3000);
  await hideSubtitle(page);

  // ── Act 1 ──────────────────────────────────────────────────────
  const act1 = acts[0];
  await waitForEnter("Act 1: Discovery");
  log(`ACT ${act1.id}: ${act1.taskLabel}`);
  await injectTaskOverlay(page, act1.taskLabel);
  await narrate(page, act1, "start");

  const act1Promise = spawnClaudeAct(act1.prompt, DEMO_DIR);

  // Choreography: wait for blackboard entries, switch to blackboard stream
  await waitForStat(page, "#stat-bb-entries", 0);
  await clickTab(page, "blackboard");
  await narrate(page, act1, "blackboard");
  await sleep(500);
  await clickView(page, "stream", "blackboard");

  await act1Promise;
  await narrate(page, act1, "done");
  log("Act 1 complete");
  await sleep(2000); // Poll catch-up
  await hideSubtitle(page);
  await removeOverlay(page);

  // ── Act 2 ──────────────────────────────────────────────────────
  const act2 = acts[1];
  await waitForEnter("Act 2: Architecture Decision");
  log(`ACT ${act2.id}: ${act2.taskLabel}`);
  await injectTaskOverlay(page, act2.taskLabel);
  await narrate(page, act2, "start");

  const act2Promise = spawnClaudeAct(act2.prompt, DEMO_DIR);

  // Choreography: decisions → timeline → graph → visual
  await waitForStat(page, "#stat-active-decisions", 0);
  await clickTab(page, "decisions");
  await narrate(page, act2, "decision");
  await sleep(1000);
  await clickView(page, "timeline", "decisions");
  await sleep(1500);

  await waitForStat(page, "#stat-graph-entities", 0);
  await clickTab(page, "graph");
  await narrate(page, act2, "graph");
  await sleep(500);
  await clickView(page, "visual", "graph");

  await act2Promise;
  await narrate(page, act2, "done");
  log("Act 2 complete");
  await sleep(2000);
  await hideSubtitle(page);
  await removeOverlay(page);

  // ── Session Boundary ───────────────────────────────────────────
  await waitForEnter("Session boundary");
  log("Session boundary");
  await clickTab(page, "stats");
  await sleep(1000);
  await injectSessionBoundary(page);
  await sleep(4000);
  await removeOverlay(page);
  await sleep(500);

  // ── Act 3 ──────────────────────────────────────────────────────
  const act3 = acts[2];
  await waitForEnter("Act 3: Fresh Start");
  log(`ACT ${act3.id}: ${act3.taskLabel}`);
  await injectTaskOverlay(page, act3.taskLabel);
  await narrate(page, act3, "start");

  const act3Promise = spawnClaudeAct(act3.prompt, DEMO_DIR);

  // Choreography: wait for 2 agents, switch to agents tab
  await waitForStat(page, "#stat-registered-agents", 1);
  await clickTab(page, "agents");
  await narrate(page, act3, "agents");
  await sleep(2000);
  await narrate(page, act3, "assemble");

  await act3Promise;
  await narrate(page, act3, "done");
  log("Act 3 complete");
  await sleep(2000);
  await hideSubtitle(page);
  await removeOverlay(page);

  // ── Act 4 ──────────────────────────────────────────────────────
  const act4 = acts[3];
  await waitForEnter("Act 4: Continue & Verify");
  log(`ACT ${act4.id}: ${act4.taskLabel}`);
  await injectTaskOverlay(page, act4.taskLabel);
  await narrate(page, act4, "start");

  const act4Promise = spawnClaudeAct(act4.prompt, DEMO_DIR);

  // Choreography: decisions timeline first
  await sleep(3000);
  await clickTab(page, "decisions");
  await narrate(page, act4, "decision");
  await clickView(page, "timeline", "decisions");

  await act4Promise;
  await narrate(page, act4, "verify");
  log("Act 4 complete");
  await sleep(1000);

  // Switch to insights after completion
  await clickTab(page, "insights");
  await sleep(2000);
  await hideSubtitle(page);
  await removeOverlay(page);

  // ── Closing ────────────────────────────────────────────────────
  log("Closing");
  await clickTab(page, "stats");
  await sleep(1000);
  await injectClosing(page);
  await sleep(5000);

  // ── Teardown ───────────────────────────────────────────────────
  log("Saving video...");
  await page.close(); // Triggers video save
  const video = page.video();
  if (video) {
    const videoPath = await video.path();
    log(`Video saved: ${videoPath}`);
  }
  await context.close();
  await browser.close();
  cleanup();
  log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
