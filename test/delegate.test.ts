import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeRegistryEntry, type RegistryEntry } from "../src/registry.ts";
import { claimMetroAlias } from "../src/identity.ts";
import { InboxDispatcher } from "../src/dispatcher.ts";
import {
  DEFAULT_DELEGATE_POLL_MS,
  DEFAULT_DELEGATE_TIMEOUT_MS,
  runDelegate,
} from "../src/delegate.ts";
import type { RequestRecord } from "../src/asks.ts";

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-delegate-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  const now = Date.now();
  return {
    version: 1,
    instanceId: randomUUID(),
    sessionId: randomUUID(),
    metroName: "Red-1",
    sessionName: "test",
    cwd: "/tmp/proj",
    projectRoot: "/tmp/proj",
    pid: process.pid,
    model: "anthropic/claude-opus-4-6",
    state: "idle",
    startedAt: now,
    lastHeartbeat: now,
    ...overrides,
  };
}

interface Captured {
  askEntries: RequestRecord[];
  handoffEntries: Record<string, unknown>[];
}

function makeCallerRef(caller: RegistryEntry) {
  return {
    instanceId: caller.instanceId,
    cwd: caller.cwd,
    projectRoot: caller.projectRoot,
  };
}

/** Stand up two peers in the same project + a caller; return the dispatcher
 * + captured-entry arrays + helpers for resolving peer identity. */
async function setup(t: import("node:test").TestContext, peers: RegistryEntry[]) {
  const root = await withTempRoot(t);
  const caller = makeEntry({ metroName: "Red-1", instanceId: randomUUID() });
  await writeRegistryEntry(root, caller);
  for (const p of peers) await writeRegistryEntry(root, p);
  const dispatcher = new InboxDispatcher(path.join(root, "noop"));
  dispatcher.start(60_000);
  t.after(() => dispatcher.stop());
  return { root, caller, dispatcher };
}

