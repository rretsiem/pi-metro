import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  writeRegistryEntry,
  readRegistry,
  type RegistryEntry,
} from "../src/registry.ts";
import { listSessions } from "../src/list.ts";

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-list-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function entry(over: Partial<RegistryEntry> & { instanceId: string }): RegistryEntry {
  return {
    version: 1,
    sessionId: "sess-" + over.instanceId,
    metroName: "Red-1",
    cwd: "/work/app/api",
    projectRoot: "/work/app",
    pid: process.pid,
    model: "anthropic/claude-opus-4-6",
    state: "idle",
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
    ...over,
  };
}

const CALLER = {
  instanceId: "a1a1a1a1",
  cwd: "/work/app/api",
  projectRoot: "/work/app",
};

test("cwd scope: same-cwd callers see only themselves filtered out", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, entry({ instanceId: "a1a1a1a1" }));
  await writeRegistryEntry(root, entry({ instanceId: "b2b2b2b2", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({ instanceId: "b3b3b3b3", metroName: "Green-1", cwd: "/work/app/web" }),
  );
  const sessions = await listSessions(root, CALLER, "cwd");
  assert.deepEqual(sessions.map((s) => s.instanceId), ["b2b2b2b2"]);
});

test("project scope: same projectRoot, excluding caller and other projects", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, entry({ instanceId: "a1a1a1a1" }));
  await writeRegistryEntry(
    root,
    entry({ instanceId: "b3b3b3b3", metroName: "Green-1", cwd: "/work/app/web" }),
  );
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "b4b4b4b4",
      metroName: "Blue-1",
      cwd: "/elsewhere/x",
      projectRoot: "/elsewhere",
    }),
  );
  const sessions = await listSessions(root, CALLER, "project");
  assert.deepEqual(sessions.map((s) => s.instanceId), ["b3b3b3b3"]);
});

test("all scope: returns all live sessions except the caller", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, entry({ instanceId: "a1a1a1a1" }));
  await writeRegistryEntry(root, entry({ instanceId: "b2b2b2b2", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "b4b4b4b4",
      metroName: "Green-1",
      cwd: "/elsewhere/x",
      projectRoot: "/elsewhere",
    }),
  );
  const sessions = await listSessions(root, CALLER, "all");
  assert.deepEqual(new Set(sessions.map((s) => s.instanceId)), new Set(["b2b2b2b2", "b4b4b4b4"]));
});

test("sort order: same-cwd, then same-project, then rest; stable within rank", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, entry({ instanceId: "a1a1a1a1" }));
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "b5b5b5b5",
      metroName: "Pink-1",
      cwd: "/elsewhere/x",
      projectRoot: "/elsewhere",
    }),
  );
  await writeRegistryEntry(
    root,
    entry({ instanceId: "b6b6b6b6", metroName: "Green-1", cwd: "/work/app/web" }),
  );
  await writeRegistryEntry(root, entry({ instanceId: "b7b7b7b7", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({ instanceId: "abc12346", metroName: "Teal-1", cwd: "/work/app/cli" }),
  );
  const sessions = await listSessions(root, CALLER, "all");
  const rank = (s: (typeof sessions)[number]) =>
    s.cwd === CALLER.cwd ? 0 : s.projectRoot === CALLER.projectRoot ? 1 : 2;
  // ranks must be non-decreasing: cwd group, project group, rest
  assert.deepEqual(sessions.map(rank), [0, 1, 1, 2]);
  // within-rank order matches registry read order (stable sort)
  const readOrder = (await readRegistry(root)).map((e) => e.instanceId);
  const projGroup = sessions.filter((s) => rank(s) === 1).map((s) => s.instanceId);
  assert.deepEqual(
    projGroup,
    ["b6b6b6b6", "abc12346"].sort(
      (a, b) => readOrder.indexOf(a) - readOrder.indexOf(b),
    ),
  );
});

test("stale entries (old heartbeat, dead pid) are excluded", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, entry({ instanceId: "a1a1a1a1" }));
  await writeRegistryEntry(root, entry({ instanceId: "abcdef01", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "deadbeef",
      metroName: "Green-1",
      pid: 2_000_000_000, // no such process
      lastHeartbeat: Date.now() - 60_000,
    }),
  );
  const sessions = await listSessions(root, CALLER, "all");
  assert.deepEqual(sessions.map((s) => s.instanceId), ["abcdef01"]);
});

test("foregroundOnly: hides entries with a parentInstanceId", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, entry({ instanceId: "a1a1a1a1" }));
  await writeRegistryEntry(root, entry({ instanceId: "f0f0f0f0", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "b0b0b0b0",
      metroName: "Green-1",
      parentInstanceId: "some-parent",
    }),
  );
  const sessions = await listSessions(root, CALLER, "all", {
    foregroundOnly: true,
  });
  assert.deepEqual(sessions.map((s) => s.instanceId), ["f0f0f0f0"]);
});

test("subagentsOnly: keeps only entries with a parentInstanceId", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, entry({ instanceId: "a1a1a1a1" }));
  await writeRegistryEntry(root, entry({ instanceId: "f0f0f0f0", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "d1d1d1d1d1d1d1d1",
      metroName: "Green-1",
      parentInstanceId: "deadbeef",
    }),
  );
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "d2d2d2d2d2d2d2d2",
      metroName: "Pink-1",
      parentInstanceId: "abcdef01",
    }),
  );
  const sessions = await listSessions(root, CALLER, "all", {
    subagentsOnly: true,
  });
  assert.deepEqual(new Set(sessions.map((s) => s.instanceId)), new Set(["d1d1d1d1d1d1d1d1", "d2d2d2d2d2d2d2d2"]));
});

test("foregroundOnly wins when both flags are set (and both are no-ops otherwise)", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, entry({ instanceId: "a1a1a1a1" }));
  await writeRegistryEntry(root, entry({ instanceId: "f0f0f0f0", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "b0b0b0b0",
      metroName: "Green-1",
      parentInstanceId: "deadbeef",
    }),
  );
  // both: foregroundOnly wins per list.ts contract
  const both = await listSessions(root, CALLER, "all", {
    foregroundOnly: true,
    subagentsOnly: true,
  });
  assert.deepEqual(both.map((s) => s.instanceId), ["f0f0f0f0"]);
  // neither: full list
  const none = await listSessions(root, CALLER, "all", {});
  assert.deepEqual(
    new Set(none.map((s) => s.instanceId)),
    new Set(["f0f0f0f0", "b0b0b0b0"]),
  );
});

test("parentInstanceId is surfaced on SessionInfo", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, entry({ instanceId: "a1a1a1a1" }));
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "b0b0b0b0",
      metroName: "Green-1",
      parentInstanceId: "parent-id",
    }),
  );
  const sessions = await listSessions(root, CALLER, "all");
  const sub = sessions.find((s) => s.instanceId === "b0b0b0b0");
  assert.equal(sub?.parentInstanceId, "parent-id");
  const fg = sessions.find((s) => s.instanceId === "a1a1a1a1");
  // caller is excluded; instead check an explicit foreground peer
  await writeRegistryEntry(root, entry({ instanceId: "f0f0f0f0", metroName: "Blue-1" }));
  const fg2 = (await listSessions(root, CALLER, "all")).find(
    (s) => s.instanceId === "f0f0f0f0",
  );
  assert.equal(fg2?.parentInstanceId, undefined);
});
