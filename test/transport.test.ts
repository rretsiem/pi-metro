import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  MAX_PAYLOAD_BYTES,
  INSTANCE_ID_PATTERN,
  inboxDir,
  pathInsideRoot,
  readMessage,
  resolveTarget,
  safeInboxDir,
  validateInstanceId,
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

/** Valid shape per INSTANCE_ID_PATTERN: 8–64 hex chars. */
const SENDER_ID = "12345678"; // 8 hex
const TARGET_ID = "1111111111111111"; // 16 hex
const FAR_ID = "deadbeefdeadbeef"; // 16 hex
const T1 = "1111111111111111"; // keep test alias lookups matching
const T2 = "2222222222222222";
const T3 = "3333333333333333";
const T4 = "4444444444444444";
const T5 = "5555555555555555";

function msg(over: Record<string, unknown> = {}): Message {
  return {
    version: 1,
    id: randomUUID(),
    type: "chat",
    correlationId: randomUUID(),
    from: { instanceId: SENDER_ID, metroName: "Red-1", sessionName: "auth" },
    toInstanceId: TARGET_ID,
    payload: { text: "hi" },
    timestamp: Date.now(),
    ...over,
  } as Message;
}

const CALLER = { instanceId: SENDER_ID, cwd: "/work/app/api", projectRoot: "/work/app" };

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
  const r = validateMessage(msg({ payload: "abcdef01".repeat(MAX_PAYLOAD_BYTES) }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /64 KiB/);
});

test("validate rejects unknown version", () => {
  const r = validateMessage({ ...msg(), version: 2 });
  assert.equal(r.ok, false);
});

test("atomic write leaves exactly one final file and no temp leftovers", async (t) => {
  const root = await withTempRoot(t);
  const dir = await safeInboxDir(root, "abcdef01");
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
  const dir = await safeInboxDir(root, "abcdef01");
  const r = await writeMessage(dir, { ...msg(), version: 2 } as Message);
  assert.equal(r.ok, false);
  assert.deepEqual(await readdir(dir), []);
});

test("resolveTarget rejects missing, stale, ambiguous, cross-scope", () => {
  // missing
  assert.equal(resolveTarget([], "Blue-1", CALLER, "project").ok, false);
  // stale (old heartbeat)
  const stale = entry({ instanceId: T2, lastHeartbeat: Date.now() - 60_000 });
  assert.equal(resolveTarget([stale], "Blue-1", CALLER, "project").ok, false);
  // ambiguous: two live instances share the alias
  const a = entry({ instanceId: T3 });
  const b = entry({ instanceId: T4 });
  assert.equal(resolveTarget([a, b], "Blue-1", CALLER, "all").ok, false);
  // cross-scope: other project rejected under project and cwd scope
  const far = entry({ instanceId: T5, cwd: "/else/x", projectRoot: "/else" });
  assert.equal(resolveTarget([far], "Blue-1", CALLER, "project").ok, false);
  assert.equal(resolveTarget([far], "Blue-1", CALLER, "cwd").ok, false);
  const okAll = resolveTarget([far], "Blue-1", CALLER, "all");
  assert.ok(okAll.ok);
  assert.equal(okAll.target.instanceId, T5);
  // happy path: unique live in-project target by alias and by instanceId
  const live = entry({ instanceId: T1 });
  assert.ok(resolveTarget([live], "Blue-1", CALLER, "project").ok);
  assert.ok(resolveTarget([live], T1, CALLER, "project").ok);
});

