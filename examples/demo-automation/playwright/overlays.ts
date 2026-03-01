/**
 * DOM overlay injection helpers for the demo recording.
 * All overlays use position:fixed with z-index:9999 and are injected
 * via page.evaluate(). They reference CSS variables from the dashboard
 * for visual consistency.
 */
import type { Page } from "@playwright/test";

const OVERLAY_ID = "demo-overlay";
const SUBTITLE_ID = "demo-subtitle";

/**
 * Full-screen intro title card. Product name + tagline, fades in.
 * Sits on an opaque black background so the dashboard isn't visible yet.
 */
export async function injectIntro(
  page: Page,
  title: string,
  tagline: string,
): Promise<void> {
  await page.evaluate(
    ({ id, t, tag }) => {
      const existing = document.getElementById(id);
      if (existing) existing.remove();

      const el = document.createElement("div");
      el.id = id;
      el.innerHTML = `
      <style>
        #${id} {
          position: fixed;
          inset: 0;
          z-index: 9999;
          background: #0f172a;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 20px;
          font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
          animation: demo-intro-in 1s ease-out;
        }
        @keyframes demo-intro-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        #${id} .demo-intro-title {
          color: #e2e8f0;
          font-size: 42px;
          font-weight: 700;
          letter-spacing: 0.04em;
        }
        #${id} .demo-intro-accent {
          color: #10b981;
        }
        #${id} .demo-intro-tagline {
          color: #94a3b8;
          font-size: 18px;
          letter-spacing: 0.02em;
        }
      </style>
      <div class="demo-intro-title"><span class="demo-intro-accent">twining</span>-mcp</div>
      <div class="demo-intro-tagline">${tag}</div>
    `;
      document.body.appendChild(el);
    },
    { id: OVERLAY_ID, t: title, tag: tagline },
  );
}

/**
 * Inject a task banner at the top of the screen.
 * Shows a pulsing green dot + the developer's task description.
 * pointer-events:none so the dashboard stays clickable underneath.
 */
export async function injectTaskOverlay(
  page: Page,
  label: string,
): Promise<void> {
  await page.evaluate(
    ({ id, text }) => {
      const existing = document.getElementById(id);
      if (existing) existing.remove();

      const el = document.createElement("div");
      el.id = id;
      el.innerHTML = `
      <style>
        #${id} {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          z-index: 9999;
          pointer-events: none;
          padding: 12px 24px;
          background: linear-gradient(135deg, rgba(16, 185, 129, 0.15) 0%, rgba(16, 185, 129, 0.05) 100%);
          border-bottom: 1px solid rgba(16, 185, 129, 0.3);
          backdrop-filter: blur(8px);
          display: flex;
          align-items: center;
          gap: 12px;
          font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
          animation: demo-slide-in 0.3s ease-out;
        }
        @keyframes demo-slide-in {
          from { transform: translateY(-100%); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @keyframes demo-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        #${id} .demo-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #10b981;
          animation: demo-pulse 1.5s ease-in-out infinite;
          flex-shrink: 0;
        }
        #${id} .demo-label {
          color: #e2e8f0;
          font-size: 14px;
          letter-spacing: 0.02em;
        }
        #${id} .demo-chevron {
          color: #10b981;
          margin-right: 4px;
        }
      </style>
      <div class="demo-dot"></div>
      <span class="demo-label"><span class="demo-chevron">&gt;</span> ${text}</span>
    `;
      document.body.appendChild(el);
    },
    { id: OVERLAY_ID, text: label },
  );
}

/**
 * Show a full-screen session boundary overlay.
 * Dark backdrop with centered text about context loss.
 */
