# Twining MCP Demo — Recording Guide

## Overview

3-3.5 minute demo showing the "2-Agent Handoff" story. Agent Alpha explores and decides, the session ends, Agent Beta assembles full context instantly.

## Screen Layout

- **Left 60%**: Terminal (running `./run-live-demo.sh`)
- **Right 40%**: Chrome at `http://127.0.0.1:24282/?poll=1000&demo=1`

### Terminal Setup
- Font: 14pt monospace (SF Mono, JetBrains Mono, or similar)
- Theme: dark background
- Window: no tabs, clean title bar
- Increase line spacing slightly for readability

### Dashboard Setup
- Dark theme (default)
- Start on **Stats** tab (all counters at zero)
- Zoom browser to 110-125% so text is readable in recording

## Pre-Recording Checklist

1. `npm run build` in the twining-mcp root
2. `./reset-demo.sh` to clean state
3. Open dashboard in Chrome: `http://127.0.0.1:24282/?poll=1000&demo=1`
4. Verify Stats tab shows all zeros
5. Start screen recording (OBS, ScreenFlow, or QuickTime)
6. Run `./run-live-demo.sh`

## Tab Switching Choreography

| Act | When | Dashboard Tab |
|-----|------|---------------|
| Cold open | Script starts, banner displayed | **Stats** (all zeros) |
| Act 1 | Agent Alpha posts findings | Switch to **Blackboard** — watch entries stream in |
| Act 2a | Agent Alpha makes JWT decision | Switch to **Decisions** — see timeline entry |
| Act 2b | Agent Alpha maps entities | Switch to **Graph** — see nodes + edges appear |
| Session break | "SESSION ENDS" banner | Switch to **Stats** — show accumulated counters |
| Act 3 | Agent Beta registers | Switch to **Agents** — two agents visible |
| Act 3 | Agent Beta calls assemble | Switch to **Blackboard** or stay on Agents |
| Act 4a | Agent Beta makes decision | Switch to **Decisions** — two decisions on timeline |
| Act 4b | Agent Beta runs verify | Switch to **Insights** — verification results |
| Closing | "Demo Complete" banner | **Stats** — final accumulated state |

## Key Moments to Highlight

1. **Blackboard streaming** (Act 1): Entries appearing live as the agent posts them
2. **Decision with alternatives** (Act 2): The JWT decision shows rejected options
3. **Graph visualization** (Act 2): Three entities connected by relation edges
4. **Session boundary** (between Act 2-3): Dashboard persists even though agent is gone
5. **The `twining_assemble` moment** (Act 3): Agent Beta gets EVERYTHING in one call
6. **Two agents on Agents tab** (Act 3): Both registered, different capabilities
7. **Compatible decisions** (Act 4): Password reset builds on JWT, visible on timeline
8. **Verification** (Act 4): Shows project health check

## Post-Production Notes

### Text Overlays
- **0:00**: "Your AI agents forget everything between sessions."
- **Session boundary**: "Session ends. Context window gone."
- **After Act 3**: "One call. Full context."
- **Closing**: "Two agents. One persistent memory. Zero context lost." + `npm install -g twining-mcp`

### Timing Targets
- Cold open: 0:00-0:15
- Act 1 (Discovery): 0:15-1:00
- Act 2 (Decision + Graph): 1:00-1:45
- Session boundary: 1:45-1:55
- Act 3 (Assembly): 1:55-2:40
- Act 4 (Continue + Verify): 2:40-3:10
- Closing: 3:10-3:25

### Editing Tips
- Speed up `claude -p` waiting/processing with 2-4x timelapse
- Keep tool output visible long enough to read (2-3 seconds)
- Add subtle zoom on dashboard when switching tabs
- Background music: low ambient, no vocals

### Recording Settings
- Resolution: 1920x1080 minimum (2560x1440 preferred)
- Frame rate: 30fps
- Format: MP4 with H.264
- Audio: system audio only (no mic unless doing voiceover live)

## Automated Recording (Playwright)

The Playwright orchestrator automates the entire demo — browser control, tab switching, overlays, and `claude -p` execution — in a single command. No manual tab switching needed.

### Quick Start

```bash
# One-time setup
npm run build
npm install                          # Installs @playwright/test
npx playwright install chromium      # Downloads Chromium browser

# Record
npm run demo:record

# With manual pause between acts (for timing control)
npm run demo:record:pause

# Convert to MP4 (optional)
ffmpeg -i examples/demo-automation/recordings/*.webm -crf 18 demo.mp4
```

### What It Does

1. Runs `reset-demo.sh` to clean state
2. Starts its own dashboard server (auto-detects port)
3. Launches Chromium at 1920x1080 with video recording
4. For each act:
   - Injects a task overlay banner
   - Spawns `claude -p` with the act's prompt
   - Switches tabs when dashboard stats change (data-driven, not time-based)
   - Removes the overlay after completion
5. Shows session boundary and closing overlays
6. Saves video to `examples/demo-automation/recordings/`

### Files

| File | Purpose |
|------|---------|
| `playwright/record-demo.ts` | Main orchestrator |
| `playwright/overlays.ts` | DOM overlay injection (task banner, session boundary, closing) |
| `playwright/acts.ts` | Act definitions (labels, prompts, tab choreography) |
| `playwright/claude-runner.ts` | Dashboard server + `claude -p` process management |

### Environment Variables

| Variable | Effect |
|----------|--------|
| `DEMO_PAUSE=1` | Insert stdin waits before each act |

## Troubleshooting

- **Dashboard not updating**: Check `?poll=1000` URL parameter
- **claude -p fails**: Ensure `npm run build` was run, check `.mcp.json` paths
- **No entries appearing**: Run `./reset-demo.sh` and try again
- **Dashboard shows stale data**: Hard refresh browser (Cmd+Shift+R)
