import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  claimMetroAlias,
  releaseMetroAlias,
  staleClaimsCleanup,
} from "../src/identity.ts";

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("50 concurrent claims all get unique aliases", async (t) => {
  const root = await withTempRoot(t);
  const names = await Promise.all(
    Array.from({ length: 50 }, () => claimMetroAlias(root, randomUUID())),
  );
  assert.equal(new Set(names).size, 50);
});

test("reclaiming previous alias returns the same alias", async (t) => {
  const root = await withTempRoot(t);
  const instanceId = randomUUID();
  const first = await claimMetroAlias(root, instanceId);
  const reclaimed = await claimMetroAlias(root, instanceId, first);
  assert.equal(reclaimed, first);
});

test("previous alias taken by another instance allocates a new one", async (t) => {
  const root = await withTempRoot(t);
  const taken = await claimMetroAlias(root, randomUUID());
  const other = await claimMetroAlias(root, randomUUID(), taken);
  assert.notEqual(other, taken);
});

test("releaseMetroAlias removes claim only for the owner", async (t) => {
  const root = await withTempRoot(t);
  const owner = randomUUID();
  const name = await claimMetroAlias(root, owner);
  assert.equal(await releaseMetroAlias(root, name, randomUUID()), false);
  assert.equal(await releaseMetroAlias(root, name, owner), true);
  // name is free again
  assert.equal(await claimMetroAlias(root, randomUUID(), name), name);
});

test("staleClaimsCleanup removes claims not in the valid set", async (t) => {
  const root = await withTempRoot(t);
  const live = randomUUID();
  const liveName = await claimMetroAlias(root, live);
  const dead1 = await claimMetroAlias(root, randomUUID());
  const dead2 = await claimMetroAlias(root, randomUUID());
  const removed = await staleClaimsCleanup(root, new Set([live]));
  assert.deepEqual(new Set(removed), new Set([dead1, dead2]));
  // live claim survives: owner can reclaim it
  assert.equal(await claimMetroAlias(root, live, liveName), liveName);
});
