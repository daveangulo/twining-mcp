# Twining MCP Demo Video Script

## Overview
**Duration**: ~10 minutes
**Format**: Screen recording with narration
**Scenario**: Multi-agent team adds authentication to a web app, coordinating through Twining

## Demo Narrative

### Act 1: The Problem (1 min)
**What we're showing**: Why agent coordination is hard

- Open Claude Code with a simple web app project
- Show multiple conversation threads or context windows
- Narration: "When multiple AI agents work on the same codebase, they face coordination challenges: duplicated work, conflicting decisions, lost context across conversations, no shared memory."
- Introduce Twining: "Twining is an MCP server that gives AI agents persistent shared memory, structured decision tracking, and coordination primitives."

### Act 2: Blackboard - Shared Communication (2 min)
**What we're showing**: `twining_post`, `twining_read`, `twining_query`, entry types

**Scenario**: Agent A starts authentication work

1. **Agent A posts a finding**
   ```
   twining_post(entry_type="finding",
     summary="App has no authentication system",
     detail="Reviewing codebase — routes are unprotected, no auth middleware, no user model",
     scope="src/")
   ```

2. **Agent A posts a need**
   ```
   twining_post(entry_type="need",
     summary="Need database schema design for user authentication",
     scope="src/db/",
     tags=["database", "security"])
   ```

3. **Agent A posts a warning**
   ```
   twining_post(entry_type="warning",
     summary="Password reset endpoint vulnerable to timing attacks",
     detail="Current implementation uses string comparison for token validation",
     scope="src/routes/auth.ts")
   ```

4. **Show dashboard** - Blackboard tab with entries filtered by type
5. **Agent B queries blackboard**
   ```
   twining_query(query="authentication security concerns")
   # Returns the warning and need entries
   ```

**Key Points**:
- 10 entry types (finding, warning, need, question, answer, status, offer, artifact, constraint, decision)
- Semantic search via embeddings
- Persistent across conversations
- Shown in real-time on dashboard

### Act 3: Decisions - Structured Rationale (2 min)
**What we're showing**: `twining_decide`, `twining_why`, `twining_trace`, conflict detection

**Scenario**: Agent A makes architectural decisions

1. **Record a decision**
   ```
   twining_decide(
     domain="architecture",
     scope="src/auth/",
     summary="Use JWT tokens with HttpOnly cookies for session management",
     context="Need stateless auth that works with React SPA + API architecture",
     rationale="JWTs avoid server-side session storage. HttpOnly cookies prevent XSS. Refresh token rotation handles expiry.",
     alternatives=[
       {option: "Session-based auth with Redis",
        reason_rejected: "Adds Redis dependency, not needed at current scale"},
       {option: "JWT in localStorage",
        reason_rejected: "Vulnerable to XSS attacks"}
     ],
     confidence="high",
     affected_files=["src/auth/jwt.ts", "src/middleware/auth.ts"]
   )
   ```

2. **Conflict detection**
   - Show what happens when Agent B tries to make a conflicting decision
   - Twining auto-posts a warning to blackboard
   - Agents can use `twining_override` or `twining_reconsider`

3. **Decision tracing**
   ```
   twining_why(scope="src/auth/jwt.ts")
   # Shows the JWT decision with full rationale

   twining_trace(decision_id="...", direction="downstream")
   # Shows what other decisions depend on this one
   ```

4. **Show dashboard** - Decision timeline visualization with vis-timeline

**Key Points**:
- Captures "why" not just "what"
- Tracks alternatives considered
- Conflict detection prevents contradictory decisions
- Decision dependencies form a DAG
- Timeline visualization shows evolution

### Act 4: Context Assembly - Smart Context Injection (1.5 min)
**What we're showing**: `twining_assemble`, `twining_summarize`, token budgeting

**Scenario**: Agent C joins the project fresh

