import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  STALE_THRESHOLD_MS,
  writeRegistryEntry,
  type RegistryEntry,
} from "../src/registry.ts";
import { claimMetroAlias } from "../src/identity.ts";
import {
  STORAGE_SWEEP_INTERVAL_MS,
  isSweepDisabled,
  sweepMetrolStorage,
  __resetSweepDisabledForTests,
} from "../src/sweep.ts";

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-sweep-test-"));
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
    cwd: "/tmp/x",
    projectRoot: "/tmp/x",
    pid: process.pid,
    model: "anthropic/claude-opus-4-6",
    state: "idle",
    startedAt: now,
    lastHeartbeat: now,
    ...overrides,
  };
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

test("STORAGE_SWEEP_INTERVAL_MS is 5 minutes", () => {
  assert.equal(STORAGE_SWEEP_INTERVAL_MS, 5 * 60_000);
});

// --- isSweepDisabled (D1) -------------------------------------------------

test("isSweepDisabled: unset env → false", () => {
  __resetSweepDisabledForTests();
  const before = process.env.METROL_DISABLE_SWEEP;
  delete process.env.METROL_DISABLE_SWEEP;
  try {
    __resetSweepDisabledForTests();
    assert.equal(isSweepDisabled(), false);
  } finally {
    if (before !== undefined) process.env.METROL_DISABLE_SWEEP = before;
    __resetSweepDisabledForTests();
  }
});

test("isSweepDisabled: truthy values disable sweep", () => {
  for (const value of ["1", "true", "TRUE", " yes ", "True"]) {
    __resetSweepDisabledForTests();
    const before = process.env.METROL_DISABLE_SWEEP;
    process.env.METROL_DISABLE_SWEEP = value;
    try {
      __resetSweepDisabledForTests();
      assert.equal(isSweepDisabled(), true, `value=${JSON.stringify(value)}`);
    } finally {
      if (before !== undefined) process.env.METROL_DISABLE_SWEEP = before;
      else delete process.env.METROL_DISABLE_SWEEP;
      __resetSweepDisabledForTests();
    }
  }
});

test("isSweepDisabled: falsy values do not disable sweep", () => {
  for (const value of ["0", "false", "no", "", "  "]) {
    __resetSweepDisabledForTests();
    const before = process.env.METROL_DISABLE_SWEEP;
    process.env.METROL_DISABLE_SWEEP = value;
    try {
      __resetSweepDisabledForTests();
      assert.equal(isSweepDisabled(), false, `value=${JSON.stringify(value)}`);
    } finally {
      if (before !== undefined) process.env.METROL_DISABLE_SWEEP = before;
      else delete process.env.METROL_DISABLE_SWEEP;
      __resetSweepDisabledForTests();
    }
  }
});

test("isSweepDisabled: result is memoized across calls", () => {
  __resetSweepDisabledForTests();
  const before = process.env.METROL_DISABLE_SWEEP;
  process.env.METROL_DISABLE_SWEEP = "1";
  try {
    __resetSweepDisabledForTests();
    assert.equal(isSweepDisabled(), true);
    // Mutate the env after the first read — the cached decision must hold.
    process.env.METROL_DISABLE_SWEEP = "0";
    assert.equal(isSweepDisabled(), true);
    // Even clearing the env keeps the original answer.
    delete process.env.METROL_DISABLE_SWEEP;
    assert.equal(isSweepDisabled(), true);
  } finally {
    if (before !== undefined) process.env.METROL_DISABLE_SWEEP = before;
    else delete process.env.METROL_DISABLE_SWEEP;
    __resetSweepDisabledForTests();
  }
});

