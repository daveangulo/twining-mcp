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
  search: { results: [], sortKey: "relevance", sortDir: "desc", page: 1, pageSize: 25, selectedId: null, query: "", fallback_mode: true },
  agents: { data: [], sortKey: "agent_id", sortDir: "asc", page: 1, pageSize: 25, selectedId: null },
  delegations: { data: [], sortKey: "timestamp", sortDir: "desc", page: 1, pageSize: 25, selectedId: null },
  handoffs: { data: [], sortKey: "created_at", sortDir: "desc", page: 1, pageSize: 25, selectedId: null },
  agentsSubView: "agents-list",
  insights: { valueStats: null, toolUsage: [], errors: [] },
  globalScope: "",
  status: null,
  pollTimer: null,
  pollInterval: 3000,
  connected: false
};

/* ========== Debounce Utility ========== */

function debounce(fn, delay) {
  var timer = null;
  return function() {
    var args = arguments;
    var ctx = this;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function() { fn.apply(ctx, args); timer = null; }, delay);
  };
}

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
      renderActivityBreakdown();
      renderRecentActivity();
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

/* ========== Agent Coordination Fetching ========== */

function fetchAgents() {
  fetch("/api/agents")
    .then(function(res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function(data) {
      state.agents.data = data.agents || [];
      state.connected = true;
      updateConnectionIndicator();
      renderAgents();
    })
    .catch(function() {
      state.connected = false;
      updateConnectionIndicator();
    });
}

function fetchDelegations() {
  fetch("/api/delegations")
    .then(function(res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function(data) {
      state.delegations.data = data.delegations || [];
      state.connected = true;
      updateConnectionIndicator();
      renderDelegations();
    })
    .catch(function() {
      state.connected = false;
      updateConnectionIndicator();
    });
}

function fetchHandoffs() {
  fetch("/api/handoffs")
    .then(function(res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function(data) {
      state.handoffs.data = data.handoffs || [];
      state.connected = true;
      updateConnectionIndicator();
      renderHandoffs();
    })
    .catch(function() {
      state.connected = false;
      updateConnectionIndicator();
    });
}

function fetchHandoffDetail(id) {
  fetch("/api/handoffs/" + encodeURIComponent(id))
    .then(function(res) {
      if (res.status === 404) {
        var panel = document.getElementById("handoffs-detail");
        if (panel) { clearElement(panel); panel.appendChild(el("p", "placeholder", "Handoff not found")); }
        return null;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function(data) {
      if (data) {
        renderHandoffDetail(data);
      }
    })
    .catch(function() {
      var panel = document.getElementById("handoffs-detail");
      if (panel) { clearElement(panel); panel.appendChild(el("p", "placeholder", "Handoff not found")); }
    });
}

/* ========== Insights Fetching ========== */

function fetchValueStats() {
  fetch("/api/analytics/value-stats")
    .then(function(res) { return res.json(); })
    .then(function(data) {
      state.insights.valueStats = data;
      renderValueStats();
    })
    .catch(function() {});
}

function fetchToolUsage() {
  fetch("/api/analytics/tool-usage")
    .then(function(res) { return res.json(); })
    .then(function(data) {
      state.insights.toolUsage = data.tools || [];
      renderToolUsage();
    })
    .catch(function() {});
}

function fetchErrorBreakdown() {
  fetch("/api/analytics/errors")
    .then(function(res) { return res.json(); })
    .then(function(data) {
      state.insights.errors = data.errors || [];
      renderErrorBreakdown();
    })
    .catch(function() {});
}

function fetchInsights() {
  fetchValueStats();
  fetchToolUsage();
  fetchErrorBreakdown();
}

/* ========== Polling Lifecycle ========== */

function refreshData() {
  fetchStatus();
  var tab = state.activeTab;
  if (tab === "stats") fetchBlackboard();
  else if (tab === "blackboard") fetchBlackboard();
  else if (tab === "decisions") fetchDecisions();
  else if (tab === "graph") fetchGraph();
  else if (tab === "search" && state.search.query) fetchSearch();
  else if (tab === "agents") {
    if (state.agentsSubView === "agents-list") fetchAgents();
    else if (state.agentsSubView === "delegations") fetchDelegations();
    else if (state.agentsSubView === "handoffs") fetchHandoffs();
  }
  else if (tab === "insights") fetchInsights();
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

  // Ensure data is loaded for the target tab (needed for navigateToId)
  if (tabName === "blackboard" && state.blackboard.data.length === 0) fetchBlackboard();
  if (tabName === "decisions" && state.decisions.data.length === 0) fetchDecisions();
  if (tabName === "graph" && state.graph.data.length === 0) fetchGraph();
  if (tabName === "agents" && state.agents.data.length === 0) fetchAgents();

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
  else if (tabName === "search") renderSearchResults();
  else if (tabName === "agents") renderAgents();
  else if (tabName === "delegations") renderDelegations();
  else if (tabName === "handoffs") renderHandoffs();
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
  setVal("stat-registered-agents", s.registered_agents);
  setVal("stat-active-agents", s.active_agents);
  setVal("stat-pending-delegations", s.pending_delegations);
  setVal("stat-total-handoffs", s.total_handoffs);

  // Update project name in header and page title
  if (s.project_name) {
    var titleEl = document.getElementById("dashboard-title");
    if (titleEl) titleEl.textContent = s.project_name + " — Twining";
    document.title = s.project_name + " — Twining Dashboard";
  }

  var msgEl = document.getElementById("uninitialized-msg");
  if (msgEl) {
    msgEl.style.display = (s.initialized === false) ? "block" : "none";
  }

  renderActivityBreakdown();
  renderRecentActivity();
}

function renderActivityBreakdown() {
  var container = document.getElementById('activity-breakdown');
  if (!container) return;

  var entries = state.blackboard.data || [];
  var typeCounts = {};

  for (var i = 0; i < entries.length; i++) {
    var type = entries[i].entry_type || 'unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  }

  clearElement(container);

  var types = Object.keys(typeCounts).sort(function(a, b) {
    return typeCounts[b] - typeCounts[a];
  });

  for (var j = 0; j < types.length; j++) {
    var type = types[j];
    var count = typeCounts[type];

    var item = el('div', 'activity-item');
    var label = el('div', 'activity-item-label', type);
    var countEl = el('div', 'activity-item-count', String(count));

    item.appendChild(label);
    item.appendChild(countEl);
    container.appendChild(item);
  }
}

function renderRecentActivity() {
  var container = document.getElementById('recent-activity');
  if (!container) return;

  var entries = state.blackboard.data || [];
  var sorted = entries.slice().sort(function(a, b) {
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  var recent = sorted.slice(0, 10);
  clearElement(container);

  if (recent.length === 0) {
    container.textContent = 'No recent activity';
    return;
  }

  for (var i = 0; i < recent.length; i++) {
    var entry = recent[i];

    var entryDiv = el('div', 'activity-entry');

    var header = el('div', 'activity-entry-header');
    var typeSpan = el('div', 'activity-entry-type', entry.entry_type || 'unknown');
    var timeSpan = el('div', 'activity-entry-time', formatTimestamp(entry.timestamp));

    header.appendChild(typeSpan);
    header.appendChild(timeSpan);

    var summary = el('div', 'activity-entry-summary', truncate(entry.summary || '', 80));

    entryDiv.appendChild(header);
    entryDiv.appendChild(summary);
    container.appendChild(entryDiv);
  }
}

/* ========== Render: Blackboard ========== */

function renderBlackboard() {
  var ts = state.blackboard;
  var scoped = applyGlobalScope(ts.data, "scope");
  var sorted = sortData(scoped, ts.sortKey, ts.sortDir);
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
    { label: "Tags", value: (entry.tags && entry.tags.length) ? entry.tags.join(", ") : null }
  ];

  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.value === undefined || f.value === null) continue;
    var div = el("div", "detail-field");
    div.appendChild(el("div", "detail-label", f.label));
    // Use clickable ID rendering for ID field
    if (f.label === "ID") {
      var valDiv = el("div", "detail-value");
      renderIdValue(valDiv, String(f.value));
      div.appendChild(valDiv);
    } else {
      div.appendChild(el("div", "detail-value", String(f.value)));
    }
    panel.appendChild(div);
  }

  // Relates To with clickable IDs
  if (entry.relates_to && entry.relates_to.length) {
    var rtDiv = el("div", "detail-field");
    rtDiv.appendChild(el("div", "detail-label", "Relates To"));
    var rtVal = el("div", "detail-value");
    renderIdList(rtVal, entry.relates_to);
    rtDiv.appendChild(rtVal);
    panel.appendChild(rtDiv);
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
  var scoped = applyGlobalScope(ts.data, "scope");
  var sorted = sortData(scoped, ts.sortKey, ts.sortDir);
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

  // Update timeline if it is visible
  var timelineView = document.getElementById('decisions-timeline-view');
  if (timelineView && timelineView.style.display !== 'none' && window.timelineInstance) {
    updateTimelineData();
  }

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

function renderDecisionDetail(decision, panelId) {
  var panel = document.getElementById(panelId || "decisions-detail");
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
    // Use clickable ID rendering for ID field
    if (f.label === "ID") {
      var valDiv = el("div", "detail-value");
      renderIdValue(valDiv, String(f.value));
      div.appendChild(valDiv);
    } else {
      div.appendChild(el("div", "detail-value", String(f.value)));
    }
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

  // Array fields (non-ID)
  var plainArrayFields = [
    { label: "Affected Files", value: decision.affected_files },
    { label: "Affected Symbols", value: decision.affected_symbols },
    { label: "Commit Hashes", value: decision.commit_hashes }
  ];

  for (var af = 0; af < plainArrayFields.length; af++) {
    var arrField = plainArrayFields[af];
    if (!arrField.value || arrField.value.length === 0) continue;
    var arrDiv = el("div", "detail-field");
    arrDiv.appendChild(el("div", "detail-label", arrField.label));
    arrDiv.appendChild(el("div", "detail-value", arrField.value.join(", ")));
    panel.appendChild(arrDiv);
  }

  // ID array fields with clickable links
  var idArrayFields = [
    { label: "Depends On", value: decision.depends_on },
    { label: "Supersedes", value: decision.supersedes ? [decision.supersedes] : null }
  ];

  for (var idf = 0; idf < idArrayFields.length; idf++) {
    var idField = idArrayFields[idf];
    if (!idField.value || idField.value.length === 0) continue;
    var idDiv = el("div", "detail-field");
    idDiv.appendChild(el("div", "detail-label", idField.label));
    var idVal = el("div", "detail-value");
    renderIdList(idVal, idField.value);
    idDiv.appendChild(idVal);
    panel.appendChild(idDiv);
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
  var scoped = applyGlobalScope(ts.data, "scope");
  var sorted = sortData(scoped, ts.sortKey, ts.sortDir);
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

  // Update graph visualization if visual view is active
  var graphVisualView = document.getElementById('graph-visual-view');
  if (graphVisualView && graphVisualView.style.display !== 'none' && window.cyInstance) {
    updateGraphData();
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

function renderGraphVisualDetail(entity) {
  renderGraphDetail(entity, "graph-visual-detail");
}

function renderGraphDetail(entity, panelId) {
  var panel = document.getElementById(panelId || "graph-detail");
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
    // Use clickable ID rendering for ID field
    if (f.label === "ID") {
      var valDiv = el("div", "detail-value");
      renderIdValue(valDiv, String(f.value));
      div.appendChild(valDiv);
    } else {
      div.appendChild(el("div", "detail-value", String(f.value)));
    }
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

  // Relations involving this entity (with clickable source/target IDs)
  var entityId = entity.id || entity.name;
  var relatedRelations = state.graph.relations.filter(function(r) {
    return r.source === entityId || r.target === entityId;
  });
  if (relatedRelations.length > 0) {
    var relDiv = el("div", "detail-field");
    relDiv.appendChild(el("div", "detail-label", "Relations (" + relatedRelations.length + ")"));
    for (var r = 0; r < relatedRelations.length; r++) {
      var rel = relatedRelations[r];
      var relBlock = el("div");
      relBlock.style.marginBottom = "0.25rem";
      relBlock.style.fontSize = "0.8125rem";

      var sourceSpan = el("span");
      renderIdValue(sourceSpan, rel.source || "--");
      relBlock.appendChild(sourceSpan);
      relBlock.appendChild(document.createTextNode(" --[" + (rel.type || "?") + "]--> "));
      var targetSpan = el("span");
      renderIdValue(targetSpan, rel.target || "--");
      relBlock.appendChild(targetSpan);

      relDiv.appendChild(relBlock);
    }
    panel.appendChild(relDiv);
  }
}

/* ========== Render: Agents ========== */

function renderAgents() {
  var ts = state.agents;
  var sorted = sortData(ts.data, ts.sortKey, ts.sortDir);
  var page = paginate(sorted, ts.page, ts.pageSize);

  updateSortHeaders("agents-table", ts.sortKey, ts.sortDir);

  var tbody = document.querySelector("#agents-table tbody");
  if (!tbody) return;
  clearElement(tbody);

  for (var i = 0; i < page.length; i++) {
    var agent = page[i];
    var tr = el("tr");
    tr.setAttribute("data-id", agent.agent_id || "");
    if (ts.selectedId && (agent.agent_id === ts.selectedId)) {
      tr.classList.add("selected");
    }

    var tdId = el("td", null, agent.agent_id || "--");
    var tdStatus = el("td");
    tdStatus.appendChild(createBadge("liveness-" + (agent.liveness || "gone")));
    var tdRole = el("td", null, agent.role || "--");

    var tdCaps = el("td");
    if (agent.capabilities && agent.capabilities.length) {
      for (var c = 0; c < agent.capabilities.length; c++) {
        tdCaps.appendChild(el("span", "capability-tag", agent.capabilities[c]));
      }
    } else {
      tdCaps.textContent = "--";
    }

    var tdActive = el("td", null, formatTimestamp(agent.last_active));

    tr.appendChild(tdId);
    tr.appendChild(tdStatus);
    tr.appendChild(tdRole);
    tr.appendChild(tdCaps);
    tr.appendChild(tdActive);

    (function(a) {
      tr.addEventListener("click", function() {
        ts.selectedId = a.agent_id;
        renderAgents();
        renderAgentDetail(a);
      });
    })(agent);

    tbody.appendChild(tr);
  }

  renderPagination("agents-pagination", sorted.length, ts, renderAgents);

  if (ts.selectedId) {
    var found = null;
    for (var k = 0; k < ts.data.length; k++) {
      if (ts.data[k].agent_id === ts.selectedId) { found = ts.data[k]; break; }
    }
    if (!found) {
      var panel = document.getElementById("agents-detail");
      if (panel) { clearElement(panel); panel.appendChild(el("p", "placeholder", "Agent no longer exists")); ts.selectedId = null; }
    }
  }
}

function renderAgentDetail(agent) {
  var panel = document.getElementById("agents-detail");
  if (!panel) return;
  clearElement(panel);

  panel.appendChild(el("h3", null, "Agent Details"));

  var fields = [
    { label: "Agent ID", value: agent.agent_id },
    { label: "Role", value: agent.role },
    { label: "Description", value: agent.description },
    { label: "Registered At", value: formatTimestamp(agent.registered_at) },
    { label: "Last Active", value: formatTimestamp(agent.last_active) }
  ];

  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.value === undefined || f.value === null) continue;
    var div = el("div", "detail-field");
    div.appendChild(el("div", "detail-label", f.label));
    div.appendChild(el("div", "detail-value", String(f.value)));
    panel.appendChild(div);
  }

  // Liveness badge
  var liveDiv = el("div", "detail-field");
  liveDiv.appendChild(el("div", "detail-label", "Liveness"));
  var liveVal = el("div", "detail-value");
  liveVal.appendChild(createBadge("liveness-" + (agent.liveness || "gone")));
  liveDiv.appendChild(liveVal);
  panel.appendChild(liveDiv);

  // Capabilities as tags
  if (agent.capabilities && agent.capabilities.length) {
    var capsDiv = el("div", "detail-field");
    capsDiv.appendChild(el("div", "detail-label", "Capabilities"));
    var capsVal = el("div", "detail-value");
    for (var c = 0; c < agent.capabilities.length; c++) {
      capsVal.appendChild(el("span", "capability-tag", agent.capabilities[c]));
    }
    capsDiv.appendChild(capsVal);
    panel.appendChild(capsDiv);
  }
}

/* ========== Render: Delegations ========== */

function renderDelegations() {
  var ts = state.delegations;
  var scoped = applyGlobalScope(ts.data, "scope");
  var sorted = sortData(scoped, ts.sortKey, ts.sortDir);
  var page = paginate(sorted, ts.page, ts.pageSize);

  updateSortHeaders("delegations-table", ts.sortKey, ts.sortDir);

  var tbody = document.querySelector("#delegations-table tbody");
  if (!tbody) return;
  clearElement(tbody);

  for (var i = 0; i < page.length; i++) {
    var del = page[i];
    var tr = el("tr");
    tr.setAttribute("data-id", del.entry_id || "");
    if (del.expired) tr.classList.add("delegation-expired");
    if (ts.selectedId && (del.entry_id === ts.selectedId)) {
      tr.classList.add("selected");
    }

    var tdTime = el("td", null, formatTimestamp(del.timestamp));
    var tdUrg = el("td");
    tdUrg.appendChild(createBadge("urgency-" + (del.urgency || "normal")));
    var tdSummary = el("td", null, truncate(del.summary, 60));

    var tdCaps = el("td");
    if (del.required_capabilities && del.required_capabilities.length) {
      for (var c = 0; c < del.required_capabilities.length; c++) {
        tdCaps.appendChild(el("span", "capability-tag", del.required_capabilities[c]));
      }
    } else {
      tdCaps.textContent = "--";
    }

    var tdStatus = el("td");
    if (del.expired) {
      tdStatus.appendChild(createBadge("liveness-gone"));
      tdStatus.lastChild.textContent = "Expired";
    } else {
      tdStatus.appendChild(createBadge("liveness-active"));
      tdStatus.lastChild.textContent = "Active";
    }

    tr.appendChild(tdTime);
    tr.appendChild(tdUrg);
    tr.appendChild(tdSummary);
    tr.appendChild(tdCaps);
    tr.appendChild(tdStatus);

    (function(d) {
      tr.addEventListener("click", function() {
        ts.selectedId = d.entry_id;
        renderDelegations();
        renderDelegationDetail(d);
      });
    })(del);

    tbody.appendChild(tr);
  }

  renderPagination("delegations-pagination", sorted.length, ts, renderDelegations);

  if (ts.selectedId) {
    var found = null;
    for (var k = 0; k < ts.data.length; k++) {
      if (ts.data[k].entry_id === ts.selectedId) { found = ts.data[k]; break; }
    }
    if (!found) {
      var panel = document.getElementById("delegations-detail");
      if (panel) { clearElement(panel); panel.appendChild(el("p", "placeholder", "Delegation no longer exists")); ts.selectedId = null; }
    }
  }
}

function renderDelegationDetail(delegation) {
  var panel = document.getElementById("delegations-detail");
  if (!panel) return;
  clearElement(panel);

  panel.appendChild(el("h3", null, "Delegation Details"));

  // Entry ID (clickable)
  var idDiv = el("div", "detail-field");
  idDiv.appendChild(el("div", "detail-label", "Entry ID"));
  var idVal = el("div", "detail-value");
  renderIdValue(idVal, delegation.entry_id || "--");
  idDiv.appendChild(idVal);
  panel.appendChild(idDiv);

  var fields = [
    { label: "Timestamp", value: formatTimestamp(delegation.timestamp) },
    { label: "Summary", value: delegation.summary },
    { label: "Scope", value: delegation.scope },
    { label: "Agent ID", value: delegation.agent_id }
  ];

  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.value === undefined || f.value === null) continue;
    var div = el("div", "detail-field");
    div.appendChild(el("div", "detail-label", f.label));
    div.appendChild(el("div", "detail-value", String(f.value)));
    panel.appendChild(div);
  }

  // Urgency badge
  var urgDiv = el("div", "detail-field");
  urgDiv.appendChild(el("div", "detail-label", "Urgency"));
  var urgVal = el("div", "detail-value");
  urgVal.appendChild(createBadge("urgency-" + (delegation.urgency || "normal")));
  urgDiv.appendChild(urgVal);
  panel.appendChild(urgDiv);

  // Required capabilities
  if (delegation.required_capabilities && delegation.required_capabilities.length) {
    var capsDiv = el("div", "detail-field");
    capsDiv.appendChild(el("div", "detail-label", "Required Capabilities"));
    var capsVal = el("div", "detail-value");
    for (var c = 0; c < delegation.required_capabilities.length; c++) {
      capsVal.appendChild(el("span", "capability-tag", delegation.required_capabilities[c]));
    }
    capsDiv.appendChild(capsVal);
    panel.appendChild(capsDiv);
  }

  // Expires At
  if (delegation.expires_at) {
    var expDiv = el("div", "detail-field");
    expDiv.appendChild(el("div", "detail-label", "Expires At"));
    expDiv.appendChild(el("div", "detail-value", formatTimestamp(delegation.expires_at)));
    panel.appendChild(expDiv);
  }

  // Status
  var statusDiv = el("div", "detail-field");
  statusDiv.appendChild(el("div", "detail-label", "Status"));
  var statusVal = el("div", "detail-value");
  if (delegation.expired) {
    var expBadge = createBadge("liveness-gone");
    expBadge.textContent = "Expired";
    statusVal.appendChild(expBadge);
  } else {
    var actBadge = createBadge("liveness-active");
    actBadge.textContent = "Active";
    statusVal.appendChild(actBadge);
  }
  statusDiv.appendChild(statusVal);
  panel.appendChild(statusDiv);

  // Suggested Agents
  if (delegation.suggested_agents && delegation.suggested_agents.length) {
    var saDiv = el("div", "detail-field");
    saDiv.appendChild(el("div", "detail-label", "Suggested Agents (" + delegation.suggested_agents.length + ")"));
    for (var s = 0; s < delegation.suggested_agents.length; s++) {
      var sa = delegation.suggested_agents[s];
      var saRow = el("div", "suggested-agent");
      var saInfo = el("span");
      saInfo.textContent = sa.agent_id || "--";
      saRow.appendChild(saInfo);

      var saLive = createBadge("liveness-" + (sa.liveness || "gone"));
      saRow.appendChild(saLive);

      var saScore = el("span", "agent-score", Math.round((sa.total_score || 0) * 100) + "%");
      saRow.appendChild(saScore);

      saDiv.appendChild(saRow);
    }
    panel.appendChild(saDiv);
  }
}

/* ========== Render: Handoffs ========== */

function renderHandoffs() {
  var ts = state.handoffs;
  var scoped = applyGlobalScope(ts.data, "scope");
  var sorted = sortData(scoped, ts.sortKey, ts.sortDir);
  var page = paginate(sorted, ts.page, ts.pageSize);

  updateSortHeaders("handoffs-table", ts.sortKey, ts.sortDir);

  var tbody = document.querySelector("#handoffs-table tbody");
  if (!tbody) return;
  clearElement(tbody);

  for (var i = 0; i < page.length; i++) {
    var handoff = page[i];
    var tr = el("tr");
    tr.setAttribute("data-id", handoff.id || "");
    if (ts.selectedId && (handoff.id === ts.selectedId)) {
      tr.classList.add("selected");
    }

    var tdCreated = el("td", null, formatTimestamp(handoff.created_at));
    var tdSource = el("td", null, handoff.source_agent || "--");
    var tdTarget = el("td", null, handoff.target_agent || "--");
    var tdSummary = el("td", null, truncate(handoff.summary, 50));

    var tdResult = el("td");
    tdResult.appendChild(createBadge("result-" + (handoff.result_status || "completed")));

    var tdAck = el("td");
    if (handoff.acknowledged) {
      tdAck.appendChild(el("span", "ack-yes", "\u2713 Yes"));
    } else {
      tdAck.appendChild(el("span", "ack-no", "No"));
    }

    tr.appendChild(tdCreated);
    tr.appendChild(tdSource);
    tr.appendChild(tdTarget);
    tr.appendChild(tdSummary);
    tr.appendChild(tdResult);
    tr.appendChild(tdAck);

    (function(h) {
      tr.addEventListener("click", function() {
        ts.selectedId = h.id;
        renderHandoffs();
        fetchHandoffDetail(h.id);
      });
    })(handoff);

    tbody.appendChild(tr);
  }

  renderPagination("handoffs-pagination", sorted.length, ts, renderHandoffs);

  if (ts.selectedId) {
    var found = null;
    for (var k = 0; k < ts.data.length; k++) {
      if (ts.data[k].id === ts.selectedId) { found = ts.data[k]; break; }
    }
    if (!found) {
      var panel = document.getElementById("handoffs-detail");
      if (panel) { clearElement(panel); panel.appendChild(el("p", "placeholder", "Handoff no longer exists")); ts.selectedId = null; }
    }
  }
}

function renderHandoffDetail(handoff) {
  var panel = document.getElementById("handoffs-detail");
  if (!panel) return;
  clearElement(panel);

  panel.appendChild(el("h3", null, "Handoff Details"));

  // ID (clickable)
  var idDiv = el("div", "detail-field");
  idDiv.appendChild(el("div", "detail-label", "ID"));
  var idVal = el("div", "detail-value");
  renderIdValue(idVal, handoff.id || "--");
  idDiv.appendChild(idVal);
  panel.appendChild(idDiv);

  var fields = [
    { label: "Created At", value: formatTimestamp(handoff.created_at) },
    { label: "Source Agent", value: handoff.source_agent },
    { label: "Target Agent", value: handoff.target_agent },
    { label: "Scope", value: handoff.scope },
    { label: "Summary", value: handoff.summary }
  ];

  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.value === undefined || f.value === null) continue;
    var div = el("div", "detail-field");
    div.appendChild(el("div", "detail-label", f.label));
    div.appendChild(el("div", "detail-value", String(f.value)));
    panel.appendChild(div);
  }

  // Result Status badge
  var rsDiv = el("div", "detail-field");
  rsDiv.appendChild(el("div", "detail-label", "Result Status"));
  var rsVal = el("div", "detail-value");
  rsVal.appendChild(createBadge("result-" + (handoff.result_status || "completed")));
  rsDiv.appendChild(rsVal);
  panel.appendChild(rsDiv);

  // Acknowledged
  var ackDiv = el("div", "detail-field");
  ackDiv.appendChild(el("div", "detail-label", "Acknowledged"));
  var ackVal = el("div", "detail-value");
  if (handoff.acknowledged) {
    ackVal.appendChild(el("span", "ack-yes", "\u2713 Yes"));
    if (handoff.acknowledged_by) {
      ackVal.appendChild(document.createTextNode(" by " + handoff.acknowledged_by));
    }
    if (handoff.acknowledged_at) {
      ackVal.appendChild(document.createTextNode(" at " + formatTimestamp(handoff.acknowledged_at)));
    }
  } else {
    ackVal.appendChild(el("span", "ack-no", "No"));
  }
  ackDiv.appendChild(ackVal);
  panel.appendChild(ackDiv);

  // Results section
  if (handoff.results && handoff.results.length) {
    var resDiv = el("div", "detail-field");
    resDiv.appendChild(el("div", "detail-label", "Results (" + handoff.results.length + ")"));
    for (var r = 0; r < handoff.results.length; r++) {
      var result = handoff.results[r];
      var resBlock = el("div");
      resBlock.style.marginBottom = "0.5rem";
      resBlock.style.paddingLeft = "0.5rem";
      resBlock.style.borderLeft = "2px solid var(--card-border)";

      if (result.task) {
        var taskEl = el("div");
        taskEl.appendChild(el("strong", null, "Task: "));
        taskEl.appendChild(document.createTextNode(result.task));
        resBlock.appendChild(taskEl);
      }
      if (result.status) {
        var statusEl = el("div");
        statusEl.appendChild(el("strong", null, "Status: "));
        statusEl.appendChild(createBadge("result-" + result.status));
        resBlock.appendChild(statusEl);
      }
      if (result.output) {
        var outputEl = el("div", "detail-value");
        var pre = el("pre", null, result.output);
        outputEl.appendChild(pre);
        resBlock.appendChild(outputEl);
      }

      resDiv.appendChild(resBlock);
    }
    panel.appendChild(resDiv);
  }

  // Context Snapshot
  if (handoff.context_snapshot) {
    var ctx = handoff.context_snapshot;
    var ctxDiv = el("div", "detail-field");
    ctxDiv.appendChild(el("div", "detail-label", "Context Snapshot"));

    // Decision IDs (clickable)
    if (ctx.decision_ids && ctx.decision_ids.length) {
      var didsDiv = el("div");
      didsDiv.appendChild(el("strong", null, "Decision IDs: "));
      renderIdList(didsDiv, ctx.decision_ids);
      ctxDiv.appendChild(didsDiv);
    }

    // Warning IDs (clickable)
    if (ctx.warning_ids && ctx.warning_ids.length) {
      var widsDiv = el("div");
      widsDiv.appendChild(el("strong", null, "Warning IDs: "));
      renderIdList(widsDiv, ctx.warning_ids);
      ctxDiv.appendChild(widsDiv);
    }

    // Finding IDs (clickable)
    if (ctx.finding_ids && ctx.finding_ids.length) {
      var fidsDiv = el("div");
      fidsDiv.appendChild(el("strong", null, "Finding IDs: "));
      renderIdList(fidsDiv, ctx.finding_ids);
      ctxDiv.appendChild(fidsDiv);
    }

    // Summaries
    if (ctx.summaries && ctx.summaries.length) {
      var sumDiv = el("div");
      sumDiv.appendChild(el("strong", null, "Summaries:"));
      var sumUl = el("ul");
      for (var si = 0; si < ctx.summaries.length; si++) {
        sumUl.appendChild(el("li", null, ctx.summaries[si]));
      }
      sumDiv.appendChild(sumUl);
      ctxDiv.appendChild(sumDiv);
    }

    panel.appendChild(ctxDiv);
  }
}

/* ========== Global Scope Filter ========== */

function applyGlobalScope(data, scopeField) {
  if (!state.globalScope) return data;
  var gs = state.globalScope;
  return data.filter(function(item) {
    var itemScope = item[scopeField || "scope"] || "";
    // For graph entities, check properties.file or properties.scope as fallback
    if (!itemScope && item.properties) {
      itemScope = item.properties.file || item.properties.scope || "";
    }
    return itemScope.startsWith(gs) || gs.startsWith(itemScope);
  });
}

/* ========== Clickable ID Navigation (SRCH-04) ========== */

var ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

function renderIdValue(container, value) {
  if (ULID_PATTERN.test(value)) {
    var link = el("span", "clickable-id", value);
    link.addEventListener("click", function(e) {
      e.stopPropagation();
      navigateToId(value);
    });
    container.appendChild(link);
  } else {
    container.textContent = value;
  }
}

function renderIdList(container, ids) {
  if (!ids || !ids.length) { container.textContent = "--"; return; }
  for (var i = 0; i < ids.length; i++) {
    if (i > 0) container.appendChild(document.createTextNode(", "));
    renderIdValue(container, ids[i]);
  }
}

function navigateToId(id) {
  // Check blackboard
  for (var i = 0; i < state.blackboard.data.length; i++) {
    if (state.blackboard.data[i].id === id) {
      switchTab("blackboard");
      state.blackboard.selectedId = id;
      renderBlackboard();
      renderBlackboardDetail(state.blackboard.data[i]);
      return;
    }
  }
  // Check decisions
  for (var j = 0; j < state.decisions.data.length; j++) {
    if (state.decisions.data[j].id === id) {
      switchTab("decisions");
      state.decisions.selectedId = id;
      renderDecisions();
      fetchDecisionDetail(id);
      return;
    }
  }
  // Check graph entities
  for (var k = 0; k < state.graph.data.length; k++) {
    if (state.graph.data[k].id === id) {
      switchTab("graph");
      state.graph.selectedId = id;
      renderGraph();
      renderGraphDetail(state.graph.data[k]);
      return;
    }
  }
  // Not found -- data may not be loaded yet
  var statusBar = document.getElementById("search-status-bar");
  if (statusBar) {
    clearElement(statusBar);
    statusBar.appendChild(el("span", null, "ID not found in loaded data: " + id));
  }
}

/* ========== Search Functions ========== */

function buildSearchUrl() {
  var q = state.search.query;
  if (!q) return null;
  var params = "q=" + encodeURIComponent(q);

  // Type filter
  var typesSelect = document.getElementById("filter-types");
  if (typesSelect) {
    var selectedTypes = [];
    for (var i = 0; i < typesSelect.options.length; i++) {
      if (typesSelect.options[i].selected) selectedTypes.push(typesSelect.options[i].value);
    }
    if (selectedTypes.length > 0 && selectedTypes.length < 3) {
      params += "&types=" + selectedTypes.join(",");
    }
  }

  // Status filter
  var statusSelect = document.getElementById("filter-status");
  if (statusSelect && statusSelect.value) params += "&status=" + encodeURIComponent(statusSelect.value);

  // Scope (uses global scope if set)
  if (state.globalScope) params += "&scope=" + encodeURIComponent(state.globalScope);

  // Date filters
  var sinceInput = document.getElementById("filter-since");
  if (sinceInput && sinceInput.value) params += "&since=" + sinceInput.value + "T00:00:00Z";
  var untilInput = document.getElementById("filter-until");
  if (untilInput && untilInput.value) params += "&until=" + untilInput.value + "T23:59:59Z";

  return "/api/search?" + params;
}

function fetchSearch() {
  var url = buildSearchUrl();
  if (!url) {
    state.search.results = [];
    renderSearchResults();
    return;
  }

  fetch(url)
    .then(function(res) {
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function(data) {
      state.search.results = data.results || [];
      state.search.fallback_mode = data.fallback_mode !== false;
      state.search.page = 1;
      state.connected = true;
      updateConnectionIndicator();
      renderSearchResults();
    })
    .catch(function() {
      state.connected = false;
      updateConnectionIndicator();
    });
}

function performSearch() {
  var input = document.getElementById("search-input");
  state.search.query = input ? input.value.trim() : "";
  if (!state.search.query) {
    state.search.results = [];
    renderSearchResults();
    return;
  }
  // Auto-switch to search tab
  switchTab("search");
  fetchSearch();
}

/* ========== Render: Search Results ========== */

function renderSearchResults() {
  var ts = state.search;
  var tbody = document.querySelector("#search-table tbody");
  if (!tbody) return;
  clearElement(tbody);

  var sorted = sortData(ts.results, ts.sortKey, ts.sortDir);
  var page = paginate(sorted, ts.page, ts.pageSize);

  for (var i = 0; i < page.length; i++) {
    var result = page[i];
    var tr = el("tr");
    tr.setAttribute("data-id", result.id || "");
    if (ts.selectedId && result.id === ts.selectedId) tr.classList.add("selected");

    // Type badge
    var tdType = el("td");
    tdType.appendChild(createBadge(result.type));
    tr.appendChild(tdType);

    // Summary/Name
    var tdSummary = el("td", null, truncate(result.summary || result.name || "--", 80));
    tr.appendChild(tdSummary);

    // Scope
    var tdScope = el("td", null, result.scope || "--");
    tr.appendChild(tdScope);

    // Relevance
    var relPct = Math.round((result.relevance || 0) * 100);
    var tdRel = el("td", null, relPct + "%");
    tr.appendChild(tdRel);

    // Timestamp
    var tdTime = el("td", null, formatTimestamp(result.timestamp));
    tr.appendChild(tdTime);

    // Click to show detail
    (function(r) {
      tr.addEventListener("click", function() {
        ts.selectedId = r.id;
        renderSearchResults();
        renderSearchDetail(r);
      });
    })(result);

    tbody.appendChild(tr);
  }

  renderPagination("search-pagination", sorted.length, ts, renderSearchResults);

  // Status bar
  var statusBar = document.getElementById("search-status-bar");
  if (statusBar) {
    clearElement(statusBar);
    if (ts.query) {
      var msg = ts.results.length + " results for \"" + ts.query + "\"";
      if (ts.fallback_mode) msg += " (keyword search)";
      else msg += " (semantic search)";
      statusBar.appendChild(el("span", null, msg));
    }
  }
}

function renderSearchDetail(result) {
  var panel = document.getElementById("search-detail");
  if (!panel) return;
  clearElement(panel);

  panel.appendChild(el("h3", null, (result.type || "Item") + " Details"));

  var fields = [
    { label: "ID", value: result.id },
    { label: "Type", value: result.type },
    { label: "Summary", value: result.summary || result.name },
    { label: "Scope", value: result.scope },
    { label: "Relevance", value: result.relevance != null ? Math.round(result.relevance * 100) + "%" : null },
    { label: "Timestamp", value: formatTimestamp(result.timestamp) },
    { label: "Status", value: result.status },
    { label: "Domain", value: result.domain },
    { label: "Confidence", value: result.confidence },
    { label: "Entry Type", value: result.entry_type },
    { label: "Entity Type", value: result.entity_type }
  ];

  for (var i = 0; i < fields.length; i++) {
    var f = fields[i];
    if (f.value === undefined || f.value === null) continue;
    var div = el("div", "detail-field");
    div.appendChild(el("div", "detail-label", f.label));
    // Use clickable ID rendering for ID field
    if (f.label === "ID") {
      var valDiv = el("div", "detail-value");
      renderIdValue(valDiv, String(f.value));
      div.appendChild(valDiv);
    } else {
      div.appendChild(el("div", "detail-value", String(f.value)));
    }
    panel.appendChild(div);
  }

  // "Go to item" button
  if (result.id) {
    var goBtn = el("button", null, "Go to " + result.type + " tab");
    goBtn.style.marginTop = "1rem";
    goBtn.addEventListener("click", function() { navigateToId(result.id); });
    panel.appendChild(goBtn);
  }
}

/* ========== Theme Toggle ========== */

function initTheme() {
  var saved = localStorage.getItem('twining-theme');
  if (saved) {
    setTheme(saved);
  } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    setTheme('dark');
  }
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e) {
      if (!localStorage.getItem('twining-theme')) {
        setTheme(e.matches ? 'dark' : 'light');
      }
    });
  }
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  var icon = document.getElementById('theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '\u2600' : '\u263D';
}

function toggleTheme() {
  var current = document.documentElement.getAttribute('data-theme') || 'light';
  var next = current === 'dark' ? 'light' : 'dark';
  setTheme(next);
  localStorage.setItem('twining-theme', next);
  // Refresh cytoscape styles if graph is initialized (for Plan 10-03)
  if (window.cyInstance) {
    window.cyInstance.style(buildGraphStyles());
  }
}

/* ========== View-Mode Toggles ========== */

function toggleView(tab, viewName) {
  // Update active button state
  var toggleContainer = document.getElementById(tab + '-view-toggle');
  if (toggleContainer) {
    toggleContainer.querySelectorAll('.view-btn').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-view') === viewName);
    });
  }
  if (tab === 'decisions') {
    document.getElementById('decisions-table-view').style.display = viewName === 'table' ? 'block' : 'none';
    document.getElementById('decisions-timeline-view').style.display = viewName === 'timeline' ? 'block' : 'none';
    if (viewName === 'timeline' && typeof initTimeline === 'function') initTimeline();
  }
  if (tab === 'graph') {
    document.getElementById('graph-table-view').style.display = viewName === 'table' ? 'block' : 'none';
    document.getElementById('graph-visual-view').style.display = viewName === 'visual' ? 'block' : 'none';
    if (viewName === 'visual' && typeof initGraphVis === 'function') initGraphVis();
  }
  if (tab === 'agents') {
    document.getElementById('agents-list-view').style.display = viewName === 'agents-list' ? 'block' : 'none';
    document.getElementById('delegations-view').style.display = viewName === 'delegations' ? 'block' : 'none';
    document.getElementById('handoffs-view').style.display = viewName === 'handoffs' ? 'block' : 'none';
    state.agentsSubView = viewName;
    if (viewName === 'agents-list' && state.agents.data.length === 0) fetchAgents();
    if (viewName === 'delegations' && state.delegations.data.length === 0) fetchDelegations();
    if (viewName === 'handoffs' && state.handoffs.data.length === 0) fetchHandoffs();
  }
}

