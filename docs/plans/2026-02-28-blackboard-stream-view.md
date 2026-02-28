# Blackboard Stream View — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a Stream alternate view to the Blackboard tab — a card-based activity feed with type coloring, time groups, relates_to thread lines, and type filter chips.

**Architecture:** The Blackboard tab gets a Table/Stream toggle (same pattern as Decisions and Graph). The Stream view renders blackboard entries as styled cards in reverse-chronological order, grouped by date, with CSS thread lines connecting `relates_to` entries. Type filter chips control visibility. The detail panel reuses the existing `renderBlackboardDetail`.

**Tech Stack:** Vanilla HTML/JS/CSS. No new dependencies. Matches existing dashboard patterns.

---

### Task 1: HTML — Add view toggle and stream container markup

**Files:**
- Modify: `src/dashboard/public/index.html:241-262` (Blackboard tab section)

**Step 1: Replace the Blackboard tab HTML**

The current Blackboard tab markup (lines 241-262) is a bare `content-area` with a table and detail panel. Replace it with the view toggle + two view containers pattern matching Decisions tab (lines 264-322).

Replace the content of `<!-- Blackboard Tab -->` div (`id="tab-blackboard"`) with:

```html
    <!-- Blackboard Tab -->
    <div class="tab-content" id="tab-blackboard" style="display:none">
      <div class="view-toggle" id="blackboard-view-toggle">
        <button class="view-btn active" data-view="table" data-tab="blackboard">Table</button>
        <button class="view-btn" data-view="stream" data-tab="blackboard">Stream</button>
      </div>
      <div class="view-table" id="blackboard-table-view">
        <div class="content-area">
          <div class="list-panel">
            <table class="data-table" id="blackboard-table">
              <thead>
                <tr>
                  <th class="sortable-header" data-sort-key="timestamp">Timestamp</th>
                  <th class="sortable-header" data-sort-key="entry_type">Type</th>
                  <th class="sortable-header" data-sort-key="scope">Scope</th>
                  <th class="sortable-header" data-sort-key="summary">Summary</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
            <div class="pagination" id="blackboard-pagination"></div>
          </div>
          <div class="detail-panel" id="blackboard-detail">
            <p class="placeholder">Select an entry to view details</p>
          </div>
        </div>
      </div>
      <div class="view-visual" id="blackboard-stream-view" style="display:none">
        <div class="stream-toolbar">
          <div class="stream-type-filters" id="stream-type-filters"></div>
        </div>
        <div class="content-area">
          <div class="list-panel">
            <div class="stream-container" id="stream-container"></div>
          </div>
          <div class="detail-panel" id="blackboard-stream-detail">
            <p class="placeholder">Select a card to view details</p>
          </div>
        </div>
      </div>
    </div>
```

**Step 2: Verify visually**

Run the dashboard (`npm run dev` or however the server starts) and confirm:
- Blackboard tab shows Table/Stream toggle
- Table view looks identical to before
- Stream view shows empty container when toggled (no JS yet)

**Step 3: Commit**

```bash
git add src/dashboard/public/index.html
git commit -m "feat(dashboard): add stream view toggle and container markup to blackboard tab"
```

---

### Task 2: JS — Wire the view toggle and add type color map

**Files:**
- Modify: `src/dashboard/public/app.js`

**Step 1: Add blackboard entry type color map**

Insert after the `ENTITY_COLORS` block (around line 2214). Add:

```javascript
/* ========== Blackboard Stream View ========== */

var ENTRY_TYPE_COLORS = {
  warning:    '#ffaa00',
  constraint: '#ff4466',
  need:       '#a78bfa',
  finding:    '#6366f1',
  decision:   '#00d4aa',
  question:   '#22d3ee',
  answer:     '#2dd4bf',
  status:     '#8892a8',
  offer:      '#10b981',
  artifact:   '#fbbf24'
};

var streamTypeFilter = null;
```

**Step 2: Wire the view toggle in `toggleView` function**

In the `toggleView` function (line ~1906), add a new `if` block after the `agents` block (after line 1932):

```javascript
  if (tab === 'blackboard') {
    document.getElementById('blackboard-table-view').style.display = viewName === 'table' ? 'block' : 'none';
    document.getElementById('blackboard-stream-view').style.display = viewName === 'stream' ? 'block' : 'none';
    if (viewName === 'stream' && typeof renderStream === 'function') renderStream();
  }
```

**Step 3: Verify the toggle works**