test("integration: sweep removes stale registry file, stale claim, and stale instance dir in one call", async (t) => {
  const root = await withTempRoot(t);

  // Stale registry: dead PID + old heartbeat.
  const staleReg = makeEntry({
    pid: 99999999,
    lastHeartbeat: Date.now() - STALE_THRESHOLD_MS - 1000,
  });
  await writeRegistryEntry(root, staleReg);

  // Stale claim: not in live set, claimedAt older than grace.
  const staleClaim = await claimMetroAlias(root, randomUUID());
  await backdateClaim(root, staleClaim);

  // Stale instance dir with leftover fake inbox message files.
  const staleInst = randomUUID();
  await mkdir(path.join(root, "instances", staleInst, "inbox"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "instances", staleInst, "inbox", "1-a.json"),
    "{}",
  );
  await writeFile(
    path.join(root, "instances", staleInst, "inbox", "2-b.json"),
    "{}",
  );

  // One live entry so the snapshot isn't empty (also exercises the
  // "owner in live set → never remove" path for the claim sweep).
  const liveInst = randomUUID();
  await writeRegistryEntry(root, makeEntry({ instanceId: liveInst }));

  const result = await sweepMetrolStorage(root);
  assert.deepEqual(result.registry, [staleReg.instanceId]);
  assert.deepEqual(result.claims, [staleClaim]);
  assert.deepEqual(result.instances, [staleInst]);

  // Verify everything stale is actually gone; only the live registry entry remains.
  const regLeft = (await readdir(path.join(root, "registry"))).filter(
    (f) => !f.startsWith(".tmp-"),
  );
  assert.deepEqual(regLeft, [`${liveInst}.json`]);
  assert.deepEqual(await readdir(path.join(root, "claims")), []);
  assert.deepEqual(await readdir(path.join(root, "instances")), []);
});

test("integration: sweep removes nothing when everything is live", async (t) => {
  const root = await withTempRoot(t);

  // Live registry.
  const liveReg = makeEntry({ pid: process.pid, lastHeartbeat: Date.now() });
  await writeRegistryEntry(root, liveReg);

  // Live claim (just claimed — within grace period, owner IS in live set).
  const liveClaim = await claimMetroAlias(root, liveReg.instanceId);

  // Live instance dir.
  await mkdir(path.join(root, "instances", liveReg.instanceId, "inbox"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "instances", liveReg.instanceId, "inbox", "msg.json"),
    "{}",
  );

  const result = await sweepMetrolStorage(root);
  assert.deepEqual(result, { registry: [], claims: [], instances: [], leases: [] });

  // Everything is still present.
  const regLeft = (await readdir(path.join(root, "registry"))).filter(
    (f) => !f.startsWith(".tmp-"),
  );
  assert.deepEqual(regLeft, [`${liveReg.instanceId}.json`]);
  assert.deepEqual(await readdir(path.join(root, "claims")), [liveClaim]);
  const instLeft = await readdir(path.join(root, "instances"));
  assert.deepEqual(instLeft, [liveReg.instanceId]);
});

test("integration: a freshly-claimed-but-not-yet-registered session survives a sweep", async (t) => {
  // The grace-period contract: claim owner is NOT in the live set yet
  // (no registry entry written), but claimedAt is fresh.
  const root = await withTempRoot(t);
  const fresh = await claimMetroAlias(root, randomUUID());
  const result = await sweepMetrolStorage(root);
  assert.deepEqual(result.claims, []);
  assert.deepEqual(await readdir(path.join(root, "claims")), [fresh]);
});

test("integration: a stale-but-freshly-claimed claim survives; a stale-and-old claim goes", async (t) => {
  // Mixed case: one fresh claim survives, one old claim gets removed,
  // both have owners not in the live-instance-id set.
  const root = await withTempRoot(t);
  const fresh = await claimMetroAlias(root, randomUUID());
  const old = await claimMetroAlias(root, randomUUID());
  await backdateClaim(root, old);
  const result = await sweepMetrolStorage(root);
  assert.deepEqual(result.claims, [old]);
  const left = await readdir(path.join(root, "claims"));
  assert.deepEqual(left, [fresh]);
});

