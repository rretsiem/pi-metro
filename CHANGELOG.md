# Changelog

## 0.2.1 - 2026-08-16

Pre-publish hardening plus the v0.2.1 roadmap batches. 262 tests, all passing
on macOS / Linux / Windows CI (Node 22).

- Per-file lease coordination: structured `write`/`edit` calls block on
  conflicts, with `metro_claim` and `metro_release` for multi-step edits.
  Held leases renew with the heartbeat and are swept after a crash.
- Path-traversal hardening: `validateInstanceId` + `pathInsideRoot` gate every
  inbox and registry path; stale-instance cleanup skips symlinks.
- Ask correctness: `replyAsk` truncates long replies, `agent_end` fallback
  requires `willRetry === false`, incoming asks have a 5-minute hard deadline.
- Packaging: `files` allowlist, `prepublishOnly: npm test`, `engines.node:
  ">=20"`, peerDependencies for `@earendil-works/pi-ai`, `@earendil-works/pi-tui`,
  and `typebox`.
- `broadcast` writes in parallel (`Promise.all`).
- Dispatcher dedup history capped at 10k (FIFO evict).
- Trigger buffer queue capped at 200; overflow drops oldest and logs `metrol:in`.
- `StatusWriter` write-through: in-memory entry is the source of truth, no
  read-modify-write race on same-tick updates.
- `METROL_DISABLE_SWEEP` skips startup and periodic storage sweeps.
- Inbox poll skip uses an mtime + file-count + total-size fingerprint (NFS/FAT
  mtime rewind no longer hides new mail).
- `metro_delegate` wrapper composes `metro_select_peer` + `metro_ask` into one
  call; honors `targetHint`, auto-picks idle peer with lowest context usage,
  optionally blocks for the reply. Adds a `metrol:handoff` audit entry.
- `metro_cancel` sends a best-effort cancel: queued asks are dropped, running
  asks are superseded (natural reply discarded). New `cancel` message type;
  `cancelled` added to `FailReason`; `AskQueue.remove(predicate)` for queue
  cancellation.

## 0.2.0 - 2026-08-16

Nine roadmap enhancements, fully wired end to end. 191 tests.

- Richer live status: `stateSince`, `activeToolName`, `contextUsage`,
  `lastActivity` on every registry entry; idle transition moved to
  `agent_settled` (not `agent_end`); throttled non-transition writes,
  jittered heartbeat.
- Resilient asks: per-request liveness monitor (90s inactivity / 30min
  hard ceiling / target-gone detection), bounded incoming queue (max 4,
  immediate `busy` decline past the cap), rank-based state transitions
  (terminal states are sticky against stale/duplicate updates), 60 KiB
  reply truncation, `agent_end` fallback for a stranded `followUp` ask.
- Idle-gated triggered messages: `metro_publish(triggerTurn: true)`
  delivers as a debounced (200ms), batched (20 items / 16 KiB) idle-gated
  user turn instead of a plain notification; busy targets retry up to 60s
  before a queued follow-up fallback.
- Smart peer selection: `metro_select_peer` picks the best live peer
  (idle first, then lowest context usage).
- `/metro status`: self status plus all live peers in one view.
- Low-latency wake-up: `fs.watch` on the inbox directory (debounced,
  backoff + full-rescan on error) layered over the existing poll interval;
  poll skips entirely when the directory hasn't changed.
- Storage hygiene: every session sweeps stale registry files, alias
  claims (15s grace period), and orphaned instance directories at startup
  and every 5 minutes — crashed (`kill -9`) sessions get cleaned up, not
  just graceful shutdowns.
- `metro_compact`: ask a peer to compact its context window; busy/
  unsupported targets decline immediately, never queued.
- `metro_whoami` and `/metro list [--foreground|--exclude-subagents]`:
  self-identity discoverability and parent/child (subagent) session
  filtering via `METROL_PARENT_INSTANCE_ID`.

## 0.1.0 - 2026-08-15

Initial public release.

- Filesystem JSONL registry for live Pi sessions.
- Atomic alias allocation (`Red-1`, `Blue-2`, ...).
- Direct messages, scoped broadcast, fixed queries.
- `metro_ask` with sender-side persistence and `metro_read` rebuild.
- FIFO incoming ask queue with single active run.
- 64 KiB payload cap, version 1 envelope, atomic temp-file writes.
- 63 unit tests covering identity, transport, dispatcher, registry, list, queries, and presentation.
