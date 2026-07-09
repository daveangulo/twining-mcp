/**
 * Zoomable density timeline (canvas). Replaces vis-timeline.
 *
 * Wide zoom: stacked histogram bars per adaptive bucket, colored by domain
 * or status. Under LOZENGE_THRESHOLD visible records it switches to
 * individually selectable lozenges. Wheel = zoom at cursor, drag = pan,
 * shift+drag = brush range (drives the synced list), click = select.
 * One rAF redraw per invalidation; no per-record DOM ever.
 */
import { chooseBucket, bucketize, makeScale } from "./timeline-scale.js";
import { el, clearElement, truncate } from "./util.js";

const LOZENGE_THRESHOLD = 150;
const AXIS_H = 26;
const LOZ_H = 18;
const LOZ_GAP = 4;
const MS_MIN_SPAN = 5 * 60 * 1000; // zoomMin parity with the old timeline
const MS_MAX_SPAN = 20 * 365 * 24 * 3600 * 1000;

const DOMAIN_COLORS = {
  architecture: "#6366f1",
  implementation: "#3b82f6",
  testing: "#10b981",
  deployment: "#f59e0b",
  security: "#ef4444",
  performance: "#8b5cf6",
  "api-design": "#06b6d4",
  "data-model": "#ec4899",
  documentation: "#a3e635",
  release: "#f97316",
};
const STATUS_COLORS = {
  active: "#00d68f",
  provisional: "#ffaa00",
  superseded: "#5a6478",
  overridden: "#ff4466",
  archived: "#8892a8",
};
const FALLBACK_COLORS = ["#22d3ee", "#c084fc", "#facc15", "#fb7185", "#34d399", "#f472b6"];

function colorFor(key, colorKey, fallbackIndex) {
  const table = colorKey === "status" ? STATUS_COLORS : DOMAIN_COLORS;
  return table[key] || FALLBACK_COLORS[fallbackIndex % FALLBACK_COLORS.length];
}