1. **Agent C assembles context**
   ```
   twining_assemble(
     task="Implement password reset flow",
     scope="src/auth/"
   )
   ```
   - Returns:
     - Relevant decisions (JWT auth decision)
     - Active warnings (timing attack warning)
     - Open needs (database schema need)
     - Knowledge graph entities (auth modules)
     - All scored by relevance, fitted within token budget

2. **Show the assembly output** - structured JSON with everything Agent C needs
3. **Contrast with manual approach** - "Without Twining, Agent C would need to read all conversation history or re-explore the codebase"

**Key Points**:
- Intelligent context selection (not dump-everything)
- Token budget controls context size
- Scores by relevance to task + scope
- Includes cross-cutting concerns (warnings, needs)

### Act 5: Knowledge Graph - Code Structure Mapping (1.5 min)
**What we're showing**: `twining_add_entity`, `twining_add_relation`, `twining_neighbors`, auto-population

**Scenario**: Agents build a knowledge graph of the auth system

1. **Show auto-population from decisions**
   - When we made the JWT decision, Twining auto-created:
     - File entities for src/auth/jwt.ts, src/middleware/auth.ts
     - `decided_by` relations linking files to decision

2. **Agent enriches with Serena**
   ```
   # Agent uses Serena to analyze code
   serena.find_symbol("JwtMiddleware")

   # Agent adds rich structure to graph
   twining_add_entity(name="JwtMiddleware", type="class",
     properties={file: "src/auth/jwt.ts", purpose: "Express middleware for JWT validation"})

   twining_add_relation(source="AuthRouter", target="JwtMiddleware", type="imports")
   twining_add_relation(source="JwtMiddleware", target="validateToken", type="calls")
   ```

3. **Query the graph**
   ```
   twining_neighbors(entity="JwtMiddleware", depth=2)
   # Shows what imports it, what it calls, what decided it
   ```

4. **Show dashboard** - Interactive graph visualization with cytoscape.js
   - Filter by entity type
   - Filter by relation type
   - Click nodes to see properties
   - Navigate neighborhood

**Key Points**:
- Auto-populated from decisions (minimal manual work)
- Enriched with Serena symbol analysis
- Queryable for impact analysis
- Visual exploration in dashboard

### Act 6: Verification & Rigor (1.5 min)
**What we're showing**: `twining_verify`, test coverage tracking, drift detection, constraint checking

**Scenario**: Agent D verifies the auth implementation before handoff

1. **Link tests to decisions**
   ```
   twining_add_relation(
     source="src/auth/jwt.ts",
     target="test/auth/jwt.test.ts",
     type="tested_by",
     properties={covers: "JWT generation and validation"}
   )
   ```

2. **Run verification**
   ```
   twining_verify(scope="src/auth/", checks=["test_coverage", "warnings", "drift", "assembly"])
   ```
   - Returns:
     - ✓ test_coverage: All decisions have tested_by relations
     - ⚠ warnings: 1 unresolved (timing attack warning still open)
     - ✓ drift: No stale decisions (code matches decision timestamps)
     - ✓ assembly: No blind decisions (all decisions made after assembling context)

3. **Show constraint checking**
   ```
   twining_post(entry_type="constraint",
     summary="No plaintext passwords in logs",
     detail='{"check_command": "grep -r \\"password\\" src/ | grep -i log | wc -l", "expected": "0"}',
     scope="src/")

   twining_verify(scope="src/", checks=["constraints"])
   # Runs the check command, validates output
   ```

**Key Points**:
- Decision-to-test traceability (not just code coverage)
- Drift detection catches stale decisions
- Assembly tracking prevents "blind decisions"
- Mechanical constraint checking
- Deterministic verification for probabilistic agents

### Act 7: Agent Coordination (1.5 min)
**What we're showing**: Agent registry, delegation, handoffs

**Scenario**: Multi-agent workflow

1. **Agent registration**
   ```
   # Agents auto-register on first tool call
   twining_agents()
   # Shows: agent-a (capabilities: ["typescript", "security"]),
   #        agent-b (capabilities: ["database", "testing"])
   ```

