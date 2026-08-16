import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { findProjectRoot } from "../src/project.ts";

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("finds project root in dir containing .git", async (t) => {
  const root = await withTempRoot(t);
  await mkdir(path.join(root, ".git"));
  assert.equal(await findProjectRoot(root), root);
});

test("finds project root when nested under subdirs", async (t) => {
  const root = await withTempRoot(t);
  await mkdir(path.join(root, ".git"));
  const nested = path.join(root, "abcdef0d", "b", "c");
  await mkdir(nested, { recursive: true });
  assert.equal(await findProjectRoot(nested), root);
});

test("falls back to cwd when no .git exists", async (t) => {
  const root = await withTempRoot(t);
  const nested = path.join(root, "abcdef01", "abcdef0c");
  await mkdir(nested, { recursive: true });
  assert.equal(await findProjectRoot(nested), nested);
});