export function createDensityTimeline(container, { store, onSelect, onRangeChange }) {
  const state = {
    from: 0,
    to: 1,
    colorKey: "domain",
    filter: { kinds: ["decision"] },
    brush: null, // {fromMs, toMs} while active
    hits: [], // lozenge hit rects for click resolution
    selectedId: null,
  };

  const canvas = el("canvas", "dt-canvas");
  const wrap = el("div", "dt-wrap");
  wrap.appendChild(canvas);
  container.appendChild(wrap);
  const ctx = canvas.getContext("2d");

  /* ---------------- range helpers ---------------- */

  function dataExtent() {
    const rows = store.filter(state.filter);
    if (!rows.length) {
      const now = Date.now();
      return [now - 30 * 86400000, now];
    }
    const a = Date.parse(rows[0].timestamp);
    const b = Date.parse(rows[rows.length - 1].timestamp);
    const pad = Math.max((b - a) * 0.02, 3600000);
    return [a - pad, b + pad];
  }

  function clampRange(from, to) {
    let span = to - from;
    if (span < MS_MIN_SPAN) span = MS_MIN_SPAN;
    if (span > MS_MAX_SPAN) span = MS_MAX_SPAN;
    const mid = (from + to) / 2;
    return [mid - span / 2, mid + span / 2];
  }

  function fit() {
    [state.from, state.to] = dataExtent();
    invalidate();
  }

  /* ---------------- rendering ---------------- */

  let rafScheduled = false;
  function invalidate() {
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      draw();
    });
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function visibleRows() {
    return store.filter({
      ...state.filter,
      from: new Date(state.from).toISOString(),
      to: new Date(state.to).toISOString(),
    });
  }

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth || 800;
    const h = wrap.clientHeight || 320;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const scale = makeScale(state.from, state.to, w);
    const rows = visibleRows();
    const plotH = h - AXIS_H;
    state.hits = [];

    drawAxis(scale, w, h, plotH);
    if (rows.length < LOZENGE_THRESHOLD) drawLozenges(rows, scale, plotH);
    else drawBars(rows, scale, plotH);

    // Brush overlay
    if (state.brush) {
      const x0 = scale.x(state.brush.fromMs);
      const x1 = scale.x(state.brush.toMs);
      ctx.fillStyle = "rgba(0, 212, 170, 0.12)";
      ctx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), plotH);
      ctx.strokeStyle = cssVar("--accent") || "#00d4aa";
      ctx.strokeRect(Math.min(x0, x1) + 0.5, 0.5, Math.abs(x1 - x0), plotH - 1);
    }

    // Now marker
    const nowX = scale.x(Date.now());
    if (nowX >= 0 && nowX <= w) {
      ctx.strokeStyle = cssVar("--accent") || "#00d4aa";
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(nowX + 0.5, 0);
      ctx.lineTo(nowX + 0.5, plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    updateLegend(rows);
    updateModeNote(rows.length);
  }

  function drawAxis(scale, w, h, plotH) {
    const border = cssVar("--border-strong") || "rgba(255,255,255,0.14)";
    const text = cssVar("--text-tertiary") || "#5a6478";
    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(0, plotH + 0.5);
    ctx.lineTo(w, plotH + 0.5);
    ctx.stroke();

    const bucket = chooseBucket(state.to - state.from);
    // A tick every k buckets so labels stay ~90px apart
    const pxPerBucket = scale.x(state.from + bucket.ms) - scale.x(state.from);
    const every = Math.max(1, Math.ceil(90 / Math.max(pxPerBucket, 1)));
    const first = Math.floor(state.from / bucket.ms) * bucket.ms;
    ctx.fillStyle = text;
    ctx.font = "10px JetBrains Mono, monospace";
    ctx.textBaseline = "top";
    for (let t = first; t <= state.to; t += bucket.ms * every) {
      const x = scale.x(t);
      if (x < 0) continue;
      ctx.strokeStyle = border;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, plotH);
      ctx.lineTo(x + 0.5, plotH + 4);
      ctx.stroke();
      const d = new Date(t);
      const label =
        bucket.unit === "hour"
          ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
          : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: bucket.unit === "month" || bucket.unit === "year" ? "numeric" : undefined });
      ctx.fillText(label, x + 3, plotH + 7);
    }
  }

  function drawBars(rows, scale, plotH) {
    const bucket = chooseBucket(state.to - state.from);
    const buckets = bucketize(rows, state.from, state.to, bucket.ms, state.colorKey);
    if (!buckets.length) return;
    const maxTotal = Math.max(...buckets.map((b) => b.total));
    const barW = Math.max(2, scale.x(state.from + bucket.ms) - scale.x(state.from) - 1);
    const keys = legendKeys(rows);
    for (const b of buckets) {
      const x = scale.x(b.t0);
      let y = plotH;
      for (const [i, key] of keys.entries()) {
        const n = b.counts.get(key);
        if (!n) continue;
        const segH = (n / maxTotal) * (plotH - 8);
        y -= segH;
        ctx.fillStyle = colorFor(key, state.colorKey, i);
        ctx.fillRect(x, y, barW, segH);
      }
    }
  }

  function drawLozenges(rows, scale, plotH) {
    // Lane layout: first lane whose last lozenge ends before this one's x
    const laneEnds = [];
    ctx.font = "10px DM Sans, sans-serif";
    ctx.textBaseline = "middle";
    for (const row of rows) {
      const t = Date.parse(row.timestamp);
      const x = scale.x(t);
      const label = truncate(row.summary, 42);
      const wPx = Math.min(ctx.measureText(label).width + 14, 280);
      let lane = laneEnds.findIndex((end) => end < x);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = x + wPx + 6;
      const y = 8 + lane * (LOZ_H + LOZ_GAP);
      if (y + LOZ_H > plotH) continue; // below the fold at extreme densities
      const keys = legendKeys(rows);
      const key = row[state.colorKey] ?? row.entry_type ?? "other";
      const color = colorFor(key, state.colorKey, Math.max(0, keys.indexOf(key)));
      ctx.fillStyle = color + "33";
      ctx.strokeStyle = row.id === state.selectedId ? (cssVar("--accent") || "#00d4aa") : color;
      roundRect(x, y, wPx, LOZ_H, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = cssVar("--text-primary") || "#e8ecf4";
      if (row.status === "superseded") {
        ctx.save();
        ctx.globalAlpha = 0.55;
      }
      ctx.fillText(label, x + 7, y + LOZ_H / 2);
      if (row.status === "superseded") {
        const tw = Math.min(ctx.measureText(label).width, wPx - 14);
        ctx.beginPath();
        ctx.moveTo(x + 7, y + LOZ_H / 2);
        ctx.lineTo(x + 7 + tw, y + LOZ_H / 2);
        ctx.strokeStyle = cssVar("--text-primary") || "#e8ecf4";
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      }
      state.hits.push({ x, y, w: wPx, h: LOZ_H, row });
    }
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------- legend + mode note ---------------- */

  const legendHost = document.getElementById("timeline-legend");
  const modeNote = el("span", "dt-mode");

  function legendKeys(rows) {
    const seen = new Map();
    for (const r of rows) {
      const k = r[state.colorKey] ?? r.entry_type ?? "other";
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    return [...seen.keys()].sort();
  }

  function updateLegend(rows) {
    if (!legendHost) return;
    clearElement(legendHost);
    const keys = legendKeys(rows);
    for (const [i, key] of keys.entries()) {
      const item = el("span", "dt-legend-item");
      const swatch = el("span", "dt-swatch");
      swatch.style.background = colorFor(key, state.colorKey, i);
      item.appendChild(swatch);
      item.appendChild(el("span", null, key));
      legendHost.appendChild(item);
    }
    const toggle = el("button", "lv-chip", `color: ${state.colorKey} ⇄`);
    toggle.type = "button";
    toggle.addEventListener("click", () => {
      state.colorKey = state.colorKey === "domain" ? "status" : "domain";
      invalidate();
    });
    legendHost.appendChild(toggle);
    legendHost.appendChild(modeNote);
  }

  function updateModeNote(count) {
    modeNote.textContent =
      count < LOZENGE_THRESHOLD
        ? `${count} items — individual view`
        : `${count} records — density view (zoom in for items)`;
  }

  /* ---------------- interactions ---------------- */

  let drag = null; // {startX, from, to, brush: bool, moved: bool}

  canvas.addEventListener("wheel", (evt) => {
    evt.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const scale = makeScale(state.from, state.to, rect.width);
    const tAtCursor = scale.t(evt.clientX - rect.left);
    const factor = evt.deltaY > 0 ? 1.15 : 1 / 1.15;
    let from = tAtCursor - (tAtCursor - state.from) * factor;
    let to = tAtCursor + (state.to - tAtCursor) * factor;
    [state.from, state.to] = clampRange(from, to);
    invalidate();
  }, { passive: false });

  canvas.addEventListener("mousedown", (evt) => {
    drag = { startX: evt.clientX, from: state.from, to: state.to, brush: evt.shiftKey, moved: false };
  });

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);

  function onMove(evt) {
    if (!drag) return;
    const rect = canvas.getBoundingClientRect();
    const dx = evt.clientX - drag.startX;
    if (Math.abs(dx) > 3) drag.moved = true;
    if (drag.brush) {
      const scale = makeScale(drag.from, drag.to, rect.width);
      const a = scale.t(drag.startX - rect.left);
      const b = scale.t(evt.clientX - rect.left);
      state.brush = { fromMs: Math.min(a, b), toMs: Math.max(a, b) };
    } else {
      const span = drag.to - drag.from;
      const shift = (dx / rect.width) * span;
      state.from = drag.from - shift;
      state.to = drag.to - shift;
    }
    invalidate();
  }

  function onUp(evt) {
    if (!drag) return;
    const wasBrush = drag.brush && state.brush;
    const moved = drag.moved;
    drag = null;
    if (wasBrush) {
      if (onRangeChange) onRangeChange({ ...state.brush });
      invalidate();
      return;
    }
    if (!moved) {
      // Click: lozenge hit-test
      const rect = canvas.getBoundingClientRect();
      const cx = evt.clientX - rect.left;
      const cy = evt.clientY - rect.top;
      const hit = state.hits.find((h) => cx >= h.x && cx <= h.x + h.w && cy >= h.y && cy <= h.y + h.h);
      if (hit) {
        state.selectedId = hit.row.id;
        invalidate();
        if (onSelect) onSelect(hit.row);
      } else if (state.brush) {
        state.brush = null;
        if (onRangeChange) onRangeChange(null);
        invalidate();
      }
    }
  }

  /* ---------------- toolbar ---------------- */

  function zoomCenter(factor) {
    const mid = (state.from + state.to) / 2;
    const half = ((state.to - state.from) / 2) * factor;
    [state.from, state.to] = clampRange(mid - half, mid + half);
    invalidate();
  }

  const btns = {
    "timeline-zoom-in": () => zoomCenter(1 / 1.4),
    "timeline-zoom-out": () => zoomCenter(1.4),
    "timeline-fit": fit,
    "timeline-today": () => {
      const span = state.to - state.from;
      state.from = Date.now() - span / 2;
      state.to = Date.now() + span / 2;
      invalidate();
    },
  };
  const btnHandlers = [];
  for (const [id, fn] of Object.entries(btns)) {
    const b = document.getElementById(id);
    if (b) {
      b.addEventListener("click", fn);
      btnHandlers.push([b, fn]);
    }
  }

  /* ---------------- domain filter chips ---------------- */

  const chipHost = document.getElementById("timeline-domain-filters");

  function renderChips() {
    if (!chipHost) return;
    clearElement(chipHost);
    const counts = store.facetCounts({ kinds: ["decision"] }, "domain");
    const selected = state.filter.domains || [];
    for (const domain of [...counts.keys()].sort()) {
      const chip = el("button", "lv-chip", `${domain} (${counts.get(domain)})`);
      chip.type = "button";
      if (selected.includes(domain)) chip.classList.add("active");
      chip.addEventListener("click", () => {
        const cur = state.filter.domains || [];
        state.filter.domains = cur.includes(domain) ? cur.filter((d) => d !== domain) : [...cur, domain];
        if (!state.filter.domains.length) delete state.filter.domains;
        renderChips();
        invalidate();
        if (onRangeChange) onRangeChange(state.brush ? { ...state.brush } : null, { ...state.filter });
      });
      chipHost.appendChild(chip);
    }
  }

  /* ---------------- store subscription + resize ---------------- */

  const unsubscribe = store.subscribe(() => {
    renderChips();
    invalidate();
  });
  const resizeObserver = new ResizeObserver(invalidate);
  resizeObserver.observe(wrap);

  fit();
  renderChips();

  return {
    fit,
    refresh: invalidate,
    setFilter(patch) {
      Object.assign(state.filter, patch);
      invalidate();
    },
    getRange: () => ({ fromMs: state.from, toMs: state.to }),
    getFilter: () => ({ ...state.filter }),
    destroy() {
      unsubscribe();
      resizeObserver.disconnect();
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      for (const [b, fn] of btnHandlers) b.removeEventListener("click", fn);
      clearElement(container);
    },
  };
}
