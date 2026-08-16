import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeRegistryEntry, type RegistryEntry } from "../src/registry.ts";
import {inboxDir, type Message, safeInboxDir} from "../src/transport.ts";
import {
  COMPACT_TIMEOUT_MS,
  CompactPendingMap,
  decideCompactResponse,
  rejectSelfTarget,
  requestCompact,
  respondCompact,
  type CompactRequestPayload,
  type CompactResponsePayload,
} from "../src/compact.ts";

// Test-only read/write helpers that bypass transport.ts validateMessage.
// The integration snippet adds "compactReq"/"compactRes" to MESSAGE_TYPES;
// until that lands, the production validator rejects them. The wire shape
// is identical to what writeMessage/readMessage produce, so the test
// faithfully exercises the format without depending on the integration.
async function writeRaw(dir: string, msg: Message): Promise<string> {
  await import("node:fs/promises").then((m) =>
    m.mkdir(dir, { recursive: true }),
  );
  const file = `${msg.timestamp}-${msg.id}.json`;
  await writeFile(path.join(dir, file), JSON.stringify(msg));
  return file;
}

async function readRaw(filePath: string): Promise<Message> {
  return JSON.parse(await readFile(filePath, "utf8")) as Message;
}

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-compact-test-"));
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
const TARGET = entry({ instanceId: "b0b0b0b0", metroName: "Blue-1", sessionName: "auth-refactor" });

// ---------------------------------------------------------------------------
// 1. Receiver declines with `reason: "busy"` when running.
// 3. Receiver declines with `reason: "unsupported"` when `ctx.compact` is missing.
// (busy precedence over unsupported)
// ---------------------------------------------------------------------------

test("decideCompactResponse: busy wins over unsupported", () => {
  assert.deepEqual(
    decideCompactResponse({ agentRunning: true, hasCompactCapability: true }),
    { ok: false, reason: "busy" },
  );
  // running + no capability: still busy, not unsupported
  assert.deepEqual(
    decideCompactResponse({ agentRunning: true, hasCompactCapability: false }),
    { ok: false, reason: "busy" },
  );
});

test("decideCompactResponse: idle but no compact capability → unsupported", () => {
  assert.deepEqual(
    decideCompactResponse({ agentRunning: false, hasCompactCapability: false }),
    { ok: false, reason: "unsupported" },
  );
});

test("decideCompactResponse: idle and has capability → ok", () => {
  assert.deepEqual(
    decideCompactResponse({ agentRunning: false, hasCompactCapability: true }),
    { ok: true },
  );
});

test("COMPACT_TIMEOUT_MS is 3 minutes (180_000 ms)", () => {
  assert.equal(COMPACT_TIMEOUT_MS, 180_000);
});

// ---------------------------------------------------------------------------
// 5. Self-target rejected (and the inverse case for completeness).
// ---------------------------------------------------------------------------

test("rejectSelfTarget: same metroName → rejected", () => {
  const r = rejectSelfTarget("Red-1", "Red-1");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /cannot target self/);
  assert.match(r.error ?? "", /Red-1/);
});

test("rejectSelfTarget: different metroName → ok", () => {
  assert.deepEqual(rejectSelfTarget("Red-1", "Blue-1"), { ok: true });
});

// ---------------------------------------------------------------------------
// CompactPendingMap: local correlation map used by the sender side.
// ---------------------------------------------------------------------------

test("CompactPendingMap: resolves on correlationId match", async () => {
  const map = new CompactPendingMap();
  const waiting = map.register("req-1", 3000);
  const matched = map.resolve({
    version: 1,
    id: "abcdef01",
    type: "compactRes",
    correlationId: "req-1",
    from: { instanceId: "b0b0b0b0", metroName: "Blue-1" },
    toInstanceId: "a1a1a1a1",
    payload: {
      id: "req-1",
      from: { instanceId: "b0b0b0b0", metroName: "Blue-1" },
      to: "Red-1",
      ok: true,
    } as CompactResponsePayload,
    timestamp: Date.now(),
  } as Message);
  assert.equal(matched, true);
  const r = await waiting;
  assert.equal(r.error, null);
  assert.equal(r.value?.ok, true);
  assert.equal(map.size, 0);
});

