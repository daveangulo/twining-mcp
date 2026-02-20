# Agent Integration Architecture for Twining MCP

> Which agent frameworks work best with Twining, why, and what the optimal coordination architecture looks like.

---

## 1. The Problem: Why Agent Coordination Is Hard

Multi-agent coding workflows suffer from a fundamental tension: **fresh context windows prevent quality degradation but create information silos**. Every new Claude Code session, every subagent, every Task() clone starts with a blank slate. Decisions made by one agent are invisible to the next. The system optimizes locally while failing globally. Every handoff is lossy because agents share *what* was done but not *why*.

The agent framework landscape offers three broad approaches to this problem, and they are not equal:

**Orchestrator frameworks** (CrewAI, LangGraph, AutoGen) model coordination as pipeline routing or conversation management. A central coordinator assigns work, collects results, and decides next steps. This creates a bottleneck: the orchestrator must understand all context to route effectively, but its own context window is finite. The orchestrator becomes a single point of failure for coordination quality.

**Spec-driven frameworks** (GSD, BMAD) produce structured artifacts — roadmaps, plans, requirements — that guide execution. These artifacts persist on disk, but they're *documentation*, not *shared state*. An agent reading a plan knows what to build, but not what decisions were made during previous phases, what alternatives were rejected, or what gotchas were discovered.

**Blackboard systems** (Twining, SBP) make coordination state visible to all agents through a shared medium. Agents self-select into work based on what they observe. Decisions, warnings, needs, and findings persist independently of any individual agent's context window. The coordination layer outlives every agent that writes to it.

The core insight: **orchestrators coordinate through assignment, spec frameworks coordinate through documentation, and blackboards coordinate through visible shared state**. For LLM agents with ephemeral context windows, visible shared state is the only model where coordination knowledge survives context resets without information loss.

---

## 2. Framework Landscape Analysis

### Scoring Dimensions

Each framework is scored 0–3 on five dimensions relevant to Twining integration:

| Dimension | 0 | 1 | 2 | 3 |
|-----------|---|---|---|---|
| **MCP Native** | No support | Via adapter/plugin | First-class but optional | Core protocol |
| **Shared Context** | None (local only) | Conversation history | Persistent artifacts | Structured shared state |
| **Blackboard Compat** | Incompatible model | Could bolt on | Natural fit, some friction | Designed for it |
| **Peer vs Orchestrator** | Hard orchestrator | Orchestrator-default | Flexible | Peer-native |
| **SWE Focus** | General-purpose | Some SWE features | SWE-oriented | SWE-native |

### Comparison

| Framework | MCP | Context | BB Compat | Peer | SWE | Total | Recommendation |
|-----------|-----|---------|-----------|------|-----|-------|----------------|
| **Claude Code + Twining** | 3 | 3 | 3 | 3 | 3 | **15/15** | Primary path |
| **Claude Agent SDK + Twining** | 3 | 2 | 3 | 2 | 2 | **12/15** | Programmatic path |
| **Strands (AWS)** | 3 | 2 | 2 | 2 | 1 | **10/15** | Alternative host |
| **SBP (AdviceNXT)** | 2 | 2 | 3 | 3 | 0 | **10/15** | Philosophical ally |
| **OpenHands** | 1 | 1 | 1 | 1 | 3 | **7/15** | SWE-focused, wrong model |
| **AutoGen / AG2** | 2 | 1 | 1 | 1 | 1 | **6/15** | Conversation-bound |
| **LangGraph** | 1 | 1 | 1 | 0 | 1 | **4/15** | Graph orchestrator |
| **CrewAI** | 2 | 1 | 1 | 0 | 1 | **5/15** | Role orchestrator |
| **Agency-Swarm** | 2 | 1 | 1 | 0 | 1 | **5/15** | OpenAI-centric |

*GSD and BMAD are scored separately in Section 6 — they're complementary workflow tools, not competing coordination models.*

### Framework Details

**Claude Code + Twining MCP (15/15).** Claude Code is both an MCP host and a software development agent. It natively spawns subagents via `Task()`, manages context windows, and connects to MCP servers. Twining provides the missing coordination layer: persistent decisions, shared blackboard, knowledge graph, and context assembly. Every Twining tool call is a standard MCP request — no adapters, no wrappers. Subagents inherit MCP server connections automatically. This combination works today with zero framework code.

**Claude Agent SDK + Twining (12/15).** The SDK provides the same agent loop and MCP tool system that powers Claude Code, programmable in Python and TypeScript. The `query()` function creates an async streaming loop where Claude autonomously reasons, calls tools, and returns results. MCP servers (including Twining) are configured via `.mcp.json` or in code. Multi-agent coordination requires external orchestration — the SDK provides a single-agent loop, not multi-agent primitives. Score is slightly lower because you must build the agent lifecycle management that Claude Code provides out of the box.

**Strands Agents (10/15).** AWS's open-source SDK uses a "model-driven" approach: three primitives (model, prompt, tools) with the LLM handling all planning autonomously. First-class MCP support. Four multi-agent patterns: Agents as Tools (hierarchical), Swarm Agents (shared memory), Agent Graphs, and Agent Workflows. The swarm pattern with shared memory is conceptually close to a blackboard. Production-grade with Amazon Bedrock AgentCore integration. Main gap: general-purpose, not SWE-focused, and the swarm's "shared memory" is in-process, not persistent across sessions.

