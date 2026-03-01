# Twining MCP Demo - Ready-to-Execute Commands

This file contains all the commands and prompts for the demo video, ready to copy-paste.

## Setup

```bash
# Create demo project
mkdir twining-demo && cd twining-demo
npm init -y

# Create simple web app structure
mkdir -p src/{auth,routes,middleware,db} test/auth

# Add Twining to .mcp.json
cat > .mcp.json << 'EOF'
{
  "mcpServers": {
    "twining": {
      "command": "twining-mcp",
      "args": ["--project", "."]
    },
    "serena": {
      "command": "serena",
      "args": ["--project", "."]
    }
  }
}
EOF

# Create placeholder files
touch src/routes/api.ts
touch src/middleware/cors.ts
touch src/db/schema.ts
```

## Act 2: Blackboard Commands

### Agent A - Initial Discovery

**Prompt**: "Review this codebase and identify what authentication mechanisms are present."

**Then manually execute these Twining calls** (or show the agent doing them):

```typescript
// Finding #1
twining_post({
  entry_type: "finding",
  summary: "App has no authentication system",
  detail: "Reviewing codebase — routes are unprotected, no auth middleware exists, no user model in database schema. All API endpoints are publicly accessible.",
  scope: "src/",
  tags: ["security", "authentication"]
})

// Need #1
twining_post({
  entry_type: "need",
  summary: "Need database schema design for user authentication",
  detail: "Requires user table with: id, email (unique), hashed_password, created_at, updated_at. Also need sessions table for refresh tokens.",
  scope: "src/db/",
  tags: ["database", "security"]
})

// Warning #1
twining_post({
  entry_type: "warning",
  summary: "No rate limiting on API endpoints - DDoS vulnerable",
  detail: "Current implementation has no request throttling. Auth endpoints especially vulnerable to brute force attacks.",
  scope: "src/routes/",
  tags: ["security", "performance"]
})

// Question #1
twining_post({
  entry_type: "question",
  summary: "Should we use email-only or email+username for login?",
  detail: "Email-only is simpler and more common. Username adds complexity but some users prefer it for privacy.",
  scope: "src/auth/",
  tags: ["ux", "authentication"]
})
```

### Show Dashboard
- Open http://localhost:24282
- Navigate to Blackboard tab
- Filter by entry_type="warning"
- Show real-time updates

### Agent B - Query Blackboard

**Prompt**: "I need to implement secure authentication. What are the current security concerns?"

```typescript
twining_query({
  query: "authentication security concerns",
  limit: 10
})
// Returns: the warning + need entries
```

```typescript
// Agent B answers the question
twining_post({
  entry_type: "answer",
  summary: "Use email-only login to reduce attack surface",
  detail: "Email-only is industry standard and reduces complexity. Fewer fields means fewer validation rules and less attack surface.",
  scope: "src/auth/",
  relates_to: ["<question-id>"],  // ID from question above
  tags: ["decision", "ux"]
})
```

## Act 3: Decisions Commands

### Agent A - Record JWT Decision

