/**
 * Shared virtualized, faceted list view.
 *
 * Renders only the visible window of rows (bounded DOM regardless of dataset
 * size) over the client index store. Facet chips show live counts computed
 * from the store; day-group header rows are injected into the virtual space.
 *
 * createListView(container, { store, kinds, columns, facets, onSelect })
 *   columns: [{ key, label, width?, render?(row) -> string }]
 *   facets:  [{ filterKey, field, label }]  — chips per value with counts
 * returns { setFilter, getFilter, refresh, destroy }
 */
import { el, clearElement, formatTimestamp, dayLabel, truncate, debounce } from "./util.js";

const ROW_HEIGHT = 44;
const OVERSCAN = 10;

export function createListView(container, opts) {
  const { store, kinds, columns, facets = [], onSelect } = opts;
  const rowHeight = opts.rowHeight || ROW_HEIGHT;

  const state = {
    filter: { kinds: kinds ? kinds.slice() : undefined },
    sortDir: "desc", // timestamp only; column sort cycles handled per-column
    sortKey: "timestamp",
    selectedId: null,
    displayList: [], // [{header: label} | {row}]
  };

  /* ---------- Skeleton ---------- */
  container.classList.add("lv");
  const facetBar = el("div", "lv-facets");
  const headerRow = el("div", "lv-header");
  const viewport = el("div", "lv-viewport");
  const spacer = el("div", "lv-spacer");
  const windowEl = el("div", "lv-window");
  const countLine = el("div", "lv-count");
  viewport.appendChild(spacer);
  viewport.appendChild(windowEl);
  container.appendChild(facetBar);
  container.appendChild(countLine);
  container.appendChild(headerRow);
  container.appendChild(viewport);

  /* ---------- Facet bar ---------- */
  const textInput = el("input", "lv-search");
  textInput.type = "search";
  textInput.placeholder = "Filter summaries…";
  textInput.addEventListener(
    "input",
    debounce(() => {
      state.filter.text = textInput.value || undefined;
      rebuild();
    }, 150),
  );

  function renderFacets() {
    clearElement(facetBar);
    facetBar.appendChild(textInput);
    for (const facet of facets) {
      const group = el("span", "lv-facet-group");
      group.appendChild(el("span", "lv-facet-label", facet.label));
      const counts = store.facetCounts(state.filter, facet.field);
      const selected = state.filter[facet.filterKey] || [];
      const values = [...counts.keys()].sort();
      for (const value of values) {
        const chip = el("button", "lv-chip", `${value} (${counts.get(value)})`);
        chip.type = "button";
        if (selected.includes(value)) chip.classList.add("active");
        chip.addEventListener("click", () => {
          const cur = state.filter[facet.filterKey] || [];
          state.filter[facet.filterKey] = cur.includes(value)
            ? cur.filter((v) => v !== value)
            : [...cur, value];
          if (state.filter[facet.filterKey].length === 0) delete state.filter[facet.filterKey];
          rebuild();
        });
        group.appendChild(chip);
      }
      facetBar.appendChild(group);
    }
  }

  /* ---------- Header ---------- */
  function renderHeader() {
    clearElement(headerRow);
    for (const col of columns) {
      const cell = el("span", "lv-hcell", col.label);
      if (col.width) cell.style.flex = `0 0 ${col.width}`;
      if (col.key === "timestamp") {
        cell.classList.add("sortable", state.sortDir);
        cell.addEventListener("click", () => {
          state.sortDir = state.sortDir === "desc" ? "asc" : "desc";
          rebuild();
        });
      }
      headerRow.appendChild(cell);
    }
  }

  /* ---------- Virtual window ---------- */
  function rebuild() {
    const rows = store.filter(state.filter);
    // store.rows are timestamp ASC; display default is DESC (newest first)
    const ordered = state.sortDir === "desc" ? rows.slice().reverse() : rows.slice();
    state.displayList = [];
    let lastDay = null;
    for (const row of ordered) {
      const day = dayLabel(row.timestamp);
      if (day !== lastDay) {
        state.displayList.push({ header: day });
        lastDay = day;
      }
      state.displayList.push({ row });
    }
    if (opts.onFilterChange) opts.onFilterChange({ ...state.filter });
    spacer.style.height = `${state.displayList.length * rowHeight}px`;
    // Clamp scroll when the list shrinks (e.g. a filter applied while scrolled
    // deep) — layout may not have caught up before renderWindow reads it.
    const maxScroll = Math.max(0, state.displayList.length * rowHeight - viewport.clientHeight);
    if (viewport.scrollTop > maxScroll) viewport.scrollTop = maxScroll;
    countLine.textContent = `${rows.length} of ${store.rows.length} records`;
    renderFacets();
    renderHeader();
    renderWindow();
  }

  function renderWindow() {
    const scrollTop = viewport.scrollTop;
    const height = viewport.clientHeight || 600;
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
    const last = Math.min(
      state.displayList.length,
      Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN,
    );
    clearElement(windowEl);
    windowEl.style.transform = `translateY(${first * rowHeight}px)`;
    for (let i = first; i < last; i++) {
      const item = state.displayList[i];
      if (item.header) {
        const h = el("div", "lv-day", item.header);
        h.style.height = `${rowHeight}px`;
        windowEl.appendChild(h);
        continue;
      }
      const row = item.row;
      const div = el("div", "lv-row");
      div.style.height = `${rowHeight}px`;
      if (row.id === state.selectedId) div.classList.add("selected");
      if (row.status === "superseded") div.classList.add("superseded");
      for (const col of columns) {
        const text = col.render ? col.render(row) : row[col.key];
        const cell = el("span", `lv-cell lv-col-${col.key}`, text === undefined ? "--" : String(text));
        if (col.width) cell.style.flex = `0 0 ${col.width}`;
        div.appendChild(cell);
      }
      div.addEventListener("click", () => {
        state.selectedId = row.id;
        renderWindow();
        if (onSelect) onSelect(row);
      });
      windowEl.appendChild(div);
    }
  }

  let scrollScheduled = false;
  function onScroll() {
    if (scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      renderWindow();
    });
  }
  viewport.addEventListener("scroll", onScroll);
  const unsubscribe = store.subscribe(rebuild);

  rebuild();

  return {
    setFilter(patch) {
      Object.assign(state.filter, patch);
      for (const k of Object.keys(state.filter)) {
        if (state.filter[k] === undefined) delete state.filter[k];
      }
      rebuild();
    },
    getFilter: () => ({ ...state.filter }),
    refresh: rebuild,
    destroy() {
      unsubscribe();
      viewport.removeEventListener("scroll", onScroll);
      clearElement(container);
      container.classList.remove("lv");
    },
  };
}

/** Column presets shared by tabs. */
export const COLUMNS = {
  time: { key: "timestamp", label: "Time", width: "11rem", render: (r) => formatTimestamp(r.timestamp) },
  type: { key: "entry_type", label: "Type", width: "7rem" },
  scope: { key: "scope", label: "Scope", width: "12rem" },
  summary: { key: "summary", label: "Summary", render: (r) => truncate(r.summary, 110) },
  domain: { key: "domain", label: "Domain", width: "9rem" },
  status: { key: "status", label: "Status", width: "7.5rem" },
  confidence: { key: "confidence", label: "Conf.", width: "5.5rem" },
};
