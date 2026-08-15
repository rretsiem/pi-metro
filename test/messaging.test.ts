import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeRegistryEntry, type RegistryEntry } from "../src/registry.ts";
import { inboxDir } from "../src/transport.ts";
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

const CALLER = entry({ instanceId: "me", metroName: "Red-1" });

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
  await writeRegistryEntry(root, entry({ instanceId: "bob", metroName: "Blue-1" }));
  const id = await sendDirect(root, CALLER, "Blue-1", "hello bob");
  assert.equal(typeof id, "string");
  const msgs = await inboxFiles(root, "bob");
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].id, id);
  assert.equal(msgs[0].type, "chat");
  assert.equal(msgs[0].toInstanceId, "bob");
  assert.equal(msgs[0].from.metroName, "Red-1");
  assert.equal(msgs[0].payload.text, "hello bob");
});

test("broadcast scope cwd: only exact-cwd sessions, excluding caller", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(root, entry({ instanceId: "sib", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({ instanceId: "web", metroName: "Green-1", cwd: "/work/app/web" }),
  );
  const n = await broadcast(root, CALLER, "ping", "cwd");
  assert.equal(n, 1);
  assert.equal((await inboxFiles(root, "sib")).length, 1);
  assert.equal((await inboxFiles(root, "web")).length, 0);
  assert.equal((await inboxFiles(root, "me")).length, 0);
});

test("broadcast scope project: all same-project sessions, excluding caller", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(
    root,
    entry({ instanceId: "web", metroName: "Green-1", cwd: "/work/app/web" }),
  );
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "other",
      metroName: "Teal-1",
      cwd: "/elsewhere/x",
      projectRoot: "/elsewhere",
    }),
  );
  const n = await broadcast(root, CALLER, "ping", "project");
  assert.equal(n, 1);
  assert.equal((await inboxFiles(root, "web"))[0].type, "chat");
  assert.equal((await inboxFiles(root, "other")).length, 0);
});

test("broadcast scope all: every session except caller, returns count", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(root, entry({ instanceId: "sib", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "other",
      metroName: "Teal-1",
      cwd: "/elsewhere/x",
      projectRoot: "/elsewhere",
    }),
  );
  const n = await broadcast(root, CALLER, "ping", "all");
  assert.equal(n, 2);
  assert.equal((await inboxFiles(root, "sib")).length, 1);
  assert.equal((await inboxFiles(root, "other")).length, 1);
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
      instanceId: "far",
      metroName: "Pink-1",
      cwd: "/elsewhere/x",
      projectRoot: "/elsewhere",
    }),
  );
  await assert.rejects(() => sendDirect(root, CALLER, "Pink-1", "hi"), /not found/);
  const id = await sendDirect(root, CALLER, "Pink-1", "hi", "all");
  assert.equal(typeof id, "string");
});
