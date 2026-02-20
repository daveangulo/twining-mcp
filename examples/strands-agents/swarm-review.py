#!/usr/bin/env python3
"""
Strands Agents + Twining MCP: Collaborative Code Review

Demonstrates two Strands agents sharing state through Twining for
collaborative code review. Agent A reviews auth code and hands off
to Agent B, which reviews database code.

Both agents coordinate through Twining's blackboard, decisions, and
handoff tools -- no direct communication between agents is needed.

Usage:
    python swarm-review.py
"""

from strands import Agent
from strands.tools.mcp import MCPClient


# ---------------------------------------------------------------------------
# MCP client configuration
# ---------------------------------------------------------------------------
# MCPClient connects to the Twining MCP server defined in .mcp.json.
# All Twining tools (twining_assemble, twining_post, twining_decide, etc.)
# become available as callable tools for the Strands agents.
mcp_client = MCPClient(
    command="twining-mcp",
    args=["--project", "."],
)


# ---------------------------------------------------------------------------
# System prompts
# ---------------------------------------------------------------------------
AUTH_REVIEWER_PROMPT = """\
You are an expert authentication and authorization code reviewer.
You have access to Twining MCP tools for coordinating with other reviewers.

Your workflow:
1. Use twining_assemble to gather context before starting your review
2. Review the authentication module code thoroughly
3. Post important findings to the Twining blackboard using twining_post
4. Record any architectural decisions or recommendations using twining_decide
5. When done, create a handoff for the next reviewer using twining_handoff

Focus on:
- Authentication flow correctness
- Token validation and expiration
- Session management security
- Input validation on auth endpoints
- Credential storage practices

Always provide concrete, actionable feedback with file and line references.
"""

DB_REVIEWER_PROMPT = """\
You are an expert database and data access layer code reviewer.
You have access to Twining MCP tools for coordinating with other reviewers.

Your workflow:
1. Use twining_assemble to gather context -- this will include findings from
   previous reviewers so you can build on their work
2. Review the database module code thoroughly
3. Record architectural decisions or recommendations using twining_decide
4. Delegate any remaining work that needs a different specialist using twining_delegate

Focus on:
- Query efficiency and N+1 problems
- SQL injection prevention
- Transaction handling and isolation levels
- Connection pool configuration
- Migration safety and rollback paths
- Data validation before persistence

Always provide concrete, actionable feedback with file and line references.
"""


# ---------------------------------------------------------------------------
# Agent task prompts
# ---------------------------------------------------------------------------
AGENT_A_TASK = """\
You are reviewing a web application's authentication system. Perform a
thorough code review by following these steps:

Step 1 -- Assemble context:
  Call twining_assemble with task="Code review of authentication module"
  and scope="src/auth/" to see any prior decisions or warnings.

Step 2 -- Post your key findings:
  For each significant finding, call twining_post with:
  - entry_type: "finding" for observations
  - entry_type: "warning" for security concerns
  - scope: the relevant file path (e.g. "src/auth/jwt.ts")
  - tags: ["code-review", "auth"]

  Example findings to post:
  - "Auth middleware does not validate token expiration on refresh endpoint"
  - "Password hashing uses bcrypt with cost factor 10, consider increasing to 12"

Step 3 -- Record a decision:
  Call twining_decide to record your top recommendation:
  - domain: "security"
  - scope: "src/auth/"
  - summary: your main recommendation
  - context: what you found during review
  - rationale: why this matters
  - confidence: "high", "medium", or "low"
  - Include at least one alternative in the alternatives array

Step 4 -- Hand off to the database reviewer:
  Call twining_handoff with:
  - source_agent: "auth-reviewer"
  - target_agent: "db-reviewer"
  - summary: a brief summary of your review findings
  - results: an array with one entry describing what you completed

Summarize your complete review at the end.
"""

AGENT_B_TASK = """\
You are reviewing a web application's database layer. Another reviewer
has already examined the authentication code and may have left relevant
findings. Follow these steps:

Step 1 -- Assemble context:
  Call twining_assemble with task="Code review of database layer"
  and scope="src/db/" to see prior decisions and findings from other
  reviewers. Pay attention to any warnings or findings -- the auth
  reviewer may have noted issues that affect the database layer.

Step 2 -- Record a decision:
  Call twining_decide to record your main recommendation:
  - domain: "performance"
  - scope: "src/db/"
  - summary: your recommendation for the database layer
  - context: what you observed (including anything relevant from the
    auth reviewer's findings)
  - rationale: why this matters
  - confidence: "high", "medium", or "low"
  - Include at least one alternative in the alternatives array

Step 3 -- Delegate remaining work:
  Call twining_delegate with:
  - summary: "Performance profiling needed for slow database queries"
  - required_capabilities: ["database", "performance-testing"]
  - urgency: "normal"
  - scope: "src/db/"

Summarize your complete review at the end, noting how you built on
the auth reviewer's findings.
"""


# ---------------------------------------------------------------------------
# Main: run the two-agent swarm review
# ---------------------------------------------------------------------------
def main():
    # Use MCPClient as a context manager so the Twining server is started
    # and stopped cleanly. All Twining tools are available inside the block.
    with mcp_client:
        tools = mcp_client.list_tools_sync()
        print(f"Connected to Twining MCP -- {len(tools)} tools available\n")

        # ---------------------------------------------------------------
        # Agent A: Auth Reviewer
        # ---------------------------------------------------------------
        print("=" * 60)
        print("AGENT A: Authentication Reviewer")
        print("=" * 60)

        agent_a = Agent(
            model="us.anthropic.claude-sonnet-4-20250514",
            tools=tools,
            system_prompt=AUTH_REVIEWER_PROMPT,
        )

        # Run Agent A's review. The agent will call Twining tools as
        # instructed: assemble context, post findings, record a decision,
        # and create a handoff for Agent B.
        response_a = agent_a(AGENT_A_TASK)
        print(f"\nAgent A completed:\n{response_a}\n")

        # ---------------------------------------------------------------
        # Agent B: Database Reviewer
        # ---------------------------------------------------------------
        print("=" * 60)
        print("AGENT B: Database Reviewer")
        print("=" * 60)

        agent_b = Agent(
            model="us.anthropic.claude-sonnet-4-20250514",
            tools=tools,
            system_prompt=DB_REVIEWER_PROMPT,
        )

        # Run Agent B's review. When it calls twining_assemble, it will
        # see Agent A's findings, warnings, and decisions -- enabling it
        # to build on the previous review without any direct communication.
        response_b = agent_b(AGENT_B_TASK)
        print(f"\nAgent B completed:\n{response_b}\n")

        # ---------------------------------------------------------------
        # Summary
        # ---------------------------------------------------------------
        print("=" * 60)
        print("SWARM REVIEW COMPLETE")
        print("=" * 60)
        print(
            "Both agents have posted their findings to Twining.\n"
            "Use the Twining dashboard (http://localhost:24282) to view:\n"
            "  - Blackboard entries from both reviewers\n"
            "  - Decision records with rationale\n"
            "  - Handoff and delegation records\n"
        )


if __name__ == "__main__":
    main()
