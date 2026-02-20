"""
Code Review Agent using Claude Code SDK + Twining MCP

Demonstrates the full Twining lifecycle:
  1. Assemble context for the target scope
  2. Review code and identify issues
  3. Post findings and warnings to the blackboard
  4. Record decisions with rationale
  5. Create a handoff for follow-up work

Usage:
    python review-agent.py <scope>

Examples:
    python review-agent.py src/storage/
    python review-agent.py src/engine/context-assembler.ts
    python review-agent.py project
"""

import asyncio
import sys
from pathlib import Path

from claude_code_sdk import ClaudeCodeOptions, query


# Agent identity -- used in Twining posts and handoffs so other agents
# can trace which agent produced which records.
AGENT_ID = "review-agent"


async def assemble_context(scope: str, cwd: str) -> str:
    """
    Step 1: Gather existing Twining context before starting work.

    This is the most important step. Without it, the agent has no knowledge
    of prior decisions, warnings, or architectural context. It would risk
    duplicating work or contradicting existing decisions.
    """
    prompt = f"""You are a code review agent (agent_id: {AGENT_ID}).

Before reviewing any code, gather context for the scope "{scope}".

1. Call twining_assemble with task="Code review of {scope}" and scope="{scope}"
   to get relevant decisions, warnings, needs, and graph entities.

2. Call twining_why with scope="{scope}" to understand the decision history
   for this area of the codebase.

3. Summarize what you learned:
   - What decisions already exist for this scope?
   - Are there any warnings or constraints to be aware of?
   - What patterns or conventions are established?

Report your findings as a structured summary. Do NOT modify any files."""

    messages = []
    async for message in query(
        prompt=prompt,
        options=ClaudeCodeOptions(
            allowed_tools=[
                "mcp__twining__twining_assemble",
                "mcp__twining__twining_why",
                "mcp__twining__twining_read",
                "mcp__twining__twining_recent",
            ],
            cwd=cwd,
        ),
    ):
        messages.append(message)

    # Extract the final text response from Claude's messages.
    # Messages with type "result" contain the assistant's final answer.
    result_text = _extract_result(messages)
    print("\n--- Context Assembly Complete ---")
    print(result_text[:2000])  # Truncate for readability in terminal
    return result_text


async def review_code(scope: str, context_summary: str, cwd: str) -> str:
    """
    Step 2: Perform the actual code review.

    The agent reads source files within the scope and analyzes them for:
    - Code quality issues (complexity, duplication, error handling)
    - Architectural concerns (coupling, separation of concerns)
    - Consistency with established patterns (from the context assembly)
    - Potential bugs or edge cases
    """
    prompt = f"""You are a code review agent (agent_id: {AGENT_ID}).

You have already gathered context for "{scope}". Here is what you know:

<context>
{context_summary}
</context>

Now perform a thorough code review of the files in scope "{scope}":

1. Read the relevant source files in the scope.
2. Analyze them for:
   - Code quality: complexity, readability, error handling, naming
   - Architecture: coupling, cohesion, separation of concerns
   - Consistency: does the code follow the patterns and decisions you found in context?
   - Bugs: potential edge cases, race conditions, missing validation
3. For each issue found, note:
   - Severity (critical / warning / suggestion)
   - File and approximate location
   - Description of the issue
   - Suggested fix or improvement

Produce a structured review report. Do NOT modify any files."""

    messages = []
    async for message in query(
        prompt=prompt,
        options=ClaudeCodeOptions(
            allowed_tools=[
                "Read",  # Allow reading source files
                "Glob",  # Allow finding files by pattern
                "Grep",  # Allow searching file contents
            ],
            cwd=cwd,
        ),
    ):
        messages.append(message)

    result_text = _extract_result(messages)
    print("\n--- Code Review Complete ---")
    print(result_text[:2000])
    return result_text


async def post_findings(scope: str, review_report: str, cwd: str) -> str:
    """
    Step 3: Record findings and warnings on the Twining blackboard.

    This makes the review results visible to other agents and future sessions.
    Findings are informational; warnings flag things that could cause problems
    if someone changes the code without understanding them.
    """
    prompt = f"""You are a code review agent (agent_id: {AGENT_ID}).

You have completed a code review of "{scope}". Here is your review report:

<review_report>
{review_report}
</review_report>

Now record your findings on the Twining blackboard:

1. For each significant finding, call twining_post with:
   - entry_type: "finding" (for informational observations)
   - OR entry_type: "warning" (for issues that could cause problems)
   - summary: A concise one-line description (max 200 chars)
   - detail: Full context and explanation
   - scope: "{scope}"
   - tags: ["code-review", "{AGENT_ID}"] plus any relevant domain tags
   - agent_id: "{AGENT_ID}"

2. If you identified work that needs to be done, post those as needs:
   - entry_type: "need"
   - Include enough detail for another agent to act on it

3. Keep the number of posts reasonable -- group related minor issues into
   a single finding rather than posting one per line of code.

Report what you posted (entry IDs and summaries)."""

    messages = []
    async for message in query(
        prompt=prompt,
        options=ClaudeCodeOptions(
            allowed_tools=["mcp__twining__twining_post"],
            cwd=cwd,
        ),
    ):
        messages.append(message)

    result_text = _extract_result(messages)
    print("\n--- Findings Posted ---")
    print(result_text[:2000])
    return result_text


