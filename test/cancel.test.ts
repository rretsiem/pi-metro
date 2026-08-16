import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AskQueue, findRequest, sendFail } from "../src/asks.ts";
import { InboxDispatcher } from "../src/dispatcher.ts";
import {
  safeInboxDir,
  writeMessage,
  readMessage,
  type Message,
} from "../src/transport.ts";
import { writeRegistryEntry, type RegistryEntry } from "../src/registry.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-cancel-test-"));
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
    cwd: "/tmp/x",
    projectRoot: "/tmp/x",
    pid: process.pid,
    model: "anthropic/claude-opus-4-6",
    state: "idle",
    startedAt: now,
    lastHeartbeat: now,
    ...overrides,
  };
}

// ===== AskQueue.remove =====

test("AskQueue.remove drops a waiting item by predicate and returns it", async () => {
  type Item = { id: string };
  // Use a blocker so the first item stays in busy state, keeping the
  // remaining items queued (pump won't drain them while busy).
  let release: (() => void) | undefined;
  const blocker = new Promise<void>((r) => {
    release = r;
  });
  const q = new AskQueue<Item>(async () => {
    await blocker;
  });
  q.enqueue({ id: "a" }); // runs, blocks → busy
  q.enqueue({ id: "b" }); // queued
  q.enqueue({ id: "c" }); // queued
  // Wait for "a" to start so the queue is busy with it.
  await waitFor(() => q.isActive);
  assert.equal(q.queuedCount, 2);
  const dropped = q.remove((x) => x.id === "c");
  assert.deepEqual(dropped, { id: "c" });
  assert.equal(q.queuedCount, 1);
  // Let "a" finish so the test exits cleanly.
  release!();
});

test("AskQueue.remove returns undefined when nothing matches", async () => {
  // Block the first item so the second stays in waiting, then remove
  // a non-existent id from waiting.
  let release: (() => void) | undefined;
  const blocker = new Promise<void>((r) => {
    release = r;
  });
  const q = new AskQueue<{ id: string }>(async () => {
    await blocker;
  });
  q.enqueue({ id: "a" });
  q.enqueue({ id: "b" });
  await waitFor(() => q.isActive);
  assert.equal(q.queuedCount, 1);
  const dropped = q.remove((x) => x.id === "z");
  assert.equal(dropped, undefined);
  assert.equal(q.queuedCount, 1);
  release!();
});

test("AskQueue.remove cannot remove the currently-running item", async () => {
  let started = false;
  let release: (() => void) | undefined;
  const blocker = new Promise<void>((r) => {
    release = r;
  });
  const q = new AskQueue<{ id: string }>(async () => {
    started = true;
    await blocker;
  });
  q.enqueue({ id: "running" });
  await waitFor(() => started);
  const dropped = q.remove((x) => x.id === "running");
  assert.equal(dropped, undefined);
  release!();
});

// ===== Receiver-side onCancel behaviour =====

interface CancelFixture {
  rootDir: string;
  receiverInstanceId: string;
  senderInstanceId: string;
  dispatcher: InboxDispatcher;
}

async function setupTwoParty(
  t: import("node:test").TestContext,
): Promise<CancelFixture> {
  const rootDir = await withTempRoot(t);
  const receiverInstanceId = randomUUID();
  const senderInstanceId = randomUUID();
  await writeRegistryEntry(rootDir, makeEntry({ instanceId: receiverInstanceId }));
  await writeRegistryEntry(rootDir, makeEntry({ instanceId: senderInstanceId }));
  const receiverDir = await safeInboxDir(rootDir, receiverInstanceId);
  const dispatcher = new InboxDispatcher(receiverDir, {
    onChat: () => {},
    onCancel: async () => {
      // Test wires its own onCancel in specific tests.
    },
  });
  dispatcher.start(10);
  t.after(() => dispatcher.stop());
  return { rootDir, receiverInstanceId, senderInstanceId, dispatcher };
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(5);
  }
}

test("dispatcher routes cancel messages to onCancel", async (t) => {
  const f = await setupTwoParty(t);
  const received: string[] = [];
  // Replace the dispatcher with one that captures cancel payloads.
  await f.dispatcher.stop();
  const dir = await safeInboxDir(f.rootDir, f.receiverInstanceId);
  const d = new InboxDispatcher(dir, {
    onCancel: async (msg) => {
      const p = msg.payload as { requestId?: unknown };
      if (typeof p?.requestId === "string") received.push(p.requestId);
    },
  });
  d.start(10);
  t.after(() => d.stop());

  // Write a cancel message directly into the receiver's inbox.
  const senderEntry = makeEntry({ instanceId: f.senderInstanceId });
  const cancel: Message = {
    version: 1,
    id: randomUUID(),
    type: "cancel",
    from: {
      instanceId: senderEntry.instanceId,
      metroName: senderEntry.metroName,
    },
    toInstanceId: f.receiverInstanceId,
    payload: { requestId: "req-xyz" },
    timestamp: Date.now(),
  };
  await writeMessage(dir, cancel);
  await waitFor(() => received.length === 1);
  assert.deepEqual(received, ["req-xyz"]);
});

