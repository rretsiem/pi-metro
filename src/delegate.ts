import { listSessions, type CallerRef, type Scope, type SessionInfo } from "./list.ts";
import { selectPeer } from "./select.ts";
import { enqueueAsk, type EnqueuedAsk, type RequestRecord } from "./asks.ts";
import { findRequest } from "./asks.ts";
import type { InboxDispatcher } from "./dispatcher.ts";
import type { RegistryEntry } from "./registry.ts";

export interface DelegateOptions {
  /** Task description / curated handoff to send to the chosen peer. */
  question: string;
  /** Scope of peer candidates. Default "project". */
  scope?: Scope;
  /** Force a specific peer by metroName or instanceId (must be in scope). */
  targetHint?: string;
  /** If true, block until the reply arrives (or `timeoutMs` elapses). Default false. */
  waitForReply?: boolean;
  /** Poll timeout when `waitForReply` is true. Default 5 minutes. */
  timeoutMs?: number;
  /** Poll interval when `waitForReply` is true. Default 1000ms. */
  pollIntervalMs?: number;
  /** Max time to wait for the receiver's ACK before proceeding. Default
   * adapts to the call shape: 5000ms when waitForReply is true (the caller
   * is committed to waiting), 250ms when false (the caller is moving on
   * and just wants the queue confirm). Lower this in tests to skip waiting
   * on an ACK that never arrives. */
  ackTimeoutMs?: number;
}

export interface DelegateQueued {
  ok: true;
  status: "queued";
  requestId: string;
  target: string;
  scope: Scope;
}

export interface DelegateBlocked {
  ok: true;
  status: "answered" | "failed" | "timeout";
  requestId: string;
  target: string;
  scope: Scope;
  reply?: string;
  error?: string;
  durationMs: number;
}

export interface DelegateNoPeer {
  ok: false;
  error: "no_idle_peer";
  scope: Scope;
}

export type DelegateResult = DelegateQueued | DelegateBlocked | DelegateNoPeer;

export interface RunDelegateArgs {
  rootDir: string;
  dispatcher: InboxDispatcher;
  callerEntry: RegistryEntry;
  caller: CallerRef;
  options: DelegateOptions;
  /** Writes a metrol:request entry (used by enqueueAsk). */
  appendAskEntry: (data: RequestRecord) => void;
  /** Writes the metrol:handoff audit entry. */
  appendHandoffEntry: (data: Record<string, unknown>) => void;
  /** Sleep helper for the blocking poll (tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Reads session entries for `findRequest`. Tests inject a stub. */
  getEntries: () => unknown[];
  now?: () => number;
}

export const DEFAULT_DELEGATE_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_DELEGATE_POLL_MS = 1_000;

/**
 * Compose peer selection + ask enqueue + optional blocking poll into a
 * single call. Mirrors the `metro_select_peer` fallback: when a
 * `targetHint` matches any in-scope peer, pick from those; otherwise pick
 * from the full in-scope pool. Returns `no_idle_peer` cleanly (no write,
 * no entry) when no candidate exists.
 */
export async function runDelegate(args: RunDelegateArgs): Promise<DelegateResult> {
  const scope: Scope = args.options.scope ?? "project";
  const waitForReply = args.options.waitForReply ?? false;
  const timeoutMs = args.options.timeoutMs ?? DEFAULT_DELEGATE_TIMEOUT_MS;
  const pollMs = args.options.pollIntervalMs ?? DEFAULT_DELEGATE_POLL_MS;
  const ackTimeoutMs = args.options.ackTimeoutMs ?? (waitForReply ? 5_000 : 250);
  const sleep = args.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = args.now ?? Date.now;

  const all = await listSessions(args.rootDir, args.caller, scope);
  const hint = args.options.targetHint;
  const pool: SessionInfo[] = hint
    ? all.filter((s) => s.metroName === hint || s.instanceId === hint)
    : all;
  const picked = selectPeer(pool.length > 0 ? pool : all, args.caller, { scope });
  if (!picked) {
    return { ok: false, error: "no_idle_peer", scope };
  }

  const targetName = picked.metroName;

  const enqueued: EnqueuedAsk = await enqueueAsk(
    args.rootDir,
    args.dispatcher,
    args.callerEntry,
    targetName,
    args.options.question,
    scope,
    args.appendAskEntry,
    ackTimeoutMs,
  );

  args.appendHandoffEntry({
    requestId: enqueued.requestId,
    target: targetName,
    scope,
    blocking: waitForReply,
    ts: now(),
  });

  if (!waitForReply) {
    return { ok: true, status: "queued", requestId: enqueued.requestId, target: targetName, scope };
  }

  const startedAt = now();
  while (true) {
    const entries = args.getEntries();
    const r = findRequest(entries, enqueued.requestId);
    if (r.ok) {
      const status = r.request.status;
      if (status === "answered") {
        return {
          ok: true,
          status: "answered",
          requestId: enqueued.requestId,
          target: targetName,
          scope,
          reply: typeof r.request.reply === "string" ? r.request.reply : undefined,
          durationMs: now() - startedAt,
        };
      }
      if (status === "failed") {
        return {
          ok: true,
          status: "failed",
          requestId: enqueued.requestId,
          target: targetName,
          scope,
          error: r.request.error,
          durationMs: now() - startedAt,
        };
      }
    }
    if (now() - startedAt >= timeoutMs) {
      return {
        ok: true,
        status: "timeout",
        requestId: enqueued.requestId,
        target: targetName,
        scope,
        error: `timeout after ${timeoutMs}ms`,
        durationMs: now() - startedAt,
      };
    }
    await sleep(pollMs);
  }
}