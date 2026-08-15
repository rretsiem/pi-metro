import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeRegistryEntry, type RegistryEntry } from "../src/registry.ts";
import { inboxDir, readMessage, type Message } from "../src/transport.ts";
import { InboxDispatcher } from "../src/dispatcher.ts";
import {
  AskQueue,
  MAX_ASK_QUEUE_DEPTH,
  REPLY_PAYLOAD_MAX_BYTES,
  STATE_RANK,
  applyRankedTransition,
  ackAsk,
  askMarker,
  enqueueAsk,
  extractAskReply,
  findRequest,
  formatAskPrompt,
  livenessMonitor,
  rebuildRequests,
  replyAsk,
  sendFail,
  sendProgress,
  truncateReply,
} from "../src/asks.ts";

const waitFor = async (
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> => {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-ask-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function entry(over: Partial<RegistryEntry> & { instanceId: string }): RegistryEntry {
  return {
    version: 1,
    metroName: "Red-1",
    cwd: "/work/app/api",
    projectRoot: "/work/app",
    pid: process.pid,
    state: "idle",
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
    ...over,
  };
}

const CALLER = entry({ instanceId: "me", metroName: "Red-1" });
const TARGET = entry({ instanceId: "bob", metroName: "Blue-1", sessionName: "auth-refactor" });

function customEntry(data: unknown) {
  return { type: "custom", customType: "metrol:request", data };
}

// 1. formatAskPrompt carries identity, marker, question
test("formatAskPrompt includes request ID, sender identity, and question", () => {
  const p = formatAskPrompt({
    requestId: "req-123",
    question: "Which module owns token refresh?",
    from: { instanceId: "me", metroName: "Red-1", sessionName: "auth-refactor" },
  });
  assert.ok(p.includes(askMarker("req-123")));
  assert.ok(p.includes("req-123"));
  assert.ok(p.includes("Red-1"));
  assert.ok(p.includes("auth-refactor"));
  assert.ok(p.includes("Which module owns token refresh?"));
  assert.match(p, /Metrol/);
  assert.match(p, /not instructions/i);
});

// 2. latest request entry wins when rebuilding state
test("rebuildRequests: latest entry per requestId wins; findRequest resolves latest/unknown", () => {
  const entries = [
    customEntry({ requestId: "a", target: "Blue-1", status: "queued", question: "q", updatedAt: 1 }),
    customEntry({ requestId: "b", target: "Blue-1", status: "queued", question: "q2", updatedAt: 2 }),
    { type: "message", message: { role: "user", content: "noise" } },
    customEntry({ requestId: "a", target: "Blue-1", status: "answered", question: "q", reply: "the answer", updatedAt: 3 }),
    { type: "custom", customType: "metrol:identity", data: { metroName: "Red-1" } },
  ];
  const all = rebuildRequests(entries);
  assert.equal(all.length, 2);
  const a = all.find((r) => r.requestId === "a");
  assert.equal(a?.status, "answered");
  assert.equal(a?.reply, "the answer");

  // no id → most recent by updatedAt
  const latest = findRequest(entries);
  assert.equal(latest.ok, true);
  if (latest.ok) assert.equal(latest.request.requestId, "a");

  const older = findRequest(entries, "b");
  assert.equal(older.ok, true);
  if (older.ok) assert.equal(older.request.status, "queued");

  const missing = findRequest(entries, "nope");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /nope/);

  const none = findRequest([]);
  assert.equal(none.ok, false);
});

// 3. enqueueAsk returns immediately with queued request ID and writes a valid ask file
test("enqueueAsk persists queued state and writes a valid ask message file", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(root, TARGET);
  const targetInbox = await inboxDir(root, "bob");

  const dispatcher = new InboxDispatcher(await inboxDir(root, "me"), () => {});
  dispatcher.start(10);
  t.after(() => dispatcher.stop());

  const persisted: unknown[] = [];
  const r = await enqueueAsk(
    root, dispatcher, CALLER, "Blue-1", "What does the parser export?",
    "project",
    (data) => persisted.push(data),
    100, // short ack timeout: nobody is reading the target inbox here
  );
  assert.equal(r.status, "queued");
  assert.equal(typeof r.requestId, "string");
  assert.match(r.ack ?? "", /timeout/); // no receiver → ack times out, still queued

  const files = (await readdir(targetInbox)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  const read = await readMessage(path.join(targetInbox, files[0]));
  assert.equal(read.ok, true);
  if (read.ok) {
    assert.equal(read.msg.type, "ask");
    assert.equal(read.msg.toInstanceId, "bob");
    assert.equal(read.msg.from.metroName, "Red-1");
    const p = read.msg.payload as { requestId: string; question: string };
    assert.equal(p.requestId, r.requestId);
    assert.equal(p.question, "What does the parser export?");
  }

  const queued = persisted[0] as { requestId: string; status: string; question: string };
  assert.equal(queued.requestId, r.requestId);
  assert.equal(queued.status, "queued");
  assert.equal(queued.question, "What does the parser export?");

  await dispatcher.stop();
});

test("enqueueAsk persists failed state and throws when the target cannot be resolved", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  const dispatcher = new InboxDispatcher(await inboxDir(root, "me"), () => {});
  dispatcher.start(10);
  t.after(() => dispatcher.stop());

  const persisted: { status: string; error?: string }[] = [];
  await assert.rejects(
    () => enqueueAsk(root, dispatcher, CALLER, "Ghost-1", "hi", "project", (d) => persisted.push(d), 100),
    /not found/,
  );
  assert.equal(persisted[0]?.status, "failed");
  assert.match(persisted[0]?.error ?? "", /not found/);
  await dispatcher.stop();
});

