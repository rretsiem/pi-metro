import { watch as nodeWatch, type FSWatcher } from "node:fs";

/** Debounce window for fs.watch events. Roadmap: 50-100ms. */
export const DEBOUNCE_MS = 50;

/**
 * Exponential backoff for fs.watch retries. Index 0 is the first retry after
 * a watcher failure; later steps cap at 30s.
 */
export const BACKOFF_STEPS_MS: readonly number[] = [250, 1000, 5000, 30000];

/**
 * Pure predicate: a poll can skip work when the directory's mtime hasn't moved
 * since the last poll. A null `lastSeenMtimeMs` (first poll) never skips —
 * there is no prior baseline to compare against.
 */
export function shouldSkipPoll(
  dirMtimeMs: number,
  lastSeenMtimeMs: number | null,
): boolean {
  if (lastSeenMtimeMs === null) return false;
  return dirMtimeMs <= lastSeenMtimeMs;
}

/**
 * Minimal surface createWatcher needs from an fs.watch-like emitter.
 * The real node:fs FSWatcher satisfies this; fakes for tests need only
 * `close()` plus `on('error', ...)` (and they may extend EventEmitter so
 * tests can `emit('change' | 'rename' | 'error', ...)`.
 */
export interface WatcherLike {
  close(): void;
  on(event: "error", listener: (err: unknown) => void): unknown;
}

/**
 * A drop-in replacement for `node:fs.watch(filename, listener)`. Real fs.watch
 * satisfies this signature directly; tests inject a fake that records every
 * invocation and exposes a controllable EventEmitter.
 */
export type WatchFn = (
  filename: string,
  listener: (eventType: string, filename: string | Buffer | null) => void,
) => WatcherLike;

export interface CreateWatcherOptions {
  /** Called once per debounce window when something changes in the dir. */
  onEvent: () => void;
  /** Called on every watcher error (after each retry attempt). Optional. */
  onError?: (err: unknown) => void;
  /** Override the 50ms debounce window. Tests use small values. */
  debounceMs?: number;
  /** Override the exponential-backoff schedule. Tests use small values. */
  backoffMs?: readonly number[];
  /** Inject a fake watch function. Default: node:fs.watch. */
  watchFn?: WatchFn;
}

/**
 * Wraps `fs.watch(dir, ...)` as a low-latency wake-up hint:
 *  - Watches the directory itself, not individual files.
 *  - Coalesces rapid-fire events into one `onEvent()` call per debounce window.
 *  - On any watcher error (EPERM, ENOENT, EMFILE, …), closes the broken
 *    watcher and retries with exponential backoff (250ms → 1s → 5s → 30s cap).
 *    Each successful (re)start fires `onEvent()` once to force a full rescan.
 *  - Never throws synchronously — watch-function failures route through
 *    `onError` and the same backoff loop.
 *
 * The polling `InboxDispatcher` stays the source of truth; this is purely a
 * hint to wake it up sooner. See `InboxDispatcher` integration snippets.
 */
export function createWatcher(
  dir: string,
  opts: CreateWatcherOptions,
): { close(): void } {
  const debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
  const backoffMs = opts.backoffMs ?? BACKOFF_STEPS_MS;
  const watchFn: WatchFn = opts.watchFn ?? defaultWatchFn;

  let closed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let watcher: WatcherLike | null = null;

  const clearDebounce = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  };
  const clearBackoff = (): void => {
    if (backoffTimer) {
      clearTimeout(backoffTimer);
      backoffTimer = null;
    }
  };
  const fireOnEvent = (): void => {
    clearDebounce();
    try {
      opts.onEvent();
    } catch {
      // onEvent is a hint to the caller — it must never crash the watcher.
    }
  };
  const scheduleFire = (): void => {
    if (closed) return;
    clearDebounce();
    debounceTimer = setTimeout(fireOnEvent, debounceMs);
    if (typeof debounceTimer.unref === "function") debounceTimer.unref();
  };
  const scheduleBackoff = (): void => {
    if (closed) return;
    const idx = Math.min(attempt, backoffMs.length - 1);
    const delay = backoffMs[idx];
    attempt++;
    clearBackoff();
    backoffTimer = setTimeout(startWatcher, delay);
    if (typeof backoffTimer.unref === "function") backoffTimer.unref();
  };
  const closeWatcher = (): void => {
    if (!watcher) return;
    try {
      watcher.close();
    } catch {
      // ignore — close failures must not stall backoff
    }
    watcher = null;
  };
  function startWatcher(): void {
    if (closed) return;
    const listener = (
      _eventType: string,
      _filename: string | Buffer | null,
    ): void => {
      scheduleFire();
    };
    let w: WatcherLike;
    try {
      w = watchFn(dir, listener);
    } catch (err) {
      opts.onError?.(err);
      scheduleBackoff();
      return;
    }
    watcher = w;
    attempt = 0; // reset on successful (re)start
    w.on("error", (err: unknown) => {
      opts.onError?.(err);
      closeWatcher();
      scheduleBackoff();
    });
    // Each successful (re)start fires onEvent once to force a full rescan.
    fireOnEvent();
  }

  startWatcher();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      clearDebounce();
      clearBackoff();
      closeWatcher();
    },
  };
}

const defaultWatchFn: WatchFn = (dir, listener) => {
  const w = nodeWatch(dir, { persistent: false }, listener);
  return w as unknown as WatcherLike;
};

// `FSWatcher` is exported for type consumers that want to keep the real type.
export type { FSWatcher };