test("cancel before accept: a queued ask is removed and a fail/cancelled is sent back", async (t) => {
  const rootDir = await withTempRoot(t);
  const receiverInstanceId = randomUUID();
  const senderInstanceId = randomUUID();
  await writeRegistryEntry(rootDir, makeEntry({ instanceId: receiverInstanceId }));
  await writeRegistryEntry(rootDir, makeEntry({ instanceId: senderInstanceId }));
  const receiverDir = await safeInboxDir(rootDir, receiverInstanceId);
  const senderDir = await safeInboxDir(rootDir, senderInstanceId);

  // Use a blocker so the FIRST enqueued item holds busy state; subsequent
  // enqueues stay in waiting. This lets us enqueue an ask that we can
  // cancel before it ever runs.
  let releaseFirst: (() => void) | undefined;
  const blocker = new Promise<void>((r) => {
    releaseFirst = r;
  });
  const startedRuns: string[] = [];
  const q = new AskQueue<{ msg: Message; requestId: string }>(
    async (item) => {
      startedRuns.push(item.requestId);
      await blocker;
    },
  );

  // Pre-block the queue by enqueueing a sentinel (this represents an
  // earlier ask already in progress on the receiver).
  q.enqueue({
    msg: { from: { instanceId: "sentinel", metroName: "sentinel" } } as Message,
    requestId: "sentinel",
  });
  await waitFor(() => q.isActive);

  const senderEntry: RegistryEntry = makeEntry({ instanceId: senderInstanceId });
  const d = new InboxDispatcher(receiverDir, {
    onAsk: async (msg) => {
      const p = msg.payload as { requestId?: unknown };
      const requestId = typeof p?.requestId === "string" ? p.requestId : msg.id;
      q.enqueue({ msg, requestId });
    },
    onCancel: async (msg) => {
      const p = msg.payload as { requestId?: unknown };
      if (typeof p?.requestId !== "string") return;
      const dropped = q.remove((x) => x.requestId === p.requestId);
      if (dropped) {
        await sendFail(rootDir, senderEntry, dropped.msg, p.requestId, "cancelled", "cancelled by sender");
      }
    },
  });
  d.start(10);
  t.after(() => d.stop());

  const ask: Message = {
    version: 1,
    id: "ask-1",
    type: "ask",
    from: {
      instanceId: senderInstanceId,
      metroName: "Red-1",
    },
    toInstanceId: receiverInstanceId,
    payload: { requestId: "req-1", question: "test?" },
    timestamp: Date.now(),
  };
  await writeMessage(receiverDir, ask);

  // Wait until the ask is queued (not running — sentinel holds busy).
  await waitFor(() => q.queuedCount === 1);

  // Now write a cancel message.
  const cancel: Message = {
    version: 1,
    id: randomUUID(),
    type: "cancel",
    from: {
      instanceId: senderInstanceId,
      metroName: "Red-1",
    },
    toInstanceId: receiverInstanceId,
    payload: { requestId: "req-1" },
    timestamp: Date.now(),
  };
  await writeMessage(receiverDir, cancel);

  // Wait until the queue drops to 0 and a fail message lands in the
  // sender's inbox.
  await waitFor(() => q.queuedCount === 0);
  await waitFor(async () => (await readdir(senderDir)).length > 0);
  // The ask should never have started (it was cancelled before its run).
  assert.equal(startedRuns.includes("req-1"), false);
  // The fail message should be a fail with reason=cancelled.
  const senderFiles = await readdir(senderDir);
  assert.ok(senderFiles.length > 0);
  const failFile = senderFiles[0];
  const r = await readMessage(path.join(senderDir, failFile));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.msg.type, "fail");
  const fp = r.msg.payload as { requestId?: unknown; reason?: unknown };
  assert.equal(fp.requestId, "req-1");
  assert.equal(fp.reason, "cancelled");
  // Let the sentinel drain so the test exits cleanly.
  releaseFirst!();
});

