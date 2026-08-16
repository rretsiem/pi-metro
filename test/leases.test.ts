import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_LEASE_TTL_MS,
  LEASE_NAME_PATTERN,
  LEASE_SWEEP_GRACE_MS,
  claimLease,
  leaseNameForPath,
  readLease,
  releaseLease,
  renewLease,
  sweepExpiredLeases,
  validateLeaseName,
  type LeaseOwner,
} from "../src/leases.ts";

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-lease-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function readOwnerFile(rootDir: string, name: string): Promise<LeaseOwner> {
  return JSON.parse(
    await readFile(path.join(rootDir, "leases", name, "owner.json"), "utf8"),
  );
}

async function backdateClaim(rootDir: string, name: string, ageMs: number): Promise<void> {
  const file = path.join(rootDir, "leases", name, "owner.json");
  const owner = JSON.parse(await readFile(file, "utf8"));
  owner.claimedAt = Date.now() - ageMs;
  await writeFile(file, JSON.stringify(owner));
}

async function backdateExpiry(rootDir: string, name: string, ageMs: number): Promise<void> {
  const file = path.join(rootDir, "leases", name, "owner.json");
  const owner = JSON.parse(await readFile(file, "utf8"));
  owner.expiresAt = Date.now() - ageMs;
  await writeFile(file, JSON.stringify(owner));
}

test("claimLease on a fresh name succeeds and writes owner.json", async (t) => {
  const root = await withTempRoot(t);
  const id = randomUUID();
  assert.equal(await claimLease(root, "foo", id), true);
  const owner = await readOwnerFile(root, "foo");
  assert.equal(owner.instanceId, id);
  assert.ok(owner.claimedAt > 0);
  assert.equal(owner.expiresAt - owner.claimedAt, DEFAULT_LEASE_TTL_MS);
  assert.equal(owner.ttlMs, DEFAULT_LEASE_TTL_MS);
  // Lease directory layout: <root>/leases/<name>/owner.json
  assert.deepEqual(await readdir(path.join(root, "leases", "foo")), ["owner.json"]);
});

test("claimLease auto-creates the leases dir", async (t) => {
  const root = await withTempRoot(t);
  // Don't pre-create <root>/leases; claimLease must create it.
  assert.equal(await claimLease(root, "foo", randomUUID()), true);
  assert.ok((await readdir(path.join(root, "leases"))).includes("foo"));
});

test("claimLease reclaims an expired lease without waiting for a sweep", async (t) => {
  const root = await withTempRoot(t);
  const first = randomUUID();
  const second = randomUUID();
  assert.equal(await claimLease(root, "expired", first, 1), true);
  await backdateExpiry(root, "expired", 1_000);
  assert.equal(await claimLease(root, "expired", second), true);
  assert.equal((await readLease(root, "expired"))?.instanceId, second);
});

test("claimLease reclaims a corrupt lease directory", async (t) => {
  const root = await withTempRoot(t);
  await mkdir(path.join(root, "leases", "corrupt"), { recursive: true });
  assert.equal(await claimLease(root, "corrupt", randomUUID()), true);
});

test("claimLease by a different instance returns false and the original holder is preserved", async (t) => {
  const root = await withTempRoot(t);
  const a = randomUUID();
  const b = randomUUID();
  await claimLease(root, "foo", a);
  assert.equal(await claimLease(root, "foo", b), false);
  const owner = await readLease(root, "foo");
  assert.equal(owner?.instanceId, a);
});

test("claimLease by the same instance is a reentry: refreshes expiry, preserves claimedAt", async (t) => {
  const root = await withTempRoot(t);
  const id = randomUUID();
  await claimLease(root, "foo", id, 1000);
  const before = await readLease(root, "foo");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await claimLease(root, "foo", id, 5000), true);
  const after = await readLease(root, "foo");
  assert.ok(before && after);
  // ExpiresAt was pushed out; original claimedAt preserved; ttl updated.
  assert.ok(after.expiresAt > before.expiresAt);
  assert.equal(after.claimedAt, before.claimedAt);
  assert.equal(after.ttlMs, 5000);
});

test("readLease returns null when no lease exists", async (t) => {
  const root = await withTempRoot(t);
  assert.equal(await readLease(root, "missing"), null);
});

test("readLease returns null for malformed names (path validation)", async (t) => {
  const root = await withTempRoot(t);
  assert.equal(await readLease(root, ""), null);
  assert.equal(await readLease(root, "../etc"), null);
  assert.equal(await readLease(root, "with/slash"), null);
  assert.equal(await readLease(root, "with space"), null);
  assert.equal(await readLease(root, null as unknown as string), null);
});