/* ========== Decision Timeline Visualization ========== */

var CONFIDENCE_CLASSES = { high: 'confidence-high', medium: 'confidence-medium', low: 'confidence-low' };
var STATUS_CLASSES = { provisional: 'status-provisional', superseded: 'status-superseded', overridden: 'status-overridden' };

function getDecisionClassName(d) {
  if (d.status && d.status !== 'active' && STATUS_CLASSES[d.status]) {
    return STATUS_CLASSES[d.status];
  }
  if (d.confidence && CONFIDENCE_CLASSES[d.confidence]) {
    return CONFIDENCE_CLASSES[d.confidence];
  }
  return '';
}

function buildTimelineItems(decisions) {
  var scoped = applyGlobalScope(decisions, 'scope');
  var items = [];
  for (var i = 0; i < scoped.length; i++) {
    var d = scoped[i];
    items.push({
      id: d.id,
      content: truncate(d.summary, 60),
      start: d.timestamp,
      className: getDecisionClassName(d),
      title: d.summary + ' [' + (d.status || 'unknown') + ', ' + (d.confidence || 'unknown') + ']'
    });
  }
  return items;
}

function initTimeline() {
  if (window.timelineInstance) {
    updateTimelineData();
    return;
  }
  if (typeof vis === 'undefined' || !vis.Timeline) return;

  var items = buildTimelineItems(state.decisions.data);
  window.timelineDataSet = new vis.DataSet(items);

  var container = document.getElementById('timeline-container');
  if (!container) return;

  var options = {
    zoomMin: 1000 * 60 * 60,
    zoomMax: 1000 * 60 * 60 * 24 * 365,
    orientation: { axis: 'top' },
    selectable: true,
    tooltip: { followMouse: true },
    margin: { item: { horizontal: 10, vertical: 20 } },
    stack: true,
    maxHeight: 600
  };

  window.timelineInstance = new vis.Timeline(container, window.timelineDataSet, options);

  window.timelineInstance.on('select', function(properties) {
    if (properties.items.length > 0) {
      var id = properties.items[0];
      state.decisions.selectedId = id;
      fetchTimelineDecisionDetail(id);
    }
  });

  window.timelineInstance.fit();
  renderTimelineLegend();
}

