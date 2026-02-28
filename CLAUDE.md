# Claude Code Project Instructions

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

### TypeScript-Specific Guidelines

This is a TypeScript project. Keep in mind:
- Use name paths like `ClassName/methodName` for methods
- Constructors are named `constructor` in symbol trees
- Use `find_symbol` with substring matching for exported functions

### Common Workflows

**Understanding a class:**
```
1. get_symbols_overview(relative_path="src/engine/blackboard.ts")
2. find_symbol(name_path="BlackboardEngine", depth=1, include_body=false)
3. find_symbol(name_path="BlackboardEngine/post", include_body=true)
```

**Finding usage of a method:**
```
1. find_referencing_symbols(name_path="post", relative_path="src/engine/blackboard.ts")
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
