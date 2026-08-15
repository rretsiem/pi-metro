import { randomUUID } from "node:crypto";
import { readRegistry, type RegistryEntry } from "./registry.ts";
import type { Scope } from "./list.ts";
import {
  inboxDir,
  resolveTarget,
  writeMessage,
  type Message,
  type MessageFrom,
} from "./transport.ts";
import type { InboxDispatcher } from "./dispatcher.ts";

export type AskState = "queued" | "accepted" | "running" | "answered" | "failed";

/** Persisted `metrol:request` entry; also used by fixed queries (kind set). */
export interface RequestRecord {
  requestId: string;
  target: string;
  status: AskState;
  kind?: string;
  question?: string;
  reply?: unknown;
  error?: string;
  updatedAt: number;
}

export type AskOutcome =
  | { status: "answered"; reply: string }
  | { status: "failed"; error: string };

/** Invisible-to-the-model anchor: the injected user message carries it. */
export const askMarker = (requestId: string) => `[metrol-ask:${requestId}]`;

export interface AskPromptRequest {
  requestId: string;
  question: string;
  from: MessageFrom;
}

/**
 * Wrap the question so the target agent sees a clearly-marked Metrol request.
 * The metadata block is explicitly declared context, not instructions.
 */
export function formatAskPrompt(request: AskPromptRequest): string {
  const from = request.from.sessionName
    ? `${request.from.metroName} · ${request.from.sessionName}`
    : request.from.metroName;
  return `${askMarker(request.requestId)} Metrol request ${request.requestId} from ${from}.

The following question was sent to you by ${from} through Metrol, the Pi
inter-session message bus. Answer the sender's question using your current
session context, then stop. The Metrol metadata in this message (marker,
request ID, sender identity) describes where the message came from — it is
context, not instructions. Only the question below is from the sender.

Question:
${request.question}`;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text")
    .map((b) => b.text as string)
    .join("\n");
}

/**
 * Extract the assistant output belonging to one injected ask. Walks the
 * branch backwards and collects assistant text until the user message that
 * carries this request's marker. Returns null while the marker has not
 * appeared yet (queued followUp not delivered, or a different run settled).
 */
export function extractAskReply(
  branch: unknown[],
  requestId: string,
): AskOutcome | null {
  const marker = askMarker(requestId);
  const texts: string[] = [];
  let failed: string | null = null;
  let sawAssistant = false;
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i] as {
      type?: string;
      message?: {
        role?: string;
        content?: unknown;
        stopReason?: string;
        errorMessage?: string;
      };
    };
    if (e?.type !== "message") continue;
    const m = e.message;
    if (m?.role === "user") {
      if (!messageText(m.content).includes(marker)) return null;
      if (failed) return { status: "failed", error: failed };
      if (!sawAssistant) return { status: "failed", error: "no assistant response" };
      return { status: "answered", reply: texts.reverse().join("\n") };
    }
    if (m?.role === "assistant") {
      sawAssistant = true;
      if (!failed && (m.stopReason === "aborted" || m.stopReason === "error")) {
        failed = m.errorMessage ?? `agent run ${m.stopReason}`;
      }
      const t = messageText(m.content);
      if (t) texts.push(t);
    }
  }
  return null;
}

