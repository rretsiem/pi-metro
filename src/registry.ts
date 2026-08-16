import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateInstanceId, pathInsideRoot } from "./transport.ts";

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

/** Resolve the registry entry path for a given instanceId, with shape and
 * root-escape checks. Returns null if the instanceId is malformed or the
 * resolved path escapes the metrol root. */
function entryPath(rootDir: string, instanceId: string): string | null {
  if (!validateInstanceId(instanceId)) return null;
  return pathInsideRoot(rootDir, "registry", `${instanceId}.json`);
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

/** Atomic write: same-dir temp file + rename. Throws on a malformed
 * instanceId or any path that would escape the metrol root. */
export async function writeRegistryEntry(
  rootDir: string,
  entry: RegistryEntry,
): Promise<void> {
  if (!validateInstanceId(entry.instanceId)) {
    throw new Error(`metrol: refusing to write registry entry with invalid instanceId: ${entry.instanceId}`);
  }
  await mkdir(registryDir(rootDir), { recursive: true });
  const tmp = pathInsideRoot(rootDir, "registry", `.tmp-${randomUUID()}.json`);
  if (!tmp) throw new Error("metrol: temp registry path escaped root");
  await writeFile(tmp, JSON.stringify(entry));
  const dest = entryPath(rootDir, entry.instanceId);
  if (!dest) throw new Error(`metrol: refusing to write registry entry with invalid instanceId: ${entry.instanceId}`);
  await rename(tmp, dest);
}

/** Live entries only: fresh heartbeat AND alive PID. Entries whose
 * instanceId doesn't match the bus shape are skipped (defense in depth —
 * the bus itself validates shapes on write; this catches a pre-existing
 * hand-edited file). */
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
    // The filename is the source of truth for the entry's instanceId — the
    // file's content also carries it, but we trust the path component.
    const entryId = file.slice(0, -".json".length);
    if (!validateInstanceId(entryId)) continue;
    try {
      const entry: RegistryEntry = JSON.parse(
        await readFile(path.join(registryDir(rootDir), file), "utf8"),
      );
      if (!validateInstanceId(entry.instanceId)) continue;
      if (now - entry.lastHeartbeat > STALE_THRESHOLD_MS) continue;
      if (!pidAlive(entry.pid)) continue;
      live.push(entry);
    } catch {
      // corrupt/unreadable entry: skip
    }
  }
  return live;
}

/** Read-modify-write with atomic rename. Throws if the entry does not exist
 * or its instanceId is malformed. */
export async function updateRegistry(
  rootDir: string,
  instanceId: string,
  patch: Partial<RegistryEntry>,
): Promise<void> {
  const dest = entryPath(rootDir, instanceId);
  if (!dest) throw new Error(`metrol: refusing to update registry entry with invalid instanceId: ${instanceId}`);
  const existing: RegistryEntry = JSON.parse(await readFile(dest, "utf8"));
  await writeRegistryEntry(rootDir, { ...existing, ...patch, instanceId });
}

export async function removeRegistryEntry(
  rootDir: string,
  instanceId: string,
): Promise<void> {
  const dest = entryPath(rootDir, instanceId);
  if (!dest) return; // malformed: nothing to remove
  try {
    await rm(dest);
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
 *
 * SECURITY: uses `lstat` (not `stat`) so symlinks are not followed into
 * arbitrary filesystem locations. A malicious or buggy local process that
 * drops a symlink at `instances/<id>` pointing to `/etc` or into a user's
 * project tree will not be `rm`'d here — the entry is skipped on
 * `isSymbolicLink()`. The same-user trust model is documented in
 * SECURITY.md; this is the defense-in-depth boundary for it.
 */
export async function cleanupStaleInstanceDirs(
  rootDir: string,
  liveInstanceIds: Iterable<string>,
): Promise<string[]> {
  const dir = pathInsideRoot(rootDir, "instances");
  if (!dir) return [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const live = new Set(liveInstanceIds);
  const removed: string[] = [];
  for (const entry of entries) {
    // Skip anything that isn't a real directory: symlinks, files, sockets.
    if (!entry.isDirectory()) continue;
    if (entry.isSymbolicLink()) continue;
    if (live.has(entry.name)) continue;
    if (!validateInstanceId(entry.name)) continue;
    const target = pathInsideRoot(rootDir, "instances", entry.name);
    if (!target) continue;
    await rm(target, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
