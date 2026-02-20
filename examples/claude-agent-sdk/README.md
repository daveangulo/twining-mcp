# Claude Agent SDK + Twining Example

A code review agent built with the [Claude Code SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) that demonstrates the full Twining MCP lifecycle: context assembly, code review, finding capture, decision recording, and handoff creation.

## What This Demonstrates

The review agent walks through a complete Twining workflow:

1. **Assemble context** -- Gathers relevant decisions, warnings, and knowledge graph entities for the target scope before starting work
2. **Review code** -- Reads and analyzes source files, checking for issues, patterns, and architectural concerns
3. **Post findings** -- Records discoveries and warnings on the Twining blackboard so other agents (or future sessions) can see them
4. **Record decisions** -- Captures architectural observations and review judgments with full rationale and alternatives considered
5. **Create handoff** -- Produces a structured handoff summarizing review results and follow-up work for the next agent

This is the pattern any autonomous agent should follow when working on a Twining-enabled codebase: always start with context, always leave a trail.

## Prerequisites

- **Python 3.10+**
- **Claude Code** installed and authenticated (`claude` CLI available on PATH)
- **claude-code-sdk** Python package
- **A Twining-enabled project** -- any project with a `.twining/` directory (run `twining-mcp --project /path/to/project` once to initialize)

## Installation

```bash
cd examples/claude-agent-sdk
pip install -r requirements.txt
```

Or with a virtual environment:

```bash
cd examples/claude-agent-sdk
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## Usage

Run the review agent against a scope in your project:

```bash
# Review a specific directory
python review-agent.py src/storage/

# Review a specific file
python review-agent.py src/engine/context-assembler.ts

# Review the whole project (broad scope)
python review-agent.py project
```

The agent will use Claude to:
- Read the Twining context for that scope
- Analyze the code and identify issues or patterns
- Record everything back into Twining for future agents

## How It Works

The script uses `claude_code_sdk.query()` to send prompts to Claude Code, which has access to Twining MCP tools via the `.mcp.json` configuration in this directory. Each step is a separate query call with a focused prompt, demonstrating how to orchestrate multi-step agent workflows.

The `allowed_tools` parameter restricts Claude to only Twining MCP tools (plus file reading), keeping the agent focused and predictable.

## Adapting for Your Own Agents

The review agent is a starting point. You can adapt the pattern for:

- **Migration agents** -- Assemble context, make changes, record decisions about migration strategy
- **Test generation agents** -- Read code structure from the knowledge graph, generate tests, post coverage findings
- **Refactoring agents** -- Check decision history with `twining_why` before refactoring, record new decisions after
- **Documentation agents** -- Query the knowledge graph for entity relationships, generate docs, post artifacts

The key principle: **context in, decisions out**. Every agent should consume Twining context before acting and produce Twining records after acting.
