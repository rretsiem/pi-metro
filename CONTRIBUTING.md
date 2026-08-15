# Contributing

## Issues

Use the GitHub issue templates under `.github/ISSUE_TEMPLATE/`. Include
Pi version, OS, and a minimal reproduction.

## Pull requests

1. Fork the repo and create a topic branch.
2. Run `npm test` locally.
3. Add tests for any new behavior.
4. Keep tests in `test/` (the existing 63 tests live there).
5. Do not commit:
   - API keys, tokens, or credentials.
   - Personal paths (`/Users/<name>/...`, `~`-style home dirs).
   - Real session identifiers or model outputs.
6. Open a PR using the template at `.github/PULL_REQUEST_TEMPLATE.md`.

## Coding conventions

- TypeScript, Node 20+.
- ESM (`"type": "module"`).
- Tests use `node --test` with `tsx` for TS loader.
- Constants live in code; configuration files only when warranted.
- Status is derived from Pi lifecycle events, not polling where avoidable.
- New fields are optional; old readers must not crash.