export async function injectSessionBoundary(page: Page): Promise<void> {
  await page.evaluate((id) => {
    const existing = document.getElementById(id);
    if (existing) existing.remove();

    const el = document.createElement("div");
    el.id = id;
    el.innerHTML = `
      <style>
        #${id} {
          position: fixed;
          inset: 0;
          z-index: 9999;
          background: rgba(0, 0, 0, 0.85);
          backdrop-filter: blur(12px);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 16px;
          font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
          animation: demo-fade-in 0.5s ease-out;
        }
        @keyframes demo-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        #${id} .demo-boundary-main {
          color: #f87171;
          font-size: 28px;
          font-weight: 600;
          letter-spacing: 0.03em;
        }
        #${id} .demo-boundary-sub {
          color: #94a3b8;
          font-size: 16px;
          max-width: 500px;
          text-align: center;
          line-height: 1.6;
        }
      </style>
      <div class="demo-boundary-main">Session ends. Context window gone.</div>
      <div class="demo-boundary-sub">
        The dashboard persists. The state persists.<br>
        But the agent remembers nothing.
      </div>
    `;
    document.body.appendChild(el);
  }, OVERLAY_ID);
}

/**
 * Show the closing overlay with the tagline and install command.
 */
export async function injectClosing(page: Page): Promise<void> {
  await page.evaluate((id) => {
    const existing = document.getElementById(id);
    if (existing) existing.remove();

    const el = document.createElement("div");
    el.id = id;
    el.innerHTML = `
      <style>
        #${id} {
          position: fixed;
          inset: 0;
          z-index: 9999;
          background: rgba(0, 0, 0, 0.9);
          backdrop-filter: blur(16px);
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 24px;
          font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
          animation: demo-fade-in 0.8s ease-out;
        }
        @keyframes demo-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        #${id} .demo-closing-tagline {
          color: #e2e8f0;
          font-size: 28px;
          font-weight: 600;
          text-align: center;
          line-height: 1.4;
          letter-spacing: 0.02em;
        }
        #${id} .demo-closing-install {
          color: #10b981;
          font-size: 20px;
          padding: 12px 24px;
          border: 1px solid rgba(16, 185, 129, 0.4);
          border-radius: 8px;
          background: rgba(16, 185, 129, 0.1);
          margin-top: 12px;
        }
      </style>
      <div class="demo-closing-tagline">
        Two agents. One persistent memory.<br>
        Zero context lost.
      </div>
      <div class="demo-closing-install">npm install -g twining-mcp</div>
    `;
    document.body.appendChild(el);
  }, OVERLAY_ID);
}

/**
 * Show a subtitle bar at the bottom of the screen.
 * Each call replaces the previous subtitle with a crossfade.
 * Used for narration cues that bridge gaps during claude -p execution.
 */
export async function showSubtitle(page: Page, text: string): Promise<void> {
  await page.evaluate(
    ({ id, msg }) => {
      const existing = document.getElementById(id);
      if (existing) {
        existing.style.transition = "opacity 0.3s ease-out";
        existing.style.opacity = "0";
        setTimeout(() => existing.remove(), 300);
      }

      const el = document.createElement("div");
      el.id = id;
      el.innerHTML = `
      <style>
        #${id} {
          position: fixed;
          bottom: 120px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 9998;
          pointer-events: none;
          padding: 10px 28px;
          background: rgba(0, 0, 0, 0.75);
          border: 1px solid rgba(148, 163, 184, 0.2);
          border-radius: 8px;
          backdrop-filter: blur(8px);
          font-family: 'SF Mono', 'JetBrains Mono', 'Fira Code', monospace;
          font-size: 15px;
          color: #cbd5e1;
          letter-spacing: 0.02em;
          white-space: nowrap;
          opacity: 0;
          animation: demo-sub-in 0.4s ease-out 0.15s forwards;
        }
        @keyframes demo-sub-in {
          from { opacity: 0; transform: translateX(-50%) translateY(8px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      </style>
      ${msg}
    `;
      document.body.appendChild(el);
    },
    { id: SUBTITLE_ID, msg: text },
  );
}

/**
 * Fade out and remove the subtitle bar.
 */
export async function hideSubtitle(page: Page): Promise<void> {
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.transition = "opacity 0.4s ease-out";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 400);
  }, SUBTITLE_ID);
  await page.waitForTimeout(450);
}

/**
 * Fade out and remove the current overlay.
 */
export async function removeOverlay(page: Page): Promise<void> {
  await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.transition = "opacity 0.4s ease-out";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 400);
  }, OVERLAY_ID);
  // Wait for the fade-out to complete
  await page.waitForTimeout(500);
}