```typescript
twining_decide({
  domain: "architecture",
  scope: "src/auth/",
  summary: "Use JWT tokens with HttpOnly cookies for session management",
  context: "Need stateless authentication that works with React SPA + REST API architecture. Must prevent XSS and CSRF attacks. App will scale horizontally so session storage must be client-side.",
  rationale: "JWTs avoid server-side session storage which simplifies horizontal scaling. HttpOnly cookies prevent XSS attacks by making tokens inaccessible to JavaScript. Refresh token rotation handles expiry and provides logout capability. SameSite cookie attribute prevents CSRF.",
  alternatives: [
    {
      option: "Session-based auth with Redis",
      pros: ["Immediate revocation", "Smaller cookie size", "Server-side control"],
      cons: ["Requires Redis infrastructure", "Stateful architecture", "Doesn't scale horizontally as easily"],
      reason_rejected: "Adds Redis dependency and operational complexity not needed at current scale (< 10k users). Can migrate later if immediate revocation becomes critical."
    },
    {
      option: "JWT in localStorage",
      pros: ["Simple implementation", "Works with any client"],
      cons: ["Vulnerable to XSS attacks", "No httpOnly protection"],
      reason_rejected: "Security risk too high — XSS vulnerability could leak tokens"
    },
    {
      option: "OAuth2 with third-party provider",
      pros: ["No password storage", "Proven security", "Social login"],
      cons: ["External dependency", "Privacy concerns", "User data sharing"],
      reason_rejected: "Want to own the authentication flow for first version. Can add social login later."
    }
  ],
  constraints: ["Must work without JavaScript for critical paths", "Must support API clients (mobile apps)"],
  confidence: "high",
  affected_files: ["src/auth/jwt.ts", "src/middleware/auth.ts", "src/routes/auth.ts"],
  affected_symbols: ["JwtMiddleware", "generateToken", "verifyToken"]
})
```

### Agent B - Conflicting Decision Attempt

```typescript
// Agent B tries to make a different decision
twining_decide({
  domain: "architecture",
  scope: "src/auth/",
  summary: "Use session cookies with server-side storage",
  context: "Need to be able to immediately revoke sessions",
  rationale: "Server-side sessions allow instant logout across all devices",
  alternatives: [{
    option: "JWT tokens",
    reason_rejected: "Cannot revoke JWTs before expiry"
  }],
  confidence: "medium",
  affected_files: ["src/auth/session.ts"]
})

// Twining detects conflict and auto-posts warning:
// "Potential conflict: new decision may conflict with existing decision(s)"
```

### Show Conflict Resolution

```typescript
// Agent B reviews the conflict
twining_why({scope: "src/auth/"})
// Shows the JWT decision with full rationale

// Agent B overrides their own decision or reconsiders the JWT one
twining_reconsider({
  decision_id: "<jwt-decision-id>",
  new_context: "Product requirement changed: Need immediate session revocation for security compliance (SOC 2). JWT expiry-based logout is insufficient."
})
// Sets decision to "provisional" and posts warning to blackboard
```

### Show Decision Timeline
- Dashboard → Decisions tab
- Interactive timeline with vis-timeline
- Click decision to see full details
- Show dependency graph

## Act 4: Context Assembly Commands

### Agent C - Fresh Start

**Prompt**: "I need to implement the password reset flow. Give me context on the current authentication approach."

```typescript
twining_assemble({
  task: "Implement password reset flow",
  scope: "src/auth/",
  max_tokens: 4000
})

// Returns:
// {
//   "active_decisions": [
//     {id: "...", summary: "Use JWT tokens...", rationale: "...", confidence: "high"}
//   ],
//   "active_warnings": [
//     {id: "...", summary: "No rate limiting on API endpoints..."}
//   ],
//   "open_needs": [
//     {id: "...", summary: "Need database schema design..."}
//   ],
//   "related_entities": [
//     {name: "JwtMiddleware", type: "class", properties: {...}}
//   ],
//   "token_estimate": 2847
// }
```

**Agent C now has everything needed**:
- The JWT decision (so they use compatible approach)
- The rate limiting warning (so they add it to reset endpoint)
- The database need (so they coordinate schema design)
- The code structure (so they integrate properly)

### Contrast: Without Twining

**Show**: "Without Twining, Agent C would need to:"
- Read entire conversation history (100s of messages)
- Or re-explore codebase from scratch
- Or ask lots of clarifying questions
- Risk making conflicting decisions

## Act 5: Knowledge Graph Commands

### Show Auto-Population

```typescript
// After the JWT decision above, Twining auto-created:
twining_graph_query({query: "jwt"})

// Returns:
// [
//   {name: "src/auth/jwt.ts", type: "file", properties: {}},
//   {name: "src/middleware/auth.ts", type: "file", properties: {}},
//   {name: "JwtMiddleware", type: "function", properties: {}}
// ]

// Plus "decided_by" relations linking them to the decision
```

