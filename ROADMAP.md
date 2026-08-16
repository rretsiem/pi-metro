# Metrol Roadmap

This is the working roadmap for the `pi-metro` extension. It tracks every
planned change past `v0.2.0`, with priority, scope, test surface, and the
order we agreed to ship things in. Update this file as work lands — the
checkboxes are the source of truth.

Status legend: `[ ]` pending · `[~]` in progress · `[x]` shipped in the listed version.

---

## Recently shipped

### v0.2.0 — 2026-08-16

- All nine roadmap enhancements wired end to end (Tasks 01–09).
- 191 tests, 100% passing on macOS/Linux/Windows CI.
- GitHub repo `github.com/rretsiem/pi-metro` (currently private, pending
  publish to npm + flip to public).

### v0.2.1 (in progress) — pre-publish security + correctness hardening

- [x] **Path-traversal via peer-supplied `instanceId`** — closed. `validateInstanceId`
      gates every `path.join` and registry read at the trust boundary.
      ([commit 3e3f1f1](https://github.com/rretsiem/pi-metro/commit/3e3f1f1))
- [x] **Defensive `pathInsideRoot()`** — even if a future regex relaxation
      lets a slash-bearing id through, `path.resolve` + prefix check refuses
      it. ([3e3f1f1](https://github.com/rretsiem/pi-metro/commit/3e3f1f1))
- [x] **`cleanupStaleInstanceDirs` symlink-skip** — `Dirent.withFileTypes`
      + `isSymbolicLink()` so a malicious symlink at `instances/<id> -> /etc`
      is no longer `rm -rf`'d. ([3e3f1f1](https://github.com/rretsiem/pi-metro/commit/3e3f1f1))
- [x] **`replyAsk` truncates long replies** via `truncateReply`. ([3e3f1f1](https://github.com/rretsiem/pi-metro/commit/3e3f1f1))
- [x] **`agent_end` fallback** now requires `event?.willRetry === false`
      explicitly (was firing on undefined event too). ([3e3f1f1](https://github.com/rretsiem/pi-metro/commit/3e3f1f1))
- [x] **`runIncomingAsk` 5-minute hard deadline** so a stranded `followUp`
      can no longer hang the queue slot forever. ([3e3f1f1](https://github.com/rretsiem/pi-metro/commit/3e3f1f1))
- [x] **Packaging** — `files` allowlist, `prepublishOnly: npm test`,
      `engines.node: ">=20"`, `repository` / `homepage` / `bugs` fields,
      `@earendil-works/pi-ai` / `@earendil-works/pi-tui` / `typebox` as
      `peerDependencies`. ([6cb86d2](https://github.com/rretsiem/pi-metro/commit/6cb86d2))
- [x] **Tests** — 198 passing, including 7 new security tests
      (`validateInstanceId`, `pathInsideRoot`, `inboxDir` null-on-bad-id,
      `safeInboxDir` throws, symlink-skip, non-dir skip). ([3e3f1f1](https://github.com/rretsiem/pi-metro/commit/3e3f1f1))

---

## Current focus — shipping order

The next work batch ships the S-tier items below in this exact order. Each
ship should be its own commit, all 198+ existing tests must continue to pass,
and any new tests must be added in the same commit.

### Batch A — quick wins (~30 min total)

- [x] **A1. `broadcast` parallelize** — `Promise.all(recipients.map(sendChat))`
      in `src/messaging.ts:48-67`. Shipped [commit 7160c90](https://github.com/rretsiem/pi-metro/commit/7160c90),
      232/232 tests passing. One new regression test added.
- [x] **A2. `dispatcher.seen` FIFO cap at 10k** — `src/dispatcher.ts:33`.
      Unbounded `Set<string>` growth → slow `Set.has` after ~1M messages.
      Cap + FIFO evict when at capacity, drop the oldest entry. No new
      allocations per evict; just a Map splice.
      - Test: `test/dispatcher.test.ts` — write 11k unique message IDs,
        assert `seen.size === 10k` and that the evicted ones are not
        re-delivered (their files were already deleted, but a re-poll
        would have re-triggered them).

### Batch B — TriggerBuffer queue cap (~45 min)

- [x] **B1. `TriggerBuffer.queue` cap at 200** — `src/triggers.ts:43`. A
      malicious peer can queue 1M items during a 60s idle wait, then take
      hours of sequential 20-item batches to drain. Add a `TRIGGER_QUEUE_CAP`
      constant, drop the oldest item on overflow, append a `metrol:in`
      entry per drop so the user can see "trigger queue full, dropped N".
      - Test: `test/triggers.test.ts` — enqueue 250 items with `isIdle()` stuck
        `false`; after the buffer caps, assert `pendingCount <= 200` and
        that the dispatcher's inbox got a `dropped` entry.

### Batch C — write-through source of truth (~75 min)

- [x] **C1. `StatusWriter` write-through** — `src/status.ts` keeps an
      in-memory `entry` and only writes via `updateRegistry`. Add an
      in-memory write-through so `toolStart`/`toolEnd`/etc. don't
      read+merge+write the file at all — just patch the in-memory entry
      and re-serialize the whole thing. Removes the read-modify-write
      race window the `reviewer` audit flagged.
      - Test: `test/status.test.ts` — simulate two updates landing in the
        same tick (e.g., `toolStart` racing `heartbeat`); assert that the
        on-disk file contains both fields, not the lossy second-writer-wins
        race the current `updateRegistry` has.

### Batch D — micro-tweaks (~20 min)

- [x] **D1. `METROL_DISABLE_SWEEP` env var** — `src/sweep.ts` + `src/index.ts`.
      Useful for test isolation (the periodic 5-min sweep can race tests)
      and for power users who want to opt out of the auto-cleanup. Read the
      env var once at `session_start`; if set, skip both the immediate and
      periodic sweeps.
      - Test: `test/sweep.test.ts` — verify that setting
        `METROL_DISABLE_SWEEP=1` in `process.env` causes
        `sweepMetrolStorage` to be a no-op (or the `index.ts` wiring to not
        schedule the timer).
- [ ] **D2. `shouldSkipPoll` mtime fingerprint** — `src/watch.ts`. Replace
      the single `mtimeMs <= lastSeen` check with a combined fingerprint
      (mtime + file-count + size) so a backward mtime step on weird FSes
      (NFS, FAT) doesn't skip forever.
      - Test: `test/watch.test.ts` — manually rewrite a file with an
        older mtime; assert the watcher still fires on the next poll.

---

## Next batch (v0.2.2) — TBD after v0.2.1 lands

### Tier M — medium effort (50–150 LoC each)

- [ ] **M1. `metro_log` (audit trail)** — every outbound write + every
      inbound route gets a single-line log entry under `metrol:log` for
      debugging cross-process issues. New `src/log.ts` + small integration
      in `index.ts` and `dispatcher.ts`. Needs a cap + rotation policy.
- [ ] **M2. `extractAskReply` / `findRequest` `null` contract docs** —
      just comment work, no behavior change.
- [ ] **M3. `metro_compile` (named prompt templates)** — `/metro compile
      <name> <file>` registers a `.metrol-prompts/<name>.md` file as a
      `metro_compiled_prompt` tool the agent can invoke. Useful for sharing
      agent prompts across sessions. New `src/compiled.ts`.
- [ ] **M4. `metro_ack` (cheap "I saw this" protocol)** — sender can ask
      target to immediately persist an `accepted` `metrol:request` entry,
      so the sender gets guaranteed-delivery semantics without a 5s
      timeout race.

---

## Deferred (post-0.3.0)

### Tier L — large design work

- [ ] **L1. Native Unix-socket transport** alongside filesystem JSONL.
      Touches the transport-layer interface, requires new lifecycle
      wiring, breaks all current tests. Better as its own design pass.
- [ ] **L2. Cross-machine transport** — new auth/encryption story;
      out-of-scope per the trust model in `README.md` and `SECURITY.md`.
- [ ] **L3. Detached supervisor daemon** — major architectural shift;
      out-of-scope per the MVP.
- [ ] **L4. Encrypted transport** — needs a key-agreement story.

### Informational — not bugs, just noted

- [ ] **`pidAlive` PID-recycle window** — same-user trust, accepted.
- [ ] **`updateRegistry` read-modify-write race** — fully fixed by C1.
- [ ] **`messaging.broadcast` sequential writes** — fully fixed by A1.
- [ ] **`identity.tryClaim` mkdir/writeFile race window** — claim
      allocation can rarely lose; `staleClaimsCleanup` recovers on next
      sweep.
- [ ] **`queries.lastAssistantText` returns `null` contract** — addressed
      by M2 (comment).
- [ ] **`sendUserMessage` retry on mid-run steer race** — rare; Pi
      runtime issue, not Metrol's to solve.

---

## How to use this file

1. When starting a new session of work, read the "Current focus" section
   and pick up the first `[ ]` item.
2. After shipping a commit, mark the corresponding `[x]` and link the
   commit hash.
3. When promoting an item from one tier to the next (e.g., M → S), update
   the priority and add a one-line rationale.
4. Items get **removed** only when the rationale for deferring them is
   permanently wrong (e.g., "cross-machine transport" is no longer
   out-of-scope because the security model changed). Don't silently drop
   items — keep the history so we don't re-litigate decisions.
