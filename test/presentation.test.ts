import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMetroMap,
  formatMetroInbox,
  formatEntryLine,
  MAX_INBOX_ITEMS,
} from "../src/presentation.ts";
import type { SessionInfo } from "../src/list.ts";

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
  const long = "x".repeat(500) + "\nsecond line\nthird line";
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
