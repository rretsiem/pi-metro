import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMetroMap,
  formatMetroInbox,
  formatEntryLine,
  formatMetroStatus,
  MAX_INBOX_ITEMS,
} from "../src/presentation.ts";
import type { SessionInfo } from "../src/list.ts";
import type { RequestRecord } from "../src/asks.ts";

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

test("map groups by project then cwd and includes aliases/session labels", () => {
  const out = formatMetroMap([
    session({ metroName: "Blue-1", sessionName: "auth-refactor", cwd: "/work/app/api" }),
    session({ metroName: "Red-1", cwd: "/work/app/api", state: "running" }),
    session({ metroName: "Green-2", cwd: "/work/app/web" }),
    session({ metroName: "Solo-1", cwd: "/other/proj", projectRoot: "/other/proj" }),
  ]);
  // project groups are sorted; each project precedes its cwd lines
  assert.ok(out.indexOf("/other/proj\n") < out.indexOf("/work/app\n"));
  assert.ok(out.indexOf("/work/app\n") < out.indexOf("/work/app/api"));
  assert.ok(out.indexOf("/work/app\n") < out.indexOf("/work/app/web"));
  // cwd nesting under the project
  assert.match(out, /\/work\/app\n {2}\/work\/app\/api/);
  assert.ok(out.includes("/work/app/web"));
  // aliases, labels, state
  assert.ok(out.includes("Blue-1"));
  assert.ok(out.includes("auth-refactor"));
  assert.ok(out.includes("Red-1"));
  assert.ok(out.includes("running"));
  assert.ok(out.includes("Solo-1"));
});

test("map handles empty session list", () => {
  const out = formatMetroMap([]);
  assert.ok(out.includes("0"));
});

function custom(customType: string, data: Record<string, unknown>) {
  return { type: "custom", customType, data };
}

test("inbox renders newest entries first", () => {
  const out = formatMetroInbox([
    custom("metrol:out", { to: "Blue-1", preview: "first", timestamp: 1000 }),
    custom("metrol:in", { from: "Red-1", preview: "second", timestamp: 2000 }),
    custom("metrol:request", {
      requestId: "r1",
      target: "Blue-1",
      status: "answered",
      question: "third",
      updatedAt: 3000,
    }),
  ]);
  const lines = out.split("\n");
  assert.ok(out.indexOf("third") < out.indexOf("second"));
  assert.ok(out.indexOf("second") < out.indexOf("first"));
  assert.ok(lines.length <= MAX_INBOX_ITEMS + 2);
  // request shows status
  assert.ok(out.includes("answered"));
});

test("inbox caps at MAX_INBOX_ITEMS", () => {
  const entries = Array.from({ length: MAX_INBOX_ITEMS + 20 }, (_, i) =>
    custom("metrol:in", { from: "Red-1", preview: `msg-${i}`, timestamp: i }),
  );
  const out = formatMetroInbox(entries);
  assert.equal(out.split("\n").filter((l) => l.includes("msg-")).length, MAX_INBOX_ITEMS);
  // newest survive: the oldest 20 are dropped
  assert.ok(out.includes(`msg-${MAX_INBOX_ITEMS + 19}`));
  assert.ok(!out.includes("msg-0 "));
});

test("inbox truncates long/multiline previews", () => {
  const long = "abcdef01".repeat(500) + "\nsecond line\nthird line";
  const out = formatMetroInbox([
    custom("metrol:out", { to: "Blue-1", preview: long, timestamp: 1 }),
  ]);
  const body = out.split("\n").slice(1);
  assert.equal(body.length, 1); // single line per item
  assert.ok(body[0].length < 200);
  assert.ok(body[0].includes("…"));
});

test("inbox ignores non-metrol entries", () => {
  const out = formatMetroInbox([
    { type: "message", message: { role: "user" } },
    custom("other:thing", { preview: "nope" }),
  ]);
  assert.ok(!out.includes("nope"));
});

