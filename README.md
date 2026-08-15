# pi-metro (Metrol)

Inter-session message bus for the [Pi coding agent](https://github.com/badlogic/pi-mono).
Live Pi sessions on the same machine discover each other and exchange chat
messages, fixed queries, and context-aware asks.

## Status

- Stable MVP: identity, transport, dispatcher, registry, queries, asks.
- In development: richer live status, resilient asks, idle-gated triggered messages.
- See `thoughts/shared/plans/2026-08-15-metrol-implementation-roadmap.md` (when included with the consumer's knowledge base) for the roadmap.

## Install

Place the extension on a path Pi loads, or add it to `pi.extensions` in your
Pi settings.

```bash
pi -e /absolute/path/to/pi-metro
```

For automatic discovery, symlink or copy the directory into
`~/.pi/agent/extensions/metrol/`.

## Commands

- `/metro list [cwd|project|all]` — live sessions (default scope: `project`).
- `/metro map` — live sessions grouped by project root, cwd, and line.
- `/metro inbox` — recent Metrol activity (in/out/requests), newest first.
- `/metro send [--all] <target> <message>` — chat to one session.
- `/metro broadcast [--project|--all] <message>` — chat to many (default scope: `cwd`).
- `/metro query [--all] <target> <status|last_assistant_text>` — non-LLM lookup.
- `/metro ask [--all] <target> <question>` — the target agent answers with its own context.
- `/metro read [requestId]` — request state/reply (queued | accepted | running | answered | failed).

Tools for the agent: `metro_list_sessions`, `metro_publish`, `metro_query`,
`metro_ask`, `metro_read`.

## Scopes

- `cwd` — same working directory.
- `project` (default) — same git project root.
- `all` — every live session on this machine.

## Trust model

**Local, same-user only.** Metrol communicates through files under
`~/.pi/agent/metrol/` with no authentication or encryption. Any process
running as your user can read and inject messages. Do not use across trust
boundaries; ask prompts are executed by the receiving agent's session.

## Development

```bash
npm install
npm test
```

Tests run with `node --test` and `tsx` and are platform-agnostic (no
filesystem watchers, no network). The CI matrix covers macOS, Linux, and
Windows.

## Layout

```
src/        Pi extension source
test/       node --test suites (one file per module)
```

## License

MIT. See `LICENSE`.