// 4. ACK correlation is delivered if the ACK arrives immediately after registration
test("ask ACK resolves the registered correlation even when it arrives immediately", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(root, TARGET);

  const callerDispatcher = new InboxDispatcher(await inboxDir(root, "me"), () => {});
  callerDispatcher.start(10);
  t.after(() => callerDispatcher.stop());

  const acked: string[] = [];
  const receiver = new InboxDispatcher(await inboxDir(root, "bob"), {
    onChat: () => {},
    onAsk: async (msg) => {
      await ackAsk(root, TARGET, msg); // immediate ACK, correlated to msg.id
      acked.push((msg.payload as { requestId: string }).requestId);
    },
  });
  receiver.start(10);
  t.after(() => receiver.stop());

  const r = await enqueueAsk(root, callerDispatcher, CALLER, "Blue-1", "ping?", "project", undefined, 3000);
  assert.equal(r.ack, null); // ACK arrived and resolved the waiter
  assert.deepEqual(acked, [r.requestId]);

  await callerDispatcher.stop();
  await receiver.stop();
});

// 5. FIFO queue starts only one active ask at a time
test("AskQueue runs items FIFO with exactly one active at a time", async () => {
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const gates = new Map<string, () => void>();
  const q = new AskQueue<string>(
    (item) =>
      new Promise<void>((resolve) => {
        active++;
        maxActive = Math.max(maxActive, active);
        order.push(item);
        gates.set(item, () => {
          active--;
          resolve();
        });
      }),
  );

  q.enqueue("first");
  q.enqueue("second");
  q.enqueue("third");
  assert.equal(q.queuedCount, 2); // one active, two waiting

  // only the first started; nothing runs ahead
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["first"]);

  gates.get("first")!();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["first", "second"]);

  gates.get("second")!();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["first", "second", "third"]);

  gates.get("third")!();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(maxActive, 1);
  assert.equal(q.queuedCount, 0);
});

test("AskQueue advances after a failing run", async () => {
  const done: string[] = [];
  const q = new AskQueue<string>(async (item) => {
    done.push(item);
    if (item === "boom") throw new Error("run failed");
  });
  q.enqueue("boom");
  q.enqueue("next");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(done, ["boom", "next"]);
});

