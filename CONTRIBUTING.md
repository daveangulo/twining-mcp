# Contributing to Twining

Thanks for your interest in contributing! This guide covers setup, workflow, and conventions.

## Prerequisites

- Node.js >= 18
- npm

## Setup

```bash
git clone https://github.com/daveangulo/twining-mcp.git
cd twining-mcp
npm ci
npm run build
npm test
```

## Development Workflow

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm test` — all tests must pass
4. Run `npm run build` — must compile cleanly
5. Open a pull request against `main`

### Running Tests

```bash
npm test            # run all tests once
npm run test:watch  # watch mode during development
```

## Code Style

- TypeScript with strict mode
- Follow existing patterns in `src/`
- Keep changes focused — one feature or fix per PR

## Plugin Changes

Changes to files under `plugin/` **require a version bump** or CI will reject your PR.

Bump both version files at once:

```bash
scripts/bump-plugin-version.sh patch   # or minor / major
```

This updates `plugin/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` in sync.

## Pull Request Checklist

- [ ] Tests pass (`npm test`)
- [ ] Build succeeds (`npm run build`)
- [ ] Plugin version bumped (if `plugin/` files changed)

## Reporting Issues

Use [GitHub Issues](https://github.com/daveangulo/twining-mcp/issues) with the provided templates for bugs and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
