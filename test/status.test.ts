import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  HEARTBEAT_INTERVAL_MS,
  updateRegistry,
  writeRegistryEntry,
  type RegistryEntry,
} from "../src/registry.ts";
import {
  HEARTBEAT_JITTER_MS,
  STATUS_WRITE_THROTTLE_MS,
  StatusWriter,
  heartbeatDelayMs,
  initialStatus,
} from "../src/status.ts";
import { listSessions, type SessionInfo } from "../src/list.ts";
import { fmtContext, formatSessionRow } from "../src/cli.ts";
import { formatMetroMap } from "../src/presentation.ts";

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-status-test-"));
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
    cwd: "/work/app/api",
    projectRoot: "/work/app",
    pid: process.pid,
    model: "anthropic/claude-opus-4-6",
    state: "idle",
    startedAt: now,
    lastHeartbeat: now,
    ...overrides,
  };
}

async function readEntry(root: string, instanceId: string): Promise<RegistryEntry> {
  return JSON.parse(
    await readFile(path.join(root, "registry", `${instanceId}.json`), "utf8"),
  );
}

interface Harness {
  writer: StatusWriter;
  writes: Partial<RegistryEntry>[];
  setNow: (now: number) => void;
  entry: RegistryEntry;
}

async function harness(
  t: import("node:test").TestContext,
  opts: { getContextUsage?: () => unknown; startNow?: number } = {},
): Promise<Harness> {
  const root = await withTempRoot(t);
  const entry = makeEntry();
  await writeRegistryEntry(root, entry);
  let now = opts.startNow ?? Date.now();
  const writes: Partial<RegistryEntry>[] = [];
  const writer = new StatusWriter(root, entry, {
    now: () => now,
    getContextUsage: opts.getContextUsage,
    write: async (rootDir, instanceId, patch) => {
      writes.push(patch);
      await updateRegistry(rootDir, instanceId, patch);
    },
  });
  return { writer, writes, setNow: (n) => (now = n), entry };
}

let n = 0;
function session(over: Partial<SessionInfo>): SessionInfo {
  n += 1;
  return {
    metroName: "Red-1",
    cwd: "/work/app/api",
    projectRoot: "/work/app",
    pid: 1,
    state: "idle",
    lastHeartbeat: Date.now(),
    instanceId: `id-${n}`,
    ...over,
  };
}

// 1. session_start → entry has stateSince === startedAt, lastActivity set,
//    no activeToolName, no contextUsage.
test("1. initialStatus yields stateSince/lastActivity only", () => {
  const now = Date.now();
  const init = initialStatus(now);
  assert.deepEqual(init, { stateSince: now, lastActivity: now });
  assert.equal(Object.keys(init).length, 2);
  assert.ok(!("activeToolName" in init));
  assert.ok(!("contextUsage" in init));
});

// 2. agent_start → single write: state running, stateSince updated, lastActivity bumped.
test("2. agent_start writes running state in one write", async (t) => {
  const { writer, writes, entry } = await harness(t);
  const t0 = Date.now() + 1000;
  const h = await harness(t, { startNow: t0 });
  void writer;
  void entry;
  void writes;
  await h.writer.agentStart();
  assert.equal(h.writes.length, 1);
  const got = await readEntry(
    (h.writer as unknown as { rootDir: string }).rootDir,
    h.entry.instanceId,
  );
  assert.equal(got.state, "running");
  assert.equal(got.stateSince, t0);
  assert.equal(got.lastActivity, t0);
});

// 3. tool_execution_start("bash") → activeToolName "bash", state untouched.
test("3. tool_execution_start sets activeToolName, state untouched", async (t) => {
  const { writer, entry } = await harness(t);
  await writer.toolStart("bash");
  assert.equal(entry.state, "idle");
  const root = (writer as unknown as { rootDir: string }).rootDir;
  const got = await readEntry(root, entry.instanceId);
  assert.equal(got.activeToolName, "bash");
  assert.equal(got.state, "idle");
});

// 4. tool_execution_end after start → activeToolName absent, contextUsage refreshed.
test("4. tool_execution_end clears tool and refreshes contextUsage", async (t) => {
  const start = Date.now();
  const { writer, entry, setNow } = await harness(t, {
    startNow: start,
    getContextUsage: () => ({ tokens: 45200, contextWindow: 272000, percent: 17 }),
  });
  await writer.toolStart("bash");
  setNow(start + STATUS_WRITE_THROTTLE_MS + 1);
  await writer.toolEnd();
  const root = (writer as unknown as { rootDir: string }).rootDir;
  const got = await readEntry(root, entry.instanceId);
  assert.ok(!("activeToolName" in got));
  assert.deepEqual(got.contextUsage, { tokens: 45200, contextWindow: 272000 });
});