test("100 concurrent writers produce exactly 100 valid files", async (t) => {
  const root = await withTempRoot(t);
  const dir = await inboxDir(root, TARGET_ID);
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

// ===== Path-traversal / instanceId shape validation (pre-publish hardening) =====

test("validateInstanceId accepts hex and UUID shapes, rejects everything else", () => {
  // valid: 8 hex, 16 hex, 32 hex, full UUID v4, full UUID no hyphens
  assert.ok(validateInstanceId("abcdef01"));
  assert.ok(validateInstanceId("1111111111111111"));
  assert.ok(validateInstanceId("11111111111111111111111111111111"));
  assert.ok(validateInstanceId("12345678-1234-1234-1234-123456789abc"));
  assert.ok(validateInstanceId("12345678123412341234123456789012"));
  // invalid: path-traversal, slashes, NUL, NULs, control chars, non-hex, too long
  assert.equal(validateInstanceId("../../../etc/passwd"), false);
  assert.equal(validateInstanceId("foo/../../bar"), false);
  assert.equal(validateInstanceId("abcdef0d".repeat(100)), false);
  assert.equal(validateInstanceId("not hex"), false);
  assert.equal(validateInstanceId("ABCDEFGH"), false);
  assert.equal(validateInstanceId(""), false);
  assert.equal(validateInstanceId(null), false);
  assert.equal(validateInstanceId(undefined), false);
  assert.equal(validateInstanceId(123), false);
  assert.equal(validateInstanceId({}), false);
  assert.equal(validateInstanceId([]), false);
  // boundary: less than 8 hex chars is rejected (the bus's short-id form)
  assert.equal(validateInstanceId("abc"), false);
  assert.equal(validateInstanceId("abcdef0"), false);
  // 65-char string (one over the 64 cap) gets rejected
  assert.equal(validateInstanceId("f".repeat(65)), false);
  // 64-char string at the cap is accepted
  assert.ok(validateInstanceId("f".repeat(64)));
  // pattern sanity: the regex is the canonical shape
  assert.ok(INSTANCE_ID_PATTERN.test("abcdef01"));
  assert.equal(INSTANCE_ID_PATTERN.test("abc"), false);
  assert.ok(INSTANCE_ID_PATTERN.test("f".repeat(64)));
  assert.equal(INSTANCE_ID_PATTERN.test("f".repeat(65)), false);
});

test("pathInsideRoot accepts nested paths and rejects escapes", () => {
  const root = "/var/lib/metrol";
  assert.equal(pathInsideRoot(root, "instances", "abc"), "/var/lib/metrol/instances/abc");
  assert.equal(pathInsideRoot(root), "/var/lib/metrol");
  assert.equal(pathInsideRoot(root, ".."), null);
  assert.equal(pathInsideRoot(root, "..", "etc", "passwd"), null);
  assert.equal(pathInsideRoot(root, "instances", "..", "..", "..", "etc", "passwd"), null);
  assert.equal(pathInsideRoot(root, "foo", "..", "bar"), "/var/lib/metrol/bar");
  // dot-component that resolves to the root itself is allowed (matches root)
  assert.equal(pathInsideRoot(root, ".", "."), "/var/lib/metrol");
});

test("inboxDir returns null for traversal/escape attempts", async (t) => {
  const root = await withTempRoot(t);
  // valid: writes into root/instances/<id>/inbox
  const ok = await safeInboxDir(root, "abcdef01");
  assert.ok(ok !== null);
  assert.equal(ok, path.join(root, "instances", "abcdef01", "inbox"));
  // invalid: anything that doesn't match INSTANCE_ID_PATTERN
  assert.equal(await inboxDir(root, "../etc"), null);
  assert.equal(await inboxDir(root, "foo/bar"), null);
  assert.equal(await inboxDir(root, "../../tmp/evil"), null);
  assert.equal(await inboxDir(root, ""), null);
  assert.equal(await inboxDir(root, "abcdef0d".repeat(100)), null);
  assert.equal(await inboxDir(root, "not hex"), null);
  // The valid call must not have created anything outside the metrol root
  const files = await readdir(root).catch(() => []);
  assert.ok(!files.includes("etc"));
  assert.ok(!files.includes("tmp"));
});

test("safeInboxDir throws on malformed instanceId; works on valid", async (t) => {
  const root = await withTempRoot(t);
  const ok = await safeInboxDir(root, "abcdef01");
  assert.equal(ok, path.join(root, "instances", "abcdef01", "inbox"));
  await assert.rejects(() => safeInboxDir(root, "../etc"), /invalid instanceId/);
  await assert.rejects(() => safeInboxDir(root, "foo/bar"), /invalid instanceId/);
});

test("validateMessage rejects peer-supplied instanceId that fails path-traversal regex", () => {
  const good = msg();
  assert.equal(validateMessage(good).ok, true);
  // path traversal in from.instanceId
  assert.equal(
    validateMessage(msg({ from: { instanceId: "../../etc/passwd", metroName: "evil" } })).ok,
    false,
  );
  // path traversal in toInstanceId
  assert.equal(
    validateMessage(msg({ toInstanceId: "../bar" })).ok,
    false,
  );
  // non-string instanceId
  assert.equal(
    validateMessage(msg({ from: { instanceId: 123 as unknown as string, metroName: "Red-1" } })).ok,
    false,
  );
  assert.equal(
    validateMessage(msg({ toInstanceId: null as unknown as string })).ok,
    false,
  );
  // missing instanceId
  assert.equal(
    validateMessage(msg({ from: { metroName: "Red-1" } as unknown as { instanceId: string } })).ok,
    false,
  );
  // exactly the boundary: 8 hex chars OK
  assert.equal(
    validateMessage(msg({ from: { instanceId: "abcdef01", metroName: "R" } })).ok,
    true,
  );
  // 65-char string (one over the 64 cap) gets rejected
  assert.equal(
    validateMessage(msg({ from: { instanceId: "abcdef0d".repeat(65), metroName: "R" } })).ok,
    false,
  );
});
