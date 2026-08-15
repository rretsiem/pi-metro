import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_PAYLOAD_BYTES,
  inboxDir,
  readMessage,
  resolveTarget,
  validateMessage,
  writeMessage,
  type Message,
} from "../src/transport.ts";
import type { RegistryEntry } from "../src/registry.ts";

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-transport-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function msg(over: Record<string, unknown> = {}): Message {
  return {
    version: 1,
    id: randomUUID(),
    type: "chat",
    correlationId: randomUUID(),
    from: { instanceId: "sender-1", metroName: "Red-1", sessionName: "auth" },
    toInstanceId: "target-1",
    payload: { text: "hi" },
    timestamp: Date.now(),
    ...over,
  } as Message;
}

const CALLER = { instanceId: "me", cwd: "/work/app/api", projectRoot: "/work/app" };

function entry(over: Partial<RegistryEntry> & { instanceId: string }): RegistryEntry {
  return {
    version: 1,
    metroName: "Blue-1",
    cwd: "/work/app/api",
    projectRoot: "/work/app",
    pid: process.pid,
    state: "idle",
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
    ...over,
  };
}

test("validate rejects payload over 64 KiB", () => {
  const r = validateMessage(msg({ payload: "x".repeat(MAX_PAYLOAD_BYTES) }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /64 KiB/);
});

test("validate rejects unknown version", () => {
  const r = validateMessage({ ...msg(), version: 2 });
  assert.equal(r.ok, false);
});

test("atomic write leaves exactly one final file and no temp leftovers", async (t) => {
  const root = await withTempRoot(t);
  const dir = await inboxDir(root, "target-1");
  const m = msg();
  const r = await writeMessage(dir, m);
  assert.ok(r.ok);
  const files = await readdir(dir);
  assert.deepEqual(files, [r.file]);
  assert.match(r.file, /^\d+-[0-9a-f-]+\.json$/);
  const read = await readMessage(path.join(dir, r.file));
  assert.ok(read.ok);
  assert.equal(read.msg.id, m.id);
});

test("writeMessage rejects an invalid message without writing anything", async (t) => {
  const root = await withTempRoot(t);
  const dir = await inboxDir(root, "target-1");
  const r = await writeMessage(dir, { ...msg(), version: 2 } as Message);
  assert.equal(r.ok, false);
  assert.deepEqual(await readdir(dir), []);
});

test("resolveTarget rejects missing, stale, ambiguous, cross-scope", () => {
  // missing
  assert.equal(resolveTarget([], "Blue-1", CALLER, "project").ok, false);
  // stale (old heartbeat)
  const stale = entry({ instanceId: "t2", lastHeartbeat: Date.now() - 60_000 });
  assert.equal(resolveTarget([stale], "Blue-1", CALLER, "project").ok, false);
  // ambiguous: two live instances share the alias
  const a = entry({ instanceId: "t3" });
  const b = entry({ instanceId: "t4" });
  assert.equal(resolveTarget([a, b], "Blue-1", CALLER, "all").ok, false);
  // cross-scope: other project rejected under project and cwd scope
  const far = entry({ instanceId: "t5", cwd: "/else/x", projectRoot: "/else" });
  assert.equal(resolveTarget([far], "Blue-1", CALLER, "project").ok, false);
  assert.equal(resolveTarget([far], "Blue-1", CALLER, "cwd").ok, false);
  const okAll = resolveTarget([far], "Blue-1", CALLER, "all");
  assert.ok(okAll.ok);
  assert.equal(okAll.target.instanceId, "t5");
  // happy path: unique live in-project target by alias and by instanceId
  const live = entry({ instanceId: "t1" });
  assert.ok(resolveTarget([live], "Blue-1", CALLER, "project").ok);
  assert.ok(resolveTarget([live], "t1", CALLER, "project").ok);
});

test("100 concurrent writers produce exactly 100 valid files", async (t) => {
  const root = await withTempRoot(t);
  const dir = await inboxDir(root, "target-1");
  const msgs = Array.from({ length: 100 }, () => msg());
  const results = await Promise.all(msgs.map((m) => writeMessage(dir, m)));
  assert.ok(results.every((r) => r.ok));
  const files = await readdir(dir);
  assert.equal(files.length, 100);
  assert.equal(new Set(files).size, 100);
  assert.equal(files.filter((f) => f.startsWith(".tmp-")).length, 0);
  for (const f of files) {
    const r = await readMessage(path.join(dir, f));
    assert.ok(r.ok, `invalid file ${f}: ${r.ok ? "" : r.error}`);
  }
});
