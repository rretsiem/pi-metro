# Metrol Roadmap

This is the working roadmap for the `pi-metro` extension. It tracks every
planned change past `v0.2.0`, with priority, scope, test surface, and the
order we agreed to ship things in. Update this file as work lands — the
checkboxes are the source of truth. `package.json` stays at `0.2.0` until
the 0.2.1 tag.

Status legend: `[ ]` pending · `[~]` in progress · `[x]` shipped in the listed version.

---

## Recently shipped

### v0.2.0 — 2026-08-16

- All nine roadmap enhancements wired end to end (Tasks 01–09).
- 191 tests, 100% passing on macOS/Linux/Windows CI.
- GitHub repo `github.com/rretsiem/pi-metro` (currently private, pending
  publish to npm + flip to public).

### v0.2.1 — landed on `main`, not tagged (2026-08-16)

All of Batch A–D plus leases and the pre-publish security pass. 244 tests.
Tag + `package.json` bump is the remaining release step.

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

## Current focus — tag 0.2.1, then v0.2.2

No open S-tier items. Next code work is the M-tier list below. Tagging
`v0.2.1` (and bumping `package.json`) is a release step, not a code batch.

### Shipped in 0.2.1 (kept for history)

- [x] **A1. `broadcast` parallelize** — [7160c90](https://github.com/rretsiem/pi-metro/commit/7160c90)
- [x] **A2. `dispatcher.seen` FIFO cap at 10k** — [c8a9ea0](https://github.com/rretsiem/pi-metro/commit/c8a9ea0)
- [x] **B1. `TriggerBuffer.queue` cap at 200** — [8c18618](https://github.com/rretsiem/pi-metro/commit/8c18618)
- [x] **C1. `StatusWriter` write-through** — [f7385be](https://github.com/rretsiem/pi-metro/commit/f7385be)
- [x] **leases (`metro_claim` / `metro_release`)** — [bb58b75](https://github.com/rretsiem/pi-metro/commit/bb58b75)
- [x] **D1. `METROL_DISABLE_SWEEP`** — [9b40099](https://github.com/rretsiem/pi-metro/commit/9b40099)
- [x] **D2. `shouldSkipPoll` fingerprint** — [8309eaf](https://github.com/rretsiem/pi-metro/commit/8309eaf)

---

## Next batch (v0.2.2)

### Tier M — medium effort (50–150 LoC each)

- [x] **E1. `metro_delegate` wrapper** — `src/delegate.ts`. Composes
      `metro_select_peer` + `metro_ask` into one call. Honors `targetHint`,
      auto-picks idle peer with lowest context usage, returns `{requestId,
      target}` immediately (or blocks for the reply when `waitForReply`).
      Adds `metrol:handoff` audit entry on the caller side. Useful for the
      "I'm near context limit, hand this off" workflow.
      - Test: `test/delegate.test.ts` — 9 cases: no-idle-peer, auto-pick,
        hint-forces-target, blocking waits for terminal states (answered,
        failed, timeout), scope=all.
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
