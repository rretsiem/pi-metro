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

## Release and the pi.dev packages gallery

The package is structured as a [Pi package](https://pi.dev/docs/latest/packages)
so it can be installed via `pi install npm:pi-metro` or `pi install git:github.com/rretsiem/pi-metro`.
Listing in the [pi.dev gallery](https://pi.dev/packages) requires:

- The `pi-package` keyword in `package.json` (already present).
- The `pi` manifest in `package.json` declaring at least one resource
  type (`extensions`, `skills`, `prompts`, `themes`); we declare
  `extensions: ["./src/index.ts"]`.
- A publicly reachable source: an npm package on the registry, or a
  public git repo. The current GitHub repo is private; flip visibility
  to public (or publish to npm) before submitting to the gallery.
- Optional gallery preview: a `video` or `image` field under `pi`.
  MP4 only for `video`; PNG/JPEG/GIF/WebP for `image`. `video` wins
  if both are set.

Pre-release checklist before tagging `v0.x.0` and listing on the gallery:

1. `npm test` is green on macOS, Linux, and Windows.
2. `LICENSE` copyright year matches the release year and the owner
   field is filled in (currently `René`; confirm full name).
3. No commits authored by placeholder identities (e.g. `metrol-dev
   <metrol@local>`); rebase or rewrite before tagging.
4. CHANGELOG.md has an entry for the release.
5. Tag the release; the tag is what `pi install git:…@<tag>` pins to.
6. Decide npm vs. git source for the gallery listing; both work.