test("CompactPendingMap: wrong correlationId returns false and does not resolve", async () => {
  const map = new CompactPendingMap();
  const waiting = map.register("req-1", 3000);
  const matched = map.resolve({
    version: 1,
    id: "abcdef01",
    type: "compactRes",
    correlationId: "wrong",
    from: { instanceId: "b0b0b0b0", metroName: "Blue-1" },
    toInstanceId: "a1a1a1a1",
    payload: {
      id: "abcdef01",
      from: { instanceId: "b0b0b0b0", metroName: "Blue-1" },
      to: "Red-1",
      ok: true,
    } as CompactResponsePayload,
    timestamp: Date.now(),
  } as Message);
  assert.equal(matched, false);
  assert.equal(map.size, 1);
  // cleanup so the dangling timer doesn't keep the test alive
  map.clear();
  void waiting;
});

// 6. Target timeout produces `failed` (pending-map level: short timeout, no reply).
test("CompactPendingMap: timeout when no reply arrives", async () => {
  const map = new CompactPendingMap();
  const t0 = Date.now();
  const r = await map.register("req-1", 50);
  const elapsed = Date.now() - t0;
  assert.match(r.error ?? "", /timeout after 50ms/);
  assert.equal(r.value, undefined);
  assert.equal(map.size, 0);
  assert.ok(elapsed < 1000, `timeout should fire promptly, took ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// requestCompact — sender side: payload, self-target, missing target, success,
// busy/unsupported outcomes, timeout. Tests write the reply file directly to
// the caller's inbox and then call `pending.resolve(msg)` — the same call the
// integration-layer dispatcher makes after routing a `compactRes`.
// ---------------------------------------------------------------------------

function makeResponse(replyId: string, ok: boolean, reason?: "busy" | "unsupported"): Message {
  const payload: CompactResponsePayload = {
    id: replyId,
    from: { instanceId: "b0b0b0b0", metroName: "Blue-1", sessionName: "auth-refactor" },
    to: "Red-1",
    ok,
    reason,
  };
  return {
    version: 1,
    id: `res-${replyId}`,
    type: "compactRes",
    correlationId: replyId,
    from: payload.from,
    toInstanceId: "a1a1a1a1",
    payload,
    timestamp: Date.now(),
  } as Message;
}

async function readRequestFromInbox(targetInbox: string): Promise<Message> {
  const files = (await readdir(targetInbox)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1, `expected 1 file, got ${files.length}`);
  return readRaw(path.join(targetInbox, files[0]));
}

/**
 * Wait for the first request file to appear in the target inbox. `requestCompact`
 * is async: the caller starts it, and the file lands after the first `await`
 * inside (readRegistry + resolveTarget). The caller polls the inbox so the
 * test can read the file before resolving the pending map.
 */
async function waitForRequestFile(
  targetInbox: string,
  timeoutMs = 1000,
): Promise<Message> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const files = (await readdir(targetInbox)).filter(
      (f) => f.endsWith(".json") && !f.startsWith(".tmp-"),
    );
    if (files.length === 1) return readRaw(path.join(targetInbox, files[0]));
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("timeout waiting for request file");
}

test("requestCompact: self-target rejected before any write", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  const pending = new CompactPendingMap();
  const persisted: { status: string; error?: string }[] = [];
  await assert.rejects(
    () =>
      requestCompact(
        root,
        pending,
        CALLER,
        "Red-1",
        "trim please",
        "project",
        (d) => persisted.push(d),
      ),
    /cannot target self/,
  );
  assert.equal(persisted[0]?.status, "failed");
  assert.match(persisted[0]?.error ?? "", /cannot target self/);
  // nothing was written to anyone's inbox
  const callerInbox = await safeInboxDir(root, "a1a1a1a1");
  assert.equal((await readdir(callerInbox)).length, 0);
});

test("requestCompact: unknown target → throws and persists failed", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  const pending = new CompactPendingMap();
  const persisted: { status: string; error?: string }[] = [];
  await assert.rejects(
    () =>
      requestCompact(
        root,
        pending,
        CALLER,
        "Ghost-1",
        undefined,
        "project",
        (d) => persisted.push(d),
      ),
    /not found/,
  );
  assert.equal(persisted[0]?.status, "failed");
  assert.match(persisted[0]?.error ?? "", /not found/);
});

test("requestCompact: writes a compactReq message with the spec payload shape", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(root, TARGET);
  const pending = new CompactPendingMap();
  const targetInbox = await safeInboxDir(root, "b0b0b0b0");

  const persisted: { status: string; requestId: string }[] = [];
  const waiting = requestCompact(
    root,
    pending,
    CALLER,
    "Blue-1",
    "summarize session",
    "project",
    (d) => persisted.push(d),
    3000,
  );

  // the file must be on disk before we reply
  const req = await waitForRequestFile(targetInbox);
  assert.equal(req.type, "compactReq");
  assert.equal(req.toInstanceId, "b0b0b0b0");
  assert.equal(req.from.metroName, "Red-1");
  assert.equal(req.from.sessionName, undefined);
  const p = req.payload as CompactRequestPayload;
  assert.equal(p.id, req.id);
  assert.equal(p.from.metroName, "Red-1");
  assert.equal(p.to, "Blue-1");
  assert.equal(p.instructions, "summarize session");
  pending.resolve(makeResponse(req.id, true));
  const outcome = await waiting;
  assert.deepEqual(outcome, { status: "ok" });
  // queued + ok persisted
  assert.deepEqual(
    persisted.map((p) => p.status),
    ["queued", "ok"],
  );
});

// 4. Succeeds on idle target (the receiver's reply says ok: true).
test("requestCompact: ok reply → { status: 'ok' }", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(root, TARGET);
  const pending = new CompactPendingMap();
  const targetInbox = await safeInboxDir(root, "b0b0b0b0");

  const waiting = requestCompact(
    root,
    pending,
    CALLER,
    "Blue-1",
    undefined,
    "project",
    undefined,
    3000,
  );

  const req = await waitForRequestFile(targetInbox);
  pending.resolve(makeResponse(req.id, true));
  const outcome = await waiting;
  assert.deepEqual(outcome, { status: "ok" });
});

test("requestCompact: busy reply → { status: 'busy' }", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(root, TARGET);
  const pending = new CompactPendingMap();
  const targetInbox = await safeInboxDir(root, "b0b0b0b0");

  const waiting = requestCompact(
    root,
    pending,
    CALLER,
    "Blue-1",
    undefined,
    "project",
    undefined,
    3000,
  );

  const req = await waitForRequestFile(targetInbox);
  pending.resolve(makeResponse(req.id, false, "busy"));
  const outcome = await waiting;
  assert.deepEqual(outcome, { status: "busy" });
});

test("requestCompact: unsupported reply → { status: 'unsupported' }", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(root, TARGET);
  const pending = new CompactPendingMap();
  const targetInbox = await safeInboxDir(root, "b0b0b0b0");

  const waiting = requestCompact(
    root,
    pending,
    CALLER,
    "Blue-1",
    undefined,
    "project",
    undefined,
    3000,
  );

  const req = await waitForRequestFile(targetInbox);
  pending.resolve(makeResponse(req.id, false, "unsupported"));
  const outcome = await waiting;
  assert.deepEqual(outcome, { status: "unsupported" });
});

// 6. end-to-end target timeout (full request path, not just the pending map).
test("requestCompact: timeout → { status: 'failed', error: 'timeout...' }", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, CALLER);
  await writeRegistryEntry(root, TARGET);
  const pending = new CompactPendingMap();
  const persisted: { status: string; error?: string }[] = [];

  const t0 = Date.now();
  const outcome = await requestCompact(
    root,
    pending,
    CALLER,
    "Blue-1",
    undefined,
    "project",
    (d) => persisted.push(d),
    50,
  );
  const elapsed = Date.now() - t0;
  assert.equal(outcome.status, "failed");
  assert.match(outcome.error, /timeout after 50ms/);
  assert.ok(elapsed < 1000, `should fail fast, took ${elapsed}ms`);
  assert.deepEqual(
    persisted.map((p) => p.status),
    ["queued", "failed"],
  );
  assert.equal(pending.size, 0);
});

// ---------------------------------------------------------------------------
// 2. Receiver never `followUp`s a compact request — it must reject immediately.
// The `respondCompact` function is the only thing the integration layer calls
// for a rejection: it writes a correlated reply, takes no compact callback,
// and never accepts a turn/queue parameter. The shape of the reply asserts
// the answer is "right now" (no queue, no followUp marker).
// ---------------------------------------------------------------------------

test("respondCompact: busy → writes a reply with reason: 'busy' immediately", async (t) => {
  const root = await withTempRoot(t);
  const callerInbox = await safeInboxDir(root, "a1a1a1a1");
  const req: Message = {
    version: 1,
    id: "req-1",
    type: "compactReq",
    from: { instanceId: "a1a1a1a1", metroName: "Red-1" },
    toInstanceId: "b0b0b0b0",
    payload: {
      id: "req-1",
      from: { instanceId: "a1a1a1a1", metroName: "Red-1" },
      to: "Blue-1",
      instructions: "trim",
    } as CompactRequestPayload,
    timestamp: Date.now(),
  } as Message;
  await respondCompact(root, TARGET, req, { ok: false, reason: "busy" });

  const files = (await readdir(callerInbox)).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 1);
  const reply = await readRaw(path.join(callerInbox, files[0]));
  assert.equal(reply.type, "compactRes");
  assert.equal(reply.correlationId, "req-1");
  assert.equal(reply.from.metroName, "Blue-1");
  const p = reply.payload as CompactResponsePayload;
  assert.equal(p.id, "req-1");
  assert.equal(p.ok, false);
  assert.equal(p.reason, "busy");
  assert.equal(p.to, "Red-1");
  // No followUp: the reply is present in the inbox right now, not queued.
  // The reply's correlationId matches the request id, so the sender's
  // pending map will resolve synchronously — no need for agent_settled.
  assert.equal(reply.correlationId, req.id);
});

test("respondCompact: unsupported → writes a reply with reason: 'unsupported'", async (t) => {
  const root = await withTempRoot(t);
  const callerInbox = await safeInboxDir(root, "a1a1a1a1");
  const req: Message = {
    version: 1,
    id: "req-2",
    type: "compactReq",
    from: { instanceId: "a1a1a1a1", metroName: "Red-1" },
    toInstanceId: "b0b0b0b0",
    payload: {
      id: "req-2",
      from: { instanceId: "a1a1a1a1", metroName: "Red-1" },
      to: "Blue-1",
    } as CompactRequestPayload,
    timestamp: Date.now(),
  } as Message;
  await respondCompact(root, TARGET, req, { ok: false, reason: "unsupported" });

  const files = (await readdir(callerInbox)).filter((f) => f.endsWith(".json"));
  const reply = await readRaw(path.join(callerInbox, files[0]));
  const p = reply.payload as CompactResponsePayload;
  assert.equal(p.ok, false);
  assert.equal(p.reason, "unsupported");
});

test("respondCompact: ok → writes a reply with ok: true and no reason field", async (t) => {
  const root = await withTempRoot(t);
  const callerInbox = await safeInboxDir(root, "a1a1a1a1");
  const req: Message = {
    version: 1,
    id: "req-3",
    type: "compactReq",
    from: { instanceId: "a1a1a1a1", metroName: "Red-1" },
    toInstanceId: "b0b0b0b0",
    payload: {
      id: "req-3",
      from: { instanceId: "a1a1a1a1", metroName: "Red-1" },
      to: "Blue-1",
    } as CompactRequestPayload,
    timestamp: Date.now(),
  } as Message;
  await respondCompact(root, TARGET, req, { ok: true });

  const files = (await readdir(callerInbox)).filter((f) => f.endsWith(".json"));
  const reply = await readRaw(path.join(callerInbox, files[0]));
  const p = reply.payload as CompactResponsePayload;
  assert.equal(p.ok, true);
  assert.equal(p.reason, undefined);
});
