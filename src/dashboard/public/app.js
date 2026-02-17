/**
 * Twining Dashboard - Client Application
 *
 * Full dashboard client: tab navigation, data fetching, table rendering
 * with sorting/pagination, detail inspector, polling with visibility-aware
 * lifecycle. All user content rendered via textContent (no innerHTML for
 * user data) to prevent XSS.
 */

/* global state */
var state = {
  activeTab: "stats",
  blackboard: { data: [], sortKey: "timestamp", sortDir: "desc", page: 1, pageSize: 25, selectedId: null },
  decisions: { data: [], sortKey: "timestamp", sortDir: "desc", page: 1, pageSize: 25, selectedId: null },
  graph: { data: [], relations: [], sortKey: "name", sortDir: "asc", page: 1, pageSize: 25, selectedId: null },
  status: null,
  pollTimer: null,
  pollInterval: 3000,
  connected: false
};

/* ========== Helper Functions ========== */

function formatTimestamp(ts) {
  if (!ts || ts === "none" || ts === "Never") return "Never";
  try {
    var d = new Date(ts);
    if (isNaN(d.getTime())) return "--";
    return d.toLocaleString();
  } catch (e) {
    return "--";
  }
}

function truncate(str, len) {
  if (!str) return "--";
  if (str.length <= len) return str;
  return str.slice(0, len) + "...";
}

function el(tag, className, textContent) {
  var elem = document.createElement(tag);
  if (className) elem.className = className;
  if (textContent !== undefined && textContent !== null) elem.textContent = textContent;
  return elem;
}

function createBadge(text) {
  if (!text) return el("span", "badge", "--");
  var span = el("span", "badge " + String(text).toLowerCase(), text);
  return span;
}

function clearElement(container) {
  while (container.firstChild) {
    container.removeChild(container.firstChild);
  }
}

/* ========== Connection & Poll Indicators ========== */

function updateConnectionIndicator() {
  var dot = document.getElementById("connection-dot");
  var text = document.getElementById("connection-text");
  if (!dot || !text) return;
  if (state.connected) {
    dot.className = "status-dot connected";
    text.textContent = "Connected";
  } else {
    dot.className = "status-dot disconnected";
    text.textContent = "Disconnected";
  }
}

function updatePollIndicator(isPolling) {
  var dot = document.getElementById("poll-dot");
  var text = document.getElementById("poll-text");
  if (!dot || !text) return;
  if (isPolling) {
    dot.className = "status-dot polling";
    text.textContent = "Polling";
  } else {
    dot.className = "status-dot paused";
    text.textContent = "Paused";
  }
}

/* ========== Data Fetching ========== */