function renderTimelineLegend() {
  var legend = document.getElementById('timeline-legend');
  if (!legend || legend.children.length > 0) return;
  var items = [
    { color: '#4caf50', label: 'High confidence' },
    { color: '#ff9800', label: 'Medium confidence' },
    { color: '#f44336', label: 'Low confidence' },
    { color: 'var(--muted)', label: 'Provisional (dashed)', dashed: true },
    { color: 'var(--muted)', label: 'Superseded (strikethrough)', strike: true }
  ];
  for (var i = 0; i < items.length; i++) {
    var item = document.createElement('span');
    item.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:0.8rem;';
    var dot = document.createElement('span');
    dot.style.cssText = 'width:10px;height:10px;border-radius:50%;display:inline-block;background:' + items[i].color;
    if (items[i].dashed) dot.style.cssText += ';border:2px dashed var(--text);background:transparent';
    var label = document.createElement('span');
    label.textContent = items[i].label;
    if (items[i].strike) label.style.textDecoration = 'line-through';
    item.appendChild(dot);
    item.appendChild(label);
    legend.appendChild(item);
  }
}

function updateTimelineData() {
  if (!window.timelineDataSet) return;
  var items = buildTimelineItems(state.decisions.data);
  window.timelineDataSet.clear();
  window.timelineDataSet.add(items);
}

