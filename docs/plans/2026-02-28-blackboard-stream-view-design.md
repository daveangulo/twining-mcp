# Blackboard Stream View — Design

## Problem

The Blackboard tab is a plain data table (Timestamp, Type, Scope, Summary) with a detail panel. Unlike the Decisions tab (which has a Timeline view) and the Graph tab (which has a Visual view), the Blackboard has no alternate visualization to bring its data to life.

Blackboard data is fundamentally a multi-agent conversation — needs, questions, answers, warnings, findings — and the `relates_to` links between entries form implicit threads. None of this is visible in the table view.

## Solution: Stream View

A vertical activity stream/feed of styled cards, organized chronologically with time group headers and thread lines connecting related entries.

## Layout

The Blackboard tab gets a **Table / Stream** toggle matching the existing pattern from Decisions and Graph.

```
┌─────────────────────────────────────────────┬──────────────────────┐
│  [type filter chips]                        │                      │
│                                             │                      │
│  ── Today ──────────────────────────────    │   Detail Panel       │
│                                             │   (reuses existing   │
│  ┌─ warning ─────────────────────────┐      │   renderBlackboard   │
│  │ Potential conflict: new decision   │      │   Detail function)   │
│  │ src/dashboard/  · 4:21 AM         │      │                      │
│  └───────────────────────────────────┘      │                      │
│    │                                        │                      │
│    └─ relates to ──┐                        │                      │
│                    ▼                        │                      │
│  ┌─ decision ────────────────────────┐      │                      │
│  │ Redesign dashboard UI with dark-  │      │                      │
│  │ first professional theme...       │      │                      │
│  │ src/dashboard/  · 4:21 AM         │      │                      │
│  └───────────────────────────────────┘      │                      │
│                                             │                      │
│  ── Feb 27 ─────────────────────────────    │                      │
│  ...                                        │                      │
└─────────────────────────────────────────────┴──────────────────────┘
```

- Left panel: scrollable card stream
- Right panel: existing detail panel (reuses `renderBlackboardDetail`)
- Time group headers divide cards into clusters (Today, Yesterday, or date labels)

## Card Design

```
┌─ ● warning ──────────────────────────────────────┐
│                                                   │
│  Potential conflict: new decision may conflict     │
│  with 1 existing decision(s)                      │
│                                                   │
│  src/dashboard/public/app.js  ·  4:21 AM          │
│                                                   │
└───────────────────────────────────────────────────┘
```

- Left border accent (3px) in the type color
- Type badge: small pill with dot + label, top-left, colored bg at ~12% opacity (same `color-mix` pattern as graph type chips)
- Summary: `--font-body`, `--text-primary`, 2-line clamp
- Footer: scope in `--font-mono` (truncated) + relative timestamp, `--text-tertiary`
- Hover: `--bg-hover` background
- Selected: brighter border + `--accent-subtle` background

### Type Color Mapping

| Type       | Color                        | Token                  |
|------------|------------------------------|------------------------|
| warning    | #ffaa00                      | `var(--warning)`       |
| constraint | #ff4466                      | `var(--error)`         |
| need       | #a78bfa                      | `var(--purple)`        |
| finding    | #6366f1                      | `var(--info)`          |
| decision   | #00d4aa                      | `var(--accent)`        |
| question   | #22d3ee                      | `var(--cyan)`          |
| answer     | #2dd4bf                      | `var(--teal)`          |
| status     | #8892a8                      | `var(--text-secondary)`|
| offer      | #10b981                      | literal                |
| artifact   | #fbbf24                      | `var(--amber)`         |

## Threading (relates_to)

When entry A has `relates_to: ["B"]` and both are visible in the stream, a thread connector appears:

- Thin vertical line (2px, `--border-strong`) from source card bottom to target card top
- Left-margin indent creates a "thread rail" effect
- If cards are non-adjacent, the line passes alongside intermediate cards as a gutter rail
- CSS-only: absolutely-positioned elements on wrapper divs, no canvas/SVG
- Thread lines inherit a muted version of the source card's type color

Constraints:
- Only draw threads when both entries are visible (not filtered out)
- Off-screen related entries show a small "linked" icon on the card footer (clickable, navigates to entry in table view)
- No crossing-line resolution — at this data scale (dozens of entries), overlaps are fine
- Multi-hop chains (A→B→C) produce continuous thread rails

## Filter Chips

Matching the graph type filter pattern:

```
● All  ● warning (5)  ● finding (12)  ● decision (8)  ● need (3)  ...
```

- Same toggle logic as graph type filters (solo, multi-select, return to All)
- Only show types present in current data
- Count in parentheses
- Dot color matches type color
- New CSS class `stream-type-chip`, reusing the chip pattern from `.graph-type-chip`

## Sorting & Pagination

- Default: newest first (reverse chronological)
- No sort controls — stream is inherently time-ordered (table view handles arbitrary sorting)
- No pagination — renders all entries with scroll. Archival keeps active sets manageable.
- Global scope filter from header bar applies automatically

## Technical Notes

- All vanilla HTML/JS/CSS (no frameworks) — matches existing dashboard
- Reuses existing helpers: `el()`, `clearElement()`, `formatTimestamp()`, `truncate()`, `applyGlobalScope()`
- Reuses existing `renderBlackboardDetail()` for the detail panel
- New functions: `initStream()`, `renderStream()`, `renderStreamCards()`, `renderStreamThreads()`, `renderStreamTypeFilters()`
- New state: `streamTypeFilter` (null = all, object = active set)
- Files modified: `index.html` (markup), `app.js` (logic), `style.css` (styles)