function fetchStatus() {
  fetch("/api/status")
    .then(function(res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function(data) {
      state.status = data;
      state.connected = true;
      updateConnectionIndicator();
      renderStatus();
    })
    .catch(function() {
      state.connected = false;
      updateConnectionIndicator();
    });
}

function fetchBlackboard() {
  fetch("/api/blackboard")
    .then(function(res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function(data) {
      state.blackboard.data = data.entries || [];
      state.connected = true;
      updateConnectionIndicator();
      renderBlackboard();
    })
    .catch(function() {
      state.connected = false;
      updateConnectionIndicator();
    });
}

function fetchDecisions() {
  fetch("/api/decisions")
    .then(function(res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function(data) {
      state.decisions.data = data.decisions || [];
      state.connected = true;
      updateConnectionIndicator();
      renderDecisions();
    })
    .catch(function() {
      state.connected = false;
      updateConnectionIndicator();
    });
}

function fetchGraph() {
  fetch("/api/graph")
    .then(function(res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function(data) {
      state.graph.data = data.entities || [];
      state.graph.relations = data.relations || [];
      state.connected = true;
      updateConnectionIndicator();
      renderGraph();
    })
    .catch(function() {
      state.connected = false;
      updateConnectionIndicator();
    });
}

function fetchDecisionDetail(id) {
  fetch("/api/decisions/" + encodeURIComponent(id))
    .then(function(res) {
      if (res.status === 404) {
        renderDecisionDetailNotFound();
        return null;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function(data) {
      if (data) {
        renderDecisionDetail(data);
      }
    })
    .catch(function() {
      renderDecisionDetailNotFound();
    });
}

/* ========== Polling Lifecycle ========== */

function refreshData() {
  fetchStatus();
  var tab = state.activeTab;
  if (tab === "blackboard") fetchBlackboard();
  else if (tab === "decisions") fetchDecisions();
  else if (tab === "graph") fetchGraph();
}

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(refreshData, state.pollInterval);
  updatePollIndicator(true);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
  updatePollIndicator(false);
}

/* ========== Tab Navigation ========== */

function switchTab(tabName) {
  var contents = document.querySelectorAll(".tab-content");
  for (var i = 0; i < contents.length; i++) {
    contents[i].style.display = "none";
  }
  var target = document.getElementById("tab-" + tabName);
  if (target) target.style.display = "block";

  var btns = document.querySelectorAll(".tab-btn");
  for (var j = 0; j < btns.length; j++) {
    btns[j].classList.remove("active");
    if (btns[j].getAttribute("data-tab") === tabName) {
      btns[j].classList.add("active");
    }
  }

  state.activeTab = tabName;
  stopPolling();
  startPolling();
  refreshData();
}

/* ========== Sorting ========== */

function sortData(data, key, dir) {
  var sorted = data.slice();
  sorted.sort(function(a, b) {
    var va = a[key];
    var vb = b[key];
    if (va === undefined || va === null) va = "";
    if (vb === undefined || vb === null) vb = "";
    if (typeof va === "string") va = va.toLowerCase();
    if (typeof vb === "string") vb = vb.toLowerCase();
    if (va < vb) return dir === "asc" ? -1 : 1;
    if (va > vb) return dir === "asc" ? 1 : -1;
    return 0;
  });
  return sorted;
}

function handleSort(tabName, key) {
  var tabState = state[tabName];
  if (!tabState) return;
  if (tabState.sortKey === key) {
    tabState.sortDir = tabState.sortDir === "asc" ? "desc" : "asc";
  } else {
    tabState.sortKey = key;
    tabState.sortDir = "asc";
  }
  tabState.page = 1;

  if (tabName === "blackboard") renderBlackboard();
  else if (tabName === "decisions") renderDecisions();
  else if (tabName === "graph") renderGraph();
}

function updateSortHeaders(tableId, sortKey, sortDir) {
  var table = document.getElementById(tableId);
  if (!table) return;
  var headers = table.querySelectorAll(".sortable-header");
  for (var i = 0; i < headers.length; i++) {
    headers[i].classList.remove("sort-asc", "sort-desc");
    if (headers[i].getAttribute("data-sort-key") === sortKey) {
      headers[i].classList.add(sortDir === "asc" ? "sort-asc" : "sort-desc");
    }
  }
}

/* ========== Pagination ========== */

function paginate(data, page, pageSize) {
  var start = (page - 1) * pageSize;
  var end = start + pageSize;
  return data.slice(start, end);
}

function renderPagination(containerId, totalItems, tabState, renderFn) {
  var container = document.getElementById(containerId);
  if (!container) return;
  clearElement(container);

  var totalPages = Math.max(1, Math.ceil(totalItems / tabState.pageSize));
  var info = el("span", null, "Page " + tabState.page + " of " + totalPages + " (" + totalItems + " items)");

  var btnGroup = el("div");
  btnGroup.style.display = "flex";
  btnGroup.style.gap = "0.5rem";

  var prevBtn = el("button", null, "Previous");
  prevBtn.disabled = tabState.page <= 1;
  prevBtn.addEventListener("click", function() {
    if (tabState.page > 1) {
      tabState.page--;
      renderFn();
    }
  });

  var nextBtn = el("button", null, "Next");
  nextBtn.disabled = tabState.page >= totalPages;
  nextBtn.addEventListener("click", function() {
    if (tabState.page < totalPages) {
      tabState.page++;
      renderFn();
    }
  });

  btnGroup.appendChild(prevBtn);
  btnGroup.appendChild(nextBtn);
  container.appendChild(info);
  container.appendChild(btnGroup);
}

/* ========== Render: Status ========== */

function renderStatus() {
  if (!state.status) return;
  var s = state.status;

  var setVal = function(id, val) {
    var elem = document.getElementById(id);
    if (elem) elem.textContent = (val !== undefined && val !== null) ? String(val) : "--";
  };

  setVal("stat-bb-entries", s.blackboard_entries);
  setVal("stat-active-decisions", s.active_decisions);
  setVal("stat-provisional-decisions", s.provisional_decisions);
  setVal("stat-graph-entities", s.graph_entities);
  setVal("stat-graph-relations", s.graph_relations);
  setVal("stat-last-activity", formatTimestamp(s.last_activity));

  var msgEl = document.getElementById("uninitialized-msg");
  if (msgEl) {
    msgEl.style.display = (s.initialized === false) ? "block" : "none";
  }
}

/* ========== Render: Blackboard ========== */

function renderBlackboard() {
  var ts = state.blackboard;
  var sorted = sortData(ts.data, ts.sortKey, ts.sortDir);
  var page = paginate(sorted, ts.page, ts.pageSize);

  updateSortHeaders("blackboard-table", ts.sortKey, ts.sortDir);

  var tbody = document.querySelector("#blackboard-table tbody");
  if (!tbody) return;
  clearElement(tbody);

  for (var i = 0; i < page.length; i++) {
    var entry = page[i];
    var tr = el("tr");
    tr.setAttribute("data-id", entry.id || "");
    if (ts.selectedId && (entry.id === ts.selectedId)) {
      tr.classList.add("selected");
    }

    var tdTime = el("td", null, formatTimestamp(entry.timestamp));
    var tdType = el("td", null, entry.entry_type || "--");
    var tdScope = el("td", null, entry.scope || "--");
    var tdSummary = el("td", null, truncate(entry.summary, 80));

    tr.appendChild(tdTime);
    tr.appendChild(tdType);
    tr.appendChild(tdScope);
    tr.appendChild(tdSummary);

    (function(e) {
      tr.addEventListener("click", function() {
        ts.selectedId = e.id;
        renderBlackboard();
        renderBlackboardDetail(e);
      });
    })(entry);

    tbody.appendChild(tr);
  }

  renderPagination("blackboard-pagination", sorted.length, ts, renderBlackboard);

  // If selected item exists, show its detail
  if (ts.selectedId) {
    var found = null;
    for (var k = 0; k < ts.data.length; k++) {
      if (ts.data[k].id === ts.selectedId) {
        found = ts.data[k];
        break;
      }
    }
    if (!found) {
      var panel = document.getElementById("blackboard-detail");
      if (panel) {
        clearElement(panel);
        panel.appendChild(el("p", "placeholder", "Item no longer exists"));
        ts.selectedId = null;
      }
    }
  }
}

function renderBlackboardDetail(entry) {
  var panel = document.getElementById("blackboard-detail");
  if (!panel) return;
  clearElement(panel);

  panel.appendChild(el("h3", null, "Entry Details"));

  var fields = [
    { label: "ID", value: entry.id },
    { label: "Timestamp", value: formatTimestamp(entry.timestamp) },
    { label: "Type", value: entry.entry_type },
    { label: "Summary", value: entry.summary },
    { label: "Scope", value: entry.scope },
    { label: "Agent ID", value: entry.agent_id },
    { label: "Tags", value: (entry.tags && entry.tags.length) ? entry.tags.join(", ") : null },
    { label: "Relates To", value: (entry.relates_to && entry.relates_to.length) ? entry.relates_to.join(", ") : null }
  ];

  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.value === undefined || f.value === null) continue;
    var div = el("div", "detail-field");
    div.appendChild(el("div", "detail-label", f.label));
    div.appendChild(el("div", "detail-value", String(f.value)));
    panel.appendChild(div);
  }

  // Detail field (long text)
  if (entry.detail) {
    var detailDiv = el("div", "detail-field");
    detailDiv.appendChild(el("div", "detail-label", "Detail"));
    var valDiv = el("div", "detail-value");
    var pre = el("pre", null, entry.detail);
    valDiv.appendChild(pre);
    detailDiv.appendChild(valDiv);
    panel.appendChild(detailDiv);
  }
}

/* ========== Render: Decisions ========== */

function renderDecisions() {
  var ts = state.decisions;
  var sorted = sortData(ts.data, ts.sortKey, ts.sortDir);
  var page = paginate(sorted, ts.page, ts.pageSize);

  updateSortHeaders("decisions-table", ts.sortKey, ts.sortDir);

  var tbody = document.querySelector("#decisions-table tbody");
  if (!tbody) return;
  clearElement(tbody);

  for (var i = 0; i < page.length; i++) {
    var decision = page[i];
    var tr = el("tr");
    tr.setAttribute("data-id", decision.id || "");
    if (ts.selectedId && (decision.id === ts.selectedId)) {
      tr.classList.add("selected");
    }

    var tdTime = el("td", null, formatTimestamp(decision.timestamp));
    var tdDomain = el("td", null, decision.domain || "--");
    var tdScope = el("td", null, decision.scope || "--");
    var tdSummary = el("td", null, truncate(decision.summary, 80));

    var tdStatus = el("td");
    tdStatus.appendChild(createBadge(decision.status));

    var tdConf = el("td");
    tdConf.appendChild(createBadge(decision.confidence));

    tr.appendChild(tdTime);
    tr.appendChild(tdDomain);
    tr.appendChild(tdScope);
    tr.appendChild(tdSummary);
    tr.appendChild(tdStatus);
    tr.appendChild(tdConf);

    (function(d) {
      tr.addEventListener("click", function() {
        ts.selectedId = d.id;
        renderDecisions();
        fetchDecisionDetail(d.id);
      });
    })(decision);

    tbody.appendChild(tr);
  }

  renderPagination("decisions-pagination", sorted.length, ts, renderDecisions);

  // Check if selected item still exists
  if (ts.selectedId) {
    var found = false;
    for (var k = 0; k < ts.data.length; k++) {
      if (ts.data[k].id === ts.selectedId) {
        found = true;
        break;
      }
    }
    if (!found) {
      var panel = document.getElementById("decisions-detail");
      if (panel) {
        clearElement(panel);
        panel.appendChild(el("p", "placeholder", "Item no longer exists"));
        ts.selectedId = null;
      }
    }
  }
}

function renderDecisionDetail(decision) {
  var panel = document.getElementById("decisions-detail");
  if (!panel) return;
  clearElement(panel);

  panel.appendChild(el("h3", null, "Decision Details"));

  // Basic fields
  var fields = [
    { label: "ID", value: decision.id },
    { label: "Timestamp", value: formatTimestamp(decision.timestamp) },
    { label: "Domain", value: decision.domain },
    { label: "Scope", value: decision.scope },
    { label: "Summary", value: decision.summary }
  ];

  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.value === undefined || f.value === null) continue;
    var div = el("div", "detail-field");
    div.appendChild(el("div", "detail-label", f.label));
    div.appendChild(el("div", "detail-value", String(f.value)));
    panel.appendChild(div);
  }

  // Status badge
  var statusDiv = el("div", "detail-field");
  statusDiv.appendChild(el("div", "detail-label", "Status"));
  var statusVal = el("div", "detail-value");
  statusVal.appendChild(createBadge(decision.status));
  statusDiv.appendChild(statusVal);
  panel.appendChild(statusDiv);

  // Confidence badge
  var confDiv = el("div", "detail-field");
  confDiv.appendChild(el("div", "detail-label", "Confidence"));
  var confVal = el("div", "detail-value");
  confVal.appendChild(createBadge(decision.confidence));
  confDiv.appendChild(confVal);
  panel.appendChild(confDiv);

  // Long text fields
  var textFields = [
    { label: "Context", value: decision.context },
    { label: "Rationale", value: decision.rationale }
  ];

  for (var t = 0; t < textFields.length; t++) {
    var tf = textFields[t];
    if (!tf.value) continue;
    var tfDiv = el("div", "detail-field");
    tfDiv.appendChild(el("div", "detail-label", tf.label));
    var tfVal = el("div", "detail-value");
    var pre = el("pre", null, tf.value);
    tfVal.appendChild(pre);
    tfDiv.appendChild(tfVal);
    panel.appendChild(tfDiv);
  }

  // Constraints (bullet list)
  if (decision.constraints && decision.constraints.length > 0) {
    var conDiv = el("div", "detail-field");
    conDiv.appendChild(el("div", "detail-label", "Constraints"));
    var ul = el("ul");
    for (var c = 0; c < decision.constraints.length; c++) {
      var li = el("li", null, decision.constraints[c]);
      ul.appendChild(li);
    }
    conDiv.appendChild(ul);
    panel.appendChild(conDiv);
  }

  // Alternatives
  if (decision.alternatives && decision.alternatives.length > 0) {
    var altDiv = el("div", "detail-field");
    altDiv.appendChild(el("div", "detail-label", "Alternatives Considered"));
    for (var a = 0; a < decision.alternatives.length; a++) {
      var alt = decision.alternatives[a];
      var altBlock = el("div");
      altBlock.style.marginBottom = "0.5rem";
      altBlock.style.paddingLeft = "0.5rem";
      altBlock.style.borderLeft = "2px solid var(--card-border)";

      altBlock.appendChild(el("div", null, "Option: " + (alt.option || "--")));
      if (alt.pros) altBlock.appendChild(el("div", null, "Pros: " + alt.pros));
      if (alt.cons) altBlock.appendChild(el("div", null, "Cons: " + alt.cons));
      if (alt.reason_rejected) altBlock.appendChild(el("div", null, "Rejected: " + alt.reason_rejected));

      altDiv.appendChild(altBlock);
    }
    panel.appendChild(altDiv);
  }

  // Array fields
  var arrayFields = [
    { label: "Affected Files", value: decision.affected_files },
    { label: "Affected Symbols", value: decision.affected_symbols },
    { label: "Commit Hashes", value: decision.commit_hashes },
    { label: "Depends On", value: decision.depends_on },
    { label: "Supersedes", value: decision.supersedes ? [decision.supersedes] : null }
  ];

  for (var af = 0; af < arrayFields.length; af++) {
    var arrField = arrayFields[af];
    if (!arrField.value || arrField.value.length === 0) continue;
    var arrDiv = el("div", "detail-field");
    arrDiv.appendChild(el("div", "detail-label", arrField.label));
    arrDiv.appendChild(el("div", "detail-value", arrField.value.join(", ")));
    panel.appendChild(arrDiv);
  }
}

function renderDecisionDetailNotFound() {
  var panel = document.getElementById("decisions-detail");
  if (!panel) return;
  clearElement(panel);
  panel.appendChild(el("p", "placeholder", "Decision not found"));
}

/* ========== Render: Graph ========== */

function renderGraph() {
  var ts = state.graph;
  var sorted = sortData(ts.data, ts.sortKey, ts.sortDir);
  var page = paginate(sorted, ts.page, ts.pageSize);

  updateSortHeaders("graph-table", ts.sortKey, ts.sortDir);

  var tbody = document.querySelector("#graph-table tbody");
  if (!tbody) return;
  clearElement(tbody);

  for (var i = 0; i < page.length; i++) {
    var entity = page[i];
    var tr = el("tr");
    tr.setAttribute("data-id", entity.id || entity.name || "");
    if (ts.selectedId && ((entity.id || entity.name) === ts.selectedId)) {
      tr.classList.add("selected");
    }

    var tdName = el("td", null, entity.name || "--");
    var tdType = el("td", null, entity.type || "--");

    var propsStr = "--";
    if (entity.properties && typeof entity.properties === "object") {
      try {
        propsStr = truncate(JSON.stringify(entity.properties), 60);
      } catch (e) {
        propsStr = "--";
      }
    }
    var tdProps = el("td", null, propsStr);

    tr.appendChild(tdName);
    tr.appendChild(tdType);
    tr.appendChild(tdProps);

    (function(ent) {
      tr.addEventListener("click", function() {
        ts.selectedId = ent.id || ent.name;
        renderGraph();
        renderGraphDetail(ent);
      });
    })(entity);

    tbody.appendChild(tr);
  }

  renderPagination("graph-pagination", sorted.length, ts, renderGraph);

  // Relations count
  var relInfo = document.getElementById("graph-relations-info");
  if (relInfo) {
    relInfo.textContent = ts.relations.length + " relation" + (ts.relations.length !== 1 ? "s" : "");
  }

  // Check if selected item still exists
  if (ts.selectedId) {
    var found = false;
    for (var k = 0; k < ts.data.length; k++) {
      if ((ts.data[k].id || ts.data[k].name) === ts.selectedId) {
        found = true;
        break;
      }
    }
    if (!found) {
      var panel = document.getElementById("graph-detail");
      if (panel) {
        clearElement(panel);
        panel.appendChild(el("p", "placeholder", "Item no longer exists"));
        ts.selectedId = null;
      }
    }
  }
}

function renderGraphDetail(entity) {
  var panel = document.getElementById("graph-detail");
  if (!panel) return;
  clearElement(panel);

  panel.appendChild(el("h3", null, "Entity Details"));

  var fields = [
    { label: "ID", value: entity.id },
    { label: "Name", value: entity.name },
    { label: "Type", value: entity.type },
    { label: "Timestamp", value: formatTimestamp(entity.timestamp) }
  ];

  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.value === undefined || f.value === null) continue;
    var div = el("div", "detail-field");
    div.appendChild(el("div", "detail-label", f.label));
    div.appendChild(el("div", "detail-value", String(f.value)));
    panel.appendChild(div);
  }

  // Properties as key-value pairs
  if (entity.properties && typeof entity.properties === "object") {
    var propsDiv = el("div", "detail-field");
    propsDiv.appendChild(el("div", "detail-label", "Properties"));
    var keys = Object.keys(entity.properties);
    if (keys.length === 0) {
      propsDiv.appendChild(el("div", "detail-value", "(none)"));
    } else {
      for (var k = 0; k < keys.length; k++) {
        var pDiv = el("div", "detail-value");
        var val = entity.properties[keys[k]];
        pDiv.textContent = keys[k] + ": " + (typeof val === "object" ? JSON.stringify(val) : String(val));
        propsDiv.appendChild(pDiv);
      }
    }
    panel.appendChild(propsDiv);
  }
}

