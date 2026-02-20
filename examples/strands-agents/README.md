# Strands Agents + Twining MCP: Collaborative Code Review

This example demonstrates two [Strands Agents](https://github.com/strands-agents/sdk-python) sharing state through Twining MCP for collaborative code review. Agent A reviews authentication code and hands off to Agent B, which reviews database code -- both coordinating through Twining's blackboard, decisions, and handoff tools.

## Prerequisites

- **Python 3.10+**
- **[strands-agents](https://pypi.org/project/strands-agents/)** -- the Strands Agents SDK
- **[strands-agents-tools-mcp](https://pypi.org/project/strands-agents-tools-mcp/)** -- MCP tool integration for Strands
- **Twining MCP server** installed globally (`npm install -g twining-mcp`) or available on PATH
- **A Twining-enabled project** -- the `.mcp.json` in this directory is pre-configured

## Installation

```bash
cd examples/strands-agents
pip install -r requirements.txt
```

Or install directly:

```bash
pip install strands-agents strands-agents-tools-mcp
```

## Running the Swarm Review

```bash
python swarm-review.py
```

This will:

1. Start a Twining MCP server connected to the local `.twining/` directory
2. Launch **Agent A** (auth reviewer) which:
   - Assembles context from Twining
   - Reviews authentication module code
   - Posts findings and warnings to the blackboard
   - Records architectural decisions
   - Creates a handoff for Agent B with review results
3. Launch **Agent B** (database reviewer) which:
   - Assembles context (automatically sees Agent A's findings via Twining)
   - Reviews database module code
   - Records its own decisions
   - Delegates remaining work for follow-up

## What This Demonstrates

- **Shared state via Twining blackboard**: Agent A posts findings that Agent B sees when it assembles context
- **Structured decision capture**: Both agents record decisions with rationale and alternatives
- **Agent handoff**: Agent A hands off work to Agent B with a context snapshot
- **Delegation**: Agent B delegates remaining work, describing capability requirements
- **Context assembly**: Each agent starts by assembling relevant context, so it begins informed

## Architecture

```
+-------------------+       +-------------------+
|    Agent A        |       |    Agent B        |
| (Auth Reviewer)   |       | (DB Reviewer)     |
+--------+----------+       +--------+----------+
         |                           |
         |   twining_post            |   twining_assemble
         |   twining_decide          |   twining_decide
         |   twining_handoff         |   twining_delegate
         |                           |
         +----------+    +-----------+
                    |    |
              +-----v----v-----+
              |  Twining MCP   |
              |  (shared state)|
              +----------------+
```

## Adapting for Your Project

To use this pattern in your own project:

1. Copy `.mcp.json` to your project root (adjust the `--project` path if needed)
2. Customize the agent system prompts for your review criteria
3. Adjust the task prompts to point at your actual source files
4. Add more agents for additional review dimensions (security, performance, etc.)