- Click Table/Stream buttons — containers should show/hide
- Console should not error (renderStream doesn't exist yet, but the `typeof` guard handles that)

**Step 4: Commit**

```bash
git add src/dashboard/public/app.js
git commit -m "feat(dashboard): wire blackboard stream view toggle and add entry type colors"
```

---

### Task 3: JS — Implement stream rendering (cards + time groups)

**Files:**
- Modify: `src/dashboard/public/app.js`

**Step 1: Add time group helper**

Add after the `ENTRY_TYPE_COLORS` / `streamTypeFilter` declarations:

```javascript
function getTimeGroupLabel(dateStr) {
  var d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'Unknown';
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  var entryDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (entryDate.getTime() === today.getTime()) return 'Today';
  if (entryDate.getTime() === yesterday.getTime()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatTimeOnly(dateStr) {
  var d = new Date(dateStr);
  if (isNaN(d.getTime())) return '--';
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
```

**Step 2: Add `renderStream` function**

```javascript
function renderStream() {
  var container = document.getElementById('stream-container');
  if (!container) return;
  clearElement(container);

  var entries = applyGlobalScope(state.blackboard.data || [], 'scope');

  // Apply type filter
  if (streamTypeFilter) {
    entries = entries.filter(function(e) {
      return !!streamTypeFilter[e.entry_type];
    });
  }

  // Sort newest first
  entries = entries.slice().sort(function(a, b) {
    return new Date(b.timestamp) - new Date(a.timestamp);
  });

  if (entries.length === 0) {
    container.appendChild(el('p', 'placeholder', 'No entries to display'));
    return;
  }

  // Build ID lookup for visible entries (for threading)
  var visibleIds = {};
  for (var i = 0; i < entries.length; i++) {
    visibleIds[entries[i].id] = true;
  }

  // Group by date
  var currentGroup = null;
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    var groupLabel = getTimeGroupLabel(entry.timestamp);

    // Insert time group header if new group
    if (groupLabel !== currentGroup) {
      currentGroup = groupLabel;
      var header = el('div', 'stream-time-group');
      var headerLine = el('span', 'stream-time-line');
      var headerLabel = el('span', 'stream-time-label', groupLabel);
      header.appendChild(headerLine);
      header.appendChild(headerLabel);
      header.appendChild(headerLine.cloneNode(true));
      container.appendChild(header);
    }

    // Create card
    var typeColor = ENTRY_TYPE_COLORS[entry.entry_type] || '#6b7280';
    var card = el('div', 'stream-card');
    card.setAttribute('data-id', entry.id || '');
    card.style.setProperty('--card-color', typeColor);

    if (state.blackboard.selectedId && entry.id === state.blackboard.selectedId) {
      card.classList.add('selected');
    }

    // Type badge
    var badge = el('div', 'stream-card-badge');
    var badgeDot = el('span', 'stream-badge-dot');
    badge.appendChild(badgeDot);
    badge.appendChild(document.createTextNode(' ' + (entry.entry_type || 'unknown')));
    card.appendChild(badge);

    // Summary
    var summary = el('div', 'stream-card-summary', truncate(entry.summary, 120));
    card.appendChild(summary);

    // Footer: scope + time
    var footer = el('div', 'stream-card-footer');
    if (entry.scope) {
      footer.appendChild(el('span', 'stream-card-scope', truncate(entry.scope, 40)));
    }
    footer.appendChild(el('span', 'stream-card-time', formatTimeOnly(entry.timestamp)));
    card.appendChild(footer);

    // Linked icon for off-screen relates_to
    if (entry.relates_to && entry.relates_to.length) {
      var hasOffscreen = false;
      for (var r = 0; r < entry.relates_to.length; r++) {
        if (!visibleIds[entry.relates_to[r]]) { hasOffscreen = true; break; }
      }
      if (hasOffscreen) {
        var linkIcon = el('span', 'stream-card-link', '\u{1F517}');
        linkIcon.title = 'Has related entries not visible in current filter';
        footer.appendChild(linkIcon);
      }
    }

    // Click handler
    (function(e) {
      card.addEventListener('click', function() {
        state.blackboard.selectedId = e.id;
        // Remove selected from all cards
        var allCards = container.querySelectorAll('.stream-card');
        for (var c = 0; c < allCards.length; c++) {
          allCards[c].classList.remove('selected');
        }
        card.classList.add('selected');
        renderBlackboardDetail(e);
        // Also update detail in stream detail panel
        var streamDetail = document.getElementById('blackboard-stream-detail');
        if (streamDetail) {
          // Copy detail content from blackboard-detail
          var sourceDetail = document.getElementById('blackboard-detail');
          if (sourceDetail) {
            clearElement(streamDetail);
            streamDetail.innerHTML = sourceDetail.innerHTML;
          }
        }
      });
    })(entry);

    container.appendChild(card);
  }

  // Render thread lines
  renderStreamThreads(container, entries, visibleIds);

  // Render type filter chips
  renderStreamTypeFilters();
}
```

**Step 3: Verify cards render**

Toggle to Stream view — should see cards grouped by date with type badges, summaries, scope + time footers. Clicking a card should populate the detail panel.

**Step 4: Commit**

```bash
git add src/dashboard/public/app.js
git commit -m "feat(dashboard): implement stream card rendering with time groups and detail panel"
```

---

### Task 4: JS — Implement thread lines for relates_to

**Files:**
- Modify: `src/dashboard/public/app.js`

**Step 1: Add `renderStreamThreads` function**

Add after `renderStream`:

```javascript
function renderStreamThreads(container, entries, visibleIds) {
  // Build map of entry ID -> DOM card element
  var cardElements = {};
  var cards = container.querySelectorAll('.stream-card');
  for (var i = 0; i < cards.length; i++) {
    var id = cards[i].getAttribute('data-id');
    if (id) cardElements[id] = cards[i];
  }

  // For each entry with relates_to, draw thread to visible targets
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (!entry.relates_to || !entry.relates_to.length) continue;

    var sourceCard = cardElements[entry.id];
    if (!sourceCard) continue;

    for (var r = 0; r < entry.relates_to.length; r++) {
      var targetId = entry.relates_to[r];
      var targetCard = cardElements[targetId];
      if (!targetCard) continue;

      // Determine which card comes first in DOM order
      var sourceRect = sourceCard.getBoundingClientRect();
      var targetRect = targetCard.getBoundingClientRect();
      var containerRect = container.getBoundingClientRect();

      // Create thread connector element
      var thread = el('div', 'stream-thread');
      var typeColor = ENTRY_TYPE_COLORS[entry.entry_type] || '#6b7280';
      thread.style.setProperty('--thread-color', typeColor);

      // Position: from bottom of source to top of target (or vice versa)
      var topCard, bottomCard;
      if (sourceRect.top < targetRect.top) {
        topCard = sourceCard;
        bottomCard = targetCard;
      } else {
        topCard = targetCard;
        bottomCard = sourceCard;
      }

      var topBottom = topCard.offsetTop + topCard.offsetHeight;
      var bottomTop = bottomCard.offsetTop;
      var height = bottomTop - topBottom;

      if (height > 0) {
        thread.style.top = topBottom + 'px';
        thread.style.height = height + 'px';
        container.appendChild(thread);
      }
    }
  }
}
```

**Step 2: Verify threads render**

If blackboard entries have `relates_to` links, thin colored lines should appear between the connected cards. If no entries have relates_to in your test data, temporarily add one to verify.

**Step 3: Commit**

```bash
git add src/dashboard/public/app.js
git commit -m "feat(dashboard): add relates_to thread lines between stream cards"
```

---

### Task 5: JS — Implement type filter chips

**Files:**
- Modify: `src/dashboard/public/app.js`

**Step 1: Add `renderStreamTypeFilters` function**

Add after `renderStreamThreads`:

```javascript
function renderStreamTypeFilters() {
  var container = document.getElementById('stream-type-filters');
  if (!container) return;
  clearElement(container);

  // Count entry types from scoped data
  var scoped = applyGlobalScope(state.blackboard.data || [], 'scope');
  var typeSet = {};
  for (var i = 0; i < scoped.length; i++) {
    var t = scoped[i].entry_type || 'unknown';
    typeSet[t] = (typeSet[t] || 0) + 1;
  }

  var types = Object.keys(typeSet).sort(function(a, b) {
    return typeSet[b] - typeSet[a];
  });

  if (types.length === 0) return;

  // "All" chip
  var allChip = document.createElement('button');
  allChip.className = 'stream-type-chip' + (streamTypeFilter === null ? ' active' : '');
  allChip.style.setProperty('--type-color', 'var(--accent)');
  var allDot = document.createElement('span');
  allDot.className = 'chip-dot';
  allChip.appendChild(allDot);
  var allText = document.createElement('span');
  allText.textContent = 'All';
  allChip.appendChild(allText);
  allChip.addEventListener('click', function() {
    streamTypeFilter = null;
    renderStream();
  });
  container.appendChild(allChip);

  // Per-type chips
  for (var j = 0; j < types.length; j++) {
    (function(type) {
      var color = ENTRY_TYPE_COLORS[type] || '#6b7280';
      var isActive = streamTypeFilter === null || !!streamTypeFilter[type];
      var chip = document.createElement('button');
      chip.className = 'stream-type-chip' + (streamTypeFilter !== null && isActive ? ' active' : '');
      chip.style.setProperty('--type-color', color);
      var dot = document.createElement('span');
      dot.className = 'chip-dot';
      chip.appendChild(dot);
      var text = document.createElement('span');
      text.textContent = type + ' (' + typeSet[type] + ')';
      chip.appendChild(text);
      chip.addEventListener('click', function() {
        if (streamTypeFilter === null) {
          streamTypeFilter = {};
          streamTypeFilter[type] = true;
        } else if (streamTypeFilter[type]) {
          delete streamTypeFilter[type];
          if (Object.keys(streamTypeFilter).length === 0) streamTypeFilter = null;
        } else {
          streamTypeFilter[type] = true;
        }
        renderStream();
      });
      container.appendChild(chip);
    })(types[j]);
  }
}
```

**Step 2: Verify filter chips work**

- Chips should appear above the stream with colored dots and counts
- Clicking a type should solo it; clicking again returns to All
- Clicking multiple types should multi-select
- Thread lines should only appear between visible (non-filtered) entries

**Step 3: Commit**

```bash
git add src/dashboard/public/app.js
git commit -m "feat(dashboard): add type filter chips to blackboard stream view"
```

---

### Task 6: JS — Hook stream into data refresh and detail rendering

**Files:**
- Modify: `src/dashboard/public/app.js`

**Step 1: Update renderBlackboardDetail to write to the stream detail panel too**

Find the `renderBlackboardDetail` function (line ~670). After the existing function, the stream view needs its detail panel updated. Modify the click handler in `renderStream` (already done in Task 3) to render detail into `blackboard-stream-detail` directly instead of copying innerHTML.

Actually, simpler approach: modify `renderBlackboardDetail` to accept an optional panel ID parameter:

Find `function renderBlackboardDetail(entry) {` and replace it with:

```javascript
function renderBlackboardDetail(entry, panelId) {
  var panel = document.getElementById(panelId || 'blackboard-detail');
```

Then in the stream card click handler (Task 3), change the call to:

```javascript
renderBlackboardDetail(e, 'blackboard-stream-detail');
```

And remove the innerHTML copy block.

**Step 2: Ensure stream refreshes on data fetch**

In `fetchBlackboard` success handler (line ~155-158), after `renderBlackboard()`, add:

```javascript
      // Refresh stream if visible
      var streamView = document.getElementById('blackboard-stream-view');
      if (streamView && streamView.style.display !== 'none') {
        renderStream();
      }
```

**Step 3: Reset stream filter on global scope change**

Find the search/scope handler that resets page states (search for `state.blackboard.page = 1`). Add nearby:

```javascript
      streamTypeFilter = null;
```

**Step 4: Verify**

- Data refresh (polling) should update the stream if it's visible
- Global scope filter should apply to stream entries
- Clicking a card in stream view should populate the stream detail panel correctly

**Step 5: Commit**

```bash
git add src/dashboard/public/app.js
git commit -m "feat(dashboard): hook stream into data refresh and detail rendering"
```

---

### Task 7: CSS — Style the stream cards, time groups, and toolbar

**Files:**
- Modify: `src/dashboard/public/style.css`

**Step 1: Add stream styles**

Add after the graph visualization styles section (after the `@keyframes graphSlideIn` block, around line 1210). Insert a new section:

```css
/* ---------- Blackboard Stream View ---------- */

.stream-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  padding: var(--space-sm) 0;
  margin-bottom: var(--space-sm);
}

.stream-type-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.stream-type-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  font-size: 0.6875rem;
  font-family: var(--font-mono);
  font-weight: 500;
  letter-spacing: 0.01em;
  border: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
  user-select: none;
}

.stream-type-chip:hover {
  border-color: var(--border-strong);
  background: var(--bg-hover);
}

.stream-type-chip.active {
  border-color: var(--type-color, var(--accent));
  background: color-mix(in srgb, var(--type-color, var(--accent)) 12%, transparent);
  color: var(--type-color, var(--accent));
}

.stream-type-chip .chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--type-color, var(--text-tertiary));
  flex-shrink: 0;
}

.stream-type-chip.active .chip-dot {
  box-shadow: 0 0 6px var(--type-color, var(--accent));
}

/* Stream container */
.stream-container {
  position: relative;
  padding: var(--space-md);
  max-height: 700px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--border-strong) transparent;
}

/* Time group headers */
.stream-time-group {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  margin: var(--space-lg) 0 var(--space-md);
}

.stream-time-group:first-child {
  margin-top: 0;
}

.stream-time-line {
  flex: 1;
  height: 1px;
  background: var(--border);
}

.stream-time-label {
  font-family: var(--font-display);
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  white-space: nowrap;
}

/* Stream cards */
.stream-card {
  position: relative;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--card-color, var(--border-strong));
  border-radius: var(--radius-md);
  padding: var(--space-md) var(--space-lg);
  margin-bottom: var(--space-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.stream-card:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
  border-left-color: var(--card-color, var(--border-strong));
}

.stream-card.selected {
  background: var(--accent-subtle);
  border-color: var(--card-color, var(--accent));
  border-left-color: var(--card-color, var(--accent));
  box-shadow: 0 0 12px color-mix(in srgb, var(--card-color, var(--accent)) 20%, transparent);
}

/* Card badge */
.stream-card-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-size: 0.625rem;
  font-family: var(--font-mono);
  font-weight: 600;
  letter-spacing: 0.02em;
  background: color-mix(in srgb, var(--card-color, var(--accent)) 12%, transparent);
  color: var(--card-color, var(--accent));
  margin-bottom: var(--space-sm);
}

.stream-badge-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--card-color, var(--accent));
}

/* Card summary */
.stream-card-summary {
  font-family: var(--font-body);
  font-size: 0.8125rem;
  line-height: 1.5;
  color: var(--text-primary);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  margin-bottom: var(--space-sm);
}

/* Card footer */
.stream-card-footer {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  font-size: 0.6875rem;
  color: var(--text-tertiary);
}

.stream-card-scope {
  font-family: var(--font-mono);
  font-size: 0.625rem;
}

.stream-card-time {
  margin-left: auto;
}

.stream-card-link {
  font-size: 0.625rem;
  cursor: help;
  opacity: 0.6;
}

/* Thread lines */
.stream-thread {
  position: absolute;
  left: 18px;
  width: 2px;
  background: color-mix(in srgb, var(--thread-color, var(--border-strong)) 40%, transparent);
  border-radius: 1px;
  pointer-events: none;
  z-index: 0;
}

/* Entrance animation */
#blackboard-stream-view .content-area {
  animation: streamSlideIn 0.35s ease-out;
}

@keyframes streamSlideIn {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
```

**Step 2: Verify visual appearance**

- Cards should have colored left borders matching their type
- Type badges should have subtle colored backgrounds
- Time group headers should show centered labels with lines
- Thread lines should be visible (subtle) between related cards
- Hover and selected states should work
- Both dark and light themes should look correct

**Step 3: Commit**

```bash
git add src/dashboard/public/style.css
git commit -m "feat(dashboard): style blackboard stream cards, time groups, threads, and filter chips"
```

---

### Task 8: Visual polish and integration testing

**Files:**
- Possibly tweak: `src/dashboard/public/app.js`, `src/dashboard/public/style.css`

**Step 1: Test the complete flow**

Verify all of these work:
1. Table/Stream toggle switches views cleanly
2. Stream cards render with correct type colors for all 10 entry types
3. Time groups show Today/Yesterday/date labels correctly
4. Clicking a card shows detail in the right panel
5. Type filter chips appear with correct counts
6. Filtering hides/shows cards and updates thread visibility
7. Thread lines connect `relates_to` entries correctly
8. Global scope filter applies to stream
9. Data refresh (polling) updates the stream
10. Both dark and light themes render correctly
11. The link icon appears on cards with off-screen relates_to targets

**Step 2: Fix any visual issues**

Common things to tune:
- Thread line positioning (if container has padding that offsets `offsetTop`)
- Card spacing for visual rhythm
- Stream container scroll height
- Filter chip wrapping on narrow viewports

**Step 3: Commit any fixes**

```bash
git add src/dashboard/public/
git commit -m "fix(dashboard): polish stream view visual details"
```

---

## File Change Summary

| File | Changes |
|------|---------|
| `src/dashboard/public/index.html` | Add view toggle, wrap table in view container, add stream container |
| `src/dashboard/public/app.js` | Add ENTRY_TYPE_COLORS, streamTypeFilter, renderStream, renderStreamThreads, renderStreamTypeFilters, wire toggleView, hook data refresh |
| `src/dashboard/public/style.css` | Add .stream-* classes for toolbar, chips, cards, time groups, threads, animations |

No new files. No new dependencies. No backend changes.