/* ========== Initialization ========== */

document.addEventListener("DOMContentLoaded", function() {
  // Tab navigation
  var tabBtns = document.querySelectorAll(".tab-btn");
  for (var i = 0; i < tabBtns.length; i++) {
    (function(btn) {
      btn.addEventListener("click", function() {
        var tabName = btn.getAttribute("data-tab");
        if (tabName) switchTab(tabName);
      });
    })(tabBtns[i]);
  }

  // Sort headers
  var sortHeaders = document.querySelectorAll(".sortable-header");
  for (var j = 0; j < sortHeaders.length; j++) {
    (function(header) {
      header.addEventListener("click", function() {
        var key = header.getAttribute("data-sort-key");
        if (!key) return;
        // Determine which tab this header belongs to
        var table = header.closest("table");
        if (!table) return;
        var tableId = table.id;
        var tabName = null;
        if (tableId === "blackboard-table") tabName = "blackboard";
        else if (tableId === "decisions-table") tabName = "decisions";
        else if (tableId === "graph-table") tabName = "graph";
        if (tabName) handleSort(tabName, key);
      });
    })(sortHeaders[j]);
  }

  // Initial data load
  refreshData();

  // Start polling
  startPolling();

  // Visibility-aware lifecycle
  document.addEventListener("visibilitychange", function() {
    if (document.hidden) {
      stopPolling();
    } else {
      refreshData();
      startPolling();
    }
  });
});