// 5. agent_settled with activeToolName still set → tool cleared, state idle,
//    stateSince updated (agent_end no longer drives the idle transition).
test("5. agent_settled clears tool, sets idle, bumps stateSince", async (t) => {
  const start = Date.now();
  const { writer, entry, setNow } = await harness(t, {
    startNow: start,
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }),
  });
  await writer.agentStart();
  setNow(start + 100);
  await writer.toolStart("bash");
  const settleAt = start + 500;
  setNow(settleAt);
  await writer.agentSettled();
  const root = (writer as unknown as { rootDir: string }).rootDir;
  const got = await readEntry(root, entry.instanceId);
  assert.equal(got.state, "idle");
  assert.equal(got.stateSince, settleAt);
  assert.ok(!("activeToolName" in got));
  assert.deepEqual(got.contextUsage, { tokens: 100, contextWindow: 1000 });
});

// 6. session_info_changed → sessionName written AND lastActivity bumped.
test("6. session_info_changed writes name and lastActivity", async (t) => {
  const start = Date.now();
  const { writer, entry, setNow } = await harness(t, { startNow: start });
  const changedAt = start + 5000;
  setNow(changedAt);
  await writer.sessionInfoChanged("renamed");
  const root = (writer as unknown as { rootDir: string }).rootDir;
  const got = await readEntry(root, entry.instanceId);
  assert.equal(got.sessionName, "renamed");
  assert.equal(got.lastActivity, changedAt);
});

// 7. Heartbeat while running refreshes contextUsage; while idle it does not.
//    Heartbeat delay is ~10 s with 0–3 s jitter.
test("7. heartbeat refreshes contextUsage only while running; jittered delay", async (t) => {
  const usage = { tokens: 45200, contextWindow: 272000 };
  const running = await harness(t, { getContextUsage: () => usage });
  running.entry.state = "running";
  await running.writer.heartbeat();
  let got = await readEntry(
    (running.writer as unknown as { rootDir: string }).rootDir,
    running.entry.instanceId,
  );
  assert.deepEqual(got.contextUsage, usage);

  const idle = await harness(t, { getContextUsage: () => usage });
  await idle.writer.heartbeat();
  got = await readEntry(
    (idle.writer as unknown as { rootDir: string }).rootDir,
    idle.entry.instanceId,
  );
  assert.ok(!("contextUsage" in got));
  assert.equal(typeof got.lastHeartbeat, "number");

  assert.equal(heartbeatDelayMs(() => 0), HEARTBEAT_INTERVAL_MS);
  const max = heartbeatDelayMs(() => 0.9999);
  assert.ok(max >= HEARTBEAT_INTERVAL_MS);
  assert.ok(max < HEARTBEAT_INTERVAL_MS + HEARTBEAT_JITTER_MS);
});

// 8. getContextUsage() returns undefined/null → contextUsage absent, no crash.
test("8. missing getContextUsage result leaves contextUsage absent", async (t) => {
  for (const raw of [undefined, null]) {
    const { writer, entry } = await harness(t, { getContextUsage: () => raw });
    await writer.agentSettled(); // transition: refreshes contextUsage
    const root = (writer as unknown as { rootDir: string }).rootDir;
    const got = await readEntry(root, entry.instanceId);
    assert.ok(!("contextUsage" in got));
    assert.equal(got.state, "idle");
  }
  // no getContextUsage dep at all
  const { writer, entry } = await harness(t);
  await writer.toolEnd();
  const root = (writer as unknown as { rootDir: string }).rootDir;
  const got = await readEntry(root, entry.instanceId);
  assert.ok(!("contextUsage" in got));
});

// 9. N rapid tool_execution_start events within one window → at most one write.
test("9. rapid tool_execution_start events coalesce to one write", async (t) => {
  const start = Date.now();
  const { writer, writes } = await harness(t, { startNow: start });
  await writer.toolStart("bash"); // leading edge: writes
  for (const tool of ["read", "edit", "write", "grep"]) {
    await writer.toolStart(tool); // inside throttle window: no write
  }
  assert.equal(writes.length, 1);
});

// 10. agent_start / agent_settled always write immediately, even inside a window.
test("10. state transitions bypass the throttle", async (t) => {
  const start = Date.now();
  const { writer, writes } = await harness(t, { startNow: start });
  await writer.agentStart(); // write 1 (also leading edge)
  await writer.toolStart("bash"); // throttled
  await writer.agentSettled(); // transition: write 2 despite window
  await writer.agentStart(); // transition: write 3 despite window
  assert.equal(writes.length, 3);
  assert.equal(writes[1].state, "idle");
  assert.equal(writes[2].state, "running");
});

// 11. First write after the window flushes pending changes — no field is lost.
test("11. pending throttled changes merge into the next write", async (t) => {
  const start = Date.now();
  const { writer, entry, setNow } = await harness(t, { startNow: start });
  await writer.toolStart("bash"); // leading edge write
  await writer.toolStart("read"); // throttled → pending
  await writer.sessionInfoChanged("renamed"); // throttled → pending
  setNow(start + STATUS_WRITE_THROTTLE_MS + 1);
  await writer.toolEnd(); // past window: flush merges pending
  const root = (writer as unknown as { rootDir: string }).rootDir;
  const got = await readEntry(root, entry.instanceId);
  assert.equal(got.sessionName, "renamed"); // throttled field survived
  assert.ok(!("activeToolName" in got)); // latest patch wins
});