### Enrich with Serena (if available)

```typescript
// Agent uses Serena to understand the code
serena.find_symbol({name_path_pattern: "JwtMiddleware", include_body: false})

// Agent adds rich structure
twining_add_entity({
  name: "JwtMiddleware",
  type: "class",
  properties: {
    file: "src/auth/jwt.ts",
    purpose: "Express middleware for JWT validation",
    exports: "verifyToken, generateToken, refreshToken"
  }
})

twining_add_entity({
  name: "AuthRouter",
  type: "module",
  properties: {
    file: "src/routes/auth.ts",
    purpose: "Auth-related HTTP endpoints"
  }
})

// Add relationships
twining_add_relation({
  source: "AuthRouter",
  target: "JwtMiddleware",
  type: "imports",
  properties: {usage: "applies middleware to protected routes"}
})

twining_add_relation({
  source: "JwtMiddleware",
  target: "verifyToken",
  type: "calls",
  properties: {when: "on every protected request"}
})

twining_add_relation({
  source: "src/auth/jwt.ts",
  target: "test/auth/jwt.test.ts",
  type: "tested_by",
  properties: {coverage: "token generation, validation, expiry, refresh"}
})
```

### Query the Graph

```typescript
// Find what depends on JwtMiddleware
twining_neighbors({
  entity: "JwtMiddleware",
  depth: 2,
  relation_types: ["imports", "calls"]
})

// Returns neighborhood: AuthRouter → JwtMiddleware → verifyToken
```

### Show Dashboard - Graph Tab
- Interactive visualization with cytoscape.js
- Filter by: entity type (class, function, file)
- Filter by: relation type (imports, calls, tested_by, decided_by)
- Click nodes → show properties
- Drag nodes → rearrange layout
- Double-click → expand neighborhood

## Act 6: Verification Commands

### Link Tests to Decisions

```typescript
// After implementing JWT functionality
twining_add_relation({
  source: "src/auth/jwt.ts",
  target: "test/auth/jwt.test.ts",
  type: "tested_by",
  properties: {
    covers: "JWT generation, validation, expiry, refresh token rotation",
    test_count: "12",
    coverage_percent: "95"
  }
})
```

### Run Verification

```typescript
twining_verify({
  scope: "src/auth/",
  checks: ["test_coverage", "warnings", "drift", "assembly", "constraints"]
})

// Returns:
// {
//   "checks": {
//     "test_coverage": {
//       "passed": true,
//       "summary": "All 1 decision(s) have tested_by relations",
//       "details": [...]
//     },
//     "warnings": {
//       "passed": false,
//       "summary": "Found 1 unacknowledged warning(s)",
//       "unresolved_warnings": [
//         {summary: "No rate limiting on API endpoints..."}
//       ]
//     },
//     "drift": {
//       "passed": true,
//       "summary": "No stale decisions detected",
//       "stale_decisions": []
//     },
//     "assembly": {
//       "passed": true,
//       "summary": "All decisions made with context",
//       "blind_decisions": []
//     },
//     "constraints": {
//       "passed": true,
//       "summary": "All constraints satisfied",
//       "failed_constraints": []
//     }
//   },
//   "overall_status": "warnings",
//   "summary": "4/5 checks passed"
// }
```

### Add Constraint

```typescript
twining_post({
  entry_type: "constraint",
  summary: "No plaintext passwords in logs or error messages",
  detail: JSON.stringify({
    check_command: "grep -ri 'password' src/ | grep -E '(console\\.log|logger\\.)' | wc -l",
    expected: "0"
  }),
  scope: "src/"
})

// Re-run verification
twining_verify({scope: "src/", checks: ["constraints"]})
// Executes: grep -ri 'password' src/ | grep -E '(console\.log|logger\.)' | wc -l
// Validates: output === "0"
```

