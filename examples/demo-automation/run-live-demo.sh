#!/bin/bash
# Twining MCP Live Demo — 2-Agent Handoff Narrative
#
# This script drives a live demo using `claude -p` to execute scripted
# prompts against a demo project. Each prompt explicitly tells the agent
# which Twining tools to call and with what parameters.
#
# Prerequisites:
#   - `claude` CLI installed and authenticated
#   - `npm run build` completed (dist/index.js must exist)
#   - Dashboard open at http://127.0.0.1:24282/?poll=1000&demo=1
#
# Usage:
#   ./run-live-demo.sh
#
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEMO_DIR="$SCRIPT_DIR/demo-project"
MCP_CONFIG="$DEMO_DIR/.mcp.json"

# Verify dist/index.js exists
if [ ! -f "$SCRIPT_DIR/../../dist/index.js" ]; then
  echo "ERROR: dist/index.js not found. Run 'npm run build' first."
  exit 1
fi

# Reset state
echo "Resetting demo state..."
"$SCRIPT_DIR/reset-demo.sh"
echo ""

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Twining MCP Demo — The 2-Agent Handoff                    ║"
echo "╠══════════════════════════════════════════════════════════════╣"
echo "║  Dashboard: http://127.0.0.1:24282/?poll=1000&demo=1              ║"
echo "║  Start on the Stats tab (all zeros)                        ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Press Enter when ready to start recording..."
read -r

###############################################################################
# ACT 1: Agent Alpha — Discovery
###############################################################################
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ACT 1: Agent Alpha — Discovery"
echo "  Dashboard: watch the Blackboard tab"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

claude -p "$(cat <<'PROMPT'
You are Agent Alpha, a security-focused architect reviewing a web application.

Execute these Twining tool calls IN ORDER. After each call, briefly state what you did in 1 sentence. Do not do anything else.

1. Call twining_register with:
   - agent_id: "agent-alpha"
   - capabilities: ["typescript", "security", "architecture"]
   - role: "architect"

2. Call twining_post with:
   - scope: "src/routes/"
   - entry_type: "finding"
   - content: "Web app has no authentication — all API routes in src/routes/api.ts are completely unprotected. Any user can list users, create posts, and delete content without credentials."
   - confidence: "high"

3. Call twining_post with:
   - scope: "src/"
   - entry_type: "warning"
   - content: "No rate limiting on any API endpoint. The server is vulnerable to brute-force attacks and denial-of-service. This must be addressed before going to production."
   - confidence: "high"

4. Call twining_post with:
   - scope: "src/db/"
   - entry_type: "need"
   - content: "Database schema needs a users table for authentication. Currently posts and comments reference author_id but there is no users table to enforce foreign key constraints."
   - confidence: "high"

After completing all 4 calls, output: "Agent Alpha has completed initial discovery."
PROMPT
)" --mcp-config "$MCP_CONFIG" --strict-mcp-config --allowedTools "mcp__twining__*" --dangerously-skip-permissions 2>/dev/null

echo ""
echo "  [Act 1 complete — switch dashboard to Blackboard tab]"
echo ""
sleep 3

###############################################################################
# ACT 2: Agent Alpha — Architecture Decision + Knowledge Graph
###############################################################################
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ACT 2: Agent Alpha — Architecture Decision"
echo "  Dashboard: watch the Decisions tab, then Graph tab"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

claude -p "$(cat <<'PROMPT'
You are Agent Alpha continuing your architecture review.

Execute these Twining tool calls IN ORDER. After each call, briefly state what you did in 1 sentence. Do not do anything else.

1. Call twining_assemble with:
   - task: "Design authentication architecture for the web application"
   - scope: "src/auth/"
   - agent_id: "agent-alpha"

