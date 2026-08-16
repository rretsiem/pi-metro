import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeRegistryEntry, type RegistryEntry } from "../src/registry.ts";
import {inboxDir, safeInboxDir} from "../src/transport.ts";
import { InboxDispatcher } from "../src/dispatcher.ts";
import {
  answerQuery,
  handleQuery,
  runQuery,
  type QuerySnapshot,
} from "../src/queries.ts";

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-query-test-"));
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

const CALLER = entry({ instanceId: "a1a1a1a1", metroName: "Red-1" });
const TARGET = entry({ instanceId: "b0b0b0b0", metroName: "Blue-1" });

function snapshot(over: Partial<QuerySnapshot> = {}): QuerySnapshot {
  return {
    metroName: "Blue-1",
    sessionName: "auth-refactor",
    cwd: "/work/app/api",
    projectRoot: "/work/app",
    model: "anthropic/claude-opus-4-6",
    thinkingLevel: "high",
    state: "idle",
    contextUsage: { tokens: 12_345, contextWindow: 200_000 },
    lastActivity: Date.now(),
    branch: [],
    ...over,
  };
}

test("status query returns metadata and context usage, never a total cost", () => {
  const r = answerQuery("status", snapshot());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const v = r.value as Record<string, unknown>;
  assert.equal(v.metroName, "Blue-1");
  assert.equal(v.sessionName, "auth-refactor");
  assert.equal(v.cwd, "/work/app/api");
  assert.equal(v.projectRoot, "/work/app");
  assert.equal(v.model, "anthropic/claude-opus-4-6");
  assert.equal(v.thinkingLevel, "high");
  assert.equal(v.state, "idle");
  assert.deepEqual(v.contextUsage, { tokens: 12_345, contextWindow: 200_000 });
  assert.equal(typeof v.lastActivity, "number");
  for (const key of Object.keys(v)) {
    assert.ok(!/cost/i.test(key), `status must not claim cost, found "${key}"`);
  }
});

test("last_assistant_text extracts the final assistant text from the active branch", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "q1" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "first answer" },
        ],
      },
    },
    { type: "message", message: { role: "user", content: "q2" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "final" },
          { type: "toolCall", id: "c1c1c1c1", name: "bash" },
          { type: "text", text: "answer" },
        ],
      },
    },
  ];
  const r = answerQuery("last_assistant_text", snapshot({ branch }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal((r.value as { text: string }).text, "final\nanswer");

  // no assistant message on the branch → null text
  const empty = answerQuery(
    "last_assistant_text",
    snapshot({ branch: [{ type: "message", message: { role: "user", content: "q" } }] }),
  );
  assert.equal(empty.ok, true);
  if (empty.ok) assert.equal((empty.value as { text: unknown }).text, null);
});

test("unsupported query kind returns a structured error", () => {
  const r = answerQuery("full_history_dump", snapshot());
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /unsupported query kind/);
  assert.match(r.error, /full_history_dump/);
});

test("query request/reply correlation survives an immediate reply", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(root, TARGET);

  // Caller side: sole reader of the caller inbox.
  const callerDispatcher = new InboxDispatcher(await safeInboxDir(root, "a1a1a1a1"), () => {});
  callerDispatcher.start(10);
  t.after(() => callerDispatcher.stop());

  // Receiver side: sole reader of the target inbox, answers locally and replies fast.
  const receiver = new InboxDispatcher(await safeInboxDir(root, "b0b0b0b0"), {
    onChat: () => {},
    onQuery: (msg) => handleQuery(root, TARGET, msg, snapshot()),
  });
  receiver.start(10);
  t.after(() => receiver.stop());

  const r = await runQuery(root, callerDispatcher, CALLER, "Blue-1", "status", "project", 3000);
  assert.equal(r.error, null);
  const payload = r.value as { kind: string; value: { metroName: string } };
  assert.equal(payload.kind, "status");
  assert.equal(payload.value.metroName, "Blue-1");

  await callerDispatcher.stop();
  await receiver.stop();
});

test("cross-scope query is rejected unless scope is all", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "b5b5b5b5",
      metroName: "Pink-1",
      cwd: "/elsewhere/x",
      projectRoot: "/elsewhere",
    }),
  );
  const dispatcher = new InboxDispatcher(await safeInboxDir(root, "a1a1a1a1"), () => {});
  dispatcher.start(10);
  t.after(() => dispatcher.stop());

  await assert.rejects(
    () => runQuery(root, dispatcher, CALLER, "Pink-1", "status", "project", 500),
    /not found/,
  );

  // scope all: the query reaches the cross-project target's inbox
  const receiver = new InboxDispatcher(await safeInboxDir(root, "b5b5b5b5"), {
    onChat: () => {},
    onQuery: (msg) =>
      handleQuery(
        root,
        entry({ instanceId: "b5b5b5b5", metroName: "Pink-1", cwd: "/elsewhere/x", projectRoot: "/elsewhere" }),
        msg,
        snapshot({ metroName: "Pink-1" }),
      ),
  });
  receiver.start(10);
  t.after(() => receiver.stop());

  const r = await runQuery(root, dispatcher, CALLER, "Pink-1", "status", "all", 3000);
  assert.equal(r.error, null);
  assert.equal(
    (r.value as { value: { metroName: string } }).value.metroName,
    "Pink-1",
  );

  await dispatcher.stop();
  await receiver.stop();
});