// 6. answered/failed reply state is persisted and readable
test("answered and failed request states are persisted and readable via findRequest", () => {
  const entries = [
    customEntry({ requestId: "r1", target: "Blue-1", status: "queued", question: "q", updatedAt: 1 }),
    customEntry({ requestId: "r1", target: "Blue-1", status: "answered", question: "q", reply: "42", updatedAt: 2 }),
    customEntry({ requestId: "r2", target: "Blue-1", status: "failed", question: "x", error: "agent run aborted", updatedAt: 3 }),
  ];
  const r1 = findRequest(entries, "r1");
  assert.equal(r1.ok, true);
  if (r1.ok) {
    assert.equal(r1.request.status, "answered");
    assert.equal(r1.request.reply, "42");
  }
  const r2 = findRequest(entries, "r2");
  assert.equal(r2.ok, true);
  if (r2.ok) {
    assert.equal(r2.request.status, "failed");
    assert.equal(r2.request.error, "agent run aborted");
  }
});

test("replyAsk writes a reply correlated to the original request", async (t) => {
  const root = await withTempRoot(t);
  const callerInbox = await inboxDir(root, "me");
  const askMsg: Message = {
    version: 1,
    id: "req-9",
    type: "ask",
    from: { instanceId: "me", metroName: "Red-1" },
    toInstanceId: "bob",
    payload: { requestId: "req-9", question: "q" },
    timestamp: Date.now(),
  };
  await replyAsk(root, TARGET, askMsg, { status: "answered", reply: "the answer" });
  await replyAsk(root, TARGET, { ...askMsg, id: "req-10", payload: { requestId: "req-10", question: "q2" } }, { status: "failed", error: "aborted" });

  const files = (await readdir(callerInbox)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 2);
  const byCorrelation = new Map<string, Message>();
  for (const f of files) {
    const r = await readMessage(path.join(callerInbox, f));
    assert.equal(r.ok, true);
    if (r.ok) byCorrelation.set(r.msg.correlationId!, r.msg);
  }
  const first = byCorrelation.get("req-9");
  const second = byCorrelation.get("req-10");
  assert.equal(first?.type, "reply");
  assert.deepEqual(first?.payload, {
    requestId: "req-9",
    status: "answered",
    reply: "the answer",
    truncated: false,
  });
  assert.equal(second?.type, "reply");
  assert.deepEqual(second?.payload, {
    requestId: "req-10",
    status: "failed",
    error: "aborted",
  });
});

// extractAskReply: marker-anchored capture of the ask's own run
test("extractAskReply captures only the run after the request marker", () => {
  const marker = askMarker("req-1");
  const branch = [
    { type: "message", message: { role: "user", content: "earlier question" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "earlier answer" }] } },
    { type: "message", message: { role: "user", content: `${marker}\nmetrol ask...` } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "part one" },
          { type: "toolCall", id: "t1", name: "bash" },
          { type: "text", text: "part two" },
        ],
        stopReason: "stop",
      },
    },
  ];
  const o = extractAskReply(branch, "req-1");
  assert.deepEqual(o, { status: "answered", reply: "part one\npart two" });
});

test("extractAskReply returns null while the ask run has not happened yet", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "unrelated work" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "unrelated reply" }] } },
  ];
  assert.equal(extractAskReply(branch, "req-1"), null);
  // marker of a DIFFERENT request does not count
  const other = [...branch, { type: "message", message: { role: "user", content: askMarker("req-2") } }];
  assert.equal(extractAskReply(other, "req-1"), null);
});

test("extractAskReply reports aborted/error runs as failed", () => {
  const marker = askMarker("req-1");
  const branch = [
    { type: "message", message: { role: "user", content: marker } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "aborted", errorMessage: "user aborted" },
    },
  ];
  assert.deepEqual(extractAskReply(branch, "req-1"), { status: "failed", error: "user aborted" });

  const noAssistant = [{ type: "message", message: { role: "user", content: marker } }];
  assert.deepEqual(extractAskReply(noAssistant, "req-1"), { status: "failed", error: "no assistant response" });
});