**SBP — Stigmergic Blackboard Protocol (10/15).** The closest philosophical match to Twining. Inspired by ant colony behavior, SBP has agents deposit "digital pheromones" — signals with intensity that decay over time — onto a shared environment. Other agents sense pheromones and trigger actions when conditions cross thresholds. Coordination emerges from the environment, not from explicit messaging. Key differences from Twining: SBP uses intensity-based signals (pheromones) while Twining uses structured records (decisions with rationale); SBP pheromones decay, Twining decisions persist; SBP has no knowledge graph or context assembly. SBP is complementary to MCP (agents use MCP tools for work, SBP for coordination) but implements its own protocol rather than being an MCP server itself.

**OpenHands (7/15).** Formerly OpenDevin, this is the strongest pure SWE agent platform. Uses a hierarchical delegator that routes tasks to specialized micro-agents (RepoStudyAgent, VerifierAgent, etc.). Sub-agents operate as independent conversations with event-sourced state and deterministic replay. MCP support exists via the SDK but is secondary. The delegator model is the textbook orchestrator anti-pattern for blackboard integration — the delegator must hold all coordination context, and sub-agents can't self-select into work based on shared state.

**AutoGen / AG2 (6/15).** Pioneered the "agents as conversation participants" paradigm. A `GroupChatManager` orchestrates turn-taking among agents with different roles sharing a conversation thread. MCP support via `McpToolAdapter`. The conversation-as-coordination model means coordination state is embedded in message history, not in a queryable structure. Microsoft is merging AutoGen with Semantic Kernel into the "Microsoft Agent Framework." AG2 continues as an independent fork.

**CrewAI (5/15).** Role-based crew orchestration where agents have defined roles, goals, and backstories. Tasks flow through crews sequentially or under a hierarchical manager. Native MCP support (bidirectional — crews can consume and expose MCP tools). The role-assignment model is fundamentally orchestrator-shaped: work is assigned to agents by role, not self-selected from shared state. Good for well-defined workflows; poor fit for emergent coordination.

**Agency-Swarm (5/15).** Builds AI "agencies" modeled on business org charts (CEO delegates to managers, managers to specialists). Recently migrated from OpenAI Assistants API to OpenAI Agents SDK. MCP support added in 2025. OpenAI-centric ecosystem. The org-chart hierarchy is the most rigid orchestrator pattern — agents have fixed reporting lines and can only communicate through defined channels.

**LangGraph (4/15).** Models agent workflows as stateful directed graphs with explicit node/edge topology. MCP via `langchain-mcp-adapters`. The developer defines the graph structure, giving precise control over coordination flow. This is the most programmatic approach — powerful for deterministic workflows, but the opposite of self-selecting agents. Coordination is encoded in graph structure, not in shared state.

---

## 3. Why Blackboard Beats Orchestrator for LLM Agents

The blackboard architecture was formalized by Barbara Hayes-Roth in 1985 as a model for "opportunistic problem solving" — where specialist knowledge sources contribute to a shared workspace, and a control mechanism selects which knowledge source should act next based on the current state of the workspace. The key insight was that decoupled knowledge sources communicating through a shared medium produce better solutions than rigid top-down planning.

Forty years later, this insight applies directly to LLM agents. Here's why:

### N-to-N vs 1-to-N Coordination

An orchestrator creates 1-to-N communication: the coordinator talks to each agent, but agents don't see each other's work unless the coordinator relays it. A blackboard creates N-to-N communication: every agent can see every other agent's findings, warnings, and decisions. When Agent C posts a warning about a file, Agent D sees it when assembling context for that file — no orchestrator relay needed. This matters because orchestrator relay is lossy: the coordinator must decide what to forward, and it will always drop context that seemed irrelevant at relay time but becomes relevant later.

### Append-Only Audit Trail

Orchestrator state is conversational — it lives in message history that gets compressed, truncated, or lost when context windows fill up. Blackboard state is structural — decisions, warnings, and findings are append-only records with explicit rationale, timestamps, and scope. When a new agent starts work six hours later, it doesn't need the conversation history. It calls `twining_assemble` and gets exactly the decisions, warnings, and needs relevant to its task, within a token budget.

### Self-Selection Fits MCP's Architecture

MCP is request/response: the client (agent) calls the server (tool). There is no push channel — the server cannot send notifications to agents. This means orchestrator patterns that rely on pushing assignments to agents don't work natively over MCP. But blackboard patterns work perfectly: agents pull context when they start work, post results when they finish, and the blackboard is always available for the next `read` or `assemble` call.

### Token-Budgeted Context Assembly

The single biggest advantage of a structured blackboard over conversation-based coordination is **selective injection**. Twining's context assembler (`twining_assemble`) scores every decision, warning, need, and finding by relevance to the current task and scope, then fills a token budget in priority order. An agent working on `src/auth/` gets auth-related decisions and warnings, not the entire project history. This is impossible with conversation-based coordination, where the entire conversation (or a compressed summary of it) is the only context available.

### Academic Validation

Recent research confirms these advantages for LLM agents specifically:

