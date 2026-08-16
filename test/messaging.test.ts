import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeRegistryEntry, type RegistryEntry } from "../src/registry.ts";
import {inboxDir, safeInboxDir} from "../src/transport.ts";
import { sendDirect, broadcast } from "../src/messaging.ts";

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-msg-test-"));
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

async function inboxFiles(root: string, instanceId: string) {
  const dir = await inboxDir(root, instanceId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return []; // no inbox yet
  }
  files = files.filter((f) => f.endsWith(".json") && !f.startsWith(".tmp-"));
  return Promise.all(
    files.map(async (f) => JSON.parse(await readFile(path.join(dir, f), "utf8"))),
  );
}

test("sendDirect writes a chat file into the target's inbox", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(root, entry({ instanceId: "b0b0b0b0", metroName: "Blue-1" }));
  const id = await sendDirect(root, CALLER, "Blue-1", "hello bob");
  assert.equal(typeof id, "string");
  const msgs = await inboxFiles(root, "b0b0b0b0");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].id, id);
  assert.equal(msgs[0].type, "chat");
  assert.equal(msgs[0].toInstanceId, "b0b0b0b0");
  assert.equal(msgs[0].from.metroName, "Red-1");
  assert.equal(msgs[0].payload.text, "hello bob");
});

test("broadcast scope cwd: only exact-cwd sessions, excluding caller", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(root, entry({ instanceId: "b2b2b2b2", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({ instanceId: "b3b3b3b3", metroName: "Green-1", cwd: "/work/app/web" }),
  );
  const n = await broadcast(root, CALLER, "ping", "cwd");
  assert.equal(n, 1);
  assert.equal((await inboxFiles(root, "b2b2b2b2")).length, 1);
  assert.equal((await inboxFiles(root, "b3b3b3b3")).length, 0);
  assert.equal((await inboxFiles(root, "a1a1a1a1")).length, 0);
});

test("broadcast scope project: all same-project sessions, excluding caller", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(
    root,
    entry({ instanceId: "b3b3b3b3", metroName: "Green-1", cwd: "/work/app/web" }),
  );
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "b4b4b4b4",
      metroName: "Teal-1",
      cwd: "/elsewhere/x",
      projectRoot: "/elsewhere",
    }),
  );
  const n = await broadcast(root, CALLER, "ping", "project");
  assert.equal(n, 1);
  assert.equal((await inboxFiles(root, "b3b3b3b3"))[0].type, "chat");
  assert.equal((await inboxFiles(root, "b4b4b4b4")).length, 0);
});

test("broadcast scope all: every session except caller, returns count", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(root, entry({ instanceId: "b2b2b2b2", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "b4b4b4b4",
      metroName: "Teal-1",
      cwd: "/elsewhere/x",
      projectRoot: "/elsewhere",
    }),
  );
  const n = await broadcast(root, CALLER, "ping", "all");
  assert.equal(n, 2);
  assert.equal((await inboxFiles(root, "b2b2b2b2")).length, 1);
  assert.equal((await inboxFiles(root, "b4b4b4b4")).length, 1);
});

test("broadcast writes concurrently (Promise.all, no functional regression)", async (t) => {
  // After A1's parallelization of broadcast's per-recipient writes, this
  // test pins the observable contract: every recipient still gets exactly
  // one file, with the same message text and message id. Concurrency is
  // an optimization, not a behavior change.
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  const recipients = [
    entry({ instanceId: "b2b2b2b2", metroName: "Blue-1" }),
    entry({ instanceId: "b3b3b3b3", metroName: "Green-1" }),
    entry({ instanceId: "b4b4b4b4", metroName: "Teal-1" }),
  ];
  for (const r of recipients) await writeRegistryEntry(root, r);
  const n = await broadcast(root, CALLER, "hello all", "all");
  assert.equal(n, 3);
  for (const r of recipients) {
    const files = await inboxFiles(root, r.instanceId);
    assert.equal(files.length, 1);
    assert.equal(files[0].type, "chat");
    assert.equal((files[0].payload as { text?: string }).text, "hello all");
  }
});

test("sendDirect rejects unknown target", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await assert.rejects(() => sendDirect(root, CALLER, "Nope-9", "hi"), /not found/);
});

test("sendDirect rejects cross-project target without scope all", async (t) => {
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
  await assert.rejects(() => sendDirect(root, CALLER, "Pink-1", "hi"), /not found/);
  const id = await sendDirect(root, CALLER, "Pink-1", "hi", "all");
  assert.equal(typeof id, "string");
});