// ===== Task 03: Resilient remote asks =====

test("extractAskReply: aborted with partial text returns answered (not failed)", () => {
  const marker = askMarker("req-1");
  const branch = [
    { type: "message", message: { role: "user", content: marker } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial answer" }],
        stopReason: "aborted",
        errorMessage: "user aborted",
      },
    },
  ];
  assert.deepEqual(extractAskReply(branch, "req-1"), { status: "answered", reply: "partial answer" });
});

test("extractAskReply: error stopReason returns failed with run_failed, ignoring partial text", () => {
  const marker = askMarker("req-1");
  const branch = [
    { type: "message", message: { role: "user", content: marker } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "partial" }],
        stopReason: "error",
        errorMessage: "something broke",
      },
    },
  ];
  assert.deepEqual(extractAskReply(branch, "req-1"), {
    status: "failed",
    error: "run_failed",
    reason: "run_failed",
  });
});

test("rebuildRequests: malformed entries (missing requestId or status) are skipped", () => {
  const entries = [
    customEntry({ requestId: "a", status: "queued", updatedAt: 1 }),
    customEntry({ requestId: "b" }),                      // missing status
    customEntry({ status: "queued" }),                    // missing requestId
    customEntry({}),                                      // missing both
    null,
    undefined,
    { type: "custom", customType: "metrol:request", data: null },
    customEntry({ requestId: "c", status: "answered", updatedAt: 2 }),
  ];
  const all = rebuildRequests(entries);
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((r) => r.requestId).sort(), ["a", "c"]);
});

test("rebuildRequests: equal updatedAt deterministically orders by later index", () => {
  const entries = [
    customEntry({ requestId: "a", status: "queued", updatedAt: 100 }),
    customEntry({ requestId: "b", status: "queued", updatedAt: 100 }),
    customEntry({ requestId: "c", status: "queued", updatedAt: 100 }),
  ];
  const all = rebuildRequests(entries);
  // Same timestamp: later index wins (c, b, a)
  assert.deepEqual(all.map((r) => r.requestId), ["c", "b", "a"]);
});

test("truncateReply: text under 60 KiB is unchanged and not flagged", () => {
  const r = truncateReply("hi");
  assert.deepEqual(r, { text: "hi", truncated: false });
  const exact = truncateReply("x".repeat(REPLY_PAYLOAD_MAX_BYTES));
  assert.equal(exact.truncated, false);
  assert.equal(exact.text.length, REPLY_PAYLOAD_MAX_BYTES);
});

test("truncateReply: text over 60 KiB is truncated and flagged", () => {
  const text = "x".repeat(70 * 1024);
  const r = truncateReply(text);
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text, "utf8") <= REPLY_PAYLOAD_MAX_BYTES);
  assert.ok(r.text.length < text.length);
});

test("truncateReply: respects multi-byte character boundaries (UTF-8)", () => {
  // 16384 emojis = 65536 bytes > 60 KiB; truncation must not split a codepoint
  const text = "🎉".repeat(16384);
  const r = truncateReply(text);
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.text, "utf8") <= REPLY_PAYLOAD_MAX_BYTES);
  // every kept codepoint is a whole emoji
  assert.match(r.text, /^(🎉)*$/);
});

test("AskQueue.MAX_ASK_QUEUE_DEPTH: enqueue returns true for first 4, false for the 5th", async () => {
  const q = new AskQueue<string>(async () => {
    // never resolves
  });
  assert.equal(q.enqueue("a"), true);
  assert.equal(q.enqueue("b"), true);
  assert.equal(q.enqueue("c"), true);
  assert.equal(q.enqueue("d"), true);
  assert.equal(q.enqueue("e"), false);
  assert.equal(MAX_ASK_QUEUE_DEPTH, 4);
});

