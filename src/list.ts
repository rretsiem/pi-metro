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
  stateSince?: number;
  activeToolName?: string;
  contextUsage?: { tokens: number; contextWindow: number };
  lastActivity?: number;
  parentInstanceId?: string;
}

/** Visibility filters on top of scope. Both false = no filtering. */
export interface ListFilter {
  /** Keep only sessions with no parentInstanceId (foreground). */
  foregroundOnly?: boolean;
  /** Keep only sessions that have a parentInstanceId (subagents). */
  subagentsOnly?: boolean;
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
    stateSince: e.stateSince,
    activeToolName: e.activeToolName,
    contextUsage: e.contextUsage,
    lastActivity: e.lastActivity,
    parentInstanceId: e.parentInstanceId,
  };
}

/**
 * Live sessions visible to `caller`, always excluding the caller.
 * Sorted by rank (same cwd, same project, rest); Array.sort is stable,
 * so relative order within a rank is preserved. `filter` applies on top
 * of `scope` and is mutually exclusive (`foregroundOnly` wins).
 */
export async function listSessions(
  rootDir: string,
  caller: CallerRef,
  scope: Scope = "project",
  filter: ListFilter = {},
): Promise<SessionInfo[]> {
  const entries = await readRegistry(rootDir);
  const visible = entries.filter(
    (e) =>
      e.instanceId !== caller.instanceId &&
      (scope === "all" ||
        (scope === "cwd" ? e.cwd === caller.cwd : e.projectRoot === caller.projectRoot)) &&
      (filter.foregroundOnly ? !e.parentInstanceId : true) &&
      (filter.subagentsOnly && !filter.foregroundOnly ? !!e.parentInstanceId : true),
  );
  return visible
    .sort((a, b) => rank(a, caller) - rank(b, caller))
    .map(toSessionInfo);
}
