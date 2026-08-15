import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CLAIM_SWEEP_GRACE_MS,
  claimMetroAlias,
  releaseMetroAlias,
  staleClaimsCleanup,
} from "../src/identity.ts";

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function backdateClaim(
  rootDir: string,
  name: string,
  ageMs = 60_000,
): Promise<void> {
  const file = path.join(rootDir, "claims", name, "owner.json");
  const owner = JSON.parse(await readFile(file, "utf8"));
  owner.claimedAt = Date.now() - ageMs;
  await writeFile(file, JSON.stringify(owner));
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
  // Backdate the dead claims so they fall outside the sweep grace period.
  await backdateClaim(root, dead1);
  await backdateClaim(root, dead2);
  const removed = await staleClaimsCleanup(root, new Set([live]));
  assert.deepEqual(new Set(removed), new Set([dead1, dead2]));
  // live claim survives: owner can reclaim it
  assert.equal(await claimMetroAlias(root, live, liveName), liveName);
});

test("CLAIM_SWEEP_GRACE_MS is 15 seconds", () => {
  assert.equal(CLAIM_SWEEP_GRACE_MS, 15_000);
});

test("staleClaimsCleanup keeps a fresh claim whose owner is not in the valid set", async (t) => {
  const root = await withTempRoot(t);
  const fresh = await claimMetroAlias(root, randomUUID());
  // Empty valid set — owner is definitely not live.
  const removed = await staleClaimsCleanup(root, new Set());
  assert.deepEqual(removed, []);
  // The claim is still there.
  const entries = await readdir(path.join(root, "claims"));
  assert.deepEqual(entries, [fresh]);
});

test("staleClaimsCleanup removes a claim past the grace period when owner is not in the valid set", async (t) => {
  const root = await withTempRoot(t);
  const old = await claimMetroAlias(root, randomUUID());
  await backdateClaim(root, old, CLAIM_SWEEP_GRACE_MS + 1000);
  const removed = await staleClaimsCleanup(root, new Set());
  assert.deepEqual(removed, [old]);
});

test("staleClaimsCleanup never removes a claim whose owner IS in the valid set, even past the grace period", async (t) => {
  const root = await withTempRoot(t);
  const owner = randomUUID();
  const name = await claimMetroAlias(root, owner);
  // Backdate well past grace — but owner IS live, so it must survive.
  await backdateClaim(root, name, CLAIM_SWEEP_GRACE_MS + 60_000);
  const removed = await staleClaimsCleanup(root, new Set([owner]));
  assert.deepEqual(removed, []);
});