test("AskQueue: completing the active run reopens a slot", async () => {
  let resolveRun!: () => void;
  const q = new AskQueue<string>(
    () => new Promise<void>((r) => { resolveRun = r; }),
  );
  assert.equal(q.enqueue("a"), true);
  assert.equal(q.enqueue("b"), true);
  assert.equal(q.enqueue("c"), true);
  assert.equal(q.enqueue("d"), true);
  assert.equal(q.enqueue("e"), false);
  resolveRun();
  await new Promise((r) => setTimeout(r, 20));
  // "a" finished, "b" is now active; slot reopened
  assert.equal(q.enqueue("f"), true);
});

test("applyRankedTransition: higher rank wins for non-terminal", () => {
  assert.equal(STATE_RANK.queued, 0);
  assert.equal(STATE_RANK.accepted, 1);
  assert.equal(STATE_RANK.running, 2);
  assert.equal(STATE_RANK.answered, 3);
  assert.equal(STATE_RANK.failed, 3);
  assert.equal(applyRankedTransition("queued", "accepted"), "accepted");
  assert.equal(applyRankedTransition("accepted", "running"), "running");
  assert.equal(applyRankedTransition("queued", "running"), "running");
});

test("applyRankedTransition: lower rank is ignored", () => {
  assert.equal(applyRankedTransition("accepted", "queued"), "accepted");
  assert.equal(applyRankedTransition("running", "accepted"), "running");
  assert.equal(applyRankedTransition("running", "queued"), "running");
});

test("applyRankedTransition: terminal states are sticky (current wins)", () => {
  assert.equal(applyRankedTransition("answered", "failed"), "answered");
  assert.equal(applyRankedTransition("failed", "answered"), "failed");
  assert.equal(applyRankedTransition("answered", "queued"), "answered");
  assert.equal(applyRankedTransition("answered", "running"), "answered");
  assert.equal(applyRankedTransition("failed", "running"), "failed");
  assert.equal(applyRankedTransition("failed", "queued"), "failed");
});

test("applyRankedTransition: incoming terminal wins over non-terminal current", () => {
  assert.equal(applyRankedTransition("queued", "answered"), "answered");
  assert.equal(applyRankedTransition("running", "failed"), "failed");
  assert.equal(applyRankedTransition("accepted", "failed"), "failed");
});

test("livenessMonitor: target_gone when registry removes the target", async () => {
  const entry: RegistryEntry = {
    version: 1,
    instanceId: "bob",
    metroName: "Bob",
    cwd: "/tmp",
    projectRoot: "/tmp",
    pid: process.pid,
    state: "idle",
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };
  let live: RegistryEntry[] = [entry];
  const failures: string[] = [];
  const m = livenessMonitor({
    requestId: "r1",
    targetInstanceId: "bob",
    rootDir: "/tmp",
    onFailure: (r) => failures.push(r),
    intervalMs: 10,
    inactivityTimeoutMs: 1000,
    readRegistry: async () => live,
  });
  m.start();
  await new Promise((r) => setTimeout(r, 30));
  live = [];
  await new Promise((r) => setTimeout(r, 30));
  m.stop();
  assert.ok(failures.includes("target_gone"));
});

test("livenessMonitor: liveness_timeout when heartbeat never advances", async () => {
  const entry: RegistryEntry = {
    version: 1,
    instanceId: "bob",
    metroName: "Bob",
    cwd: "/tmp",
    projectRoot: "/tmp",
    pid: process.pid,
    state: "idle",
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };
  const failures: string[] = [];
  const m = livenessMonitor({
    requestId: "r1",
    targetInstanceId: "bob",
    rootDir: "/tmp",
    onFailure: (r) => failures.push(r),
    intervalMs: 10,
    inactivityTimeoutMs: 50,
    readRegistry: async () => [entry],
  });
  m.start();
  await new Promise((r) => setTimeout(r, 120));
  m.stop();
  assert.ok(failures.includes("liveness_timeout"));
});