test("sweepMetrolStorage does not touch anything outside rootDir", async (t) => {
  const root = await withTempRoot(t);

  // Seed a session JSONL outside rootDir that mimics what pi itself stores
  // one level up. The sweep must never reach it.
  const outsideDir = await mkdtemp(path.join(tmpdir(), "metrol-outside-"));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  const sessionJsonl = path.join(outsideDir, "session.jsonl");
  await writeFile(sessionJsonl, '{"keep":"a1a1a1a1"}');

  // Add some stale data inside rootDir so the sweep has work to do.
  await mkdir(path.join(root, "instances", "dead1234"), { recursive: true });
  await writeRegistryEntry(
    root,
    makeEntry({
      pid: 99999999,
      lastHeartbeat: Date.now() - STALE_THRESHOLD_MS - 1000,
    }),
  );

  await sweepMetrolStorage(root);

  // The outside file must be byte-identical.
  assert.equal(await readFile(sessionJsonl, "utf8"), '{"keep":"a1a1a1a1"}');
});

test("sweepMetrolStorage is idempotent when called twice sequentially", async (t) => {
  const root = await withTempRoot(t);
  const staleReg = makeEntry({
    pid: 99999999,
    lastHeartbeat: Date.now() - STALE_THRESHOLD_MS - 1000,
  });
  await writeRegistryEntry(root, staleReg);
  const staleClaim = await claimMetroAlias(root, randomUUID());
  await backdateClaim(root, staleClaim);
  await mkdir(path.join(root, "instances", "dead1234"), { recursive: true });

  const first = await sweepMetrolStorage(root);
  const second = await sweepMetrolStorage(root);

  assert.equal(first.registry.length, 1);
  assert.equal(first.claims.length, 1);
  assert.equal(first.instances.length, 1);
  assert.deepEqual(second, { registry: [], claims: [], instances: [], leases: [] });
});

test("sweepMetrolStorage tolerates concurrent sweeps (no throws, all stale items removed)", async (t) => {
  const root = await withTempRoot(t);
  const staleReg = makeEntry({
    pid: 99999999,
    lastHeartbeat: Date.now() - STALE_THRESHOLD_MS - 1000,
  });
  await writeRegistryEntry(root, staleReg);
  const staleClaim = await claimMetroAlias(root, randomUUID());
  await backdateClaim(root, staleClaim);
  await mkdir(path.join(root, "instances", "dead1234"), { recursive: true });

  // Race two sweeps; force:true deletes must absorb the ENOENT.
  const [a, b] = await Promise.all([
    sweepMetrolStorage(root),
    sweepMetrolStorage(root),
  ]);

  const allReg = new Set([...a.registry, ...b.registry]);
  const allClaims = new Set([...a.claims, ...b.claims]);
  const allInst = new Set([...a.instances, ...b.instances]);
  assert.deepEqual(allReg, new Set([staleReg.instanceId]));
  assert.deepEqual(allClaims, new Set([staleClaim]));
  assert.deepEqual(allInst, new Set(["dead1234"]));
});

test("sweepMetrolStorage on an empty rootDir returns an empty result", async (t) => {
  const root = await withTempRoot(t);
  const result = await sweepMetrolStorage(root);
  assert.deepEqual(result, { registry: [], claims: [], instances: [], leases: [] });
});

// --- Lease sweep integration ----------------------------------------------
//
// These tests write lease fixtures directly to the filesystem (same pattern
// as the instance-dir tests) so the sweep is exercised end-to-end without
// depending on the lease acquisition helpers.

async function writeLease(
  rootDir: string,
  leaseId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.join(rootDir, "leases", leaseId), { recursive: true });
  await writeFile(
    path.join(rootDir, "leases", leaseId, "owner.json"),
    JSON.stringify(payload),
  );
}

test("integration: sweep removes a stale lease whose owner is not in the live set", async (t) => {
  const root = await withTempRoot(t);
  const staleLeaseId = randomUUID();
  const deadOwner = randomUUID();
  await writeLease(root, staleLeaseId, {
    leaseId: staleLeaseId,
    instanceId: deadOwner,
    claimedAt: Date.now() - 60_000,
    expiresAt: Date.now() + 60_000,
    ttlMs: 120_000,
  });

  const result = await sweepMetrolStorage(root);
  assert.deepEqual(result.leases, [staleLeaseId]);
  // No other invariants disturbed.
  assert.deepEqual(result.registry, []);
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.instances, []);

  // The stale lease is gone from disk.
  assert.deepEqual(await readdir(path.join(root, "leases")), []);
});

