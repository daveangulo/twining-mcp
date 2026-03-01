#!/bin/bash
# Start a persistent dashboard server for the demo project.
# Run this BEFORE run-live-demo.sh so the dashboard is already up.
# The server reads .twining/ files from disk on each poll, so it
# picks up changes made by the claude -p processes automatically.
#
# Usage:
#   ./start-dashboard.sh
#   # Open http://127.0.0.1:24282/?poll=1000&demo=1
#   # Then in another terminal: ./run-live-demo.sh
#   # Ctrl-C here when done.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEMO_DIR="$SCRIPT_DIR/demo-project"
DIST="$SCRIPT_DIR/../../dist/index.js"

if [ ! -f "$DIST" ]; then
  echo "ERROR: dist/index.js not found. Run 'npm run build' first."
  exit 1
fi

echo "Starting dashboard server for: $DEMO_DIR"
echo "Dashboard: http://127.0.0.1:24282/?poll=1000&demo=1"
echo "Press Ctrl-C to stop."
echo ""

# Run the MCP server with dashboard enabled but no auto-open.
# Feed it an open stdin so it stays alive. It will start the HTTP
# dashboard as a side effect and then wait for MCP messages.
TWINING_DASHBOARD_NO_OPEN=1 node "$DIST" --project "$DEMO_DIR" < /dev/null &
SERVER_PID=$!

# Wait a moment for the server to bind
sleep 1

# Open the dashboard
open "http://127.0.0.1:24282/?poll=1000&demo=1" 2>/dev/null || true

echo "Dashboard server running (PID $SERVER_PID)"
echo ""

# Wait for Ctrl-C, then clean up
trap "kill $SERVER_PID 2>/dev/null; echo ''; echo 'Dashboard stopped.'; exit 0" INT TERM
wait $SERVER_PID 2>/dev/null || true