test("runDelegate: returns no_idle_peer cleanly, writes nothing", async (t) => {
  const root = await withTempRoot(t);
  const caller = makeEntry({ instanceId: randomUUID() });
  await writeRegistryEntry(root, caller);
  const dispatcher = new InboxDispatcher(path.join(root, "noop"));
  dispatcher.start(60_000);
  t.after(() => dispatcher.stop());

  const captured: Captured = { askEntries: [], handoffEntries: [] };
  const result = await runDelegate({
    rootDir: root,
    dispatcher,
    callerEntry: caller,
    caller: makeCallerRef(caller),
    options: { question: "do the thing" },
    appendAskEntry: (d) => captured.askEntries.push(d),
    appendHandoffEntry: (d) => captured.handoffEntries.push(d),
    getEntries: () => [],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result, { ok: false, error: "no_idle_peer", scope: "project" });
  assert.equal(captured.askEntries.length, 0);
  assert.equal(captured.handoffEntries.length, 0);
});

test("runDelegate: non-blocking returns requestId + target without waiting", async (t) => {
  const idlePeer = makeEntry({
    metroName: "Red-2",
    instanceId: randomUUID(),
    state: "idle",
  });
  const busyPeer = makeEntry({
    metroName: "Red-3",
    instanceId: randomUUID(),
    state: "running",
  });
  const { root, caller, dispatcher } = await setup(t, [idlePeer, busyPeer]);

  const captured: Captured = { askEntries: [], handoffEntries: [] };
  const result = await runDelegate({
    rootDir: root,
    dispatcher,
    callerEntry: caller,
    caller: makeCallerRef(caller),
    options: { question: "continue the plan from where Red-1 left off" },
    appendAskEntry: (d) => captured.askEntries.push(d),
    appendHandoffEntry: (d) => captured.handoffEntries.push(d),
    getEntries: () => [],
  });

  assert.equal(result.ok, true);
  if (!result.ok || result.status !== "queued") throw new Error("expected queued");
  assert.equal(result.target, "Red-2");
  assert.equal(result.scope, "project");
  assert.equal(typeof result.requestId, "string");
  // One metrol:request queued entry from enqueueAsk, one metrol:handoff
  // audit entry. No blocking call.
  assert.equal(captured.askEntries.length, 1);
  assert.equal(captured.handoffEntries.length, 1);
  assert.equal(captured.handoffEntries[0].blocking, false);
  assert.equal(captured.handoffEntries[0].target, "Red-2");
});

test("runDelegate: picks the idle peer (state-aware)", async (t) => {
  const idle = makeEntry({
    metroName: "Red-2",
    instanceId: randomUUID(),
    state: "idle",
    contextUsage: { tokens: 90_000, contextWindow: 100_000 },
  });
  const busy = makeEntry({
    metroName: "Red-3",
    instanceId: randomUUID(),
    state: "running",
    contextUsage: { tokens: 5_000, contextWindow: 100_000 },
  });
  // Two idle peers; lower context usage wins. Red-4 has very low usage,
  // Red-2 has high usage — state ties, Red-4 must be picked.
  const idle2 = makeEntry({
    metroName: "Red-4",
    instanceId: randomUUID(),
    state: "idle",
    contextUsage: { tokens: 5_000, contextWindow: 100_000 },
  });
  // Override busy's context so we can prove state beats context.
  const { root, caller, dispatcher } = await setup(t, [busy, idle, idle2]);

  const result = await runDelegate({
    rootDir: root,
    dispatcher,
    callerEntry: caller,
    caller: makeCallerRef(caller),
    options: { question: "x" },
    appendAskEntry: () => {},
    appendHandoffEntry: () => {},
    getEntries: () => [],
  });
  if (!result.ok || result.status !== "queued") throw new Error("expected queued");
  // Idle ranks ahead of running; among idle, missing context usage ranks
  // as best-case (0), so Red-4 wins over Red-2 (no usage reported).
  assert.equal(result.target, "Red-4");
});

test("runDelegate: targetHint forces a specific peer even when others are idle", async (t) => {
  const idle = makeEntry({
    metroName: "Red-2",
    instanceId: randomUUID(),
    state: "idle",
  });
  const busy = makeEntry({
    metroName: "Red-3",
    instanceId: randomUUID(),
    state: "running",
  });
  const { root, caller, dispatcher } = await setup(t, [idle, busy]);

  const result = await runDelegate({
    rootDir: root,
    dispatcher,
    callerEntry: caller,
    caller: makeCallerRef(caller),
    options: { question: "x", targetHint: "Red-3" },
    appendAskEntry: () => {},
    appendHandoffEntry: () => {},
    getEntries: () => [],
  });
  if (!result.ok || result.status !== "queued") throw new Error("expected queued");
  assert.equal(result.target, "Red-3");
});

test("runDelegate: blocking waits for the answered state and returns reply", async (t) => {
  const peer = makeEntry({
    metroName: "Red-2",
    instanceId: randomUUID(),
    state: "idle",
  });
  const { root, caller, dispatcher } = await setup(t, [peer]);

  // Simulate an answered request becoming visible in session entries.
  const entries: unknown[] = [];
  let pollCount = 0;
  const sleeps: number[] = [];
  let capturedRequestId: string | undefined;
  let fakeNow = 0;

  const result = await runDelegate({
    rootDir: root,
    dispatcher,
    callerEntry: caller,
    caller: makeCallerRef(caller),
    options: { question: "x", waitForReply: true, pollIntervalMs: 5, timeoutMs: 1000, ackTimeoutMs: 5 },
    appendAskEntry: (d) => { capturedRequestId = d.requestId; },
    appendHandoffEntry: () => {},
    sleep: async (ms: number) => {
      sleeps.push(ms);
      pollCount++;
      fakeNow += ms;
      // After two polls, surface an answered entry.
      if (pollCount >= 2 && capturedRequestId) {
        entries.push({
          type: "custom",
          customType: "metrol:request",
          data: {
            requestId: capturedRequestId,
            target: "Red-2",
            status: "answered",
            reply: "delegation succeeded",
            updatedAt: fakeNow,
          },
        });
      }
    },
    getEntries: () => entries,
    now: () => fakeNow,
  });

  if (!result.ok) throw new Error("expected ok");
  assert.equal(result.status, "answered");
  assert.equal(result.reply, "delegation succeeded");
  assert.equal(sleeps[0], 5);
  assert.ok(result.durationMs >= 0);
});

test("runDelegate: blocking times out cleanly when no terminal state arrives", async (t) => {
  const peer = makeEntry({
    metroName: "Red-2",
    instanceId: randomUUID(),
    state: "idle",
  });
  const { root, caller, dispatcher } = await setup(t, [peer]);

  const result = await runDelegate({
    rootDir: root,
    dispatcher,
    callerEntry: caller,
    caller: makeCallerRef(caller),
    options: { question: "x", waitForReply: true, pollIntervalMs: 10, timeoutMs: 50, ackTimeoutMs: 5 },
    appendAskEntry: () => {},
    appendHandoffEntry: () => {},
    sleep: async () => {},
    getEntries: () => [],
  });

  if (!result.ok) throw new Error("expected ok");
  assert.equal(result.status, "timeout");
  assert.match(result.error ?? "", /timeout/);
  assert.equal(result.requestId.length > 0, true);
});

test("runDelegate: blocking returns failed state when target fails the ask", async (t) => {
  const peer = makeEntry({
    metroName: "Red-2",
    instanceId: randomUUID(),
    state: "idle",
  });
  const { root, caller, dispatcher } = await setup(t, [peer]);

  const entries: unknown[] = [];
  let pollCount = 0;
  let capturedRequestId: string | undefined;
  let fakeNow = 0;
  const result = await runDelegate({
    rootDir: root,
    dispatcher,
    callerEntry: caller,
    caller: makeCallerRef(caller),
    options: { question: "x", waitForReply: true, pollIntervalMs: 5, timeoutMs: 1000, ackTimeoutMs: 5 },
    appendAskEntry: (d) => { capturedRequestId = d.requestId; },
    appendHandoffEntry: () => {},
    sleep: async () => {
      pollCount++;
      fakeNow += 5;
      if (pollCount === 1 && capturedRequestId) {
        entries.push({
          type: "custom",
          customType: "metrol:request",
          data: {
            requestId: capturedRequestId,
            target: "Red-2",
            status: "failed",
            error: "liveness_timeout",
            reason: "liveness_timeout",
            updatedAt: fakeNow,
          },
        });
      }
    },
    getEntries: () => entries,
    now: () => fakeNow,
  });

  if (!result.ok) throw new Error("expected ok");
  assert.equal(result.status, "failed");
  assert.equal(result.error, "liveness_timeout");
});

test("runDelegate: defaults match the documented contract", () => {
  assert.equal(DEFAULT_DELEGATE_TIMEOUT_MS, 5 * 60_000);
  assert.equal(DEFAULT_DELEGATE_POLL_MS, 1_000);
});

// claimMetroAlias smoke test — used to make sure peer names align with the
// alias allocator when scope=all is used.
test("runDelegate: scope=all honors cross-project peers", async (t) => {
  const root = await withTempRoot(t);
  const caller = makeEntry({ instanceId: randomUUID(), projectRoot: "/tmp/proj" });
  const crossProjectPeer = makeEntry({
    metroName: "Blue-7",
    instanceId: randomUUID(),
    projectRoot: "/tmp/other",
    cwd: "/tmp/other/x",
    state: "idle",
  });
  await writeRegistryEntry(root, caller);
  await writeRegistryEntry(root, crossProjectPeer);
  await claimMetroAlias(root, crossProjectPeer.instanceId); // ensure the alias is allocatable
  const dispatcher = new InboxDispatcher(path.join(root, "noop"));
  dispatcher.start(60_000);
  t.after(() => dispatcher.stop());

  const result = await runDelegate({
    rootDir: root,
    dispatcher,
    callerEntry: caller,
    caller: makeCallerRef(caller),
    options: { question: "x", scope: "all" },
    appendAskEntry: () => {},
    appendHandoffEntry: () => {},
    getEntries: () => [],
  });
  if (!result.ok || result.status !== "queued") throw new Error("expected queued");
  assert.equal(result.target, "Blue-7");
  assert.equal(result.scope, "all");
});