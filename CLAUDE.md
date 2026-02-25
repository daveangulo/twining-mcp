# Claude Code Project Instructions

## MANDATORY: Task Lifecycle Gates

IMPORTANT: These gates are BLOCKING REQUIREMENTS. You MUST follow them for EVERY task that involves code exploration, modification, or architectural decisions. These override all other instructions.

### Gate 1: Context Assembly (BEFORE any code exploration or modification)

You MUST call `twining_assemble` with your task description and relevant scope BEFORE reading code, exploring files, or making any changes. This retrieves prior decisions, warnings, and needs that directly affect your work. Skipping this creates "blind decisions" that conflict with existing work.

- ALWAYS call `twining_assemble` as your FIRST action on any task
- ALWAYS call `twining_why` on files you intend to modify
- NEVER start writing code without checking for `warning` entries in your scope

### Gate 2: Decision Recording (AFTER any non-trivial choice)

You MUST call `twining_decide` for any architectural, design, or implementation choice where alternatives exist. NEVER make a significant choice silently.

- ALWAYS include rationale and at least one rejected alternative
- ALWAYS post `finding` entries for surprising discoveries
- ALWAYS post `warning` entries for gotchas future agents should know
- ALWAYS post `need` entries for follow-up work you identify but won't do
- NEVER use `twining_post` with `entry_type: "decision"` — ALWAYS use `twining_decide`

### Gate 3: Verification (BEFORE completing or handing off work)

You MUST call `twining_verify` on your working scope before telling the user the task is done. NEVER skip verification.

- ALWAYS link tests to decisions via `twining_add_relation` with `type: "tested_by"`
- ALWAYS post a `status` entry summarizing what you did
- ALWAYS use `twining_link_commit` to associate decisions with git commits after committing
- ALWAYS address or explicitly acknowledge any warnings surfaced during assembly

---

## Serena MCP Best Practices

This project uses the Serena MCP server for intelligent code navigation and editing. Follow these guidelines to maximize efficiency.

### Code Navigation Principles

**Prefer symbolic tools over file reads:**
- Use `get_symbols_overview` first to understand a file's structure
- Use `find_symbol` with `include_body=false` to explore before reading
- Only use `include_body=true` when you need the actual implementation
- Avoid reading entire files unless absolutely necessary

**Symbol discovery workflow:**
1. Start with `get_symbols_overview` for file structure
2. Use `find_symbol` with `depth=1` to see class members
3. Use `find_referencing_symbols` to understand usage patterns
4. Only then read specific symbol bodies you need

### Search Strategy

**Use the right tool for the job:**
- `find_symbol` - When you know the symbol name (supports substring matching)
- `search_for_pattern` - For arbitrary text patterns, non-code files, or unknown symbol names
- `find_file` - When looking for files by name/mask
- `list_dir` - For directory structure exploration

**Pattern search tips:**
- Always pass `relative_path` when you know the scope
- Use `restrict_search_to_code_files=true` for code-only searches
- Use `context_lines_before/after` sparingly to save tokens

### Editing Guidelines

**Symbol-based editing (preferred):**
- Use `replace_symbol_body` for modifying entire methods/functions/classes
- Use `insert_after_symbol` to add code after a symbol
- Use `insert_before_symbol` to add imports or code before a symbol
- Always check references with `find_referencing_symbols` before renaming

**When to use file-based editing:**
- Small inline changes within a large method
- Non-code files (config, markdown, etc.)
- Files without clear symbol structure

### Memory System

**Reading memories:**
- Check `list_memories` for available project knowledge
- Read memories that match your current task
- Don't read the same memory twice in a conversation

**Writing memories:**
- Document architectural decisions
- Record project-specific patterns and conventions
- Save information useful for future tasks

### Efficiency Tips

1. **Be incremental:** Don't read more than you need
2. **Use depth parameter:** Control how deep to explore symbol trees
3. **Scope your searches:** Always provide `relative_path` when possible
4. **Trust tool results:** Don't verify successful operations unnecessarily
5. **Batch related operations:** Make multiple independent calls in parallel

### Java-Specific Guidelines

