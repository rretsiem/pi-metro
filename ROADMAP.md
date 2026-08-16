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
- GitHub repo `github.com/rretsiem/pi-metro` (public).

### v0.2.1 — shipped 2026-08-16 (tag `v0.2.1`, npm `0.2.1`)

Pre-publish security hardening plus the v0.2.1 roadmap batches (A–E).
262 tests, all green on macOS / Linux / Windows CI (Node 22). Trusted
Publishing (OIDC) verified end-to-end; release workflow now runs without
any static auth token.

#### Security & correctness hardening

- [x] **Path-traversal via peer-supplied `instanceId`** — `validateInstanceId`
      gates every `path.join` and registry read at the trust boundary.
      ([3e3f1f1](https://github.com/rretsiem/pi-metro/commit/3e3f1f1))
- [x] **Defensive `pathInsideRoot()`** — even if a future regex relaxation
      lets a slash-bearing id through, `path.resolve` + prefix check refuses
      it. ([3e3f1f1](https://github.com/rretsiem/pi-metro/commit/3e3f1f1))
- [x] **`cleanupStaleInstanceDirs` symlink-skip** — `Dirent.withFileTypes`
      + `isSymbolicLink()` so a malicious symlink at `instances/<id> -> /etc`
      is no longer `rm -rf`'d. ([3e3f1f1](https://github.com/rretsiem/pi-metro/commit/3e3f1f1))
- [x] **`replyAsk` truncates long replies** via `truncateReply`. ([3e3f1f1](https://github.com/rretsiem/pi-metro/commit/3e3f1f1))
- [x] **`agent_end` fallback** requires `event?.willRetry === false`
      explicitly. ([3e3f1f1](https://github.com/rretsiem/pi-metro/commit/3e3f1f1))
- [x] **`runIncomingAsk` 5-minute hard deadline** so a stranded `followUp`
      can't hang the queue slot forever. ([3e3f1f1](https://github.com/rretsiem/pi-metro/commit/3e3f1f1))
- [x] **Packaging** — `files` allowlist, `prepublishOnly: npm test`,
      `engines.node: ">=20"`, `repository` / `homepage` / `bugs` fields,
      `@earendil-works/pi-ai` / `@earendil-works/pi-tui` / `typebox` as
      `peerDependencies`. ([6cb86d2](https://github.com/rretsiem/pi-metro/commit/6cb86d2))

#### Roadmap batches A–E

- [x] **A1. `broadcast` parallelize** — `Promise.all` per-recipient writes.
      ([7160c90](https://github.com/rretsiem/pi-metro/commit/7160c90))
- [x] **A2. `dispatcher.seen` FIFO cap at 10k** — bounds memory growth on
      long-running sessions. ([c8a9ea0](https://github.com/rretsiem/pi-metro/commit/c8a9ea0))
- [x] **B1. `TriggerBuffer.queue` cap at 200** — overflow drops oldest and
      logs `metrol:in`. ([8c18618](https://github.com/rretsiem/pi-metro/commit/8c18618))
- [x] **C1. `StatusWriter` write-through** — in-memory entry is source of
      truth, no read-modify-write race. ([f7385be](https://github.com/rretsiem/pi-metro/commit/f7385be))
- [x] **Per-file lease coordination** — `metro_claim` / `metro_release`,
      structured `write`/`edit` calls block on conflicts, leases renew with
      the heartbeat. ([bb58b75](https://github.com/rretsiem/pi-metro/commit/bb58b75))
- [x] **D1. `METROL_DISABLE_SWEEP` env var** — skips both immediate and
      periodic storage sweeps. ([9b40099](https://github.com/rretsiem/pi-metro/commit/9b40099))
- [x] **D2. `shouldSkipPoll` mtime+fileCount+totalSize fingerprint** —
      NFS/FAT mtime rewinds no longer hide new mail. ([8309eaf](https://github.com/rretsiem/pi-metro/commit/8309eaf))
- [x] **E1. `metro_delegate` wrapper** — composes `metro_select_peer` +
      `metro_ask` into one call; honors `targetHint`, auto-picks idle peer
      with lowest context usage, optionally blocks for the reply. Adds
      `metrol:handoff` audit entry.
      ([b952019](https://github.com/rretsiem/pi-metro/commit/b952019))
- [x] **E2. `metro_cancel`** — best-effort ask cancellation. Queued asks
      are dropped; running asks are superseded (natural reply discarded).
      New `cancel` message type; `cancelled` added to `FailReason`.
      ([12a4564](https://github.com/rretsiem/pi-metro/commit/12a4564))

#### Release infrastructure

- [x] **GitHub Actions CI for `npm test`** — `.github/workflows/test.yml`
      on Node 22, matrix over macOS / Linux / Windows. Runs on push to
      `main` and on every PR. ([f9890c4](https://github.com/rretsiem/pi-metro/commit/f9890c4))
- [x] **Release workflow** — `.github/workflows/release.yml` triggers on
      `v*` tag push or `workflow_dispatch`. Publishes via npm Trusted
      Publishing (OIDC); no static token required. Auto-picks
      `latest` vs `next` dist-tag from the version.
      ([cd7b586](https://github.com/rretsiem/pi-metro/commit/cd7b586))
- [x] **GitHub Release page for v0.2.1** — auto-generated notes covering
      security, packaging, perf batches, and new tools.
- [x] **npm publish of `pi-metro@0.2.1`** — via the release workflow;
      Trusted Publishing verified with a `0.2.2-rc.0` dry run.
- [x] **Repo flipped from private to public** — social preview image
      hosted on GitHub's image service, no binary in tree.

---

## Next batch (v0.2.2)

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

1. When starting a new session of work, read the "Next batch" section
   and pick up the first `[ ]` item.
2. After shipping a commit, mark the corresponding `[x]` and link the
   commit hash.
3. When promoting an item from one tier to the next (e.g., M → S), update
   the priority and add a one-line rationale.
4. Items get **removed** only when the rationale for deferring them is
   permanently wrong (e.g., "cross-machine transport" is no longer
   out-of-scope because the security model changed). Don't silently drop
   items — keep the history so we don't re-litigate decisions.