test("integration: sweep keeps a lease whose owner is in the live set", async (t) => {
  const root = await withTempRoot(t);
  const liveInst = randomUUID();
  // Live registry entry → owner is in liveIds.
  await writeRegistryEntry(root, makeEntry({ instanceId: liveInst }));

  const liveLeaseId = randomUUID();
  await writeLease(root, liveLeaseId, {
    leaseId: liveLeaseId,
    instanceId: liveInst,
    claimedAt: Date.now() - 60_000,
    expiresAt: Date.now() + 60_000,
    ttlMs: 120_000,
  });

  const result = await sweepMetrolStorage(root);
  assert.deepEqual(result.leases, []);

  const left = (await readdir(path.join(root, "leases"))).filter(
    (f) => !f.startsWith(".tmp-"),
  );
  assert.deepEqual(left, [liveLeaseId]);
});

test("integration: sweep removes stale leases and live leases in one call, alongside the other sweeps", async (t) => {
  const root = await withTempRoot(t);

  // Stale registry, stale claim, stale instance dir (mirrors the sibling
  // integration test — same shape, now with leases mixed in).
  const staleReg = makeEntry({
    pid: 99999999,
    lastHeartbeat: Date.now() - STALE_THRESHOLD_MS - 1000,
  });
  await writeRegistryEntry(root, staleReg);
  const staleClaim = await claimMetroAlias(root, randomUUID());
  await backdateClaim(root, staleClaim);
  const staleInst = randomUUID();
  await mkdir(path.join(root, "instances", staleInst, "inbox"), {
    recursive: true,
  });
  await writeFile(
    path.join(root, "instances", staleInst, "inbox", "1-a.json"),
    "{}",
  );

  // Stale lease: owner not in live set.
  const staleLeaseId = randomUUID();
  await writeLease(root, staleLeaseId, {
    leaseId: staleLeaseId,
    instanceId: randomUUID(),
    claimedAt: Date.now() - 60_000,
    expiresAt: Date.now() + 60_000,
    ttlMs: 120_000,
  });

  // Live registry entry keeps the live-side fixtures alive.
  const liveInst = randomUUID();
  await writeRegistryEntry(root, makeEntry({ instanceId: liveInst }));
  const liveLeaseId = randomUUID();
  await writeLease(root, liveLeaseId, {
    leaseId: liveLeaseId,
    instanceId: liveInst,
    claimedAt: Date.now() - 60_000,
    expiresAt: Date.now() + 60_000,
    ttlMs: 120_000,
  });

  const result = await sweepMetrolStorage(root);
  assert.deepEqual(result.registry, [staleReg.instanceId]);
  assert.deepEqual(result.claims, [staleClaim]);
  assert.deepEqual(result.instances, [staleInst]);
  assert.deepEqual(result.leases, [staleLeaseId]);

  // Stale lease is gone; live lease is still on disk.
  const leasesLeft = (await readdir(path.join(root, "leases"))).filter(
    (f) => !f.startsWith(".tmp-"),
  );
  assert.deepEqual(leasesLeft, [liveLeaseId]);
});

test("sweepMetrolStorage on a rootDir with only a leases directory (no registry) still sweeps leases", async (t) => {
  // Mirror of the empty-rootDir test, but with a stale lease present.
  const root = await withTempRoot(t);
  const staleLeaseId = randomUUID();
  await writeLease(root, staleLeaseId, {
    leaseId: staleLeaseId,
    instanceId: randomUUID(),
    claimedAt: Date.now() - 60_000,
    expiresAt: Date.now() + 60_000,
    ttlMs: 120_000,
  });

  const result = await sweepMetrolStorage(root);
  assert.deepEqual(result.registry, []);
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.instances, []);
  assert.deepEqual(result.leases, [staleLeaseId]);
});