async def record_decisions(scope: str, review_report: str, cwd: str) -> str:
    """
    Step 4: Record any architectural decisions or recommendations.

    Not every review finding deserves a decision record. Decisions are for
    choices with meaningful alternatives and tradeoffs -- things where the
    "why" matters for future maintainers.
    """
    prompt = f"""You are a code review agent (agent_id: {AGENT_ID}).

Based on your code review of "{scope}":

<review_report>
{review_report}
</review_report>

If you identified any non-trivial architectural observations or recommendations
that warrant a formal decision record, capture them now:

1. Call twining_decide for each significant recommendation with:
   - domain: appropriate domain (e.g., "architecture", "implementation", "security")
   - scope: "{scope}"
   - summary: One-line decision statement
   - context: What prompted this observation
   - rationale: Why this is the right approach
   - alternatives: At least one alternative you considered and why you rejected it
   - confidence: "high", "medium", or "low"
   - agent_id: "{AGENT_ID}"
   - affected_files: List of files this applies to

2. Only record decisions for genuinely important observations. Skip trivial
   style or naming issues -- those belong in findings, not decisions.

3. If you have no observations that rise to the level of a decision, that is
   fine. Just say so.

Report what decisions you recorded (if any)."""

    messages = []
    async for message in query(
        prompt=prompt,
        options=ClaudeCodeOptions(
            allowed_tools=[
                "mcp__twining__twining_decide",
                "mcp__twining__twining_search_decisions",
            ],
            cwd=cwd,
        ),
    ):
        messages.append(message)

    result_text = _extract_result(messages)
    print("\n--- Decisions Recorded ---")
    print(result_text[:2000])
    return result_text


async def create_handoff(
    scope: str, review_report: str, findings_summary: str, cwd: str
) -> str:
    """
    Step 5: Create a handoff for follow-up work.

    The handoff packages up everything this agent did into a structured
    record that another agent (or a human) can pick up. It includes:
    - What was reviewed and what was found
    - What's completed vs. what still needs work
    - Auto-assembled context snapshot from Twining
    """
    prompt = f"""You are a code review agent (agent_id: {AGENT_ID}).

You have completed a code review of "{scope}" and posted findings.

Review summary:
<review_report>
{review_report}
</review_report>

Findings posted:
<findings>
{findings_summary}
</findings>

Now create a handoff so another agent or human can act on the review results:

1. Call twining_handoff with:
   - source_agent: "{AGENT_ID}"
   - summary: "Code review of {scope} -- [brief outcome summary]"
   - scope: "{scope}"
   - results: An array of result objects, each with:
     - description: What was done or found
     - status: "completed" for the review itself, "partial" or "blocked" for items needing follow-up
     - notes: Any additional context

2. The handoff should make it clear what follow-up actions are needed
   (if any) and what the overall health of the reviewed code is.

Report the handoff ID when complete."""

    messages = []
    async for message in query(
        prompt=prompt,
        options=ClaudeCodeOptions(
            allowed_tools=[
                "mcp__twining__twining_handoff",
                "mcp__twining__twining_post",
            ],
            cwd=cwd,
        ),
    ):
        messages.append(message)

    result_text = _extract_result(messages)
    print("\n--- Handoff Created ---")
    print(result_text[:2000])
    return result_text


def _extract_result(messages: list) -> str:
    """
    Extract the final text content from Claude's response messages.

    The Claude Code SDK returns a list of Message objects. We look for
    the result message (type="result") which contains the assistant's
    final answer. If not found, we concatenate all text content.
    """
    # Look for result-type messages first
    for message in messages:
        if message.type == "result":
            if isinstance(message.content, str):
                return message.content
            if isinstance(message.content, list):
                texts = []
                for block in message.content:
                    if hasattr(block, "text"):
                        texts.append(block.text)
                if texts:
                    return "\n".join(texts)

    # Fallback: collect all text content from all messages
    texts = []
    for message in messages:
        if isinstance(message.content, str):
            texts.append(message.content)
        elif isinstance(message.content, list):
            for block in message.content:
                if hasattr(block, "text"):
                    texts.append(block.text)
    return "\n".join(texts) if texts else "(no text output)"


async def run_review(scope: str, cwd: str) -> None:
    """
    Orchestrate the full review pipeline.

    Each step feeds its output into the next, building up context as we go.
    This sequential approach ensures each step has the information it needs
    while keeping individual Claude queries focused and manageable.
    """
    print(f"Starting code review of: {scope}")
    print(f"Working directory: {cwd}")
    print("=" * 60)

    # Step 1: Gather existing context
    print("\n[1/5] Assembling Twining context...")
    context_summary = await assemble_context(scope, cwd)

    # Step 2: Perform the review
    print("\n[2/5] Reviewing code...")
    review_report = await review_code(scope, context_summary, cwd)

    # Step 3: Post findings to blackboard
    print("\n[3/5] Posting findings to Twining blackboard...")
    findings_summary = await post_findings(scope, review_report, cwd)

    # Step 4: Record any decisions
    print("\n[4/5] Recording decisions...")
    await record_decisions(scope, review_report, cwd)

    # Step 5: Create handoff
    print("\n[5/5] Creating handoff...")
    await create_handoff(scope, review_report, findings_summary, cwd)

    print("\n" + "=" * 60)
    print("Review complete. All findings, decisions, and handoff are")
    print("recorded in Twining. Run `twining_recent` or check the")
    print("Twining dashboard to see the results.")


def main():
    if len(sys.argv) < 2:
        print("Usage: python review-agent.py <scope>")
        print()
        print("Examples:")
        print("  python review-agent.py src/storage/")
        print("  python review-agent.py src/engine/context-assembler.ts")
        print("  python review-agent.py project")
        sys.exit(1)

    scope = sys.argv[1]

    # Resolve the working directory. The agent needs to run in a project
    # root that has Twining initialized (a .twining/ directory).
    # Default to the current working directory.
    cwd = str(Path.cwd())

    asyncio.run(run_review(scope, cwd))


if __name__ == "__main__":
    main()