test("renewLease extends the expiry without changing ttl", async (t) => {
  const root = await withTempRoot(t);
  const id = randomUUID();
  await claimLease(root, "foo", id, 1000);
  const before = await readLease(root, "foo");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await renewLease(root, "foo", id), true);
  const after = await readLease(root, "foo");
  assert.ok(before && after);
  assert.ok(after.expiresAt > before.expiresAt);
  assert.equal(after.ttlMs, before.ttlMs);
  assert.equal(after.claimedAt, before.claimedAt);
});

test("renewLease can change the TTL when one is passed", async (t) => {
  const root = await withTempRoot(t);
  const id = randomUUID();
  await claimLease(root, "foo", id, 1000);
  assert.equal(await renewLease(root, "foo", id, 60_000), true);
  const after = await readLease(root, "foo");
  assert.equal(after?.ttlMs, 60_000);
});

test("renewLease by a non-owner returns false", async (t) => {
  const root = await withTempRoot(t);
  await claimLease(root, "foo", randomUUID());
  assert.equal(await renewLease(root, "foo", randomUUID()), false);
  assert.equal(await renewLease(root, "foo", ""), false);
});

test("renewLease of a missing lease returns false", async (t) => {
  const root = await withTempRoot(t);
  assert.equal(await renewLease(root, "missing", randomUUID()), false);
});

test("releaseLease by the owner returns true and removes the lease", async (t) => {
  const root = await withTempRoot(t);
  const id = randomUUID();
  await claimLease(root, "foo", id);
  assert.equal(await releaseLease(root, "foo", id), true);
  assert.equal(await readLease(root, "foo"), null);
  // After release, another instance can claim.
  assert.equal(await claimLease(root, "foo", randomUUID()), true);
});

test("releaseLease by a non-owner returns false and keeps the lease", async (t) => {
  const root = await withTempRoot(t);
  const id = randomUUID();
  await claimLease(root, "foo", id);
  assert.equal(await releaseLease(root, "foo", randomUUID()), false);
  assert.ok(await readLease(root, "foo"));
  assert.equal((await readLease(root, "foo"))?.instanceId, id);
});

test("releaseLease of a missing lease returns false", async (t) => {
  const root = await withTempRoot(t);
  assert.equal(await releaseLease(root, "missing", randomUUID()), false);
});

test("sweepExpiredLeases removes an expired lease regardless of live status", async (t) => {
  const root = await withTempRoot(t);
  await claimLease(root, "old", randomUUID(), 1000);
  await backdateExpiry(root, "old", 2000); // expired 1s ago
  // Holder is in the valid set — but expired leases are always removed.
  const removed = await sweepExpiredLeases(root, new Set([randomUUID()]));
  assert.deepEqual(removed, ["old"]);
});

test("sweepExpiredLeases keeps a fresh lease held by a live instance", async (t) => {
  const root = await withTempRoot(t);
  const id = randomUUID();
  await claimLease(root, "fresh", id, 60_000);
  const removed = await sweepExpiredLeases(root, new Set([id]));
  assert.deepEqual(removed, []);
  assert.ok(await readLease(root, "fresh"));
});

test("sweepExpiredLeases keeps a fresh lease held by a non-live instance WITHIN the grace period", async (t) => {
  const root = await withTempRoot(t);
  await claimLease(root, "fresh", randomUUID(), 60_000);
  // Holder is NOT in the valid set, but the claim is fresh.
  const removed = await sweepExpiredLeases(root, new Set());
  assert.deepEqual(removed, []);
  assert.ok(await readLease(root, "fresh"));
});

test("sweepExpiredLeases removes a lease held by a non-live instance past the grace period", async (t) => {
  const root = await withTempRoot(t);
  await claimLease(root, "abandoned", randomUUID(), 60_000);
  await backdateClaim(root, "abandoned", LEASE_SWEEP_GRACE_MS + 1000);
  const removed = await sweepExpiredLeases(root, new Set());
  assert.deepEqual(removed, ["abandoned"]);
});

test("sweepExpiredLeases keeps a lease held by a live instance even past grace", async (t) => {
  const root = await withTempRoot(t);
  const id = randomUUID();
  await claimLease(root, "live", id, 60_000);
  // Backdate well past grace — but owner IS live, so it must survive.
  await backdateClaim(root, "live", LEASE_SWEEP_GRACE_MS + 60_000);
  const removed = await sweepExpiredLeases(root, new Set([id]));
  assert.deepEqual(removed, []);
});

