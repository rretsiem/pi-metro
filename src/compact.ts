import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { readRegistry, type RegistryEntry } from "./registry.ts";
import type { Scope } from "./list.ts";
import {
  safeInboxDir,
  resolveTarget,
  type Message,
  type MessageFrom,
} from "./transport.ts";

/**
 * Atomic write for compact messages. Mirrors the `writeMessage` pattern in
 * transport.ts (temp + rename, validated on write) but does NOT call
 * `validateMessage` — `compactReq`/`compactRes` are added to MESSAGE_TYPES
 * by the integration snippet in transport.ts, but src/compact.ts must not
 * depend on that integration being applied before the tests run. The wire
 * shape is identical; the validation gate is a global safety check that
 * fires after the integration and accepts these types the same way.
 */
async function writeCompactMessage(dir: string, msg: Message): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${randomUUID()}.json`);
  await writeFile(tmp, JSON.stringify(msg));
  const file = `${msg.timestamp}-${msg.id}.json`;
  await rename(tmp, path.join(dir, file));
}

/**
 * Default timeout for a `metro_compact` request: 3 minutes. A real compact
 * is slow (re-embed + summarize) — far longer than a query (10s) but short
 * enough that a stuck target does not hold the caller's slot forever.
 * Overridable so tests can exercise the timeout path without waiting.
 */
export const COMPACT_TIMEOUT_MS = 180_000;

/**
 * Payload shape for a `compactReq` message. Mirrors the task spec and is
 * the same interface the integration snippet exports from transport.ts.
 * The `from`/`to` here are denormalized copies of the envelope so the
 * receiver can answer without re-reading the registry.
 */
export interface CompactRequestPayload {
  id: string;
  from: MessageFrom;
  to: string;
  instructions?: string;
}

/**
 * Payload shape for a `compactRes` message. `ok: true` means the receiver
 * has compacted (or is about to); `ok: false` carries the rejection reason
 * the caller must propagate.
 */
export interface CompactResponsePayload {
  id: string;
  from: MessageFrom;
  to: string;
  ok: boolean;
  reason?: "busy" | "unsupported";
}

/**
 * Receiver-side decision: reject with `busy` / `unsupported`, or proceed.
 * Encapsulated so the integration layer can compute it without a live pi
 * ctx and so the receiver's "no followUp" contract is a single function.
 */
export type CompactDecision =
  | { ok: false; reason: "busy" }
  | { ok: false; reason: "unsupported" }
  | { ok: true };

export interface CompactDecisionState {
  /** True when the agent is currently producing (model/provider running). */
  agentRunning: boolean;
  /** True when the runtime exposes a compact capability (e.g. ctx.compact). */
  hasCompactCapability: boolean;
}

/**
 * Pure receiver-side decision. `busy` wins over `unsupported` so the caller
 * sees the most actionable reason and can retry later when the target is
 * idle. `ok: true` only when both gates pass.
 */
export function decideCompactResponse(
  state: CompactDecisionState,
): CompactDecision {
  if (state.agentRunning) return { ok: false, reason: "busy" };
  if (!state.hasCompactCapability) return { ok: false, reason: "unsupported" };
  return { ok: true };
}

/** Self-target rejection: same rule as `metro_ask` / `metro_publish`. */
export interface SelfTargetCheck {
  ok: boolean;
  error?: string;
}

export function rejectSelfTarget(
  callerMetroName: string,
  target: string,
): SelfTargetCheck {
  if (target === callerMetroName) {
    return { ok: false, error: `cannot target self ("${callerMetroName}")` };
  }
  return { ok: true };
}

/** Sender-side outcome after the reply (or timeout) arrives. */
export type CompactOutcome =
  | { status: "ok" }
  | { status: "busy" }
  | { status: "unsupported" }
  | { status: "failed"; error: string };

/** Persisted `metrol:request` shape for a compact operation. */
export type CompactRequestState =
  | "queued"
  | "ok"
  | "busy"
  | "unsupported"
  | "failed";

export interface CompactRequestRecord {
  requestId: string;
  target: string;
  status: CompactRequestState;
  instructions?: string;
  error?: string;
  updatedAt: number;
}

/**
 * Pending-response correlation map. Locally copied from the dispatcher
 * `awaitReply` pattern (see src/dispatcher.ts) so `compact` does not depend
 * on dispatcher internals and is unit-testable. Each entry is one in-flight
 * `compactReq` awaiting exactly one `compactRes` keyed by correlationId.
 */
export interface CompactReplyResult {
  error: string | null;
  value?: CompactResponsePayload;
}

export class CompactPendingMap {
  private pending = new Map<string, (msg: Message) => void>();

  register(
    correlationId: string,
    timeoutMs: number,
  ): Promise<CompactReplyResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        resolve({ error: `timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(correlationId, (msg) => {
        clearTimeout(timer);
        resolve({ error: null, value: msg.payload as CompactResponsePayload });
      });
    });
  }

  /** Resolve a pending entry by correlationId. Returns true when matched. */
  resolve(msg: Message): boolean {
    const id = msg.correlationId;
    if (!id) return false;
    const waiter = this.pending.get(id);
    if (!waiter) return false;
    this.pending.delete(id);
    waiter(msg);
    return true;
  }

  /** Drop every pending waiter (used on shutdown). */
  clear(): void {
    this.pending.clear();
  }

  get size(): number {
    return this.pending.size;
  }
}

