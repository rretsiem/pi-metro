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
  instanceId: "me",
  cwd: "/work/app/api",
  projectRoot: "/work/app",
};

test("cwd scope: same-cwd callers see only themselves filtered out", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, entry({ instanceId: "me" }));
  await writeRegistryEntry(root, entry({ instanceId: "sib", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({ instanceId: "web", metroName: "Green-1", cwd: "/work/app/web" }),
  );
  const sessions = await listSessions(root, CALLER, "cwd");
  assert.deepEqual(sessions.map((s) => s.instanceId), ["sib"]);
});

test("project scope: same projectRoot, excluding caller and other projects", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, entry({ instanceId: "me" }));
  await writeRegistryEntry(
    root,
    entry({ instanceId: "web", metroName: "Green-1", cwd: "/work/app/web" }),
  );
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "other",
      metroName: "Blue-1",
      cwd: "/elsewhere/x",
      projectRoot: "/elsewhere",
    }),
  );
  const sessions = await listSessions(root, CALLER, "project");
  assert.deepEqual(sessions.map((s) => s.instanceId), ["web"]);
});

test("all scope: returns all live sessions except the caller", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, entry({ instanceId: "me" }));
  await writeRegistryEntry(root, entry({ instanceId: "sib", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "other",
      metroName: "Green-1",
      cwd: "/elsewhere/x",
      projectRoot: "/elsewhere",
    }),
  );
  const sessions = await listSessions(root, CALLER, "all");
  assert.deepEqual(new Set(sessions.map((s) => s.instanceId)), new Set(["sib", "other"]));
});

test("sort order: same-cwd, then same-project, then rest; stable within rank", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, entry({ instanceId: "me" }));
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "far",
      metroName: "Pink-1",
      cwd: "/elsewhere/x",
      projectRoot: "/elsewhere",
    }),
  );
  await writeRegistryEntry(
    root,
    entry({ instanceId: "proj1", metroName: "Green-1", cwd: "/work/app/web" }),
  );
  await writeRegistryEntry(root, entry({ instanceId: "cwd1", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({ instanceId: "proj2", metroName: "Teal-1", cwd: "/work/app/cli" }),
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
    ["proj1", "proj2"].sort(
      (a, b) => readOrder.indexOf(a) - readOrder.indexOf(b),
    ),
  );
});

test("stale entries (old heartbeat, dead pid) are excluded", async (t) => {
  const root = await withTempRoot(t);
  await writeRegistryEntry(root, entry({ instanceId: "me" }));
  await writeRegistryEntry(root, entry({ instanceId: "live", metroName: "Blue-1" }));
  await writeRegistryEntry(
    root,
    entry({
      instanceId: "stale",
      metroName: "Green-1",
      pid: 2_000_000_000, // no such process
      lastHeartbeat: Date.now() - 60_000,
    }),
  );
  const sessions = await listSessions(root, CALLER, "all");
  assert.deepEqual(sessions.map((s) => s.instanceId), ["live"]);
});