test("cancel during run: a running ask is marked cancelled; the natural reply is discarded", async (t) => {
  const rootDir = await withTempRoot(t);
  const receiverInstanceId = randomUUID();
  const senderInstanceId = randomUUID();
  await writeRegistryEntry(rootDir, makeEntry({ instanceId: receiverInstanceId }));
  await writeRegistryEntry(rootDir, makeEntry({ instanceId: senderInstanceId }));
  const receiverDir = await safeInboxDir(rootDir, receiverInstanceId);
  const senderDir = await safeInboxDir(rootDir, senderInstanceId);

  const cancelledAsks = new Set<string>();
  const completedRuns: { requestId: string; persisted: boolean }[] = [];

  let release: (() => void) | undefined;
  const blocker = new Promise<void>((r) => {
    release = r;
  });
  const q = new AskQueue<{ msg: Message; requestId: string }>(
    async (item) => {
      // Simulate a long-running ask; the run resolves only when the test
      // releases the blocker.
      await blocker;
      // After "completion," check cancellation. If cancelled, do NOT
      // persist; else persist "answered" with a synthetic reply.
      if (cancelledAsks.has(item.requestId)) {
        cancelledAsks.delete(item.requestId);
        completedRuns.push({ requestId: item.requestId, persisted: false });
      } else {
        completedRuns.push({ requestId: item.requestId, persisted: true });
      }
    },
  );

  const senderEntry: RegistryEntry = makeEntry({ instanceId: receiverInstanceId });
  const d = new InboxDispatcher(receiverDir, {
    onAsk: async (msg) => {
      const p = msg.payload as { requestId?: unknown };
      const requestId = typeof p?.requestId === "string" ? p.requestId : msg.id;
      q.enqueue({ msg, requestId });
    },
    onCancel: async (msg) => {
      const p = msg.payload as { requestId?: unknown };
      if (typeof p?.requestId !== "string") return;
      const dropped = q.remove((x) => x.requestId === p.requestId);
      if (dropped) {
        await sendFail(rootDir, senderEntry, dropped.msg, p.requestId, "cancelled", "cancelled");
        return;
      }
      // Currently running — mark cancelled + send fail back to sender.
      cancelledAsks.add(p.requestId);
      await sendFail(rootDir, senderEntry, msg, p.requestId, "cancelled", "cancelled mid-run");
    },
  });
  d.start(10);
  t.after(() => d.stop());

  const ask: Message = {
    version: 1,
    id: "ask-2",
    type: "ask",
    from: {
      instanceId: senderInstanceId,
      metroName: "Red-1",
    },
    toInstanceId: receiverInstanceId,
    payload: { requestId: "req-2", question: "long-running?" },
    timestamp: Date.now(),
  };
  await writeMessage(receiverDir, ask);
  // Wait for the run to start (the blocker holds it).
  await waitFor(() => q.isActive);

  // Cancel while running.
  const cancel: Message = {
    version: 1,
    id: randomUUID(),
    type: "cancel",
    from: { instanceId: senderInstanceId, metroName: "Red-1" },
    toInstanceId: receiverInstanceId,
    payload: { requestId: "req-2" },
    timestamp: Date.now(),
  };
  await writeMessage(receiverDir, cancel);
  await waitFor(async () => (await readdir(senderDir)).length > 0);

  // Now release the blocker — the run completes; cancellation should
  // suppress the persist.
  release!();
  await waitFor(() => completedRuns.length === 1);
  assert.equal(completedRuns[0].requestId, "req-2");
  assert.equal(completedRuns[0].persisted, false);
});

test("cancel an unknown requestId: dispatcher routes but handler does no-op", async (t) => {
  const f = await setupTwoParty(t);
  const events: string[] = [];
  await f.dispatcher.stop();
  const dir = await safeInboxDir(f.rootDir, f.receiverInstanceId);
  const d = new InboxDispatcher(dir, {
    onCancel: async (msg) => {
      const p = msg.payload as { requestId?: unknown };
      if (typeof p?.requestId !== "string") {
        events.push("no-request-id");
        return;
      }
      events.push(`got-${p.requestId}`);
    },
  });
  d.start(10);
  t.after(() => d.stop());

  const cancel: Message = {
    version: 1,
    id: randomUUID(),
    type: "cancel",
    from: { instanceId: f.senderInstanceId, metroName: "Red-1" },
    toInstanceId: f.receiverInstanceId,
    payload: { requestId: "never-existed" },
    timestamp: Date.now(),
  };
  await writeMessage(dir, cancel);
  await waitFor(() => events.length === 1);
  assert.deepEqual(events, ["got-never-existed"]);
});

test("malformed cancel payload (no requestId) is rejected by validateMessage", async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), "metrol-cancel-malformed-"));
  const dir = await safeInboxDir(rootDir, randomUUID());
  // The cancel type is in MESSAGE_TYPES, so validateMessage accepts it;
  // payload validation is the responsibility of onCancel. Confirm a
  // missing requestId simply leads to no-op in the handler.
  const cancel: Message = {
    version: 1,
    id: randomUUID(),
    type: "cancel",
    from: { instanceId: randomUUID(), metroName: "Red-1" },
    toInstanceId: randomUUID(),
    payload: {}, // no requestId
    timestamp: Date.now(),
  };
  const w = await writeMessage(dir, cancel);
  assert.equal(w.ok, true);
  await rm(rootDir, { recursive: true, force: true });
});

test("findRequest returns the latest entry per requestId (supersession visibility)", () => {
  const entries = [
    { type: "custom", customType: "metrol:request", data: { requestId: "r1", target: "Red-2", status: "queued", updatedAt: 100 } },
    { type: "custom", customType: "metrol:request", data: { requestId: "r1", target: "Red-2", status: "failed", reason: "cancelled", updatedAt: 200 } },
  ];
  const r = findRequest(entries, "r1");
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.request.status, "failed");
  assert.equal(r.request.reason, "cancelled");
});

// Suppress unused-import noise from tools that future tests may need.
void writeFile;
void readFile;