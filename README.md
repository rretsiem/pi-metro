# pi-metro (Metrol)

Inter-session message bus for the [Pi coding agent](https://github.com/badlogic/pi-mono).
Live Pi sessions on the same machine discover each other and exchange chat
messages, fixed queries, and context-aware asks.

## Status

All nine planned enhancements are implemented and integrated: richer live
status, resilient asks (liveness monitoring, ranked state transitions,
bounded queue), idle-gated triggered messages, smart peer selection,
`/metro status`, low-latency fs.watch wake-up, storage hygiene sweeps, and
`metro_compact`. See
`thoughts/shared/plans/2026-08-15-metrol-implementation-roadmap.md` (when
included with the consumer's knowledge base) for the full roadmap and
progress tracker.

## Install

Install as a Pi package via `pi install` so it lands in your standard
package location (`~/.pi/agent/npm/pi-metro` for npm, `~/.pi/agent/git/...`
for git) and is auto-discovered by every Pi session you run. Any other
user on this machine gets the same shared install.

```bash
# From the public GitHub repo (recommended — versioned, updateable)
pi install git:github.com/rretsiem/pi-metro

# Pinned to a specific tag
pi install git:github.com/rretsiem/pi-metro@v0.2.0

# From a local checkout (developer mode, no copy)
pi install /absolute/path/to/pi-metro
```

After install, `/reload` in any Pi session to pick up the new tools and
commands. Roll out new versions with `pi update --extensions`.

`pi install` adds the package to `~/.pi/agent/settings.json` under
`packages`; the entry persists across sessions and is shared across all
Pi processes you run on this machine.

For a one-shot smoke test without touching settings, use `pi -e`:

```bash
pi -e /absolute/path/to/pi-metro
```

## Commands

- `/metro list [cwd|project|all] [--foreground|--exclude-subagents]` — live sessions (default scope: `project`). The `--foreground` flag hides subagents (sessions spawned via `METROL_PARENT_INSTANCE_ID`); `--exclude-subagents` shows only them. Mutually exclusive.
- `/metro map` — live sessions grouped by project root, cwd, and line.
- `/metro inbox` — recent Metrol activity (in/out/requests), newest first.
- `/metro send [--all] <target> <message>` — chat to one session.
- `/metro broadcast [--project|--all] <message>` — chat to many (default scope: `cwd`).
- `/metro query [--all] <target> <status|last_assistant_text>` — non-LLM lookup.
- `/metro ask [--all] <target> <question>` — the target agent answers with its own context. Resilient: liveness-monitored (90s inactivity / 30min hard ceiling / target-gone detection), bounded incoming queue (max 4, 5th declines immediately with `busy`), replies over 60 KiB are truncated.
- `/metro status` — self status (state, tool, context usage, active/recent asks) plus all live peers.
- `/metro compact [--all] <target> [instructions]` — ask a peer to compact its context window; busy/unsupported targets decline immediately (never queued, unlike `/metro ask`).
- `/metro read [requestId]` — request state/reply (queued | accepted | running | answered | failed).

Tools for the agent: `metro_list_sessions`, `metro_select_peer`, `metro_whoami`,
`metro_publish`, `metro_query`, `metro_ask`, `metro_read`, `metro_compact`.

`metro_select_peer` picks the best live peer for delegation (idle first, then
lowest context usage), optionally narrowed by a `targetHint` alias/instanceId.

`metro_publish` accepts an optional `triggerTurn: true` to deliver as an
idle-gated user turn on the receiver instead of a plain chat notification.
Arrivals are debounced (200 ms) and batched (up to 20 items / 16 KiB); a busy
receiver retries for up to 60 s before falling back to a queued follow-up
delivery. Use `metro_ask` instead if you need the reply back.

`metro_whoami` returns the calling session's own Metrol identity (alias,
instanceId, sessionName, model, cwd). Run it before composing any message
that mentions your own alias — the bus metadata (`Message.from`) is the
authoritative sender identity for recipients, not anything you type in
the body.

## Subagent convention

Set `METROL_PARENT_INSTANCE_ID=<parent-instanceId>` in the environment
when spawning a subagent. The subagent's registry entry will record the
parent, and `/metro list --exclude-subagents` will surface it. Foreground
sessions leave the env var unset.

## Scopes

- `cwd` — same working directory.
- `project` (default) — same git project root.
- `all` — every live session on this machine.

## Storage hygiene

Every session is a peer janitor: no daemon owns cleanup. At startup, and
every 5 minutes thereafter, each session sweeps `~/.pi/agent/metrol/` for
stale registry files, stale alias claims (with a 15s grace period so a
just-claimed, not-yet-registered session is never swept), and orphaned
instance/inbox directories left behind by crashed (`kill -9`) sessions —
not just graceful shutdowns.

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