2. **Delegation**
   ```
   # Agent A identifies work it can't do
   twining_delegate(
     summary="Write integration tests for auth endpoints",
     required_capabilities=["testing", "integration"],
     urgency="high"
   )
   # Returns suggested agents ranked by capability match
   # Posts to blackboard as a "need" entry
   ```

3. **Handoff**
   ```
   # Agent A completes middleware, hands off routes
   twining_handoff(
     source_agent="agent-a",
     target_agent="agent-b",
     summary="Auth middleware complete, routes remaining",
     results=[
       {description: "JWT middleware with refresh tokens", status: "completed"},
       {description: "Protected route handlers", status: "partial"}
     ]
   )
   # Auto-assembles context snapshot for Agent B

   # Agent B acknowledges
   twining_acknowledge(handoff_id="...", agent_id="agent-b")
   ```

4. **Show dashboard** - Agents tab
   - Active agents with liveness indicators
   - Capability tags
   - Recent delegations and handoffs
   - Handoff timeline

**Key Points**:
- Self-organizing work distribution
- Capability-based agent discovery
- Structured handoffs with context snapshots
- Survives context window resets

### Conclusion (30 sec)
**What we're showing**: The complete picture

- Pan across dashboard tabs: Blackboard, Decisions, Graph, Agents, Stats
- Show verification passing
- Show git-diffable .twining/ directory
- Narration: "Twining turns disconnected AI agents into a coordinated team. Persistent memory, structured decisions, intelligent context assembly, and deterministic verification — all through standard MCP tools."
- Call to action: "Install with `npm install -g twining-mcp`. Documentation at [repo URL]."

## Technical Setup

### Prerequisites
1. Fresh project directory (or use Twining's own codebase)
2. Claude Code CLI with MCP enabled
3. Twining MCP installed and configured
4. Screen recording software (ScreenFlow, OBS, or built-in)
5. Dashboard running on port 24282

### Demo Environment
```bash
# Create demo project
mkdir twining-demo && cd twining-demo
npm init -y

# Add Twining to .mcp.json
cat > .mcp.json << 'EOF'
{
  "mcpServers": {
    "twining": {
      "command": "twining-mcp",
      "args": ["--project", "."]
    }
  }
}
EOF

# Start Claude Code
claude-code
```

### Screen Recording Checklist
- [ ] Browser window for dashboard (1920x1080 recommended)
- [ ] Claude Code terminal for agent interactions
- [ ] Clean .twining/ directory at start
- [ ] Pre-prepared prompts for each agent
- [ ] Dashboard auto-refresh enabled (5-second polling)

### Post-Production
- Add title cards for each act
- Highlight relevant UI elements
- Zoom in on important JSON/code sections
- Background music (subtle, non-distracting)
- Captions for narration

## Alternative: Quick Feature Tour (5 min version)

If 10 minutes is too long, here's a condensed version:

1. **Problem + Solution** (30 sec) - Show chaos without Twining, introduce concept
2. **Blackboard** (1 min) - Post entry, query, show dashboard
3. **Decisions** (1 min) - Record decision with rationale, show timeline
4. **Context Assembly** (1 min) - Assemble context, show intelligent selection
5. **Knowledge Graph** (1 min) - Add entities/relations, visualize
6. **Verification** (30 sec) - Run verify, show passing checks
7. **Wrap-up** (30 sec) - Dashboard overview, install instructions

## Assets Needed

- [ ] Narration script (detailed version of above)
- [ ] Demo codebase (simple web app with auth scenario)
- [ ] Pre-prepared agent prompts
- [ ] Dashboard with some pre-seeded data for smooth flow
- [ ] Slides/graphics for:
  - Title card
  - "The Problem" visualization
  - "How Twining Solves It" diagram
  - Feature matrix (28 tools)
  - Call to action

## Distribution

- [ ] Upload to YouTube (Anthropic channel or personal)
- [ ] Embed in README.md
- [ ] Link from docs/
- [ ] Share on Twitter/X with #MCP #ClaudeCode tags
- [ ] Submit to Anthropic MCP showcase