- **LbMAS** (2025) introduced the first blackboard-based LLM multi-agent system, achieving the best average performance (81.68%) across benchmarks while spending fewer tokens than orchestrator-based alternatives. The system's dynamic agent selection based on blackboard state outperformed both static role assignment and master-slave orchestration patterns.

- **Krishnan et al.** (2025) demonstrated that MCP-based standardized context sharing improves task completion rates and reduces coordination overhead compared to ad-hoc approaches, validating the value of structured context protocols for multi-agent systems.

- **Falconer & Sellers** (2025) identified four design patterns for multi-agent systems — including the blackboard pattern — and argued that event-driven architectures with shared state are more scalable than direct agent-to-agent messaging for production multi-agent systems.

---

## 4. Recommended Architecture: Claude Code + Twining MCP

### Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                    Claude Code (MCP Host)                         │
│                                                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ Main Session │  │  Subagent A │  │  Subagent B │  ...         │
│  │             │  │  (Task())   │  │  (Task())   │              │
│  │  Fresh      │  │  Fresh      │  │  Fresh      │              │
│  │  context    │  │  context    │  │  context    │              │
│  │  window     │  │  window     │  │  window     │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │                │                │                      │
│         └────────────────┼────────────────┘                      │
│                          │ MCP (request/response)                │
│                          ▼                                       │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │                  Twining MCP Server                        │   │
│  │                                                            │   │
│  │  ┌────────────┐  ┌───────────┐  ┌──────────────────────┐  │   │
│  │  │ Blackboard │  │ Decision  │  │ Context Assembler    │  │   │
│  │  │ (findings, │  │ Tracker   │  │ (token-budgeted      │  │   │
│  │  │  warnings, │  │ (rationale│  │  selective injection) │  │   │
│  │  │  needs)    │  │  + graph) │  │                      │  │   │
│  │  └────────────┘  └───────────┘  └──────────────────────┘  │   │
│  │                                                            │   │
│  │  ┌────────────────────────┐  ┌─────────────────────────┐  │   │
│  │  │   Knowledge Graph      │  │  Agent Coordination     │  │   │
│  │  │   (entities, relations,│  │  (registry, discovery,  │  │   │
│  │  │    decided_by links)   │  │   delegation, handoff)  │  │   │
│  │  └────────────────────────┘  └─────────────────────────┘  │   │
│  │                                                            │   │
│  │  ┌─────────────────────────────────────────────────────┐   │   │
│  │  │        .twining/  (plain files, git-trackable)      │   │   │
│  │  │  blackboard.jsonl  decisions/  graph/  agents/      │   │   │
│  │  └─────────────────────────────────────────────────────┘   │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### Agent Lifecycle

Every agent — whether it's the main Claude Code session, a subagent spawned by `Task()`, or a programmatic agent via the Claude Agent SDK — follows the same lifecycle:

1. **Assemble** — Call `twining_assemble` with task description and scope. Receive relevant decisions, warnings, needs, findings, graph entities, and planning state, all fitted within a token budget.

2. **Work** — Execute the task. Post `finding` entries for discoveries, `warning` entries for gotchas, `need` entries for follow-up work.

3. **Decide** — Call `twining_decide` for any non-trivial choice, recording rationale, alternatives considered, confidence level, and affected files/symbols. The decision engine auto-populates the knowledge graph with `decided_by` relations.

4. **Verify** — The deterministic edge. Confirm that tests pass, decisions have corresponding `tested_by` relations, warnings in scope were addressed, and affected files are consistent with decisions. See Section 5 for the full rigor framework.

5. **Handoff** — Call `twining_handoff` to package work results with an auto-assembled context snapshot. The snapshot captures active decisions and warnings at handoff time, preventing context drift.

6. **Next agent assembles** — The next agent starts at step 1, receiving the previous agent's decisions and findings through the assembler. No information is lost between context windows.

### What Each Subsystem Provides

**Blackboard** — Append-only stream of typed entries (`finding`, `warning`, `need`, `question`, `answer`, `status`, `offer`, `artifact`, `constraint`). Agents post to it while working and read from it (via filters, semantic search, or `recent`) to stay informed. The blackboard explicitly blocks `entry_type: "decision"` on `twining_post` — decisions must go through `twining_decide` to ensure rationale capture.

**Decision Tracker** — Structured records with mandatory rationale, alternatives, confidence levels, and traceability (dependency chains, supersession, override). Conflict detection flags when a new decision in the same domain and scope contradicts an existing active decision. `twining_why` on any file or scope returns the full decision chain explaining why things are the way they are.

**Decision Conflict Resolution.** When `twining_decide` detects a conflict (same domain + overlapping scope + active status), the system must resolve it. The resolution model is **flag-and-proceed, not block**:

1. The new decision is recorded normally (decisions are never blocked by conflicts).
2. A `warning` entry is auto-posted to the blackboard: `"Conflict: decision {new_id} in domain '{domain}' conflicts with active decision {existing_id} in scope '{scope}'. Agents should review via twining_why."` The warning includes `relates_to` linking both decision IDs.
3. The conflict is recorded as metadata on the new decision: `conflicts_with: [existing_id]`.
4. Both decisions remain `active`. Neither is auto-superseded.
5. Resolution requires explicit human or agent action: call `twining_override` on one decision (which sets it to `overridden` and optionally creates a replacement), or call `twining_reconsider` to flag one for review.