This is a Java project. Keep in mind:
- Class names match file names
- Use name paths like `ClassName/methodName` for methods
- Constructors are named `<init>` in symbol trees
- Inner classes use `OuterClass/InnerClass` paths

### Common Workflows

**Understanding a class:**
```
1. get_symbols_overview(relative_path="path/to/Class.java")
2. find_symbol(name_path="ClassName", depth=1, include_body=false)
3. find_symbol(name_path="ClassName/specificMethod", include_body=true)
```

**Finding usage of a method:**
```
1. find_referencing_symbols(name_path="methodName", relative_path="path/to/file.java")
```

**Adding a new method to a class:**
```
1. find_symbol(name_path="ClassName/lastMethod", relative_path="...")
2. insert_after_symbol(name_path="ClassName/lastMethod", body="new method code")
```

**Safe refactoring:**
```
1. find_referencing_symbols to understand all usages
2. Make changes ensuring backward compatibility OR update all references
3. Use rename_symbol for consistent renaming across codebase
```

---

## Twining Coordination — Workflow Details

This project uses [Twining](https://github.com/twining-mcp/twining-mcp) for shared agent coordination. The mandatory gates above define WHEN to use Twining. This section defines HOW.

IMPORTANT: Twining is configured as an MCP server. State lives in `.twining/`, is plain-text, git-diffable, and `jq`-queryable.

### Core Workflow: Think Before Acting, Decide After Acting

#### Before modifying code (BLOCKING — do NOT proceed without these):
1. You MUST call `twining_assemble` with your task description and scope to get relevant decisions, warnings, needs, and graph entities within a token budget
2. You MUST call `twining_why` on the file/module you're about to change to understand prior decision rationale
3. You MUST check for `warning` entries in your scope — these are gotchas left by previous agents

#### While working:
- ALWAYS post `finding` entries for anything surprising or noteworthy
- ALWAYS post `warning` entries for gotchas the next agent should know about
- ALWAYS post `need` entries for follow-up work you identify but won't do now
- Post `status` entries for progress updates on long-running work

#### After making significant changes:
- You MUST call `twining_decide` for any architectural or non-trivial choice — ALWAYS include rationale and at least one rejected alternative
- You MUST post a `status` entry summarizing what you did
- You MUST use `twining_link_commit` to associate decisions with git commits

#### Before handing off or completing work (BLOCKING — do NOT skip):
- You MUST call `twining_verify` to check test coverage, unresolved warnings, drift, and assembly hygiene
- You MUST link tests to decisions via `twining_add_relation` with `type: "tested_by"` for decisions affecting testable code
- You MUST address or explicitly acknowledge any warnings surfaced during assembly

### Blackboard Entry Types

Use the right type for each post:

| Type | When to use |
|------|-------------|
| `finding` | Something discovered that others should know |
| `warning` | A gotcha, risk, or "don't do X because Y" |
| `need` | Work that should be done by someone |
| `question` | Something you need answered (another agent may respond) |
| `answer` | Response to a question (use `relates_to` to link to the question ID) |
| `status` | Progress update on work in progress |
| `offer` | Capability or resource you can provide |
| `artifact` | Reference to a produced artifact (schema, export, doc) |
| `constraint` | A hard requirement or limitation that must be respected |

### Decision Conventions

**Confidence levels:**
- `high` — Well-researched, strong rationale, tested or proven
- `medium` — Reasonable choice, some uncertainty remains
- `low` — Best guess, needs validation, may be revised

**Domains** (use consistently): `architecture`, `implementation`, `testing`, `deployment`, `security`, `performance`, `api-design`, `data-model`

**Provisional decisions** are flagged for review. Always check decision status before relying on a provisional decision. Use `twining_reconsider` to flag a decision for re-evaluation with new context.

### Scope Conventions

Scopes use path-prefix semantics:
- `"project"` — matches everything (broadest, use sparingly)
- `"src/auth/"` — matches anything under the auth module
- `"src/auth/jwt.ts"` — matches a specific file

IMPORTANT: Use the narrowest scope that fits. NEVER use `"project"` scope unless the decision truly affects the entire codebase.

### Anti-patterns — NEVER do these

- NEVER skip `twining_assemble` before starting work. You'll miss decisions, warnings, and context that prevent wasted effort.
- NEVER skip `twining_verify` before handoff. It catches uncovered decisions, unresolved warnings, and blind decisions.
- NEVER use `"project"` scope for everything. Narrow scopes make assembly relevant and reduce noise.
- NEVER record trivial decisions. Variable renames don't need decision records. Reserve for choices with alternatives and tradeoffs.
- NEVER ignore conflict warnings. When `twining_decide` detects a conflict, investigate and resolve explicitly via `twining_override` or `twining_reconsider`.
- NEVER forget `relates_to`. Link answers to questions, warnings to decisions, conflict resolutions to conflicting decisions.
- NEVER use `twining_post` for decisions. ALWAYS use `twining_decide`.

### Context Window Handoff

When approaching context limits, use `twining_export` to produce a self-contained markdown document with all decisions, entries, and graph state for a scope. Start a new conversation and provide the export as context.

### Dashboard

The web dashboard runs on port 24282 by default with read-only views of blackboard, decisions, knowledge graph, and agents. Configure with environment variables:
- `TWINING_DASHBOARD=0` — disable entirely
- `TWINING_DASHBOARD_NO_OPEN=1` — prevent auto-opening browser
- `TWINING_DASHBOARD_PORT=<port>` — change the port

For full Twining tool reference (all tools, multi-agent patterns, delegation/handoff examples, verification details), see `docs/TWINING-REFERENCE.md`.

---

## Serena + Twining Integration

When Serena MCP tools are available alongside Twining, use them together for deeper code understanding and richer knowledge graph enrichment.

### Before Code Changes: Understand Structure

Use Serena's symbolic tools to understand code before modifying it:

```
# Get file overview without reading entire file
serena.get_symbols_overview("src/auth/middleware.ts", depth=1)

# Find a specific symbol's full definition
serena.find_symbol("JwtMiddleware", include_body=True)

# Understand who uses a symbol before changing it
serena.find_referencing_symbols("JwtMiddleware", relative_path="src/auth/middleware.ts")
```

Combine with Twining context:
```
# Get decision history for the file
twining_why(scope="src/auth/middleware.ts")

# Then use Serena to understand the current implementation
serena.find_symbol("JwtMiddleware", depth=1)  # See all methods
```

### After Decisions: Enrich Knowledge Graph

When `twining_decide` affects code structure, use Serena to discover relationships and record them in Twining's knowledge graph:

1. **Make the decision:**
   ```
   twining_decide(
     domain="architecture",
     scope="src/auth/",
     summary="Use JWT middleware pattern",
     affected_files=["src/auth/middleware.ts"],
     affected_symbols=["JwtMiddleware"],
     ...
   )
   # Auto-creates file/function entities with decided_by relations
   ```

2. **Use Serena to discover structural relationships:**
   ```
   serena.find_referencing_symbols("JwtMiddleware", relative_path="src/auth/middleware.ts")
   # Discovers: AuthRouter imports JwtMiddleware, UserController calls validate()
   ```

3. **Record the richer structure in Twining:**
   ```
   twining_add_entity(name="AuthRouter", type="module", properties={file: "src/auth/router.ts"})
   twining_add_relation(source="AuthRouter", target="JwtMiddleware", type="imports")
   twining_add_relation(source="UserController", target="JwtMiddleware/validate", type="calls")
   ```

### When to Enrich
- After decisions that add, remove, or restructure code modules
- When onboarding to understand a new area of the codebase
- After significant refactoring that changes dependency relationships

### When NOT to Enrich
- Trivial decisions (naming, formatting, config values)
- Decisions that don't change code structure
- When Serena tools are not available in the session

### Serena Best Practices
- Prefer `get_symbols_overview` over reading entire files — it's token-efficient
- Use `find_symbol` with `include_body=False` and `depth=1` to scan a class before diving into specific methods
- Always pass `relative_path` to constrain searches when you know the file location
- Use `search_for_pattern` for non-code files or when you don't know the symbol name

---
