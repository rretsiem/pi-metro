import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { readMessage, type Message } from "./transport.ts";
import {
  createWatcher,
  shouldSkipPoll,
  type DirFingerprint,
} from "./watch.ts";

export interface DispatcherCallbacks {
  onChat(msg: Message): void | Promise<void>;
  onQuery?(msg: Message): void | Promise<void>;
  onAsk?(msg: Message): void | Promise<void>;
  onReply?(msg: Message): void | Promise<void>;
  /** Idle-gated triggerTurn messages (Task 04). */
  onTrigger?(msg: Message): void | Promise<void>;
  /** Informational running-state ping for an outgoing ask (Task 03). Never resolves a pending waiter. */
  onProgress?(msg: Message): void | Promise<void>;
  /** Terminal failure for an outgoing ask, arriving in place of an ack/reply (Task 03). */
  onFail?(msg: Message): void | Promise<void>;
  /** Receiver-side: another session asks us to compact (Task 09). */
  onCompactRequest?(msg: Message): void | Promise<void>;
  /** Sender-side: late compactRes arriving with no registered waiter (Task 09). */
  onCompactResponse?(msg: Message): void | Promise<void>;
}

export interface ReplyResult {
  error: string | null;
  value?: unknown;
}

export const POLL_INTERVAL_MS = 2_000;

/** Maximum number of message IDs retained in the per-dispatcher dedup set.
 * Above this size, the oldest IDs are dropped on a FIFO basis. Bounds the
 * dispatcher's per-runtime memory growth; messages older than the cap are
 * no longer deduplicated, which is safe because the atomic-read+rename
 * file delete after routing guarantees we never see the same message twice
 * inside the cap window — anything evicted was already handled-and-deleted
 * and the file no longer exists on disk. */
export const DISPATCHER_SEEN_CAP = 10_000;

/**
 * Sole reader of one instance's inbox. Ticks are serialized (never overlap),
 * message IDs are deduped per runtime, files are deleted only after handling.
 * Accepts either an onChat function or a DispatcherCallbacks object.
 */
export class InboxDispatcher {
  private cb: DispatcherCallbacks;
  private timer?: NodeJS.Timeout;
  private current: Promise<void> = Promise.resolve();
  private polling = false;
  private stopped = false;
  /** FIFO-bounded dedup history. `seenIndex` is an O(1) lookup mirror of
   * `seen`; the array preserves insertion order for FIFO eviction when the
   * cap is reached. Lookup is O(1) via the Set, eviction is O(1) amortized
   * (Array.shift + Set.delete), and the cap is `DISPATCHER_SEEN_CAP` so a
   * long-running session does not accumulate unbounded memory. */
  private seen: string[] = [];
  private seenIndex = new Set<string>();
  private pending = new Map<string, (msg: Message) => void>();
  /** Last inbox-dir fingerprint we did work for. Null = first poll, never skip.
   * Composite (mtime + file-count + total-size) so weird FSes that rewind
   * mtime (NFS, FAT, `touch -d`) can't trick us into skipping a real change. */
  private lastSeenFingerprint: DirFingerprint | null = null;
  /** fs.watch handle from createWatcher; undefined when no wake-up hint installed. */
  private watcherHandle?: { close(): void };

  constructor(
    private dir: string,
    cb: DispatcherCallbacks["onChat"] | DispatcherCallbacks,
    /** Optional low-latency wake-up hint (Task 07). fs.watch is a hint only —
     * the setInterval poll below remains the delivery guarantee. */
    private wakeOpts?: { onWakeUp?: () => void },
  ) {
    this.cb = typeof cb === "function" ? { onChat: cb } : cb;
  }

  start(intervalMs: number = POLL_INTERVAL_MS): void {
    this.stopped = false;
    this.timer = setInterval(() => {
      this.current = this.poll();
    }, intervalMs);
    this.timer.unref();
    this.current = this.poll();
    if (this.wakeOpts?.onWakeUp) {
      const onWakeUp = this.wakeOpts.onWakeUp;
      this.watcherHandle = createWatcher(this.dir, {
        onEvent: onWakeUp,
        onError: () => {
          // Best-effort wake-up hint; the interval poll above is the safety
          // net, so a watcher failure is not fatal. createWatcher already
          // retries with backoff internally.
        },
      });
    }
  }