2. Call twining_decide with:
   - domain: "architecture"
   - scope: "src/auth/"
   - summary: "Use JWT with HttpOnly cookies for stateless session management"
   - rationale: "JWT enables stateless auth that scales horizontally without shared session storage. HttpOnly cookies prevent XSS token theft. This approach fits the existing Express middleware pattern and avoids introducing Redis as a new dependency."
   - alternatives: [{"option": "Server-side sessions with Redis", "reason_rejected": "Adds Redis as infrastructure dependency, increases operational complexity for a small team"}, {"option": "JWT stored in localStorage", "reason_rejected": "Vulnerable to XSS attacks — tokens accessible via JavaScript"}, {"option": "OAuth2 only (no local auth)", "reason_rejected": "Requires third-party provider dependency, not all users have OAuth accounts"}]
   - confidence: "high"
   - affected_files: ["src/auth/middleware.ts", "src/auth/router.ts", "src/auth/tokens.ts"]
   - tags: ["security", "authentication", "jwt"]
   - agent_id: "agent-alpha"

3. Call twining_add_entity with:
   - name: "JwtMiddleware"
   - entity_type: "class"
   - scope: "src/auth/middleware.ts"
   - metadata: {"description": "Express middleware that validates JWT tokens from HttpOnly cookies", "layer": "middleware"}

4. Call twining_add_entity with:
   - name: "AuthRouter"
   - entity_type: "module"
   - scope: "src/auth/router.ts"
   - metadata: {"description": "Auth routes: login, logout, refresh token", "layer": "routes"}

5. Call twining_add_entity with:
   - name: "verifyToken"
   - entity_type: "function"
   - scope: "src/auth/tokens.ts"
   - metadata: {"description": "Validates JWT signature and expiry, returns decoded payload", "layer": "util"}

6. Call twining_add_relation with:
   - source: "AuthRouter"
   - target: "JwtMiddleware"
   - relation_type: "imports"
   - metadata: {"description": "AuthRouter uses JwtMiddleware to protect authenticated routes"}

7. Call twining_add_relation with:
   - source: "JwtMiddleware"
   - target: "verifyToken"
   - relation_type: "calls"
   - metadata: {"description": "JwtMiddleware calls verifyToken to validate incoming request tokens"}

8. Call twining_handoff with:
   - source_agent: "agent-alpha"
   - target_agent: "agent-beta"
   - scope: "src/auth/"
   - summary: "Architecture review complete. JWT auth decision recorded, knowledge graph mapped. Ready for implementation of auth middleware, password reset, and rate limiting."
   - results: [{"description": "Identified missing authentication on all API routes", "status": "completed"}, {"description": "Recorded JWT with HttpOnly cookies architecture decision", "status": "completed"}, {"description": "Mapped auth entities and relations in knowledge graph", "status": "completed"}, {"description": "Rate limiting and user DB schema still needed", "status": "partial"}]

After completing all 8 calls, output: "Agent Alpha has recorded the architecture decision, mapped the knowledge graph, and created a handoff."
PROMPT
)" --mcp-config "$MCP_CONFIG" --strict-mcp-config --allowedTools "mcp__twining__*" --dangerously-skip-permissions 2>/dev/null

echo ""
echo "  [Act 2 complete — check Decisions tab, then Graph tab]"
echo ""
sleep 3

###############################################################################
# SESSION BOUNDARY
###############################################################################
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                                                            ║"
echo "║   SESSION ENDS. Agent Alpha's context window is gone.      ║"
echo "║                                                            ║"
echo "║   The dashboard persists. The state persists.              ║"
echo "║   But the agent remembers nothing.                         ║"
echo "║                                                            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  [Dashboard: switch to Stats tab to show accumulated data]"
echo ""
echo "Press Enter to continue with Agent Beta..."
read -r

###############################################################################
# ACT 3: Agent Beta — Fresh Start with Context Assembly
###############################################################################
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ACT 3: Agent Beta — Fresh Start"
echo "  Dashboard: watch the Agents tab (2 agents!), then Blackboard"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

claude -p "$(cat <<'PROMPT'
You are Agent Beta, arriving fresh with ZERO context about this project.