function fetchTimelineDecisionDetail(id) {
  fetch("/api/decisions/" + encodeURIComponent(id))
    .then(function(res) {
      if (res.status === 404) {
        var panel = document.getElementById("decisions-timeline-detail");
        if (panel) { clearElement(panel); panel.appendChild(el("p", "placeholder", "Decision not found")); }
        return null;
      }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    })
    .then(function(data) {
      if (data) {
        renderDecisionDetail(data, "decisions-timeline-detail");
      }
    })
    .catch(function() {
      var panel = document.getElementById("decisions-timeline-detail");
      if (panel) { clearElement(panel); panel.appendChild(el("p", "placeholder", "Decision not found")); }
    });
}

/* ========== Graph Visualization (cytoscape.js) ========== */

var ENTITY_COLORS = {
  module: '#3b82f6',
  'function': '#8b5cf6',
  'class': '#06b6d4',
  file: '#6b7280',
  concept: '#f59e0b',
  pattern: '#10b981',
  dependency: '#ef4444',
  api_endpoint: '#ec4899'
};

function buildGraphStyles() {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  var textColor = isDark ? '#e2e8f0' : '#1a1a2e';
  var edgeColor = isDark ? '#64748b' : '#94a3b8';
  var accentColor = isDark ? '#60a5fa' : '#3b82f6';

  var styles = [
    {
      selector: 'node',
      style: {
        'label': 'data(label)',
        'text-valign': 'bottom',
        'text-halign': 'center',
        'font-size': '11px',
        'width': 40,
        'height': 40,
        'color': textColor,
        'text-margin-y': 6,
        'background-color': '#6b7280',
        'text-wrap': 'wrap',
        'text-max-width': '120px'
      }
    },
    {
      selector: 'edge',
      style: {
        'width': 2,
        'line-color': edgeColor,
        'target-arrow-color': edgeColor,
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        'label': 'data(label)',
        'font-size': '8px',
        'color': textColor,
        'text-rotation': 'autorotate',
        'text-margin-y': -8
      }
    },
    {
      selector: 'node:selected',
      style: {
        'border-width': 3,
        'border-color': accentColor
      }
    }
  ];

  // Per-type node styles
  var types = Object.keys(ENTITY_COLORS);
  for (var i = 0; i < types.length; i++) {
    styles.push({
      selector: 'node[type="' + types[i] + '"]',
      style: {
        'background-color': ENTITY_COLORS[types[i]]
      }
    });
  }

  return styles;
}