test("formatEntryLine renders all four metrol custom types", () => {
  assert.match(
    formatEntryLine("metrol:identity", { metroName: "Red-1", instanceId: "abcdef123456" })!,
    /Red-1/,
  );
  assert.match(
    formatEntryLine("metrol:in", { from: "Blue-1", preview: "hi" })!,
    /Blue-1.*hi/,
  );
  assert.match(
    formatEntryLine("metrol:out", { to: "Blue-1", preview: "yo" })!,
    /Blue-1.*yo/,
  );
  assert.match(
    formatEntryLine("metrol:request", {
      target: "Blue-1",
      status: "answered",
      reply: "done",
    })!,
    /Blue-1.*answered.*done/,
  );
  assert.equal(formatEntryLine("unknown", {}), null);
});

// --- /metro status --- a pure renderer that takes everything pre-fetched.

function req(over: Partial<RequestRecord>): RequestRecord {
  return {
    requestId: "req-x",
    target: "Blue-1",
    status: "queued",
    updatedAt: Date.now(),
    ...over,
  };
}

test("status renders self section with alias/session/cwd/project/state/tool/ctx/ago", () => {
  const self = session({
    metroName: "Red-1",
    sessionName: "main",
    cwd: "/work/app/api",
    projectRoot: "/work/app",
    state: "running",
    activeToolName: "metro_publish",
    contextUsage: { tokens: 45_000, contextWindow: 272_000 },
    lastActivity: Date.now() - 5 * 60_000, // 5m ago
  });
  const out = formatMetroStatus(self, [], []);
  assert.ok(out.includes("Red-1"));
  assert.ok(out.includes("main"));
  assert.ok(out.includes("running"));
  assert.ok(out.includes("metro_publish"));
  assert.ok(out.includes("45K/272K"));
  assert.ok(out.includes("5m ago"));
  assert.ok(out.includes("/work/app/api"));
  assert.ok(out.includes("/work/app"));
});

test("status renders peers section in the same line format as formatMetroMap", () => {
  const self = session({ metroName: "Red-1" });
  const peers = [
    session({
      metroName: "Blue-1",
      sessionName: "auth",
      cwd: "/work/app/api",
      projectRoot: "/work/app",
      state: "idle",
      activeToolName: "metro_list_sessions",
      contextUsage: { tokens: 12_000, contextWindow: 272_000 },
    }),
  ];
  const out = formatMetroStatus(self, peers, []);
  // header from formatMetroMap must appear ("Metro map" — that's only in map)
  // status reuses the per-session segments only:
  //   alias · session · state · tool · ctx
  assert.ok(out.includes("Blue-1"));
  assert.ok(out.includes("auth"));
  assert.ok(out.includes("idle"));
  assert.ok(out.includes("metro_list_sessions"));
  assert.ok(out.includes("12K/272K"));
  // cwd grouping line (project root label) must also appear because
  // status delegates the peers block to formatMetroMap.
  assert.ok(out.includes("/work/app"));
});

test("status surfaces non-terminal asks from recentRequests", () => {
  const self = session({ metroName: "Red-1" });
  const r = req({
    requestId: "abc123",
    target: "Blue-1",
    status: "running",
    question: "are you ready?",
    updatedAt: Date.now(),
  });
  const out = formatMetroStatus(self, [], [r]);
  assert.match(out, /ask running .*Blue-1/);
  assert.ok(out.includes("are you ready?"));
});

test("status surfaces recent failures, capped to the last few", () => {
  const self = session({ metroName: "Red-1" });
  const failures: RequestRecord[] = Array.from({ length: 10 }, (_, i) =>
    req({
      requestId: `req-${i.toString().padStart(2, "0")}`,
      target: "Blue-1",
      status: "failed",
      error: `boom-${i}`,
      updatedAt: Date.now() - i * 1000,
    }),
  );
  const out = formatMetroStatus(self, [], failures);
  // most recent failure (i=0) must be present
  assert.ok(out.includes("boom-0"));
  // cap kicks in — older failures drop
  assert.ok(!out.includes("boom-7"));
  // section header surfaces the count
  assert.match(out, /recent failures/);
});
