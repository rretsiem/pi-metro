# pi-metro (Metrol)

![pi-metro — Metrol inter-session message bus](https://repository-images.githubusercontent.com/1335506315/bf307e83-aecf-4f31-b67b-0c87a3e63f27)

Metrol is a local message bus for [Pi coding agent](https://github.com/badlogic/pi-mono) sessions.
It lets live sessions on the same machine discover one another, exchange messages,
ask context-aware questions, and inspect each other's status without a central
server or daemon.

## Why Metrol?

Pi sessions are normally isolated. Metrol gives them a small, explicit way to
coordinate work:

- find the sessions working in the same directory, project, or machine;
- send a message to one peer or broadcast to several peers;
- inject an idle-gated user turn on a peer (`metro_publish` with `triggerTurn: true`);
- ask another session a question and receive its answer in that session's own context;
- query lightweight session state without using an LLM;
- claim files so two sessions do not overwrite the same path; and
- ask a peer to compact its context when needed.

Metrol is designed for local, same-user collaboration between Pi sessions. It
uses files under `~/.pi/agent/metrol/`; it does not require a network service.

## Install

Install it as a Pi package:

```bash
# npm package
pi install npm:pi-metro

# Git repository
pi install git:github.com/rretsiem/pi-metro

# Local checkout (developer mode)
pi install /absolute/path/to/pi-metro
```

Reload Pi after installing:

```text
/reload
```

Update an installed package with `pi update --extensions`. To try a local
checkout without changing package settings:

```bash
pi -e /absolute/path/to/pi-metro
```

## Agent names

Every live Pi session gets a unique Metrol alias such as `Red-1`, `Blue-2`, or
`Teal-7`. The name is an identity for the running session, not a role or model
name.

Aliases use one of these color prefixes:

`Red`, `Blue`, `Green`, `Yellow`, `Orange`, `Purple`, `Pink`, `Teal`, `Indigo`,
`Coral`, `Lime`, `Slate`, `Silver`, or `Bronze`, followed by a number from `1`
to `99`. Metrol allocates aliases atomically, so two live sessions do not get
the same name. A session normally reclaims its previous alias when it starts
again.

Use `metro_whoami` or `/metro status` to see the current session's alias.

## Commands

Run these inside Pi with the `/metro` command:

```text
/metro list [cwd|project|all] [--foreground|--exclude-subagents]
/metro map
/metro inbox
/metro send [--all] <target> <message>
/metro broadcast [--project|--all] <message>
/metro query [--all] <target> <status|last_assistant_text>
/metro ask [--all] <target> <question>
/metro read [requestId]
/metro status
/metro compact [--all] <target> [instructions]
```

- `list` finds live peers. The default scope is `project`.
  `--foreground` keeps only sessions without a parent; `--exclude-subagents`
  keeps only sessions spawned as subagents.
- `map` groups all visible sessions by project and working directory.
- `inbox` shows recent Metrol activity in the current session.
- `send` writes a chat notification to one peer. The target sees a toast and
  an inbox entry; it does **not** start a model turn.
- `broadcast` sends the same notification to every peer in the selected scope.
- `query` performs a fixed, non-LLM lookup of `status` or
  `last_assistant_text`.
- `ask` queues a question for another session. The target answers using its own
  context, then stops; use the returned request ID with `read` to inspect
  progress or the final reply.
- `status` shows the current session, visible peers, and recent requests.
- `compact` asks another session to compact its context. It declines immediately
  when the target is busy or does not support compaction.

The scope values are:

- `cwd` — sessions in the same working directory;
- `project` — sessions in the same Git project (the default); and
- `all` — every live Metrol session for the current user.

## Agent tools

The extension also registers these tools for Pi agents:

- `metro_list_sessions` — list peers;
- `metro_select_peer` — choose an idle peer, preferring lower context usage;
- `metro_whoami` — return the current session's Metrol identity;
- `metro_claim` — claim file paths before a multi-step edit;
- `metro_release` — release file claims owned by this session;
- `metro_publish` — send or broadcast a chat notification. Pass
  `triggerTurn: true` to inject an idle-gated user turn instead (the only
  way to make the target start working without a human typing);
- `metro_query` — perform a fixed lookup on a peer;
- `metro_ask` — send a context-aware question;
- `metro_read` — read a request's current state or reply; and
- `metro_compact` — request context compaction from a peer.

## How it works

Each Pi session registers itself as a peer and writes messages to the local
Metrol directory. Sessions maintain a heartbeat and clean up stale registry,
alias, inbox, and file-lease data left by crashed sessions. Incoming messages
are delivered by the receiving Pi session, so `metro_ask` runs in the target's
context rather than sharing the sender's context.

Three inbound kinds:

- `chat` (`/metro send`, `metro_publish`) — notification only.
- `trigger` (`metro_publish` with `triggerTurn: true`) — injected as a user
  turn when the target is idle (or as a follow-up after ~60s). The prompt
  treats the text as a peer message, not as instructions.
- `ask` (`metro_ask`) — injected as a turn; the target answers and stops.
  The reply is relayed to the sender.

Structured `write` and `edit` calls are automatically protected by per-file
leases. A conflicting write is blocked and the owning session is notified.
Use `metro_claim` for a multi-step edit and `metro_release` when finished;
leases renew while the session is alive and stale leases are swept after a
crash; cleanup runs every five minutes. Set `METROL_DISABLE_SWEEP=1` to skip
both the startup and periodic sweeps. Shell commands can bypass this
protection, so do not use them to evade a lease conflict.

Metrol is intentionally local and unauthenticated. Any process running as the
same user can read or inject messages, so do not use it across trust boundaries.

## Development

```bash
npm install
npm test
```

The tests use Node's built-in test runner with `tsx` and do not require a
network service; watcher coverage uses temporary local directories.

## License

MIT. See [LICENSE](LICENSE).