function renderGraphLegend() {
  var legend = document.getElementById('graph-legend');
  if (!legend) return;
  clearElement(legend);
  var types = Object.keys(ENTITY_COLORS);
  for (var i = 0; i < types.length; i++) {
    var item = document.createElement('span');
    item.className = 'graph-legend-item';
    item.style.cssText = 'display:inline-flex;align-items:center;gap:4px;margin-right:12px;font-size:0.8rem;';
    var dot = document.createElement('span');
    dot.className = 'graph-legend-dot';
    dot.style.cssText = 'width:10px;height:10px;border-radius:50%;display:inline-block;background:' + ENTITY_COLORS[types[i]];
    var label = document.createElement('span');
    label.textContent = types[i];
    item.appendChild(dot);
    item.appendChild(label);
    legend.appendChild(item);
  }
}

function buildGraphElements() {
  var entities = state.graph.data;
  var relations = state.graph.relations;
  var scoped = applyGlobalScope(entities, 'scope');
  var elements = [];

  // Build a set of visible entity IDs for filtering edges
  var visibleIds = {};
  for (var i = 0; i < scoped.length; i++) {
    var ent = scoped[i];
    var eid = ent.id || ent.name;
    visibleIds[eid] = true;
    elements.push({
      data: {
        id: eid,
        label: ent.name || eid,
        type: ent.type || 'concept'
      }
    });
  }

  for (var j = 0; j < relations.length; j++) {
    var rel = relations[j];
    if (visibleIds[rel.source] && visibleIds[rel.target]) {
      elements.push({
        data: {
          id: rel.id || (rel.source + '-' + rel.target + '-' + j),
          source: rel.source,
          target: rel.target,
          label: rel.type || ''
        }
      });
    }
  }

  return elements;
}

