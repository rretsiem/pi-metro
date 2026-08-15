import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  writeRegistryEntry,
  readRegistry,
  updateRegistry,
  removeRegistryEntry,
  pidAlive,
  sweepStaleRegistryFiles,
  STALE_THRESHOLD_MS,
  type RegistryEntry,
} from "../src/registry.ts";

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-test-"));
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

test("write → read returns the same entry", async (t) => {
  const root = await withTempRoot(t);
  const entry = makeEntry();
  await writeRegistryEntry(root, entry);
  assert.deepEqual(await readRegistry(root), [entry]);
});

test("stale heartbeat (>30s) is filtered out", async (t) => {
  const root = await withTempRoot(t);
  const stale = makeEntry({ lastHeartbeat: Date.now() - STALE_THRESHOLD_MS - 1000 });
  const fresh = makeEntry();
  await writeRegistryEntry(root, stale);
  await writeRegistryEntry(root, fresh);
  assert.deepEqual(await readRegistry(root), [fresh]);
});

test("dead PID is filtered out", async (t) => {
  const root = await withTempRoot(t);
  const dead = makeEntry({ pid: 99999999 }); // beyond max pid → ESRCH
  const alive = makeEntry();
  await writeRegistryEntry(root, dead);
  await writeRegistryEntry(root, alive);
  assert.deepEqual(await readRegistry(root), [alive]);
});

test("pidAlive: ESRCH is dead, live pid is alive", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(99999999), false);
});

test("updateRegistry merges a patch atomically", async (t) => {
  const root = await withTempRoot(t);
  const entry = makeEntry();
  await writeRegistryEntry(root, entry);
  await updateRegistry(root, entry.instanceId, {
    state: "running",
    sessionName: "renamed",
  });
  const [got] = await readRegistry(root);
  assert.equal(got.state, "running");
  assert.equal(got.sessionName, "renamed");
  assert.equal(got.metroName, entry.metroName); // untouched fields preserved
  assert.equal(got.startedAt, entry.startedAt);
});

test("removeRegistryEntry removes the file; idempotent", async (t) => {
  const root = await withTempRoot(t);
  const entry = makeEntry();
  await writeRegistryEntry(root, entry);
  await removeRegistryEntry(root, entry.instanceId);
  assert.deepEqual(await readRegistry(root), []);
  await removeRegistryEntry(root, entry.instanceId); // no throw
  await removeRegistryEntry(root, randomUUID()); // never existed
});

test("sweepStaleRegistryFiles removes a stale + dead entry", async (t) => {
  const root = await withTempRoot(t);
  const stale = makeEntry({
    pid: 99999999,
    lastHeartbeat: Date.now() - STALE_THRESHOLD_MS - 1000,
  });
  await writeRegistryEntry(root, stale);
  const removed = await sweepStaleRegistryFiles(root);
  assert.deepEqual(removed, [stale.instanceId]);
});

test("sweepStaleRegistryFiles keeps an entry with a fresh heartbeat + live PID", async (t) => {
  const root = await withTempRoot(t);
  const live = makeEntry({ pid: process.pid, lastHeartbeat: Date.now() });
  await writeRegistryEntry(root, live);
  const removed = await sweepStaleRegistryFiles(root);
  assert.deepEqual(removed, []);
  assert.equal((await readRegistry(root)).length, 1);
});

test("sweepStaleRegistryFiles keeps an entry with stale heartbeat but live PID", async (t) => {
  const root = await withTempRoot(t);
  const live = makeEntry({
    pid: process.pid,
    lastHeartbeat: Date.now() - STALE_THRESHOLD_MS - 1000,
  });
  await writeRegistryEntry(root, live);
  const removed = await sweepStaleRegistryFiles(root);
  assert.deepEqual(removed, []);
});

test("sweepStaleRegistryFiles keeps an entry with fresh heartbeat but dead PID", async (t) => {
  const root = await withTempRoot(t);
  // Fresh heartbeat but dead PID — must NOT be deleted; readRegistry also keeps it.
  const entry = makeEntry({ pid: 99999999, lastHeartbeat: Date.now() });
  await writeRegistryEntry(root, entry);
  const removed = await sweepStaleRegistryFiles(root);
  assert.deepEqual(removed, []);
});

test("sweepStaleRegistryFiles is idempotent under repeated calls", async (t) => {
  const root = await withTempRoot(t);
  const stale = makeEntry({
    pid: 99999999,
    lastHeartbeat: Date.now() - STALE_THRESHOLD_MS - 1000,
  });
  await writeRegistryEntry(root, stale);
  const first = await sweepStaleRegistryFiles(root);
  const second = await sweepStaleRegistryFiles(root);
  assert.deepEqual(first, [stale.instanceId]);
  assert.deepEqual(second, []);
});