test("livenessMonitor: deadline_exceeded after hard ceiling", async () => {
  const entry: RegistryEntry = {
    version: 1,
    instanceId: "bob",
    metroName: "Bob",
    cwd: "/tmp",
    projectRoot: "/tmp",
    pid: process.pid,
    state: "idle",
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };
  const failures: string[] = [];
  const m = livenessMonitor({
    requestId: "r1",
    targetInstanceId: "bob",
    rootDir: "/tmp",
    onFailure: (r) => failures.push(r),
    intervalMs: 10,
    inactivityTimeoutMs: 1000,
    hardCeilingMs: 50,
    readRegistry: async () => [entry],
  });
  m.start();
  await new Promise((r) => setTimeout(r, 120));
  m.stop();
  assert.ok(failures.includes("deadline_exceeded"));
});

test("livenessMonitor: recordEvent resets the inactivity clock", async () => {
  const entry: RegistryEntry = {
    version: 1,
    instanceId: "bob",
    metroName: "Bob",
    cwd: "/tmp",
    projectRoot: "/tmp",
    pid: process.pid,
    state: "idle",
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
  };
  const failures: string[] = [];
  const m = livenessMonitor({
    requestId: "r1",
    targetInstanceId: "bob",
    rootDir: "/tmp",
    onFailure: (r) => failures.push(r),
    intervalMs: 5,
    inactivityTimeoutMs: 50,
    readRegistry: async () => [entry],
  });
  m.start();
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 15));
    m.recordEvent();
  }
  m.stop();
  assert.deepEqual(failures, []);
});

test("livenessMonitor: heartbeat advance resets the inactivity clock", async () => {
  let hb = Date.now();
  const failures: string[] = [];
  const m = livenessMonitor({
    requestId: "r1",
    targetInstanceId: "bob",
    rootDir: "/tmp",
    onFailure: (r) => failures.push(r),
    intervalMs: 5,
    inactivityTimeoutMs: 50,
    readRegistry: async () => [
      {
        version: 1,
        instanceId: "bob",
        metroName: "Bob",
        cwd: "/tmp",
        projectRoot: "/tmp",
        pid: process.pid,
        state: "idle",
        startedAt: Date.now(),
        lastHeartbeat: hb,
      },
    ],
  });
  m.start();
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 15));
    hb = Date.now(); // heartbeat advances
  }
  m.stop();
  assert.deepEqual(failures, []);
});

test("enqueueAsk: self-target is rejected before any write", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  const bobInbox = await inboxDir(root, "bob");
  const meInbox = await inboxDir(root, "me");
  const dispatcher = new InboxDispatcher(meInbox, () => {});
  dispatcher.start(10);
  t.after(() => dispatcher.stop());

  const persisted: { status: string; error?: string }[] = [];
  // CALLER.metroName is "Red-1"; resolveTarget filters out the caller's instanceId,
  // so self-target comes back as "not found" instead of accepting an ask to ourselves.
  await assert.rejects(
    () =>
      enqueueAsk(
        root, dispatcher, CALLER, "Red-1", "hi", "project",
        (d) => persisted.push(d), 100,
      ),
    /not found/,
  );
  assert.equal(persisted[0]?.status, "failed");
  // No file written to the target's inbox
  assert.equal(
    (await readdir(bobInbox)).filter((f) => f.endsWith(".json")).length,
    0,
  );
});

test("dispatcher: malformed chat message is rejected and its file removed", async (t) => {
  const root = await withTempRoot(t);
  const dir = await inboxDir(root, "target-1");
  const received: Message[] = [];
  const d = new InboxDispatcher(dir, (m) => {
    received.push(m);
  });
  d.start(10);
  t.after(() => d.stop());

  // Write a malformed message directly (invalid version)
  const file = path.join(dir, `${Date.now()}-bad.json`);
  await writeFile(
    file,
    JSON.stringify({
      version: 2,
      type: "chat",
      id: randomUUID(),
      from: { instanceId: "sender", metroName: "x" },
      toInstanceId: "target-1",
      payload: { text: "hi" },
      timestamp: Date.now(),
    }),
  );

  await waitFor(
    async () => (await readdir(dir)).filter((f) => f.endsWith(".json")).length === 0,
  );
  await d.stop();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, 0);
});
