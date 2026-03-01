#!/bin/bash
# Reset demo project to clean state for a fresh recording
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEMO_DIR="$SCRIPT_DIR/demo-project"

echo "Resetting demo state in $DEMO_DIR..."

# Remove all twining state
rm -rf "$DEMO_DIR/.twining"

# Recreate minimal directory structure with config
mkdir -p "$DEMO_DIR/.twining/decisions"
mkdir -p "$DEMO_DIR/.twining/graph"

# Write config
cat > "$DEMO_DIR/.twining/config.json" << 'EOF'
{
  "version": "1.0",
  "embedding": {
    "enabled": true,
    "model": "@xenova/all-MiniLM-L6-v2"
  },
  "context_assembly": {
    "default_max_tokens": 4000
  },
  "dashboard": {
    "port": 24282,
    "auto_open": false
  }
}
EOF

# Create empty data files
touch "$DEMO_DIR/.twining/blackboard.jsonl"
touch "$DEMO_DIR/.twining/agents.jsonl"
touch "$DEMO_DIR/.twining/graph/entities.jsonl"
touch "$DEMO_DIR/.twining/graph/relations.jsonl"

echo "Demo state reset complete."
echo "  Config:     $DEMO_DIR/.twining/config.json"
echo "  Blackboard: empty"
echo "  Decisions:  empty"
echo "  Graph:      empty"
echo "  Agents:     empty"
