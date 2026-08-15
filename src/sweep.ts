import {
  cleanupStaleInstanceDirs,
  readRegistry,
  sweepStaleRegistryFiles,
} from "./registry.ts";
import { staleClaimsCleanup } from "./identity.ts";

/** How often a running session sweeps stale storage. */
export const STORAGE_SWEEP_INTERVAL_MS = 5 * 60_000;

export interface SweepResult {
  registry: string[];
  claims: string[];
  instances: string[];
}

/**
 * Compose stale-storage sweeps across registry files, alias claims, and
 * instance directories. A single `readRegistry()` snapshot drives the
 * live-instance-id set used by the claim and instance-dir sweeps; the
 * registry-file sweep uses its own (identical) staleness test so a live
 * PID with a fresh heartbeat is never a deletion candidate.
 *
 * Touches ONLY `<rootDir>/registry`, `<rootDir>/claims`, and
 * `<rootDir>/instances` — never anything above `rootDir` (e.g. session
 * JSONL files). Every delete uses `force: true`, so concurrent sweeps
 * across sessions are race-free.
 */
export async function sweepMetrolStorage(
  rootDir: string,
): Promise<SweepResult> {
  const live = await readRegistry(rootDir);
  const liveIds = new Set(live.map((e) => e.instanceId));
  const [registry, claims, instances] = await Promise.all([
    sweepStaleRegistryFiles(rootDir),
    staleClaimsCleanup(rootDir, liveIds),
    cleanupStaleInstanceDirs(rootDir, liveIds),
  ]);
  return { registry, claims, instances };
}