test("sweepExpiredLeases removes a corrupt lease (no owner.json)", async (t) => {
  const root = await withTempRoot(t);
  await mkdir(path.join(root, "leases", "corrupt"), { recursive: true });
  const removed = await sweepExpiredLeases(root, new Set());
  assert.deepEqual(removed, ["corrupt"]);
});

test("sweepExpiredLeases skips symlinks under leases/ (defense in depth)", async (t) => {
  const root = await withTempRoot(t);
  const target = await mkdtemp(path.join(tmpdir(), "metrol-lease-target-"));
  t.after(() => rm(target, { recursive: true, force: true }));
  await writeFile(path.join(target, "secret.txt"), "do not delete");
  await mkdir(path.join(root, "leases"), { recursive: true });
  await symlink(target, path.join(root, "leases", "evil"), "dir");
  const removed = await sweepExpiredLeases(root, new Set());
  assert.deepEqual(removed, []);
  assert.deepEqual(await readdir(target), ["secret.txt"]);
});

test("sweepExpiredLeases is a no-op when the leases dir is missing", async (t) => {
  const root = await withTempRoot(t);
  assert.deepEqual(await sweepExpiredLeases(root, new Set()), []);
});

test("sweepExpiredLeases is idempotent under repeated calls", async (t) => {
  const root = await withTempRoot(t);
  await claimLease(root, "old", randomUUID(), 1000);
  await backdateExpiry(root, "old", 2000);
  assert.deepEqual(await sweepExpiredLeases(root, new Set()), ["old"]);
  assert.deepEqual(await sweepExpiredLeases(root, new Set()), []);
});

test("claimLease throws on an invalid lease name", async (t) => {
  const root = await withTempRoot(t);
  await assert.rejects(() => claimLease(root, "", randomUUID()));
  await assert.rejects(() => claimLease(root, "../etc", randomUUID()));
  await assert.rejects(() => claimLease(root, "with/slash", randomUUID()));
  await assert.rejects(() => claimLease(root, "with space", randomUUID()));
});

test("claimLease throws on an invalid instanceId", async (t) => {
  const root = await withTempRoot(t);
  await assert.rejects(() => claimLease(root, "foo", "not-hex"));
  await assert.rejects(() => claimLease(root, "foo", "abc")); // too short
});

test("leaseNameForPath is stable and path-specific", () => {
  assert.equal(leaseNameForPath("/work/app/file.ts"), leaseNameForPath("/work/app/file.ts"));
  assert.notEqual(leaseNameForPath("/work/app/file.ts"), leaseNameForPath("/work/app/other.ts"));
  assert.match(leaseNameForPath("/work/app/file.ts"), /^[0-9a-f]{64}$/);
});

test("validateLeaseName accepts alphanumerics, dot, dash, underscore", () => {
  assert.equal(validateLeaseName("foo"), true);
  assert.equal(validateLeaseName("foo-bar"), true);
  assert.equal(validateLeaseName("foo_bar"), true);
  assert.equal(validateLeaseName("foo.bar"), true);
  assert.equal(validateLeaseName("Foo123"), true);
  assert.equal(validateLeaseName("a".repeat(200)), true);
});

test("validateLeaseName rejects empty, slashes, traversal, too-long, special chars, non-strings", () => {
  assert.equal(validateLeaseName(""), false);
  assert.equal(validateLeaseName("with/slash"), false);
  assert.equal(validateLeaseName("with\\backslash"), false);
  assert.equal(validateLeaseName("../traversal"), false);
  assert.equal(validateLeaseName("a/../b"), false);
  assert.equal(validateLeaseName("a".repeat(201)), false);
  assert.equal(validateLeaseName("with space"), false);
  assert.equal(validateLeaseName("with\0null"), false);
  assert.equal(validateLeaseName(null), false);
  assert.equal(validateLeaseName(undefined), false);
  assert.equal(validateLeaseName(123), false);
  assert.equal(validateLeaseName({}), false);
});

test("LEASE_NAME_PATTERN is the documented regex", () => {
  assert.deepEqual(LEASE_NAME_PATTERN, /^[A-Za-z0-9._-]+$/);
});

test("DEFAULT_LEASE_TTL_MS is 30s and LEASE_SWEEP_GRACE_MS is 15s", () => {
  assert.equal(DEFAULT_LEASE_TTL_MS, 30_000);
  assert.equal(LEASE_SWEEP_GRACE_MS, 15_000);
});