## Act 7: Agent Coordination Commands

### Agent Registration (automatic)

```typescript
// Happens automatically on first tool call
// Each agent registers with capabilities
twining_agents()

// Returns:
// [
//   {
//     agent_id: "agent-a",
//     capabilities: ["typescript", "security", "architecture"],
//     liveness: "active",
//     last_seen: "2026-02-20T02:30:00Z"
//   },
//   {
//     agent_id: "agent-b",
//     capabilities: ["database", "testing", "python"],
//     liveness: "active",
//     last_seen: "2026-02-20T02:35:00Z"
//   }
// ]
```

### Delegation

```typescript
// Agent A identifies work it can't do
twining_delegate({
  summary: "Write integration tests for auth endpoints",
  required_capabilities: ["testing", "integration"],
  scope: "test/auth/",
  urgency: "high"
})

// Returns suggested agents:
// {
//   "delegation_id": "...",
//   "suggested_agents": [
//     {agent_id: "agent-b", match_score: 2, matched_capabilities: ["testing"]}
//   ],
//   "blackboard_entry_id": "..."
// }
```

### Handoff

```typescript
// Agent A completes middleware, hands off to Agent B
twining_handoff({
  source_agent: "agent-a",
  target_agent: "agent-b",
  summary: "Auth middleware complete, route handlers remaining",
  scope: "src/auth/",
  results: [
    {
      description: "JWT middleware with token generation and validation",
      status: "completed",
      artifacts: ["src/auth/jwt.ts", "src/middleware/auth.ts"]
    },
    {
      description: "Protected route handlers (login, logout, refresh)",
      status: "partial",
      notes: "Login route done, logout and refresh still need implementation"
    },
    {
      description: "Password reset flow",
      status: "blocked",
      notes: "Waiting on email service integration decision"
    }
  ]
})

// Auto-assembles context snapshot:
// - Relevant decisions (JWT decision)
// - Active warnings (rate limiting)
// - Open needs (database schema)
// - Knowledge graph entities (JwtMiddleware, etc.)
```

### Acknowledgment

```typescript
// Agent B picks up the handoff
twining_acknowledge({
  handoff_id: "<handoff-id>",
  agent_id: "agent-b"
})
```

### Show Dashboard - Agents Tab
- Table of active agents with capabilities
- Recent delegations (needs posted to blackboard)
- Handoff timeline
- Capability match scores

## Conclusion Commands

### Show Complete System State

```typescript
// Quick overview
twining_summarize({scope: "project"})

// Full export for documentation
twining_export({scope: "src/auth/"})
// Generates markdown with all decisions, entries, and graph
```

### Show Git-Diffable State

```bash
# In terminal
ls -la .twining/
cat .twining/blackboard.jsonl | jq -r '.summary'
cat .twining/decisions/<decision-id>.json | jq .
cat .twining/config.json
```

## Timing Notes

- **Act 2** (Blackboard): ~2 min
  - Post 3-4 entries: 30 sec
  - Show dashboard: 30 sec
  - Query demo: 30 sec
  - Narration: 30 sec

- **Act 3** (Decisions): ~2 min
  - Record decision: 45 sec
  - Show conflict: 30 sec
  - Trace/why: 30 sec
  - Timeline viz: 15 sec

- **Act 4** (Assembly): ~1.5 min
  - Assemble call: 30 sec
  - Show output: 30 sec
  - Contrast without Twining: 30 sec

- **Act 5** (Graph): ~1.5 min
  - Show auto-population: 20 sec
  - Add entities/relations: 40 sec
  - Query: 20 sec
  - Dashboard viz: 30 sec

- **Act 6** (Verification): ~1.5 min
  - Link tests: 20 sec
  - Run verify: 40 sec
  - Show constraint: 30 sec

- **Act 7** (Coordination): ~1.5 min
  - Show agents: 20 sec
  - Delegate: 30 sec
  - Handoff: 40 sec

**Total**: ~10 minutes