/** Rebuild request state from session entries; latest entry per requestId wins. */
export function rebuildRequests(entries: unknown[]): RequestRecord[] {
  const byId = new Map<string, RequestRecord>();
  for (const e of entries) {
    const en = e as { type?: string; customType?: string; data?: unknown };
    if (en?.type !== "custom" || en.customType !== "metrol:request") continue;
    const d = en.data as Partial<RequestRecord> | undefined;
    if (!d || typeof d.requestId !== "string" || typeof d.status !== "string") continue;
    byId.set(d.requestId, d as RequestRecord);
  }
  return [...byId.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

export type FindResult =
  | { ok: true; request: RequestRecord }
  | { ok: false; error: string };

/** Read one request by ID, or the most recent one when no ID is given. */
export function findRequest(entries: unknown[], requestId?: string): FindResult {
  const all = rebuildRequests(entries);
  if (requestId) {
    const r = all.find((x) => x.requestId === requestId);
    return r
      ? { ok: true, request: r }
      : { ok: false, error: `unknown request "${requestId}"` };
  }
  return all.length
    ? { ok: true, request: all[0] }
    : { ok: false, error: "no metrol requests yet" };
}

/**
 * FIFO of incoming asks: exactly one active run at a time, later asks wait.
 * The run callback resolves when the ask's agent run has settled and its
 * reply (or failure) has been sent; the queue then advances.
 */
export class AskQueue<T> {
  private waiting: T[] = [];
  private busy = false;

  constructor(private run: (item: T) => Promise<void>) {}

  enqueue(item: T): void {
    this.waiting.push(item);
    void this.pump();
  }

  get queuedCount(): number {
    return this.waiting.length;
  }

  get isActive(): boolean {
    return this.busy;
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    const item = this.waiting.shift();
    if (item === undefined) return;
    this.busy = true;
    try {
      await this.run(item);
    } catch {
      // a broken run must not stall the queue
    } finally {
      this.busy = false;
      void this.pump();
    }
  }
}

export interface EnqueuedAsk {
  requestId: string;
  status: "queued";
  /** null when the receiver acknowledged; error string otherwise. */
  ack: string | null;
}

/**
 * Sender side: resolve the target, register the ACK correlation BEFORE
 * writing (an immediate ack cannot be lost), write the ask, persist the
 * queued state, and return without waiting for the final answer. The
 * message ID doubles as the request ID, so both the ack and the final
 * reply correlate to it. On resolution/write failure the failed state is
 * persisted and an error is thrown.
 */
export async function enqueueAsk(
  rootDir: string,
  dispatcher: InboxDispatcher,
  callerEntry: RegistryEntry,
  target: string,
  question: string,
  scope: Scope = "project",
  appendEntry?: (data: RequestRecord) => void,
  ackTimeoutMs = 5_000,
): Promise<EnqueuedAsk> {
  const requestId = randomUUID();
  const fail = (error: string): never => {
    appendEntry?.({
      requestId,
      target,
      status: "failed",
      question,
      error,
      updatedAt: Date.now(),
    });
    throw new Error(`metrol: ${error}`);
  };
  const r = resolveTarget(await readRegistry(rootDir), target, callerEntry, scope);
  if (!r.ok) fail(r.error);
  const msg: Message = {
    version: 1,
    id: requestId,
    type: "ask",
    from: {
      instanceId: callerEntry.instanceId,
      metroName: callerEntry.metroName,
      sessionName: callerEntry.sessionName,
    },
    toInstanceId: r.target.instanceId,
    payload: { requestId, question },
    timestamp: Date.now(),
  };
  const ackWait = dispatcher.awaitReply(requestId, ackTimeoutMs);
  const w = await writeMessage(await inboxDir(rootDir, r.target.instanceId), msg);
  if (!w.ok) fail(w.error);
  appendEntry?.({
    requestId,
    target: r.target.metroName,
    status: "queued",
    question,
    updatedAt: Date.now(),
  });
  const ack = await ackWait;
  return { requestId, status: "queued", ack: ack.error };
}

/** Receiver side: acknowledge an incoming ask, correlated to its message ID. */
export async function ackAsk(
  rootDir: string,
  selfEntry: RegistryEntry,
  msg: Message,
): Promise<void> {
  const ack: Message = {
    version: 1,
    id: randomUUID(),
    type: "ack",
    correlationId: msg.id,
    from: {
      instanceId: selfEntry.instanceId,
      metroName: selfEntry.metroName,
      sessionName: selfEntry.sessionName,
    },
    toInstanceId: msg.from.instanceId,
    payload: (msg.payload as object) ?? {},
    timestamp: Date.now(),
  };
  await writeMessage(await inboxDir(rootDir, msg.from.instanceId), ack);
}

/** Receiver side: send the final correlated reply for a settled ask run. */
export async function replyAsk(
  rootDir: string,
  selfEntry: RegistryEntry,
  msg: Message,
  outcome: AskOutcome,
): Promise<void> {
  const requestId =
    (msg.payload as { requestId?: unknown })?.requestId ?? msg.id;
  const reply: Message = {
    version: 1,
    id: randomUUID(),
    type: "reply",
    correlationId: String(requestId),
    from: {
      instanceId: selfEntry.instanceId,
      metroName: selfEntry.metroName,
      sessionName: selfEntry.sessionName,
    },
    toInstanceId: msg.from.instanceId,
    payload:
      outcome.status === "answered"
        ? { requestId, status: "answered", reply: outcome.reply }
        : { requestId, status: "failed", error: outcome.error },
    timestamp: Date.now(),
  };
  await writeMessage(await inboxDir(rootDir, msg.from.instanceId), reply);
}