function initGraphVis() {
  // Empty state check
  if (!state.graph.data || state.graph.data.length === 0) {
    var canvas = document.getElementById('graph-canvas');
    if (canvas) {
      clearElement(canvas);
      var msg = el('div', 'placeholder');
      msg.style.cssText = 'display:flex;align-items:center;justify-content:center;height:100%;color:var(--muted);font-style:italic;';
      msg.textContent = 'No graph entities yet';
      canvas.appendChild(msg);
    }
    renderGraphLegend();
    return;
  }

  // Create-once guard: if already initialized, just update data
  if (window.cyInstance) {
    updateGraphData();
    return;
  }

  if (typeof cytoscape === 'undefined') return;

  // Initialize expanded nodes tracker
  if (!state.graph.expandedNodes) {
    state.graph.expandedNodes = {};
  }

  var elements = buildGraphElements();

  window.cyInstance = cytoscape({
    container: document.getElementById('graph-canvas'),
    elements: elements,
    layout: {
      name: 'cose',
      animate: true,
      animationDuration: 500,
      nodeRepulsion: function() { return 12000; },
      idealEdgeLength: function() { return 100; },
      nodeOverlap: 20,
      padding: 40
    },
    style: buildGraphStyles(),
    minZoom: 0.2,
    maxZoom: 5,
    wheelSensitivity: 0.2
  });

  // Click node to show detail and expand neighbors
  window.cyInstance.on('tap', 'node', function(evt) {
    var nodeId = evt.target.id();
    var entity = null;
    for (var i = 0; i < state.graph.data.length; i++) {
      var e = state.graph.data[i];
      if ((e.id || e.name) === nodeId) {
        entity = e;
        break;
      }
    }
    if (entity) {
      state.graph.selectedId = nodeId;
      renderGraphDetail(entity);
      renderGraphVisualDetail(entity);
    }

    // Expand neighbors if not already expanded
    if (!state.graph.expandedNodes[nodeId]) {
      state.graph.expandedNodes[nodeId] = true;
      expandNeighbors(nodeId);
    }
  });

  renderGraphLegend();
  setupGraphControls();
}

