import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const HEARTBEAT_INTERVAL_MS = 10_000;
export const STALE_THRESHOLD_MS = 30_000;

export interface RegistryEntry {
  version: 1;
  instanceId: string;
  sessionId?: string;
  metroName: string;
  sessionName?: string;
  cwd: string;
  projectRoot: string;
  pid: number;
  model?: string;
  state: "idle" | "running";
  startedAt: number;
  lastHeartbeat: number;
  /** Epoch ms when state last transitioned; absent on legacy entries. */
  stateSince?: number;
  /** Tool currently executing; absent when no tool is running or for legacy entries. */
  activeToolName?: string;
  /** Current context usage (tokens / contextWindow); absent when unknown or for legacy entries. */
  contextUsage?: { tokens: number; contextWindow: number };
  /** Epoch ms of the last user/agent activity event; absent on legacy entries. */
  lastActivity?: number;
  /** Instance ID of the spawning session (subagent convention). Absent for foreground sessions. */
  parentInstanceId?: string;
}

function registryDir(rootDir: string) {
  return path.join(rootDir, "registry");
}

function entryPath(rootDir: string, instanceId: string) {
  return path.join(registryDir(rootDir), `${instanceId}.json`);
}

/** ESRCH = dead, EPERM = alive (not ours, but running). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Atomic write: same-dir temp file + rename. */
export async function writeRegistryEntry(
  rootDir: string,
  entry: RegistryEntry,
): Promise<void> {
  await mkdir(registryDir(rootDir), { recursive: true });
  const tmp = path.join(registryDir(rootDir), `.tmp-${randomUUID()}.json`);
  await writeFile(tmp, JSON.stringify(entry));
  await rename(tmp, entryPath(rootDir, entry.instanceId));
}

/** Live entries only: fresh heartbeat AND alive PID. */
export async function readRegistry(rootDir: string): Promise<RegistryEntry[]> {
  let files: string[];
  try {
    files = await readdir(registryDir(rootDir));
  } catch {
    return [];
  }
  const now = Date.now();
  const live: RegistryEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file.startsWith(".tmp-")) continue;
    try {
      const entry: RegistryEntry = JSON.parse(
        await readFile(path.join(registryDir(rootDir), file), "utf8"),
      );
      if (now - entry.lastHeartbeat > STALE_THRESHOLD_MS) continue;
      if (!pidAlive(entry.pid)) continue;
      live.push(entry);
    } catch {
      // corrupt/unreadable entry: skip
    }
  }
  return live;
}

/** Read-modify-write with atomic rename. Throws if the entry does not exist. */
export async function updateRegistry(
  rootDir: string,
  instanceId: string,
  patch: Partial<RegistryEntry>,
): Promise<void> {
  const existing: RegistryEntry = JSON.parse(
    await readFile(entryPath(rootDir, instanceId), "utf8"),
  );
  await writeRegistryEntry(rootDir, { ...existing, ...patch, instanceId });
}

export async function removeRegistryEntry(
  rootDir: string,
  instanceId: string,
): Promise<void> {
  try {
    await rm(entryPath(rootDir, instanceId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Remove registry files whose PID is dead AND whose heartbeat is stale.
 * Bypasses `readRegistry()`'s filtering by reading each JSON file directly
 * and applying the same staleness test. A live PID with a fresh heartbeat
 * is never a deletion candidate. Returns the removed instance IDs. Every
 * `rm` uses `force: true`, so concurrent sweeps never throw on already-
 * deleted files.
 */
export async function sweepStaleRegistryFiles(
  rootDir: string,
): Promise<string[]> {
  const dir = registryDir(rootDir);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const now = Date.now();
  const removed: string[] = [];
  for (const file of files) {
    if (!file.endsWith(".json") || file.startsWith(".tmp-")) continue;
    const filePath = path.join(dir, file);
    let entry: RegistryEntry;
    try {
      entry = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
      // Corrupt/unreadable: skip — mirrors readRegistry's behavior.
      continue;
    }
    const stale = now - entry.lastHeartbeat > STALE_THRESHOLD_MS;
    const dead = !pidAlive(entry.pid);
    if (!stale || !dead) continue;
    await rm(filePath, { force: true });
    removed.push(entry.instanceId);
  }
  return removed;
}

/**
 * Remove instance directories (inboxes) with no live registry entry — left
 * behind by crashed or shut-down sessions. Only directories under
 * `instances/` whose name is not in liveInstanceIds are removed; files and
 * claims are never touched. Returns the removed instance IDs.
 */
export async function cleanupStaleInstanceDirs(
  rootDir: string,
  liveInstanceIds: Iterable<string>,
): Promise<string[]> {
  const dir = path.join(rootDir, "instances");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const live = new Set(liveInstanceIds);
  const removed: string[] = [];
  for (const name of names) {
    if (live.has(name)) continue;
    const st = await stat(path.join(dir, name)).catch(() => null);
    if (!st?.isDirectory()) continue;
    await rm(path.join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
