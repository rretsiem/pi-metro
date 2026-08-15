import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { inboxDir, writeMessage, type Message } from "../src/transport.ts";
import { InboxDispatcher } from "../src/dispatcher.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-dispatcher-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(5);
  }
}

function msg(over: Record<string, unknown> = {}): Message {
  return {
    version: 1,
    id: randomUUID(),
    type: "chat",
    correlationId: randomUUID(),
    from: { instanceId: "sender-1", metroName: "Red-1" },
    toInstanceId: "target-1",
    payload: { text: "hi" },
    timestamp: Date.now(),
    ...over,
  } as Message;
}

test("delivers each new chat message once and empties the inbox", async (t) => {
  const root = await withTempRoot(t);
  const dir = await inboxDir(root, "target-1");
  const received: Message[] = [];
  const d = new InboxDispatcher(dir, (m) => {
    received.push(m);
  });
  d.start(10);
  t.after(() => d.stop());
  await writeMessage(dir, msg());
  await writeMessage(dir, msg());
  await writeMessage(dir, msg());
  await waitFor(() => received.length === 3);
  await waitFor(async () => (await readdir(dir)).length === 0);
  await d.stop();
  await sleep(50);
  assert.equal(received.length, 3);
  assert.equal(new Set(received.map((m) => m.id)).size, 3);
});

test("a reply registered before the write resolves the waiting promise", async (t) => {
  const root = await withTempRoot(t);
  const dir = await inboxDir(root, "target-1");
  const d = new InboxDispatcher(dir);
  d.start(10);
  t.after(() => d.stop());
  const correlationId = randomUUID();
  const waiting = d.awaitReply(correlationId, 3000);
  await writeMessage(
    dir,
    msg({ type: "reply", correlationId, payload: { answer: 42 } }),
  );
  const r = await waiting;
  assert.equal(r.error, null);
  assert.deepEqual(r.value, { answer: 42 });
  await d.stop();
});

test("two chat files with the same id are delivered once", async (t) => {
  const root = await withTempRoot(t);
  const dir = await inboxDir(root, "target-1");
  const received: Message[] = [];
  const d = new InboxDispatcher(dir, (m) => {
    received.push(m);
  });
  d.start(10);
  t.after(() => d.stop());
  const id = randomUUID();
  await writeMessage(dir, msg({ id }));
  await writeMessage(dir, msg({ id, timestamp: Date.now() + 1 }));
  await waitFor(async () => (await readdir(dir)).length === 0);
  await d.stop();
  assert.equal(received.length, 1);
  assert.equal(received[0].id, id);
});

test("stop() waits for an in-flight tick and no ticks run afterwards", async (t) => {
  const root = await withTempRoot(t);
  const dir = await inboxDir(root, "target-1");
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const d = new InboxDispatcher(dir, async () => {
    entered++;
    await gate;
  });
  await writeMessage(dir, msg());
  d.start(10);
  t.after(() => d.stop());
  await waitFor(() => entered === 1);
  const stopped = d.stop();
  release();
  await stopped; // must not hang: stop awaited the in-flight handler
  await writeMessage(dir, msg());
  await sleep(80);
  assert.equal(entered, 1);
});
