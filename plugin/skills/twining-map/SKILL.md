---
name: twining-map
description: Build and query the knowledge graph — record entities, relations, and code structure for architectural understanding
auto-invocable: true
---

# Twining Map — Knowledge Graph Building

You've made changes that affect code structure, or you're onboarding to understand a new area of the codebase. Build the knowledge graph to capture architectural relationships.

## When to Invoke

- After decisions that add, remove, or restructure code modules
- When onboarding to understand a new area of the codebase
- After significant refactoring that changes dependency relationships
- When you need to understand how components relate to each other

## When NOT to Invoke

- Trivial decisions (naming, formatting, config values)
- Changes that don't alter code structure
- When the graph already has the information (check first with `twining_neighbors`)

## Workflow

### 1. Add Entities

Call `twining_add_entity` for each significant code component:

- **`name`**: Unique identifier (e.g., `"AuthMiddleware"`, `"src/auth/middleware.ts"`)
- **`type`**: One of `module`, `function`, `class`, `file`, `concept`, `pattern`, `dependency`, `api_endpoint`
- **`properties`**: Key-value metadata (e.g., `{ file: "src/auth/middleware.ts", layer: "engine" }`)

Note: `twining_decide` auto-creates `file` and `function` entities for `affected_files` and `affected_symbols`. You only need to manually add entities for richer structural information.

### 2. Add Relations

Call `twining_add_relation` for relationships between entities:

- **`source`**: Source entity name
- **`target`**: Target entity name
- **`type`**: One of:
  - `depends_on` — A depends on B to function
  - `implements` — A implements B (interface/contract)
  - `decided_by` — A was shaped by decision B (auto-created by `twining_decide`)
  - `affects` — A affects B
  - `tested_by` — A is tested by B (used by `twining_verify` for coverage checks)
  - `calls` — A calls B at runtime
  - `imports` — A imports B
  - `related_to` — General association
- **`properties`**: Additional context (e.g., `{ reason: "JWT validation" }`)

### 3. Query the Graph

**Explore neighbors:**
```
twining_neighbors(entity_name="AuthMiddleware", depth=2)
```
Shows all entities connected within 2 hops — useful for impact analysis.

**Search by name or properties:**
```
twining_graph_query(name_pattern="auth", type="module")
```
Find entities matching a pattern.

### 4. Maintain the Graph

Use `twining_prune_graph` to remove stale entities or relations that no longer reflect the codebase. Prune when:
- Files have been deleted or renamed
- Major refactoring has changed relationships
- The graph has accumulated noise from exploratory work

## Integration with Decisions

The recommended flow after a structural decision:

1. `twining_decide` — records the decision (auto-creates file/function entities)
2. Discover actual relationships (e.g., what imports the changed module)
3. `twining_add_entity` + `twining_add_relation` — enrich with structural details
4. `twining_add_relation` with `type: "tested_by"` — link tests for verification coverage

## Entity Type Guidelines

| Type | Use for | Example |
|------|---------|---------|
| `module` | Logical groupings, packages | `"auth-module"`, `"payment-service"` |
| `function` | Standalone functions | `"validateToken"`, `"hashPassword"` |
| `class` | Classes, interfaces | `"UserController"`, `"DatabasePool"` |
| `file` | Source files | `"src/auth/middleware.ts"` |
| `concept` | Design patterns, principles | `"CQRS"`, `"event-sourcing"` |
| `pattern` | Recurring code patterns | `"repository-pattern"`, `"factory"` |
| `dependency` | External packages | `"express"`, `"postgresql"` |
| `api_endpoint` | API routes | `"POST /api/auth/login"` |