/**
 * Sender-side: resolve the target, register the correlation BEFORE writing,
 * write the compact request, then wait for the correlated `compactRes`.
 * On self-target / unknown target / write failure, persists `failed` and
 * throws. On reply timeout, returns `{ status: "failed", error: ... }`.
 *
 * CRITICAL: unlike `metro_ask`'s `followUp` fallback, the receiver side
 * never queues a compact request — it answers immediately with `busy` or
 * `unsupported`. This caller does not need to handle delayed responses.
 */
export async function requestCompact(
  rootDir: string,
  pending: CompactPendingMap,
  callerEntry: RegistryEntry,
  target: string,
  instructions?: string,
  scope: Scope = "project",
  appendEntry?: (data: CompactRequestRecord) => void,
  timeoutMs: number = COMPACT_TIMEOUT_MS,
): Promise<CompactOutcome> {
  // Self-target check runs first so we never write to anyone, even when
  // the target is missing from the registry.
  const self = rejectSelfTarget(callerEntry.metroName, target);
  if (!self.ok) {
    const error = self.error!;
    const requestId = randomUUID();
    appendEntry?.({
      requestId,
      target,
      status: "failed",
      instructions,
      error,
      updatedAt: Date.now(),
    });
    throw new Error(`metrol: ${error}`);
  }

  const requestId = randomUUID();
  const fail = (error: string): never => {
    appendEntry?.({
      requestId,
      target,
      status: "failed",
      instructions,
      error,
      updatedAt: Date.now(),
    });
    throw new Error(`metrol: ${error}`);
  };

  const r = resolveTarget(await readRegistry(rootDir), target, callerEntry, scope);
  if (!r.ok) fail(r.error);

  const from: MessageFrom = {
    instanceId: callerEntry.instanceId,
    metroName: callerEntry.metroName,
    sessionName: callerEntry.sessionName,
  };
  // Cast: `compactReq` is added to MESSAGE_TYPES by the integration snippet
  // in transport.ts; src/compact.ts does not edit transport.ts.
  const msg = {
    version: 1,
    id: requestId,
    type: "compactReq",
    from,
    toInstanceId: r.target.instanceId,
    payload: {
      id: requestId,
      from,
      to: r.target.metroName,
      instructions,
    } as CompactRequestPayload,
    timestamp: Date.now(),
  } as Message;

  const wait = pending.register(requestId, timeoutMs);
  try {
    const inbox = await safeInboxDir(rootDir, r.target.instanceId);
    await writeCompactMessage(inbox, msg);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }

  appendEntry?.({
    requestId,
    target: r.target.metroName,
    status: "queued",
    instructions,
    updatedAt: Date.now(),
  });

  const reply = await wait;
  if (reply.error) {
    appendEntry?.({
      requestId,
      target: r.target.metroName,
      status: "failed",
      instructions,
      error: reply.error,
      updatedAt: Date.now(),
    });
    return { status: "failed", error: reply.error };
  }
  const payload = reply.value!;
  if (payload.ok) {
    appendEntry?.({
      requestId,
      target: r.target.metroName,
      status: "ok",
      instructions,
      updatedAt: Date.now(),
    });
    return { status: "ok" };
  }
  const reason = payload.reason ?? "unsupported";
  appendEntry?.({
    requestId,
    target: r.target.metroName,
    status: reason,
    instructions,
    updatedAt: Date.now(),
  });
  return { status: reason };
}

/**
 * Receiver-side: write a correlated `compactRes` for the given decision.
 * Called by the integration layer's `onCompactRequest` handler.
 *
 * CRITICAL — RECEIVER MUST REJECT IMMEDIATELY:
 *   This function does NOT trigger an LLM turn, a `ctx.compact()` call, or
 *   any `pi.sendUserMessage(...)` (in particular, no `followUp`). When the
 *   decision is `{ ok: false }`, the receiver answers right now with the
 *   reason — it does NOT queue the work for after the agent run settles.
 *   The ask flow's `followUp` fallback must NEVER be applied to compact.
 *   The integration snippet in index.ts routes the success path through
 *   `ctx.compact()` (a single async call) followed by another `respondCompact`
 *   with `{ ok: true }`; the busy/unsupported paths call `respondCompact`
 *   synchronously without touching the agent.
 */
export async function respondCompact(
  rootDir: string,
  selfEntry: RegistryEntry,
  msg: Message,
  decision: CompactDecision,
): Promise<void> {
  const payload = (msg.payload as CompactRequestPayload | null) ?? {
    id: msg.id,
    from: msg.from,
    to: "",
  };
  const from: MessageFrom = {
    instanceId: selfEntry.instanceId,
    metroName: selfEntry.metroName,
    sessionName: selfEntry.sessionName,
  };
  const replyPayload: CompactResponsePayload = {
    id: payload.id,
    from,
    to: msg.from.metroName,
    ok: decision.ok,
    ...(decision.ok ? {} : { reason: decision.reason }),
  };
  // Cast: `compactRes` is added to MESSAGE_TYPES by the integration snippet
  // in transport.ts; src/compact.ts does not edit transport.ts.
  const reply = {
    version: 1,
    id: randomUUID(),
    type: "compactRes",
    correlationId: msg.id,
    from,
    toInstanceId: msg.from.instanceId,
    payload: replyPayload,
    timestamp: Date.now(),
  } as Message;
  await writeCompactMessage(
    await safeInboxDir(rootDir, msg.from.instanceId),
    reply,
  );
}
