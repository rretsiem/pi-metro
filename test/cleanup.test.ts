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
  await mkdir(path.join(root, "instances", "dead1234", "inbox"), { recursive: true });
  await writeFile(path.join(root, "instances", "dead1234", "inbox", "1-a.json"), "{}");
  const removed = await cleanupStaleInstanceDirs(root, ["abc12345"]);
  assert.deepEqual(removed, ["dead1234"]);
  const left = await readdir(path.join(root, "instances"));
  assert.deepEqual(left, []);
});

test("live instance dirs remain", async (t) => {
  const root = await withTempRoot(t);
  await mkdir(path.join(root, "instances", "abc12345", "inbox"), { recursive: true });
  const removed = await cleanupStaleInstanceDirs(root, ["abc12345"]);
  assert.deepEqual(removed, []);
  const left = await readdir(path.join(root, "instances"));
  assert.deepEqual(left, ["abc12345"]);
});

test("unrelated files and claims are untouched", async (t) => {
  const root = await withTempRoot(t);
  await mkdir(path.join(root, "instances"), { recursive: true });
  await writeFile(path.join(root, "instances", "notes.txt"), "keep me");
  await mkdir(path.join(root, "claims", "Red-1"), { recursive: true });
  await writeFile(path.join(root, "claims", "Red-1", "owner.json"), "{}");
  await mkdir(path.join(root, "instances", "abc12346"), { recursive: true });
  const removed = await cleanupStaleInstanceDirs(root, []);
  assert.deepEqual(removed, ["abc12346"]);
  const left = await readdir(path.join(root, "instances"));
  assert.deepEqual(left, ["notes.txt"]);
  const claims = await readdir(path.join(root, "claims"));
  assert.deepEqual(claims, ["Red-1"]);
});

test("missing instances dir is a no-op", async (t) => {
  const root = await withTempRoot(t);
  assert.deepEqual(await cleanupStaleInstanceDirs(root, ["abcdef01"]), []);
});

test("symlinks under instances/ are NOT followed (defense-in-depth)", async (t) => {
  // A malicious or buggy local process could drop a symlink at
  // instances/<id> pointing to /etc or into a user's project tree. The
  // sweep must refuse to follow it (lstat + isSymbolicLink), so cleanup
  // can't be tricked into `rm -rf`'ing arbitrary filesystem locations.
  const root = await withTempRoot(t);
  const target = await mkdtemp(path.join(tmpdir(), "metrol-cleanup-target-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  // a victim file inside the symlink target
  await writeFile(path.join(target, "secret.txt"), "do not delete");
  // create a symlink at instances/<id> -> target
  await mkdir(path.join(root, "instances"), { recursive: true });
  const { symlink } = await import("node:fs/promises");
  await symlink(target, path.join(root, "instances", "abcdef01"), "dir");
  const removed = await cleanupStaleInstanceDirs(root, []);
  // the symlink must NOT be removed
  assert.deepEqual(removed, []);
  // the victim file must still be there
  const secret = await readdir(target);
  assert.deepEqual(secret, ["secret.txt"]);
});

test("non-directory entries (files, sockets) are not removed", async (t) => {
  const root = await withTempRoot(t);
  await mkdir(path.join(root, "instances"), { recursive: true });
  await writeFile(path.join(root, "instances", "weird.txt"), "not a dir");
  const removed = await cleanupStaleInstanceDirs(root, []);
  assert.deepEqual(removed, []);
  const left = await readdir(path.join(root, "instances"));
  assert.ok(left.includes("weird.txt"));
});
