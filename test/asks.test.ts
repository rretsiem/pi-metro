import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeRegistryEntry, type RegistryEntry } from "../src/registry.ts";
import { inboxDir, readMessage, type Message } from "../src/transport.ts";
import { InboxDispatcher } from "../src/dispatcher.ts";
import {
  AskQueue,
  ackAsk,
  askMarker,
  enqueueAsk,
  extractAskReply,
  findRequest,
  formatAskPrompt,
  rebuildRequests,
  replyAsk,
} from "../src/asks.ts";

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
  assert.deepEqual(first?.payload, { requestId: "req-9", status: "answered", reply: "the answer" });
  assert.equal(second?.type, "reply");
  assert.deepEqual(second?.payload, { requestId: "req-10", status: "failed", error: "aborted" });
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