function setupGraphControls() {
  var zoomIn = document.getElementById('graph-zoom-in');
  var zoomOut = document.getElementById('graph-zoom-out');
  var fit = document.getElementById('graph-fit');
  var reset = document.getElementById('graph-reset');

  if (zoomIn) {
    zoomIn.onclick = function() {
      if (window.cyInstance) window.cyInstance.zoom(window.cyInstance.zoom() * 1.2);
    };
  }

  if (zoomOut) {
    zoomOut.onclick = function() {
      if (window.cyInstance) window.cyInstance.zoom(window.cyInstance.zoom() * 0.8);
    };
  }

  if (fit) {
    fit.onclick = function() {
      if (window.cyInstance) window.cyInstance.fit(null, 40);
    };
  }

  if (reset) {
    reset.onclick = function() {
      if (window.cyInstance) {
        var layout = window.cyInstance.layout({
          name: 'cose',
          animate: true,
          animationDuration: 500,
          nodeRepulsion: function() { return 12000; },
          idealEdgeLength: function() { return 100; },
          nodeOverlap: 20,
          padding: 40
        });
        layout.run();
      }
    };
  }
}

function expandNeighbors(nodeId) {
  if (!window.cyInstance) return;
  var relations = state.graph.relations;
  var newElements = [];
  var existingIds = {};

  // Collect existing node IDs in cytoscape
  window.cyInstance.nodes().forEach(function(n) {
    existingIds[n.id()] = true;
  });

  // Also collect existing edge IDs
  window.cyInstance.edges().forEach(function(e) {
    existingIds[e.id()] = true;
  });

  for (var i = 0; i < relations.length; i++) {
    var rel = relations[i];
    if (rel.source !== nodeId && rel.target !== nodeId) continue;

    var neighborId = rel.source === nodeId ? rel.target : rel.source;

    // Add neighbor node if not present
    if (!existingIds[neighborId]) {
      var neighborEntity = null;
      for (var j = 0; j < state.graph.data.length; j++) {
        var ent = state.graph.data[j];
        if ((ent.id || ent.name) === neighborId) {
          neighborEntity = ent;
          break;
        }
      }
      if (neighborEntity) {
        newElements.push({
          group: 'nodes',
          data: {
            id: neighborId,
            label: neighborEntity.name || neighborId,
            type: neighborEntity.type || 'concept'
          }
        });
        existingIds[neighborId] = true;
      }
    }

    // Add edge if not present
    var edgeId = rel.id || (rel.source + '-' + rel.target + '-' + i);
    if (!existingIds[edgeId]) {
      newElements.push({
        group: 'edges',
        data: {
          id: edgeId,
          source: rel.source,
          target: rel.target,
          label: rel.type || ''
        }
      });
      existingIds[edgeId] = true;
    }
  }

  if (newElements.length > 0) {
    var added = window.cyInstance.add(newElements);
    // Re-layout only new elements without resetting viewport
    added.layout({
      name: 'cose',
      animate: true,
      animationDuration: 300,
      fit: false,
      nodeRepulsion: function() { return 8000; }
    }).run();
  }
}

function updateGraphData() {
  if (!window.cyInstance) return;

  var elements = buildGraphElements();

  // Build sets of desired node and edge IDs
  var desiredNodeIds = {};
  var desiredEdgeIds = {};
  var desiredNodes = [];
  var desiredEdges = [];

  for (var i = 0; i < elements.length; i++) {
    var elem = elements[i];
    if (elem.data.source) {
      desiredEdgeIds[elem.data.id] = true;
      desiredEdges.push(elem);
    } else {
      desiredNodeIds[elem.data.id] = true;
      desiredNodes.push(elem);
    }
  }

  // Remove stale nodes (not in desired set and not manually expanded neighbors)
  var toRemove = [];
  window.cyInstance.nodes().forEach(function(n) {
    if (!desiredNodeIds[n.id()]) {
      toRemove.push(n);
    }
  });
  if (toRemove.length > 0) {
    window.cyInstance.remove(window.cyInstance.collection().merge(toRemove));
  }

  // Add new nodes
  var existingNodeIds = {};
  window.cyInstance.nodes().forEach(function(n) { existingNodeIds[n.id()] = true; });
  var newNodes = [];
  for (var j = 0; j < desiredNodes.length; j++) {
    if (!existingNodeIds[desiredNodes[j].data.id]) {
      newNodes.push(desiredNodes[j]);
    }
  }

  // Remove stale edges
  var edgesToRemove = [];
  window.cyInstance.edges().forEach(function(e) {
    if (!desiredEdgeIds[e.id()]) {
      edgesToRemove.push(e);
    }
  });
  if (edgesToRemove.length > 0) {
    window.cyInstance.remove(window.cyInstance.collection().merge(edgesToRemove));
  }

  // Add new edges
  var existingEdgeIds = {};
  window.cyInstance.edges().forEach(function(e) { existingEdgeIds[e.id()] = true; });
  var newEdges = [];
  for (var k = 0; k < desiredEdges.length; k++) {
    if (!existingEdgeIds[desiredEdges[k].data.id]) {
      newEdges.push(desiredEdges[k]);
    }
  }

  var allNew = newNodes.concat(newEdges);
  if (allNew.length > 0) {
    window.cyInstance.add(allNew);
    // Only re-layout if new elements were added
    window.cyInstance.layout({
      name: 'cose',
      animate: true,
      animationDuration: 300,
      fit: false,
      nodeRepulsion: function() { return 8000; }
    }).run();
  }
}

/* ========== Insights Rendering ========== */

