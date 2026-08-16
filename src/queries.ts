import { randomUUID } from "node:crypto";
import { readRegistry, type RegistryEntry } from "./registry.ts";
import type { Scope } from "./list.ts";
import {
  safeInboxDir,
  resolveTarget,
  writeMessage,
  type Message,
} from "./transport.ts";
import type { InboxDispatcher } from "./dispatcher.ts";

export const QUERY_KINDS = ["status", "last_assistant_text"] as const;
export type QueryKind = (typeof QUERY_KINDS)[number];

/** Receiver-side state captured at query time; built from pi ctx in index.ts. */
export interface QuerySnapshot {
  metroName: string;
  sessionName?: string;
  cwd: string;
  projectRoot: string;
  model?: string;
  thinkingLevel?: string;
  state: "idle" | "running";
  /** Current context usage from ctx.getContextUsage() — NOT total session cost. */
  contextUsage?: unknown;
  lastActivity: number;
  /** Active-branch session entries; only used by last_assistant_text. */
  branch?: unknown[];
}

export type QueryResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

function lastAssistantText(branch: unknown[]): string | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i] as {
      type?: string;
      message?: { role?: string; content?: unknown };
    };
    if (e?.type !== "message" || e.message?.role !== "assistant") continue;
    const c = e.message.content;
    const text =
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c
              .filter((b) => b?.type === "text")
              .map((b) => b.text as string)
              .join("\n")
          : "";
    return text || null;
  }
  return null;
}

/** Answer a fixed query locally, without an LLM turn. */
export function answerQuery(kind: string, snap: QuerySnapshot): QueryResult {
  if (kind === "status") {
    const { branch: _omit, ...status } = snap;
    return { ok: true, value: status };
  }
  if (kind === "last_assistant_text") {
    return { ok: true, value: { text: lastAssistantText(snap.branch ?? []) } };
  }
  return { ok: false, error: `unsupported query kind "${kind}"` };
}

function senderRef(entry: RegistryEntry) {
  return {
    instanceId: entry.instanceId,
    metroName: entry.metroName,
    sessionName: entry.sessionName,
  };
}

export interface QueryReply {
  id: string;
  error: string | null;
  /** Reply payload: { kind, value } on success, { kind, error } on receiver failure. */
  value?: unknown;
}

/**
 * Resolve the target, register the pending correlation BEFORE writing the
 * query (so an immediate reply cannot be lost), then wait only for the
 * correlated reply routed by the dispatcher.
 */
export async function runQuery(
  rootDir: string,
  dispatcher: InboxDispatcher,
  callerEntry: RegistryEntry,
  target: string,
  kind: string,
  scope: Scope = "project",
  timeoutMs = 10_000,
): Promise<QueryReply> {
  if (!(QUERY_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`metrol: unsupported query kind "${kind}"`);
  }
  const r = resolveTarget(await readRegistry(rootDir), target, callerEntry, scope);
  if (!r.ok) throw new Error(`metrol: ${r.error}`);
  const msg: Message = {
    version: 1,
    id: randomUUID(),
    type: "query",
    from: senderRef(callerEntry),
    toInstanceId: r.target.instanceId,
    payload: { kind },
    timestamp: Date.now(),
  };
  const waiting = dispatcher.awaitReply(msg.id, timeoutMs);
  const w = await writeMessage(await safeInboxDir(rootDir, r.target.instanceId), msg);
  if (!w.ok) throw new Error(`metrol: ${w.error}`);
  const reply = await waiting;
  return { id: msg.id, error: reply.error, value: reply.value };
}

/** Receiver side: answer locally and write a correlated reply to the requester. */
export async function handleQuery(
  rootDir: string,
  selfEntry: RegistryEntry,
  msg: Message,
  snap: QuerySnapshot,
): Promise<void> {
  const kind = (msg.payload as { kind?: unknown })?.kind;
  const result = answerQuery(typeof kind === "string" ? kind : "", snap);
  const reply: Message = {
    version: 1,
    id: randomUUID(),
    type: "reply",
    correlationId: msg.id,
    from: senderRef(selfEntry),
    toInstanceId: msg.from.instanceId,
    payload: result.ok
      ? { kind, value: result.value }
      : { kind, error: result.error },
    timestamp: Date.now(),
  };
  await writeMessage(await safeInboxDir(rootDir, msg.from.instanceId), reply);
}
