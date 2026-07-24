---
name: twining-map
description: Builds and queries the Twining knowledge graph — records entities, relations, and code structure. Use when documenting architecture or tracing dependencies between components.
auto-invocable: true
---

# Twining Map — Knowledge Graph Building (Optional)

> **This is an advanced, opt-in workflow.** Benchmark data shows graph building has no measurable correlation with coordination quality (r=-0.01). Use only when you specifically need structural analysis. Requires `graph.auto_populate: true` in config for auto-population, or manual entity/relation creation.
>
> **Tool availability.** The graph tools below (`twining_add_entity`, `twining_add_relation`, `twining_neighbors`, `twining_graph_query`, `twining_prune_graph`) are on the default surface. `twining_decide` and `twining_verify`, referenced below, require `tools.full_surface: true` — on a default install use `twining_record`'s `decisions` array instead, which populates the same `affected_files` / `affected_symbols` entities.

Build the knowledge graph to capture architectural relationships when you need to reason about code structure across multiple modules.

## When to Invoke

- When you need to understand cross-module dependencies for impact analysis
- When onboarding to a complex area where structural relationships aren't obvious from code alone
- When explicitly asked to map code structure

## When NOT to Invoke

- For most day-to-day coordination work (use decisions and blackboard instead)
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