This design ensures conflicts are **loud** (surfaced in the next `twining_assemble` as high-priority warnings) without blocking agent work. The system does not attempt to auto-resolve because conflict resolution requires judgment about intent, not just chronological ordering. The last-write-wins anti-pattern is explicitly avoided.

**Context Assembler** — The key differentiator. Scores every piece of shared state by relevance (scope match, semantic similarity, recency, confidence) and fills a token budget in priority order. This is what makes the blackboard practical for LLM agents — without selective injection, the blackboard would just be a firehose.

**Knowledge Graph** — Lightweight entity-relation graph (8 entity types, 8 relation types) tracking code structure and its relationship to decisions. `twining_decide` auto-creates `file` and `function` entities with `decided_by` relations for `affected_files` and `affected_symbols`. Agents can enrich with additional structure (`imports`, `calls`, `implements`) using Serena's symbol analysis.

**Agent Coordination** — Registry with inferred liveness (no heartbeats needed — MCP is request/response), capability-based discovery, delegation via blackboard needs, and structured handoffs with context snapshots. Agents self-select into work by reading delegations and choosing to fulfill them.

### Claude Agent SDK as Alternative Host

For programmatic workflows (CI pipelines, automated reviews, batch processing), the Claude Agent SDK replaces Claude Code as the MCP host:

```python
from claude_code_sdk import query

# Twining is configured in .mcp.json — the SDK picks it up automatically
async for msg in query(
    prompt="Review the auth module for security issues",
    options=QueryOptions(system_prompt="Always call twining_assemble before starting work...")
):
    print(msg)
```

The agent lifecycle is identical — the SDK's agent loop calls Twining tools just like Claude Code does. The difference is programmatic control: you can spawn multiple SDK agents, manage their lifecycles, and process their results in application code.

---

## 5. Maintaining Rigor: Deterministic Edges for Probabilistic Agents