Execute these Twining tool calls IN ORDER. After each call, describe what you learned in 2-3 sentences. This is important — show the audience what context assembly returns.

1. Call twining_register with:
   - agent_id: "agent-beta"
   - capabilities: ["typescript", "testing", "implementation"]
   - role: "implementer"

2. Call twining_assemble with:
   - task: "Implement password reset flow for the authentication system"
   - scope: "src/auth/"
   - agent_id: "agent-beta"

   After this call, summarize: what decisions were found, what warnings exist, what entities are in the graph, and what handoff was found. Emphasize that you got all of this WITHOUT reading any code or asking anyone.

3. The assemble response includes a recent_handoffs array. Take the handoff ID from it and call twining_acknowledge with:
   - handoff_id: (the ID from the handoff in the assemble response)
   - agent_id: "agent-beta"

4. Call twining_why with:
   - scope: "src/auth/"

   After this call, explain the decision chain you discovered — what was decided and why.

After completing all 4 calls, output: "Agent Beta has full context from Agent Alpha's work — without any re-exploration."
PROMPT
)" --mcp-config "$MCP_CONFIG" --strict-mcp-config --allowedTools "mcp__twining__*" --dangerously-skip-permissions 2>/dev/null

echo ""
echo "  [Act 3 complete — the 'aha moment': full context from assembly]"
echo ""
sleep 3

###############################################################################
# ACT 4: Agent Beta — Coordinated Decision + Verification
###############################################################################
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ACT 4: Agent Beta — Coordinated Decision & Verification"
echo "  Dashboard: watch Decisions tab (2 decisions), then Insights"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

claude -p "$(cat <<'PROMPT'
You are Agent Beta continuing implementation work.

Execute these Twining tool calls IN ORDER. After each call, briefly state what you did in 1-2 sentences. Do not do anything else.

1. Call twining_assemble with:
   - task: "Implement password reset flow building on existing JWT auth"
   - scope: "src/auth/reset/"
   - agent_id: "agent-beta"

2. Call twining_decide with:
   - domain: "implementation"
   - scope: "src/auth/reset/"
   - summary: "Password reset via time-limited signed token sent by email"
   - rationale: "Reuses the existing JWT infrastructure from the authentication decision. A short-lived signed token (15 min expiry) is sent via email. The token encodes the user ID and a reset nonce. This avoids storing reset state in the database and stays consistent with the stateless JWT architecture."
   - alternatives: [{"option": "Database-stored reset codes", "reason_rejected": "Requires new database table and cleanup job, contradicts stateless architecture"}, {"option": "SMS-based reset with OTP", "reason_rejected": "Adds SMS provider dependency and cost, phone numbers not yet collected"}]
   - confidence: "high"
   - affected_files: ["src/auth/reset/handler.ts", "src/auth/reset/email.ts"]
   - tags: ["security", "password-reset", "jwt"]
   - agent_id: "agent-beta"

3. Call twining_verify with:
   - scope: "src/auth/"

   After this call, summarize the verification results — what checks passed, what issues remain.

After completing all 3 calls, output: "Agent Beta has made a compatible decision and verified the project state."
PROMPT
)" --mcp-config "$MCP_CONFIG" --strict-mcp-config --allowedTools "mcp__twining__*" --dangerously-skip-permissions 2>/dev/null

echo ""
echo "  [Act 4 complete — check Decisions timeline and Insights tab]"
echo ""

###############################################################################
# CLOSING
###############################################################################
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║                                                            ║"
echo "║   Demo Complete!                                           ║"
echo "║                                                            ║"
echo "║   Two agents. One persistent memory.                       ║"
echo "║   Zero context lost.                                       ║"
echo "║                                                            ║"
echo "║   npm install -g twining-mcp                               ║"
echo "║                                                            ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "  Dashboard final state: http://127.0.0.1:24282/?poll=1000&demo=1"
echo "  Check all tabs: Stats, Blackboard, Decisions, Graph, Agents"
echo ""
