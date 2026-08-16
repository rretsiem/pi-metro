import {
  cleanupStaleInstanceDirs,
  readRegistry,
  sweepStaleRegistryFiles,
} from "./registry.ts";
import { staleClaimsCleanup } from "./identity.ts";
import { sweepExpiredLeases } from "./leases.ts";

/** How often a running session sweeps stale storage. */
export const STORAGE_SWEEP_INTERVAL_MS = 5 * 60_000;

/** Env var: when truthy ("1" / "true"), skip both the immediate and the
 * periodic storage sweeps. Useful for test isolation (the periodic sweep
 * can race tests) and for power users who want to opt out of the auto
 * cleanup. Read once and memoized — process.env mutations after the first
 * call do not flip the cached decision. */
export const METROL_DISABLE_SWEEP_ENV = "METROL_DISABLE_SWEEP";

let sweepDisabledCache: boolean | undefined;

function truthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Resolve once whether storage sweeps are disabled in this process.
 * The first call captures `process.env.METROL_DISABLE_SWEEP`; subsequent
 * calls return the same answer regardless of later mutations, so a session
 * behaves consistently even if something else touches the env mid-run.
 */
export function isSweepDisabled(): boolean {
  if (sweepDisabledCache !== undefined) return sweepDisabledCache;
  sweepDisabledCache = truthyEnv(process.env[METROL_DISABLE_SWEEP_ENV]);
  return sweepDisabledCache;
}

/** Test-only: forget the memoized env decision so a test can flip the
 * env var and re-query. Production code never calls this. */
export function __resetSweepDisabledForTests(): void {
  sweepDisabledCache = undefined;
}

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
