import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { pathInsideRoot, validateInstanceId } from "./transport.ts";

/** Default lease duration. Renewals can extend it; the sweep removes the
 *  lease once `expiresAt` has passed. */
export const DEFAULT_LEASE_TTL_MS = 30_000;

/** Grace window after a claim: protects a holder that just acquired a
 *  lease but hasn't yet appeared in the live registry from having its
 *  lease swept out from under it. Mirrors `CLAIM_SWEEP_GRACE_MS` in
 *  identity.ts. */
export const LEASE_SWEEP_GRACE_MS = 15_000;

/** Lease name shape: alphanumerics, dot, dash, underscore. Prevents path
 *  traversal and slashes. Defense in depth — `pathInsideRoot` would still
 *  refuse an escaped path. */
export const LEASE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export function validateLeaseName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (name.length === 0 || name.length > 200) return false;
  return LEASE_NAME_PATTERN.test(name);
}

/** Stable resource key for a canonical absolute file path. */
export function leaseNameForPath(filePath: string): string {
  return createHash("sha256").update(path.resolve(filePath)).digest("hex");
}

/** Lease ownership record. `claimedAt` is the original claim time (used
 *  for grace-period protection); `expiresAt` is when the lease expires
 *  (refreshed on renew); `ttlMs` is the lease duration. */
export interface LeaseOwner {
  instanceId: string;
  claimedAt: number;
  expiresAt: number;
  ttlMs: number;
}

function leasesDir(rootDir: string) {
  return path.join(rootDir, "leases");
}

/** Resolve a lease directory path with shape and root-escape checks.
 *  Returns null if the name is malformed or the resolved path would
 *  escape the metrol root. */
function leaseDir(rootDir: string, name: string): string | null {
  if (!validateLeaseName(name)) return null;
  return pathInsideRoot(rootDir, "leases", name);
}

async function readOwner(dir: string): Promise<LeaseOwner | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

async function writeOwner(dir: string, owner: LeaseOwner): Promise<void> {
  const tmp = path.join(dir, `.tmp-${randomUUID()}.json`);
  await writeFile(tmp, JSON.stringify(owner));
  await rename(tmp, path.join(dir, "owner.json"));
}

/** Try to claim a named lease. Atomic mkdir under `<rootDir>/leases/<name>`.
 *  Returns true on a fresh claim or a same-owner reentry (which refreshes
 *  the expiry). Returns false if the lease is held by a different
 *  instance — a future sweep will remove it once expired or once the
 *  holder leaves the live set past the grace period. Throws on invalid
 *  input or filesystem errors. */
export async function claimLease(
  rootDir: string,
  name: string,
  instanceId: string,
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
): Promise<boolean> {
  const dir = leaseDir(rootDir, name);
  if (!dir) throw new Error(`metrol: refusing to claim invalid lease name: ${name}`);
  if (!validateInstanceId(instanceId)) {
    throw new Error(`metrol: refusing to claim lease with invalid instanceId: ${instanceId}`);
  }
  await mkdir(leasesDir(rootDir), { recursive: true });
  const now = Date.now();
  try {
    await mkdir(dir); // non-recursive: atomic, EEXIST = taken
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const owner = await readOwner(dir);
    if (owner?.instanceId === instanceId) {
      // Same-owner reentry: refresh expiry (and ttl).
      const renewed: LeaseOwner = { ...owner, expiresAt: now + ttlMs, ttlMs };
      await writeOwner(dir, renewed);
      return true;
    }
    if (!owner || owner.expiresAt <= now) {
      await rm(dir, { recursive: true, force: true });
      return claimLease(rootDir, name, instanceId, ttlMs);
    }
    return false;
  }
  const owner: LeaseOwner = {
    instanceId,
    claimedAt: now,
    expiresAt: now + ttlMs,
    ttlMs,
  };
  try {
    await writeOwner(dir, owner);
  } catch (err) {
    await rm(dir, { recursive: true, force: true }); // release failed claim
    throw err;
  }
  return true;
}

/** Read the current lease owner. Returns null if no lease exists or the
 *  name is malformed. */
export async function readLease(
  rootDir: string,
  name: string,
): Promise<LeaseOwner | null> {
  const dir = leaseDir(rootDir, name);
  if (!dir) return null;
  return readOwner(dir);
}

/** Renew a lease (owner-only). Returns false if the lease does not exist
 *  or is held by a different instance. `ttlMs` defaults to the lease's
 *  original ttl; pass a different value to change the TTL on renew. */
export async function renewLease(
  rootDir: string,
  name: string,
  instanceId: string,
  ttlMs?: number,
): Promise<boolean> {
  const dir = leaseDir(rootDir, name);
  if (!dir) return false;
  const owner = await readOwner(dir);
  if (owner?.instanceId !== instanceId) return false;
  const newTtl = ttlMs ?? owner.ttlMs;
  const renewed: LeaseOwner = { ...owner, expiresAt: Date.now() + newTtl, ttlMs: newTtl };
  await writeOwner(dir, renewed);
  return true;
}

/** Release a lease (owner-only). Returns false if the lease does not exist
 *  or is held by a different instance. */
export async function releaseLease(
  rootDir: string,
  name: string,
  instanceId: string,
): Promise<boolean> {
  const dir = leaseDir(rootDir, name);
  if (!dir) return false;
  const owner = await readOwner(dir);
  if (owner?.instanceId !== instanceId) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

/** Remove leases that have expired, or whose owner is not in the live set
 *  and whose claim is past the grace period. Symlinks are never followed
 *  (defense in depth — same-user trust model documented in SECURITY.md).
 *  Returns the names of removed leases. Every `rm` uses `force: true`, so
 *  concurrent sweeps never throw on already-deleted files. */
export async function sweepExpiredLeases(
  rootDir: string,
  validInstanceIds: Set<string>,
  now: number = Date.now(),
): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(leasesDir(rootDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    // Skip non-directories (symlinks, files, sockets) — symlink-safe.
    if (!entry.isDirectory()) continue;
    if (entry.isSymbolicLink()) continue;
    if (!validateLeaseName(entry.name)) continue;
    const target = pathInsideRoot(rootDir, "leases", entry.name);
    if (!target) continue;
    const owner = await readOwner(target);
    if (!owner) {
      // Corrupt lease (no owner.json): treat as stale.
      await rm(target, { recursive: true, force: true });
      removed.push(entry.name);
      continue;
    }
    // Expired: always safe to remove.
    if (owner.expiresAt < now) {
      await rm(target, { recursive: true, force: true });
      removed.push(entry.name);
      continue;
    }
    // Owner not in valid set, past grace period.
    if (validInstanceIds.has(owner.instanceId)) continue;
    if (now - owner.claimedAt < LEASE_SWEEP_GRACE_MS) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
