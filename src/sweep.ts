import {
  cleanupStaleInstanceDirs,
  readRegistry,
  sweepStaleRegistryFiles,
} from "./registry.ts";
import { staleClaimsCleanup } from "./identity.ts";
import { sweepExpiredLeases } from "./leases.ts";

/** How often a running session sweeps stale storage. */
export const STORAGE_SWEEP_INTERVAL_MS = 5 * 60_000;

export interface SweepResult {
  registry: string[];
  claims: string[];
  instances: string[];
  leases: string[];
}

/**
 * Compose stale-storage sweeps across registry files, alias claims,
 * instance directories, and leases. A single `readRegistry()` snapshot
 * drives the live-instance-id set used by the claim, instance-dir, and
 * lease sweeps; the registry-file sweep uses its own (identical)
 * staleness test so a live PID with a fresh heartbeat is never a
 * deletion candidate.
 *
 * Touches ONLY `<rootDir>/registry`, `<rootDir>/claims`,
 * `<rootDir>/instances`, and `<rootDir>/leases` — never anything above
 * `rootDir` (e.g. session JSONL files). Every delete uses `force: true`,
 * so concurrent sweeps across sessions are race-free.
 */
export async function sweepMetrolStorage(
  rootDir: string,
): Promise<SweepResult> {
  const live = await readRegistry(rootDir);
  const liveIds = new Set(live.map((e) => e.instanceId));
  const [registry, claims, instances, leases] = await Promise.all([
    sweepStaleRegistryFiles(rootDir),
    staleClaimsCleanup(rootDir, liveIds),
    cleanupStaleInstanceDirs(rootDir, liveIds),
    sweepExpiredLeases(rootDir, liveIds),
  ]);
  return { registry, claims, instances, leases };
}