// 12. Old-format entry (no new keys) passes through toSessionInfo and
//     formatters with blank columns, no "undefined"/"null", no exceptions.
test("12. old-format entries render with blank columns", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, makeEntry({ instanceId: "abcdef0a" }));
  const [s] = await listSessions(
    root,
    { instanceId: "a1a1a1a1", cwd: "/elsewhere", projectRoot: "/elsewhere" },
    "all",
  );
  assert.equal(s.instanceId, "abcdef0a");
  const row = formatSessionRow(s);
  const map = formatMetroMap([s]);
  for (const out of [row, map, JSON.stringify(s)]) {
    assert.ok(!out.includes("undefined"), out);
    assert.ok(!out.includes("null"), out);
  }
  // map line is exactly today's format
  assert.ok(map.includes(`    ${s.metroName} · test · idle`));
  // row keeps blank columns then session name and cwd
  assert.ok(row.endsWith(`test             ${s.cwd}`) || row.includes(s.cwd));
});

// 13. New-format entry (and unknown future keys) read by old-style consumers
//     without crashing; unknown keys are ignored.
test("13. new-format entries with unknown keys are tolerated", async (t) => {
  const root = await withTempRoot(t);
  const entry = makeEntry({
    instanceId: "abcdef0b",
    stateSince: Date.now(),
    activeToolName: "bash",
    contextUsage: { tokens: 1, contextWindow: 2 },
    lastActivity: Date.now(),
  });
  await writeRegistryEntry(root, {
    ...entry,
    futureUnknownField: { nested: true },
  } as RegistryEntry);
  const [s] = await listSessions(
    root,
    { instanceId: "a1a1a1a1", cwd: "/elsewhere", projectRoot: "/elsewhere" },
    "all",
  );
  assert.equal(s.activeToolName, "bash");
  assert.deepEqual(s.contextUsage, { tokens: 1, contextWindow: 2 });
  const row = formatSessionRow(s);
  assert.ok(row.includes("bash"));
  assert.ok(!row.includes("futureUnknownField"));
});

// 14. formatSessionRow includes tool/context/activity when present;
//     alignment stable when absent.
test("14. formatSessionRow renders new columns and keeps alignment", () => {
  const full = session({
    metroName: "Red-1",
    sessionName: "auth-refactor",
    state: "running",
    activeToolName: "bash",
    contextUsage: { tokens: 45200, contextWindow: 272000 },
    lastActivity: Date.now() - 3 * 60_000,
  });
  const bare = session({
    metroName: "Blue-2",
    sessionName: "review",
    state: "idle",
  });
  const rowFull = formatSessionRow(full);
  const rowBare = formatSessionRow(bare);
  assert.ok(rowFull.includes("bash"));
  assert.ok(rowFull.includes("45K/272K"));
  assert.ok(rowFull.includes("3m ago"));
  assert.ok(!rowBare.includes("undefined"));
  // fixed-width columns: cwd starts at the same column in both rows
  assert.equal(rowFull.indexOf(full.cwd), rowBare.indexOf(bare.cwd));
});

// 15. formatMetroMap appends tool/context for running, ago for idle with
//     lastActivity, nothing extra when all new fields are absent.
test("15. formatMetroMap appends compact status segments", () => {
  const running = session({
    metroName: "Red-1",
    sessionName: "auth-refactor",
    state: "running",
    activeToolName: "bash",
    contextUsage: { tokens: 45200, contextWindow: 272000 },
  });
  const idleAgo = session({
    metroName: "Blue-2",
    cwd: "/work/app/web",
    lastActivity: Date.now() - 12 * 60_000,
  });
  const old = session({ metroName: "Green-1", cwd: "/other", projectRoot: "/other" });
  const out = formatMetroMap([running, idleAgo, old]);
  assert.ok(out.includes("Red-1 · auth-refactor · running · bash · 45K/272K"));
  const blueLine = out.split("\n").find((l) => l.includes("Blue-2"))!;
  assert.ok(blueLine.includes("· 12m ago"));
  assert.ok(!blueLine.includes("bash"));
  const greenLine = out.split("\n").find((l) => l.includes("Green-1"))!;
  assert.equal(greenLine, "    Green-1 · idle");
});

// 16. fmtContext rounds to K.
test("16. fmtContext rounds tokens to K", () => {
  assert.equal(fmtContext({ tokens: 45200, contextWindow: 272000 }), "45K/272K");
  assert.equal(fmtContext({ tokens: 500, contextWindow: 1999 }), "1K/2K");
  assert.equal(fmtContext(undefined), "");
});