> *"Certain shifts in software history feel like freedom because they remove familiar signals of control. In reality, they relocate rigor closer to where truth lives."* — Chad Fowler, ["Relocating Rigor"](https://aicoding.leaflet.pub/3mbrvhyye4k2e)

When AI agents generate code, rigor doesn't disappear — it must **relocate** from generation to evaluation. The blackboard architecture captures intent (decisions, rationale, warnings). But intent without verification is just documentation. The architecture must be **probabilistic inside, deterministic at the edges**: agents generate freely, but deterministic checks gate what survives.

Without this, Twining enables a sophisticated form of quiet failure: agents that assemble context, record decisions, hand off results — all while the code has silently drifted from every decision on the board. The coordination *looks* rigorous. The code isn't.

### 5.1 The Verify Step

The agent lifecycle (Section 4) includes a verify step between decide and handoff. This is where rigor lives. Verification answers three questions:

1. **Do the tests pass?** The most basic deterministic edge. If an agent made changes and tests fail, the handoff should not proceed. This is Fowler's core prescription: "You write the tests and the LLM generates implementations. If the tests don't pass, the code doesn't ship."

2. **Do decisions have evidence?** A decision without a `tested_by` relation in the knowledge graph is an assertion without proof. Verification flags decisions in the current scope that lack test coverage — not as a blocker, but as visible metadata that downstream agents and humans can weigh.

3. **Were warnings addressed?** If `twining_assemble` surfaced warnings for the agent's scope, verification checks whether those warnings were resolved (a new entry relating to the warning), explicitly acknowledged (a finding or answer linking back via `relates_to`), or silently ignored. Silent ignoring is the thing that must be made visible.

### 5.2 Decision-to-Test Traceability

The knowledge graph already has the `tested_by` relation type. It is unused. This is the single highest-leverage addition to the rigor model:

```
twining_decide(
  summary="Use JWT for stateless auth",
  affected_files=["src/auth/middleware.ts"],
  ...
)
# Auto-creates: file entity "src/auth/middleware.ts" --decided_by--> decision

# After writing the test:
twining_add_relation(
  source="src/auth/middleware.ts",
  target="test/auth.test.ts",
  type="tested_by",
  properties={ covers: "JWT middleware validation" }
)
```

A `twining_verify` tool (not yet built) would query: for every active decision in scope, do its `affected_files` have `tested_by` relations? Decisions with evidence rank higher in context assembly. Decisions without evidence get flagged. This makes the gap between intent and verification loud, not silent.

### 5.3 Drift Detection

Decisions describe intended state. Code evolves. When a file listed in a decision's `affected_files` is modified after the decision timestamp — without a superseding or new decision — that's **drift**. The rationale no longer matches reality, but nothing in the system surfaces this.

Drift detection would work by comparing decision timestamps against git history for affected files. On `twining_assemble` or via a standalone check:

- File `src/auth/middleware.ts` was last modified in commit `abc123` (Feb 18)
- Decision `01KHT...` affecting that file was recorded Feb 15
- No superseding decision exists
- **Flag:** "Decision X may be stale — `src/auth/middleware.ts` was modified 3 days after the decision with no update to rationale"

This is the "systems must fail visibly when they drift from intent" principle. Drift doesn't block work — it surfaces as a warning in the next agent's assembled context, prompting the agent (or human) to either update the decision or confirm it still holds.

### 5.4 Checkable Constraints

The `constraint` entry type exists on the blackboard but is purely prose. Some constraints are mechanically verifiable:

| Constraint | Checkable? | How |
|-----------|-----------|-----|
| "No direct fs calls outside storage/" | Yes | `grep` / AST analysis |
| "All public API functions have JSDoc" | Yes | Linter rule |
| "No circular imports in src/engine/" | Yes | Dependency analysis |
| "Must maintain backwards compat with v2 clients" | No | Requires judgment |

A structured constraint format could include an optional `check_command` field:

```
twining_post(
  entry_type="constraint",
  summary="No direct fs calls outside storage/",
  detail='{"check_command": "grep -r \"import.*node:fs\" src/ --include=\"*.ts\" | grep -v storage/ | wc -l", "expected": "0"}',
  scope="src/"
)
```

A `twining_verify` tool could execute checkable constraints and report pass/fail. This is the strongest form of relocated rigor: the human specifies the invariant, the system checks it continuously, and violations are impossible to miss.

### 5.5 Assembly-Before-Decision Tracking

If an agent calls `twining_decide` without having called `twining_assemble` in the same session, the decision was made without shared context. It might still be correct — but it was made blind.

Tracking this as metadata on the decision (`assembled_before: true|false`) makes uninformed decisions distinguishable from informed ones. Context assembly already records `assembled_at` timestamps; comparing against `twining_decide` timestamps for the same `agent_id` is straightforward.

This doesn't block anything. It makes a pattern visible: if an agent consistently decides without assembling, that's a workflow problem. If a specific decision was made without assembly and later causes a conflict, the metadata explains why.

### 5.6 The Rigor Hierarchy

Not every check needs to be implemented at once. The mechanisms form a hierarchy from easiest to hardest:

| Level | Mechanism | Effort | What it catches |
|-------|-----------|--------|----------------|
| 1 | Tests pass before handoff | Zero (convention) | Broken code leaving the agent |
| 2 | Assembly-before-decision tracking | Low (timestamp comparison) | Uninformed decisions |
| 3 | `tested_by` relation coverage | Low (graph query) | Decisions without evidence |
| 4 | Warning acknowledgment tracking | Medium (relates_to analysis) | Silently ignored warnings |
| 5 | Drift detection | Medium (git integration) | Stale rationale |
| 6 | Checkable constraints | High (command execution) | Invariant violations |

Level 1 is a convention that can be adopted today via `CLAUDE.md` instructions. Levels 2–3 require minor additions to existing tools. Levels 4–6 require new tooling.

### 5.7 `twining_verify` Tool Specification

The `twining_verify` tool implements Levels 2–5 of the rigor hierarchy as a single MCP tool call. It is the primary engineering deliverable for the rigor model.

**Tool Schema:**

```typescript
twining_verify({
  scope: string,             // Required. File path, directory, or domain to verify.
  checks?: string[],         // Optional. Subset of checks to run. Default: all.
                             // Values: "test_coverage", "warnings", "drift", "assembly", "constraints"
  agent_id?: string,         // Optional. If provided, checks assembly-before-decision for this agent.
  fail_on?: string[],        // Optional. Which check failures should return isError: true.
                             // Default: [] (advisory only — nothing fails by default).
})
```

**Return Structure:**

```typescript
{
  scope: string,
  verified_at: string,       // ISO timestamp
  checks: {
    test_coverage: {
      status: "pass" | "warn" | "skip",
      decisions_in_scope: number,
      decisions_with_tested_by: number,
      uncovered: Array<{ decision_id: string, summary: string, affected_files: string[] }>
    },
    warnings: {
      status: "pass" | "warn" | "skip",
      warnings_in_scope: number,
      acknowledged: number,      // Has a relates_to response (finding, answer)
      resolved: number,          // Linked to a superseding entry
      silently_ignored: number,
      ignored_details: Array<{ entry_id: string, summary: string }>
    },
    drift: {
      status: "pass" | "warn" | "skip",
      decisions_checked: number,
      stale: Array<{
        decision_id: string,
        summary: string,
        affected_file: string,
        decision_timestamp: string,
        last_file_modification: string,  // From git log
        modifying_commit: string
      }>
    },
    assembly: {
      status: "pass" | "warn" | "skip",
      decisions_by_agent: number,
      assembled_before: number,
      blind_decisions: Array<{ decision_id: string, summary: string }>
    },
    constraints: {
      status: "pass" | "warn" | "fail" | "skip",
      checkable: number,
      passed: number,
      failed: Array<{ entry_id: string, summary: string, check_command: string, actual: string, expected: string }>
    }
  },
  summary: string            // Human-readable one-paragraph summary for agent consumption
}
```

**Behavior:**

- Each check runs independently. A failure in one check does not prevent others from running.
- `test_coverage` queries the knowledge graph: for each active decision in scope, check if `affected_files` entities have `tested_by` relations. No test execution — this is a graph query, not a test runner.
- `warnings` scans the blackboard for `entry_type: "warning"` in scope, then checks for `relates_to` links from other entries (findings, answers) that reference each warning's `entry_id`.
- `drift` requires git access. For each active decision's `affected_files`, compare the decision's `created_at` timestamp against `git log --format=%aI -1 -- <file>`. Flag if file was modified after decision with no superseding decision.
- `assembly` compares `twining_decide` timestamps for the given `agent_id` against `twining_assemble` invocation timestamps (tracked in the agent registry or a new assembly log). A decision is "blind" if no `twining_assemble` call preceded it in the same agent session.
- `constraints` parses `detail` JSON on `entry_type: "constraint"` blackboard entries looking for `check_command` and `expected` fields. Executes `check_command` via `child_process.execSync` with a 5-second timeout, in the project directory. Compares stdout (trimmed) against `expected`. **Security note:** `check_command` execution must be sandboxed to the project directory and must not allow shell expansion of user-controlled variables. Only constraints posted by the current project's agents should be executable.
- The `summary` field is a natural-language paragraph summarizing the verification results, designed for injection into an agent's context. Example: *"Verification of src/auth/: 3 of 5 decisions have test coverage. 1 warning was silently ignored (entry bb-0042: 'Rate limiting not implemented'). Decision DEC-0017 may be stale — src/auth/middleware.ts was modified 3 days after the decision."*
- The tool auto-posts a `finding` to the blackboard with a summary of verification results, so downstream agents see verification state without needing to re-run the check.

**Implementation Dependencies:**

- `tested_by` relation tracking must be active (P0 roadmap item) before `test_coverage` check is useful.
- `assembly-before-decision` tracking (P1 roadmap item) must be implemented before `assembly` check works.
- Drift detection requires `git` to be available in the project directory. If `git` is not available, the `drift` check returns `status: "skip"`.
- Constraint execution is P2. The tool should ship with `constraints` check returning `status: "skip"` initially, enabled behind a flag.

---

## 6. Integration Patterns

### Pattern 1: Single-Project, Single-Session

**What it is:** One Claude Code session working on one project, with Twining providing persistent memory across context resets.

**How it works:** When the context window fills and Claude Code compacts, decisions and findings survive in `.twining/`. The next turn starts with `twining_assemble` and gets full context. When the user starts a new session tomorrow, `twining_what_changed` catches them up.

**Status:** Works today. This is Twining's simplest and highest-value use case.

### Pattern 2: Single-Project, Multi-Agent

**What it is:** Multiple Claude Code subagents or agent team members working on the same project, coordinating through Twining.

**How it works:** Each subagent calls `twining_assemble` before starting work and sees other agents' decisions and warnings. The main agent reads `twining_recent` between subagent executions to catch warnings. Agents use `twining_delegate` to post capability-typed needs and `twining_handoff` to package results.

**Status:** Works today. Claude Code subagents inherit MCP server connections.

### Pattern 3: Programmatic Agents

**What it is:** Claude Agent SDK agents running in a CI pipeline, review bot, or custom application, coordinating through Twining.

**How it works:** The SDK loads Twining from `.mcp.json`. Each agent instance calls Twining tools through the standard MCP interface. Multiple SDK agents can run in parallel, each assembling context and posting results. Application code manages agent lifecycle and processes Twining state.

**Status:** Works today. The SDK supports MCP natively.

### Pattern 4: Twining + Spec Frameworks (GSD/BMAD)

**What it is:** Using GSD or BMAD for workflow structure (phases, plans, execution tracking) while using Twining for shared state and decision capture.

**How it works:** Twining has built-in GSD awareness:
- `twining_decide` auto-appends decision summaries to `.planning/STATE.md`
- `twining_assemble` includes `.planning/` state (current phase, progress, blockers) in assembled context
- During `/gsd:execute-phase`, agents record architectural choices with `twining_decide` and post findings/warnings to the blackboard
- During `/gsd:verify-work`, `twining_why` confirms decisions are documented

GSD and BMAD are not competing coordination models — they're workflow management tools that produce structured plans. Twining captures the *decisions made during execution* of those plans, which is the part that spec frameworks don't preserve.

**Status:** Works today. The planning bridge reads `.planning/` automatically.

### Pattern 5: Multi-Project Federation

**What it is:** Multiple projects sharing Twining state — decisions in a shared library affecting downstream consumers, monorepo coordination, etc.

**How it works:** It doesn't, yet. Each Twining instance is scoped to a single `.twining/` directory. Cross-project coordination would require a federation layer.

**Status:** Not built. See Section 7.

---

## 7. Gaps to Close

### Verified Against Actual Codebase

The architecture review (`TWINING_ARCH_REVIEW.md`, Feb 2026) identified several divergences from spec. Some have been closed:

| Claim | Status | Evidence |
|-------|--------|----------|
| `twining_decide` never updates knowledge graph | **Fixed** | `src/engine/decisions.ts:251-284` — auto-creates file/function entities with `decided_by` relations |
| `twining_post` accepts `entry_type: "decision"` | **Fixed** | `src/engine/blackboard.ts:52-55` — explicitly blocks with error message directing to `twining_decide` |
| `getRecent` returns oldest-first | **Fixed** | `src/storage/blackboard-store.ts:83` — `.slice(-count).reverse()` returns newest-first |

### Real Remaining Gaps

**No multi-project federation.** Each Twining instance operates on a single `.twining/` directory. There's no mechanism to share decisions across projects, query a "parent" Twining instance, or aggregate state from multiple repos. For monorepos this doesn't matter (one `.twining/`), but for multi-repo architectures it's a real limitation.

**No pending-action processing on startup.** The spec (section 10.7) describes processing `.twining/pending-actions.jsonl` and `.twining/pending-posts.jsonl` during server initialization. This logic is not implemented. Hook-triggered work (like auto-archiving on git commit) is silently dropped.

**Missing end-to-end MCP tool layer tests.** Unit tests cover stores, engines, and embeddings thoroughly (444 tests). But there are no tests that exercise the full MCP tool surface — Zod schema validation, structured error returns, and tool-to-engine wiring. Mismatches between tool schemas and engine assumptions could slip through.

**Integration test strategy:**

The goal is to test the contract between MCP tool schemas and engine behavior — not to test MCP transport (that's the SDK's job). Tests should exercise three layers:

1. **Schema validation tests.** For each tool, submit known-good and known-bad inputs through the Zod schema. Verify that: required fields are enforced, optional fields default correctly, enum values are validated, and malformed inputs produce structured error responses (not crashes). These are table-driven tests: one test file per tool, with a `valid` and `invalid` input array.

2. **Tool-to-engine wiring tests.** For each tool, call the tool handler function directly (bypassing MCP transport) with valid input and verify the response structure matches the documented return type. Key assertions: `twining_decide` returns a decision ID and the decision is findable via `twining_why`; `twining_post` with `entry_type: "decision"` returns an error; `twining_assemble` returns entries sorted by relevance within the token budget; `twining_verify` (once built) returns the documented check structure.

3. **Round-trip scenario tests.** A small number of multi-step scenarios that exercise the agent lifecycle:
   - **Scenario A (decide → assemble):** Post 3 decisions with different scopes. Call `twining_assemble` with a scope matching one decision. Verify only the relevant decision appears.
   - **Scenario B (conflict detection):** Post two decisions in the same domain and overlapping scope. Verify the conflict warning appears on the blackboard and the second decision has `conflicts_with` metadata.
   - **Scenario C (handoff round-trip):** Register an agent, post findings, create a handoff, acknowledge the handoff. Verify the handoff context snapshot contains the findings.
   - **Scenario D (knowledge graph auto-population):** Call `twining_decide` with `affected_files`. Call `twining_neighbors` on the file entity. Verify the `decided_by` relation exists.

All integration tests should use a temporary `.twining/` directory (created in `beforeEach`, cleaned up in `afterEach`) with no shared state between tests. Use vitest (already the project's test runner).

**File organization:** `test/integration/tools/` with one file per tool for schema + wiring tests, and `test/integration/scenarios/` for round-trip tests.

**Planning bridge is read-only.** `twining_assemble` reads `.planning/` state, and `twining_decide` appends to `STATE.md`, but the bridge doesn't write GSD-format plans, create phases, or update progress. Deep GSD integration would require the bridge to also write back structured planning artifacts.

**Context assembly loads everything.** `ContextAssembler` reads the entire decision index and blackboard on every call, then filters and scores in memory. For typical project sizes (<500 entries) this is fast enough. For large `.twining/` states it becomes wasteful. Indexed reads or streaming filters would help.

**Decision file locking incomplete.** `DecisionStore.updateStatus` and `linkCommit` read/overwrite individual decision JSON files without advisory locking. Under concurrent multi-agent writes, this risks JSON corruption. The blackboard (JSONL append) is inherently safer.

**Implementation guidance for decision file locking:**

The fix should use `proper-lockfile` (already a common Node.js advisory locking library) or a similar mechanism. The pattern:

```typescript
import { lock, unlock } from 'proper-lockfile';

async function withDecisionLock<T>(decisionPath: string, fn: () => Promise<T>): Promise<T> {
  const release = await lock(decisionPath, {
    retries: { retries: 5, minTimeout: 50, maxTimeout: 500 },
    stale: 10000  // Consider lock stale after 10s (agent crash recovery)
  });
  try {
    return await fn();
  } finally {
    await release();
  }
}
```

Apply `withDecisionLock` to: `DecisionStore.updateStatus`, `DecisionStore.linkCommit`, and any future method that reads-then-overwrites a decision JSON file. The decision index file (`decisions/index.json`) also needs locking since `twining_decide` appends to it.

Do **not** lock on `twining_decide` creation of new decision files — new files don't have contention. Only lock on read-modify-write operations.

The blackboard's JSONL append (`fs.appendFileSync`) is safe for concurrent use on local filesystems and does not need locking. Confirm this assumption holds for NFS/network mounts if those become a supported deployment target.

**No verification tooling.** The verify step in the agent lifecycle (Section 4) is currently a convention, not a tool. There is no `twining_verify` that checks test coverage for decisions, detects drift between decisions and code, or validates checkable constraints. The `tested_by` relation type exists in the knowledge graph schema but nothing populates or queries it.

**No drift detection.** Decisions record `affected_files` and timestamps, and git records file modification history, but nothing compares the two. Decisions can become stale silently — the rationale describes a state of the code that no longer exists.

**No assembly-before-decision tracking.** Whether an agent assembled context before making decisions is not recorded. Uninformed decisions are indistinguishable from informed ones.

---

## 8. Implementation Roadmap

| Priority | Item | Effort | Impact | Dependencies | Status |
|----------|------|--------|--------|-------------|--------|
| **P0** | MCP tool layer integration tests (schema + wiring + scenarios) | Medium | High | None | Not started |
| **P0** | Decision file locking (`proper-lockfile` on read-modify-write ops) | Low | Medium | None | Not started |
| **P0** | `tested_by` relation tracking + query | Low | High | None | Not started |
| **P0** | Decision conflict resolution (auto-post warning, `conflicts_with` metadata) | Low | High | None | Not started |
| **P1** | Assembly-before-decision tracking (`assembled_before` metadata on decisions) | Low | Medium | None | Not started |
| **P1** | `twining_verify` tool — `test_coverage` + `warnings` checks only | Medium | High | P0: `tested_by` tracking | Not started |
| **P1** | `twining_verify` — `assembly` check | Low | Medium | P1: assembly tracking | Not started |
| **P1** | Pending-action processing on startup | Medium | Medium | None | Not started |
| **P1** | Indexed reads for context assembly | Medium | High (at scale) | None | Not started |
| **P1** | Planning bridge write-back | Medium | Medium | None | Not started |
| **P2** | `twining_verify` — `drift` check (git integration) | Medium | High | P1: verify tool exists | Not started |
| **P2** | `twining_verify` — `constraints` check (command execution, sandboxed) | High | Medium | P1: verify tool exists | Not started |
| **P2** | Multi-project federation design | High | High | None | Not started |
| **P2** | Claude Agent SDK example project | Low | High (adoption) | None | Not started |
| **P2** | Strands Agents integration example | Low | Medium (adoption) | None | Not started |
| **P3** | SBP interoperability layer | High | Low | None | Not started |
| **P3** | Relevance algorithm improvements | High | Medium | None | Ongoing |

---

## 9. Sources

### Academic Papers

- Hayes-Roth, B. (1985). "A Blackboard Architecture for Control." *Artificial Intelligence*, 26(3), 251–321. [Semantic Scholar](https://www.semanticscholar.org/paper/A-Blackboard-Architecture-for-Control-Hayes-Roth/c79a41dc13c796c26388f8cbf599c67126374e39)
- "Exploring Advanced LLM Multi-Agent Systems Based on Blackboard Architecture." (2025). [arXiv:2507.01701](https://arxiv.org/abs/2507.01701)
- Krishnan, N. (2025). "Advancing Multi-Agent Systems Through Model Context Protocol: Architecture, Implementation, and Applications." [arXiv:2504.21030](https://arxiv.org/abs/2504.21030)

### Framework Documentation

- [Claude Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) — Anthropic
- [Claude Code Subagents](https://code.claude.com/docs/en/sub-agents) — Anthropic
- [Claude Code Agent Teams](https://code.claude.com/docs/en/agent-teams) — Anthropic
- [Strands Agents SDK](https://aws.amazon.com/blogs/opensource/introducing-strands-agents-an-open-source-ai-agents-sdk/) — AWS
- [Strands Agents & MCP](https://aws.amazon.com/blogs/opensource/open-protocols-for-agent-interoperability-part-3-strands-agents-mcp/) — AWS
- [Multi-Agent Collaboration with Strands](https://aws.amazon.com/blogs/devops/multi-agent-collaboration-with-strands/) — AWS
- [SBP — Stigmergic Blackboard Protocol](https://github.com/AdviceNXT/sbp) — AdviceNXT
- [OpenHands Software Agent SDK](https://arxiv.org/html/2511.03690v1) — All-Hands-AI
- [OpenHands Sub-Agent Delegation](https://docs.openhands.dev/sdk/guides/agent-delegation) — All-Hands-AI
- [LangGraph](https://www.langchain.com/langgraph) — LangChain
- [AG2 Docs](https://docs.ag2.ai/) — AG2AI
- [CrewAI MCP Integration](https://docs.crewai.com/en/mcp/overview) — CrewAI
- [Agency-Swarm](https://github.com/VRSEN/agency-swarm) — VRSEN

### Industry Analysis

- Fowler, C. (2025). "Relocating Rigor: AI Coding and Disciplined Systems." [Leaflet](https://aicoding.leaflet.pub/3mbrvhyye4k2e)
- Falconer, S. & Sellers, A. (2025). "A Distributed State of Mind: Event-Driven Multi-Agent Systems." [InfoWorld](https://www.infoworld.com/article/3808083/a-distributed-state-of-mind-event-driven-multi-agent-systems.html), republished on [Confluent Blog](https://www.confluent.io/blog/event-driven-multi-agent-systems/)
- Petelin, D. (2025). "Building Intelligent Multi-Agent Systems with MCPs and the Blackboard Pattern." [Medium](https://medium.com/@dp2580/building-intelligent-multi-agent-systems-with-mcps-and-the-blackboard-pattern-to-build-systems-a454705d5672)

### Twining Internal References

- `TWINING-DESIGN-SPEC.md` — Authoritative design specification
- `src/utils/types.ts` — Ground truth for all data schemas
- `src/engine/decisions.ts:251-284` — Knowledge graph auto-population
- `src/engine/blackboard.ts:52-55` — Decision entry blocking
- `src/storage/blackboard-store.ts:83` — Newest-first ordering
- `docs/CLAUDE_TEMPLATE.md` — Integration template for other projects