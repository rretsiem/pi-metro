# Changelog

## 0.1.0 - 2026-08-15

Initial public release.

- Filesystem JSONL registry for live Pi sessions.
- Atomic alias allocation (`Red-1`, `Blue-2`, ...).
- Direct messages, scoped broadcast, fixed queries.
- `metro_ask` with sender-side persistence and `metro_read` rebuild.
- FIFO incoming ask queue with single active run.
- 64 KiB payload cap, version 1 envelope, atomic temp-file writes.
- 63 unit tests covering identity, transport, dispatcher, registry, list, queries, and presentation.