function renderValueStats() {
  var vs = state.insights.valueStats;
  if (!vs) return;

  // Blind decisions prevented
  var prevRate = document.getElementById("insight-prevention-rate");
  var prevDetail = document.getElementById("insight-prevention-detail");
  if (prevRate) prevRate.textContent = Math.round(vs.blind_decisions_prevented.prevention_rate * 100) + "%";
  if (prevDetail) prevDetail.textContent = vs.blind_decisions_prevented.assembled_before + " of " + vs.blind_decisions_prevented.total_decisions + " decisions had context assembled first";

  // Warnings surfaced
  var warnTotal = document.getElementById("insight-warnings-total");
  var warnDetail = document.getElementById("insight-warnings-detail");
  if (warnTotal) warnTotal.textContent = vs.warnings_surfaced.total;
  if (warnDetail) warnDetail.textContent = vs.warnings_surfaced.acknowledged + " acknowledged, " + vs.warnings_surfaced.resolved + " resolved, " + vs.warnings_surfaced.ignored + " unaddressed";

  // Test coverage
  var testCov = document.getElementById("insight-test-coverage");
  var testDetail = document.getElementById("insight-test-detail");
  if (testCov) testCov.textContent = Math.round(vs.test_coverage.coverage_rate * 100) + "%";
  if (testDetail) testDetail.textContent = vs.test_coverage.with_tested_by + " of " + vs.test_coverage.total_decisions + " decisions have tested_by relations";

  // Commit traceability
  var traceVal = document.getElementById("insight-traceability");
  var traceDetail = document.getElementById("insight-traceability-detail");
  if (traceVal) traceVal.textContent = Math.round(vs.commit_traceability.traceability_rate * 100) + "%";
  if (traceDetail) traceDetail.textContent = vs.commit_traceability.with_commits + " of " + vs.commit_traceability.total_decisions + " decisions linked to commits";

  // Decision lifecycle
  var lcVal = document.getElementById("insight-lifecycle");
  var lcDetail = document.getElementById("insight-lifecycle-detail");
  var lc = vs.decision_lifecycle;
  if (lcVal) lcVal.textContent = (lc.active + lc.provisional + lc.superseded + lc.overridden);
  if (lcDetail) lcDetail.textContent = lc.active + " active, " + lc.provisional + " provisional, " + lc.superseded + " superseded, " + lc.overridden + " overridden";

  // Knowledge graph
  var graphVal = document.getElementById("insight-graph");
  var graphDetail = document.getElementById("insight-graph-detail");
  if (graphVal) graphVal.textContent = vs.knowledge_graph.entities + " / " + vs.knowledge_graph.relations;
  if (graphDetail) {
    var typeStrs = [];
    var ebt = vs.knowledge_graph.entities_by_type;
    for (var ek in ebt) { if (ebt.hasOwnProperty(ek)) typeStrs.push(ek + ": " + ebt[ek]); }
    graphDetail.textContent = typeStrs.length > 0 ? "Entities: " + typeStrs.join(", ") : "No entities";
  }

  // Agent coordination
  var coordVal = document.getElementById("insight-coordination");
  var coordDetail = document.getElementById("insight-coordination-detail");
  if (coordVal) coordVal.textContent = vs.agent_coordination.total_handoffs;
  if (coordDetail) coordDetail.textContent = "Acknowledgment rate: " + Math.round(vs.agent_coordination.acknowledgment_rate * 100) + "%";
}

function renderToolUsage() {
  var tbody = document.querySelector("#tool-usage-table tbody");
  if (!tbody) return;
  clearElement(tbody);

  var tools = state.insights.toolUsage;
  if (tools.length === 0) {
    var row = document.createElement("tr");
    var cell = document.createElement("td");
    cell.colSpan = 6;
    cell.textContent = "No tool calls recorded";
    cell.className = "placeholder";
    row.appendChild(cell);
    tbody.appendChild(row);
    return;
  }

  for (var i = 0; i < tools.length; i++) {
    var t = tools[i];
    var tr = document.createElement("tr");

    var tdName = document.createElement("td");
    tdName.textContent = t.tool_name;
    tr.appendChild(tdName);

    var tdCalls = document.createElement("td");
    tdCalls.textContent = t.call_count;
    tr.appendChild(tdCalls);

    var tdErrors = document.createElement("td");
    tdErrors.textContent = t.error_count;
    if (t.error_count > 0) tdErrors.className = "error-count";
    tr.appendChild(tdErrors);

    var tdAvg = document.createElement("td");
    tdAvg.textContent = t.avg_duration_ms;
    tr.appendChild(tdAvg);

    var tdP95 = document.createElement("td");
    tdP95.textContent = t.p95_duration_ms;
    tr.appendChild(tdP95);

    var tdLast = document.createElement("td");
    tdLast.textContent = formatTime(t.last_called);
    tr.appendChild(tdLast);

    tbody.appendChild(tr);
  }
}

function renderErrorBreakdown() {
  var tbody = document.querySelector("#error-breakdown-table tbody");
  var noMsg = document.getElementById("no-errors-msg");
  if (!tbody) return;
  clearElement(tbody);

  var errors = state.insights.errors;
  if (errors.length === 0) {
    if (noMsg) noMsg.style.display = "block";
    return;
  }
  if (noMsg) noMsg.style.display = "none";

  for (var i = 0; i < errors.length; i++) {
    var e = errors[i];
    var tr = document.createElement("tr");

    var tdTool = document.createElement("td");
    tdTool.textContent = e.tool_name;
    tr.appendChild(tdTool);

    var tdCode = document.createElement("td");
    tdCode.textContent = e.error_code;
    tr.appendChild(tdCode);

    var tdCount = document.createElement("td");
    tdCount.textContent = e.count;
    tr.appendChild(tdCount);

    tbody.appendChild(tr);
  }
}

/* ========== Initialization ========== */

document.addEventListener("DOMContentLoaded", function() {
  // Initialize theme (must be early to avoid flash)
  initTheme();

  // Theme toggle button
  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', toggleTheme);
  }

  // View-mode toggle buttons
  document.querySelectorAll('.view-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var tab = btn.getAttribute('data-tab');
      var view = btn.getAttribute('data-view');
      if (tab && view) toggleView(tab, view);
    });
  });

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
        else if (tableId === "search-table") tabName = "search";
        else if (tableId === "agents-table") tabName = "agents";
        else if (tableId === "delegations-table") tabName = "delegations";
        else if (tableId === "handoffs-table") tabName = "handoffs";
        if (tabName) handleSort(tabName, key);
      });
    })(sortHeaders[j]);
  }

  // Search input: debounced performSearch on "input" event
  var searchInput = document.getElementById("search-input");
  if (searchInput) {
    var debouncedSearch = debounce(performSearch, 300);
    searchInput.addEventListener("input", debouncedSearch);
    // Enter key: immediate performSearch (bypass debounce)
    searchInput.addEventListener("keydown", function(e) {
      if (e.key === "Enter") {
        e.preventDefault();
        performSearch();
      }
    });
  }

  // Search button: performSearch on click
  var searchBtn = document.getElementById("search-btn");
  if (searchBtn) {
    searchBtn.addEventListener("click", performSearch);
  }

  // Clear button: clear search input, reset search state, switch to stats tab
  var clearBtn = document.getElementById("search-clear-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", function() {
      var input = document.getElementById("search-input");
      if (input) input.value = "";
      state.search.query = "";
      state.search.results = [];
      state.search.selectedId = null;
      state.search.page = 1;
      renderSearchResults();
      switchTab("stats");
    });
  }

  // Global scope filter
  var globalScopeInput = document.getElementById("global-scope");
  if (globalScopeInput) {
    var debouncedScope = debounce(function() {
      state.globalScope = globalScopeInput.value.trim();
      // Visual indicator
      if (state.globalScope) {
        globalScopeInput.classList.add("scope-active");
        var indicator = document.getElementById("scope-indicator");
        if (indicator) { indicator.style.display = "inline"; indicator.textContent = "Filtered: " + state.globalScope; }
      } else {
        globalScopeInput.classList.remove("scope-active");
        var indicator2 = document.getElementById("scope-indicator");
        if (indicator2) indicator2.style.display = "none";
      }
      // Reset pagination, re-render active tab
      state.blackboard.page = 1;
      state.decisions.page = 1;
      state.graph.page = 1;
      state.agents.page = 1;
      state.delegations.page = 1;
      state.handoffs.page = 1;
      refreshData();
    }, 300);
    globalScopeInput.addEventListener("input", debouncedScope);
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
