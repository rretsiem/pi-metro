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

/** Target inbox path; created if missing. */
export async function inboxDir(
  rootDir: string,
  instanceId: string,
): Promise<string> {
  const dir = path.join(rootDir, "instances", instanceId, "inbox");
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
