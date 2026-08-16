import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  STALE_THRESHOLD_MS,
  pidAlive,
  type RegistryEntry,
} from "./registry.ts";
import type { CallerRef, Scope } from "./list.ts";

export const MAX_PAYLOAD_BYTES = 64 * 1024;
export const MESSAGE_TYPES = [
  "chat",
  "query",
  "ask",
  "reply",
  "ack",
  "progress",
  "fail",
  "trigger",
  "compactReq",
  "compactRes",
  "cancel",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface MessageFrom {
  instanceId: string;
  metroName: string;
  sessionName?: string;
}

export interface Message {
  version: 1;
  id: string;
  type: MessageType;
  correlationId?: string;
  from: MessageFrom;
  toInstanceId: string;
  payload: unknown;
  timestamp: number;
}

export type Result<T extends object = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string };

/** Strict instanceId shape: hex string 8–64 chars, with optional hyphen
 * separators (full UUID v4 layout). Covers bare 8-hex prefixes (the
 * registry's short-id form) and full UUID v4 (with or without hyphens).
 * Used to gate every path-segment that ends up in `path.join` so peer-supplied
 * `instanceId` (in `from.instanceId`, in registry entries, in `toInstanceId`)
 * cannot escape `~/.pi/agent/metrol/` via `../`-style traversal. */
export const INSTANCE_ID_PATTERN = /^[0-9a-fA-F]{8,64}$/;
export const INSTANCE_ID_PATTERN_UUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

export function validateInstanceId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (id.length < 8 || id.length > 64) return false;
  return INSTANCE_ID_PATTERN.test(id) || INSTANCE_ID_PATTERN_UUID.test(id);
}

/** Verify the resolved path is inside `rootDir`. Returns the resolved path
 * on success, or null on escape. Defense-in-depth for path traversal: even
 * if a future regex relaxation let a slash-bearing `instanceId` through,
 * `path.resolve` + a prefix check would still refuse it. */
export function pathInsideRoot(
  rootDir: string,
  ...segments: string[]
): string | null {
  const resolved = path.resolve(rootDir, ...segments);
  const root = path.resolve(rootDir);
  if (resolved === root) return resolved;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return resolved.startsWith(prefix) ? resolved : null;
}

/** Target inbox path; created if missing. Rejects any `instanceId` that
 * would escape the metrol root via path traversal. Returns null on
 * refusal; callers must handle the null case as a write-don't-resolve
 * outcome (treat the same as "unknown target"). */
export async function inboxDir(
  rootDir: string,
  instanceId: string,
): Promise<string | null> {
  if (!validateInstanceId(instanceId)) return null;
  const dir = pathInsideRoot(rootDir, "instances", instanceId, "inbox");
  if (dir === null) return null;
  await mkdir(dir, { recursive: true });
  return dir;
}

export function validateMessage(msg: Message): Result {
  if (msg.version !== 1) {
    return { ok: false, error: `unsupported version ${msg.version}` };
  }
  if (!(MESSAGE_TYPES as readonly string[]).includes(msg.type)) {
    return { ok: false, error: `unknown type "${msg.type}"` };
  }
  // Trust boundary: every peer-supplied `instanceId` is shape-checked before
  // it can reach a path-join or a registry read. The regex matches either a
  // bare 8+ hex prefix or a full UUID v4, which is what the bus uses. Slash
  // chars, NULs, "..", and anything else is rejected here.
  if (
    !validateInstanceId(msg.from?.instanceId) ||
    !validateInstanceId(msg.toInstanceId)
  ) {
    return { ok: false, error: "invalid instanceId" };
  }
  const bytes = Buffer.byteLength(JSON.stringify(msg.payload ?? null));
  if (bytes > MAX_PAYLOAD_BYTES) {
    return { ok: false, error: `payload ${bytes}B exceeds 64 KiB limit` };
  }
  return { ok: true };
}

/** Atomic write: validate, same-dir temp file, rename. Invalid messages write nothing. */
export async function writeMessage(
  dir: string,
  msg: Message,
): Promise<Result<{ file: string }>> {
  const v = validateMessage(msg);
  if (!v.ok) return v;
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${randomUUID()}.json`);
  await writeFile(tmp, JSON.stringify(msg));
  const file = `${msg.timestamp}-${msg.id}.json`;
  await rename(tmp, path.join(dir, file));
  return { ok: true, file };
}

/** Resolve the target's inbox directory, throwing a clear error if the
 * resolved path is rejected (malformed instanceId or root-escape). Use
 * this at every outbound write site so a future call without the
 * `inboxDir` validation can't silently no-op. */
export async function safeInboxDir(
  rootDir: string,
  instanceId: string,
): Promise<string> {
  const dir = await inboxDir(rootDir, instanceId);
  if (dir === null) {
    throw new Error(
      `metrol: refusing to write to inbox with invalid instanceId: ${instanceId}`,
    );
  }
  return dir;
}

export async function readMessage(filePath: string): Promise<Result<{ msg: Message }>> {
  try {
    const msg = JSON.parse(await readFile(filePath, "utf8")) as Message;
    const v = validateMessage(msg);
    if (!v.ok) return v;
    return { ok: true, msg };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Resolve a metroName or instanceId against live registry entries.
 * Rejects missing, stale/dead, ambiguous, and cross-scope targets.
 */
export function resolveTarget(
  entries: RegistryEntry[],
  target: string,
  caller: CallerRef,
  scope: Scope = "project",
): Result<{ target: RegistryEntry }> {
  const now = Date.now();
  const live = entries.filter(
    (e) =>
      e.instanceId !== caller.instanceId &&
      now - e.lastHeartbeat <= STALE_THRESHOLD_MS &&
      pidAlive(e.pid),
  );
  const hits = live.filter(
    (e) =>
      (e.metroName === target || e.instanceId === target) &&
      (scope === "all" ||
        (scope === "cwd"
          ? e.cwd === caller.cwd
          : e.projectRoot === caller.projectRoot)),
  );
  if (hits.length === 0) {
    return { ok: false, error: `target "${target}" not found (scope ${scope})` };
  }
  if (hits.length > 1) {
    return { ok: false, error: `target "${target}" is ambiguous` };
  }
  return { ok: true, target: hits[0] };
}
