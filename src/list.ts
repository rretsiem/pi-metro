import { readRegistry, type RegistryEntry } from "./registry.ts";

export const SCOPES = ["cwd", "project", "all"] as const;
export type Scope = (typeof SCOPES)[number];

/** What listSessions needs to know about the calling session. */
export interface CallerRef {
  instanceId: string;
  cwd: string;
  projectRoot: string;
}

export interface SessionInfo {
  metroName: string;
  sessionName?: string;
  cwd: string;
  projectRoot: string;
  pid: number;
  model?: string;
  state: RegistryEntry["state"];
  lastHeartbeat: number;
  instanceId: string;
}

/** 0 = same cwd, 1 = same project, 2 = unrelated. */
function rank(entry: RegistryEntry, caller: CallerRef): number {
  if (entry.cwd === caller.cwd) return 0;
  if (entry.projectRoot === caller.projectRoot) return 1;
  return 2;
}

function toSessionInfo(e: RegistryEntry): SessionInfo {
  return {
    metroName: e.metroName,
    sessionName: e.sessionName,
    cwd: e.cwd,
    projectRoot: e.projectRoot,
    pid: e.pid,
    model: e.model,
    state: e.state,
    lastHeartbeat: e.lastHeartbeat,
    instanceId: e.instanceId,
  };
}

/**
 * Live sessions visible to `caller`, always excluding the caller.
 * Sorted by rank (same cwd, same project, rest); Array.sort is stable,
 * so relative order within a rank is preserved.
 */
export async function listSessions(
  rootDir: string,
  caller: CallerRef,
  scope: Scope = "project",
): Promise<SessionInfo[]> {
  const entries = await readRegistry(rootDir);
  const visible = entries.filter(
    (e) =>
      e.instanceId !== caller.instanceId &&
      (scope === "all" ||
        (scope === "cwd" ? e.cwd === caller.cwd : e.projectRoot === caller.projectRoot)),
  );
  return visible
    .sort((a, b) => rank(a, caller) - rank(b, caller))
    .map(toSessionInfo);
}
