# Contributing to Twining

Thank you for your interest in contributing to Twining! This guide will help you get started.

## Getting Started

1. **Fork the repository** and clone your fork locally
2. **Install dependencies**: `npm install`
3. **Build**: `npm run build`
4. **Run tests**: `npm test`

## Development Setup

Requires **Node.js >= 18**. We test against Node 18, 20, and 22.

```bash
git clone https://github.com/<your-username>/twining-mcp.git
cd twining-mcp
npm install
npm run build
npm test
```

## Making Changes

### Branch Naming

Create a descriptive branch from `main`:

```bash
git checkout -b feat/my-new-feature
git checkout -b fix/bug-description
```

### Code Style

- TypeScript with strict mode enabled
- ES modules (`"type": "module"`)
- Follow existing patterns in the codebase
- Keep changes focused — one concern per PR

### Commit Messages

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new tool for X
fix: resolve race condition in Y
docs: update installation instructions
chore: bump dependency versions
refactor: simplify context assembly logic
test: add tests for graph traversal
```

### Testing

All changes should include tests. We use [Vitest](https://vitest.dev/).

```bash
npm test            # Run full suite
npm run test:watch  # Watch mode during development
```

- Tests live alongside source files or in dedicated test directories
- Aim for meaningful coverage — test behavior, not implementation details

### Pull Request Process

1. **Create your PR** against `main`
2. **Fill out the PR template** — describe what changed and why
3. **Ensure CI passes** — build and tests must pass on Node 18, 20, and 22
4. **Keep PRs focused** — smaller PRs are easier to review
5. **Respond to feedback** — maintainers may request changes

### What We Look For

- Does it solve a real problem?
- Are there tests?
- Does it follow existing code patterns?
- Is the change minimal and focused?
- Does CI pass?

## Reporting Issues

- Use [GitHub Issues](https://github.com/daveangulo/twining-mcp/issues)
- Check existing issues before creating a new one
- Include reproduction steps for bugs
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)

## Architecture Overview

If you're diving into the codebase, start with:

- [TWINING-DESIGN-SPEC.md](TWINING-DESIGN-SPEC.md) — full technical specification
- [docs/TWINING-REFERENCE.md](docs/TWINING-REFERENCE.md) — API reference
- [docs/AGENT_INTEGRATION_ARCHITECTURE.md](docs/AGENT_INTEGRATION_ARCHITECTURE.md) — integration guidance

Key directories:

```
src/
├── engine/      # Core business logic (decisions, blackboard, graph, context assembly)
├── storage/     # File-backed persistence layer
├── tools/       # MCP tool definitions (Zod-validated)
├── embeddings/  # Semantic search (all-MiniLM-L6-v2)
├── dashboard/   # Web UI
├── analytics/   # Telemetry and metrics
└── utils/       # Shared utilities
```

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
