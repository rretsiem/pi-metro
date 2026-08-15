import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cleanupStaleInstanceDirs } from "../src/registry.ts";

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-cleanup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("stale instance dirs are removed when absent from live IDs", async (t) => {
  const root = await withTempRoot(t);
  await mkdir(path.join(root, "instances", "dead-1", "inbox"), { recursive: true });
  await writeFile(path.join(root, "instances", "dead-1", "inbox", "1-a.json"), "{}");
  const removed = await cleanupStaleInstanceDirs(root, ["live-1"]);
  assert.deepEqual(removed, ["dead-1"]);
  const left = await readdir(path.join(root, "instances"));
  assert.deepEqual(left, []);
});

test("live instance dirs remain", async (t) => {
  const root = await withTempRoot(t);
  await mkdir(path.join(root, "instances", "live-1", "inbox"), { recursive: true });
  const removed = await cleanupStaleInstanceDirs(root, ["live-1"]);
  assert.deepEqual(removed, []);
  const left = await readdir(path.join(root, "instances"));
  assert.deepEqual(left, ["live-1"]);
});

test("unrelated files and claims are untouched", async (t) => {
  const root = await withTempRoot(t);
  await mkdir(path.join(root, "instances"), { recursive: true });
  await writeFile(path.join(root, "instances", "notes.txt"), "keep me");
  await mkdir(path.join(root, "claims", "Red-1"), { recursive: true });
  await writeFile(path.join(root, "claims", "Red-1", "owner.json"), "{}");
  await mkdir(path.join(root, "instances", "stale-9"), { recursive: true });
  const removed = await cleanupStaleInstanceDirs(root, []);
  assert.deepEqual(removed, ["stale-9"]);
  const left = await readdir(path.join(root, "instances"));
  assert.deepEqual(left, ["notes.txt"]);
  const claims = await readdir(path.join(root, "claims"));
  assert.deepEqual(claims, ["Red-1"]);
});

test("missing instances dir is a no-op", async (t) => {
  const root = await withTempRoot(t);
  assert.deepEqual(await cleanupStaleInstanceDirs(root, ["x"]), []);
});
