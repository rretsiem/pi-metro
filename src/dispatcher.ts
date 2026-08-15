import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { readMessage, type Message } from "./transport.ts";

export interface DispatcherCallbacks {
  onChat(msg: Message): void | Promise<void>;
  onQuery?(msg: Message): void | Promise<void>;
  onAsk?(msg: Message): void | Promise<void>;
  onReply?(msg: Message): void | Promise<void>;
}

export interface ReplyResult {
  error: string | null;
  value?: unknown;
}

export const POLL_INTERVAL_MS = 2_000;

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
  private seen = new Set<string>();
  private pending = new Map<string, (msg: Message) => void>();

  constructor(
    private dir: string,
    cb: DispatcherCallbacks["onChat"] | DispatcherCallbacks,
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
  }

  /** Clears the interval and waits for any in-flight tick to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
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
      let files: string[];
      try {
        files = await readdir(this.dir);
      } catch {
        return; // no inbox yet
      }
      for (const file of files.sort()) {
        if (!file.endsWith(".json") || file.startsWith(".tmp-")) continue;
        const fp = path.join(this.dir, file);
        const r = await readMessage(fp);
        if (!r.ok || this.seen.has(r.msg.id)) {
          await rm(fp, { force: true }); // malformed or duplicate: never handle
          continue;
        }
        this.seen.add(r.msg.id);
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
      case "reply":
      case "ack": {
        const waiter = msg.correlationId && this.pending.get(msg.correlationId);
        if (waiter) {
          this.pending.delete(msg.correlationId!);
          waiter(msg);
        } else {
          await this.cb.onReply?.(msg);
        }
        break;
      }
    }
  }
}