  /** Clears the interval and watcher, and waits for any in-flight tick to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.watcherHandle?.close();
    this.watcherHandle = undefined;
    await this.current;
  }

  /** Register before the outbound write so a fast reply cannot be missed. */
  awaitReply(correlationId: string, timeoutMs: number): Promise<ReplyResult> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        resolve({ error: `timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      this.pending.set(correlationId, (msg) => {
        clearTimeout(timer);
        resolve({ error: null, value: msg.payload });
      });
    });
  }

  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(this.dir)).mtimeMs;
      } catch {
        return; // no inbox yet
      }

      let files: string[];
      try {
        files = await readdir(this.dir);
      } catch {
        return; // disappeared between stat and readdir; next tick retries
      }
      let totalSize = 0;
      for (const f of files) {
        if (f.startsWith(".tmp-")) continue;
        try {
          const s = await stat(path.join(this.dir, f));
          totalSize += s.size;
        } catch {
          // disappeared mid-poll; treat as size 0 so we don't under-count
          // — the next tick re-stat and the fingerprint will move.
        }
      }
      const fingerprint: DirFingerprint = {
        mtimeMs,
        fileCount: files.length,
        totalSize,
      };
      if (shouldSkipPoll(fingerprint, this.lastSeenFingerprint)) return;
      this.lastSeenFingerprint = fingerprint;

      for (const file of files.sort()) {
        if (!file.endsWith(".json") || file.startsWith(".tmp-")) continue;
        const fp = path.join(this.dir, file);
        const r = await readMessage(fp);
        if (!r.ok || this.seenIndex.has(r.msg.id)) {
          await rm(fp, { force: true }); // malformed or duplicate: never handle
          continue;
        }
        this.seen.push(r.msg.id);
        this.seenIndex.add(r.msg.id);
        // FIFO eviction when the cap is reached: drop the oldest entry
        // from both the array and the Set index. O(1) amortized.
        if (this.seen.length > DISPATCHER_SEEN_CAP) {
          const evicted = this.seen.shift()!;
          this.seenIndex.delete(evicted);
        }
        try {
          await this.route(r.msg);
        } finally {
          await rm(fp, { force: true });
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async route(msg: Message): Promise<void> {
    switch (msg.type) {
      case "chat":
        await this.cb.onChat(msg);
        break;
      case "query":
        await this.cb.onQuery?.(msg);
        break;
      case "ask":
        await this.cb.onAsk?.(msg);
        break;
      case "trigger":
        await this.cb.onTrigger?.(msg);
        break;
      case "progress":
        // Informational only — never resolves the ACK/REPLY waiter, always
        // routed to the persistence callback so the sender can bump its
        // liveness clock and persist "running".
        await this.cb.onProgress?.(msg);
        break;
      case "reply":
      case "ack":
      case "fail": {
        // FAIL can arrive in place of an ACK (immediate busy decline) or in
        // place of a REPLY (run failure) — it resolves the same pending
        // correlation as reply/ack. Only route to onFail when no waiter is
        // registered (late arrival).
        const waiter = msg.correlationId && this.pending.get(msg.correlationId);
        if (waiter) {
          this.pending.delete(msg.correlationId!);
          waiter(msg);
        } else if (msg.type === "fail") {
          await this.cb.onFail?.(msg);
        } else {
          await this.cb.onReply?.(msg);
        }
        break;
      }
      case "compactReq":
        await this.cb.onCompactRequest?.(msg);
        break;
      case "compactRes":
        // compact.ts owns its own correlation map (CompactPendingMap), entirely
        // separate from this dispatcher's `pending` (which only asks/queries
        // register into via awaitReply). Always route to the callback, which
        // resolves the compact-specific map.
        await this.cb.onCompactResponse?.(msg);
        break;
    }
  }
}
