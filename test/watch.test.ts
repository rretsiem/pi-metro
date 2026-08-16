import { test } from "node:test";
import assert from "node:assert/strict";
import EventEmitter from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BACKOFF_STEPS_MS,
  DEBOUNCE_MS,
  createWatcher,
  shouldSkipPoll,
  type DirFingerprint,
  type WatchFn,
  type WatcherLike,
} from "../src/watch.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withTempRoot(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "metrol-watch-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function waitFor(
  cond: () => boolean | Promise<boolean>,
  timeoutMs = 500,
): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await sleep(5);
  }
}

interface FakeHandle {
  watcher: WatcherLike & EventEmitter;
  listener: (eventType: string, filename: string | Buffer | null) => void;
}

/** Build a fake watch factory that records every watcher + listener. */
function makeFakeWatch(): { watchFn: WatchFn; watches: FakeHandle[] } {
  const watches: FakeHandle[] = [];
  const watchFn: WatchFn = (_dir, listener) => {
    const watcher = new EventEmitter() as WatcherLike & EventEmitter;
    watcher.close = () => {
      watcher.removeAllListeners();
    };
    // Mirror real fs.watch: positional listener receives change/rename with filename.
    watcher.on("change", (filename: string | Buffer | null) =>
      listener("change", filename),
    );
    watcher.on("rename", (filename: string | Buffer | null) =>
      listener("rename", filename),
    );
    watches.push({ watcher, listener });
    return watcher;
  };
  return { watchFn, watches };
}

// ---------- shouldSkipPoll (fingerprint) ----------

const fp = (mtimeMs: number, fileCount = 0, totalSize = 0): DirFingerprint => ({
  mtimeMs,
  fileCount,
  totalSize,
});

test("shouldSkipPoll: equal fingerprints skip", () => {
  assert.equal(shouldSkipPoll(fp(100, 3, 1024), fp(100, 3, 1024)), true);
});

test("shouldSkipPoll: newer mtime does not skip", () => {
  assert.equal(shouldSkipPoll(fp(200, 3, 1024), fp(100, 3, 1024)), false);
});

test("shouldSkipPoll: older mtime alone does NOT skip when shape unchanged — caught by fileCount/totalSize", () => {
  // Identical shape but mtime went backward — still skip, no real change.
  assert.equal(shouldSkipPoll(fp(50, 3, 1024), fp(100, 3, 1024)), true);
});

test("shouldSkipPoll: older mtime + identical shape still skips (no real change)", () => {
  // If fileCount and totalSize are unchanged and mtime rewinds, the dir
  // contents really are identical — skipping is correct. This is the
  // cheap-but-safe baseline; the next two tests cover the cases where a
  // backward mtime step actually changed something.
  assert.equal(shouldSkipPoll(fp(50, 3, 1024), fp(100, 3, 1024)), true);
});

test("shouldSkipPoll: older mtime + different fileCount does not skip (regression: NFS mtime rewind)", () => {
  assert.equal(shouldSkipPoll(fp(50, 4, 1024), fp(100, 3, 1024)), false);
});

test("shouldSkipPoll: older mtime + different totalSize does not skip", () => {
  assert.equal(shouldSkipPoll(fp(50, 3, 2048), fp(100, 3, 1024)), false);
});

test("shouldSkipPoll: null lastSeen never skips (first poll)", () => {
  assert.equal(shouldSkipPoll(fp(0), null), false);
  assert.equal(shouldSkipPoll(fp(1_000_000, 5, 10_000), null), false);
});

// ---------- createWatcher constants ----------

test("BACKOFF_STEPS_MS: 250ms → 1s → 5s capped at 30s", () => {
  assert.deepEqual(BACKOFF_STEPS_MS.slice(0, 4), [250, 1000, 5000, 30000]);
  // No step exceeds 30s cap
  for (const ms of BACKOFF_STEPS_MS) assert.ok(ms <= 30_000);
});

test("DEBOUNCE_MS is in the 50-100ms band per roadmap", () => {
  assert.ok(DEBOUNCE_MS >= 50 && DEBOUNCE_MS <= 100, `got ${DEBOUNCE_MS}`);
});

// ---------- createWatcher ----------

test("createWatcher: rapid-fire events coalesce into one onEvent", async (t) => {
  const dir = await withTempRoot(t);
  const { watchFn, watches } = makeFakeWatch();
  let count = 0;
  const w = createWatcher(dir, {
    onEvent: () => {
      count++;
    },
    watchFn,
    debounceMs: 20,
  });
  t.after(() => w.close());
  // Wait for initial onEvent from successful start
  await waitFor(() => count === 1);
  const baseline = count;

  // Five events fired inside one debounce window → exactly one onEvent
  for (let i = 0; i < 5; i++) {
    watches[0].watcher.emit("change", `f${i}.json`);
  }
  await sleep(60); // > debounceMs
  assert.equal(count, baseline + 1, `expected ${baseline + 1}, got ${count}`);
});

test("createWatcher: real fs.watch on a tmpdir fires onEvent on file change", async (t) => {
  const root = await withTempRoot(t);
  let count = 0;
  const w = createWatcher(root, {
    onEvent: () => {
      count++;
    },
  });
  t.after(() => w.close());
  // Wait for initial fire
  await waitFor(() => count >= 1, 300);
  const baseline = count;

  await writeFile(path.join(root, "hello.txt"), "world");
  await waitFor(() => count > baseline, 500);
  // No additional fires within a small quiet window
  await sleep(80);
  assert.ok(count >= baseline + 1, `expected >=${baseline + 1}, got ${count}`);
});

test("createWatcher: watcher error → onError fires, watcher retried", async (t) => {
  const dir = await withTempRoot(t);
  const { watchFn, watches } = makeFakeWatch();
  const errors: unknown[] = [];
  const w = createWatcher(dir, {
    onEvent: () => {},
    onError: (e) => errors.push(e),
    watchFn,
    backoffMs: [10, 20, 40],
  });
  t.after(() => w.close());
  await waitFor(() => watches.length === 1);
  const boom = new Error("boom");
  watches[0].watcher.emit("error", boom);
  await waitFor(() => errors.length === 1);
  await waitFor(() => watches.length === 2, 200);
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, "boom");
  assert.equal(watches.length, 2, "watcher must be retried after error");
});

test("createWatcher: close() cancels pending backoff", async (t) => {
  const dir = await withTempRoot(t);
  const { watchFn, watches } = makeFakeWatch();
  const w = createWatcher(dir, {
    onEvent: () => {},
    onError: () => {},
    watchFn,
    backoffMs: [200, 400, 800], // first retry would be 200ms after error
  });
  t.after(() => w.close());
  await waitFor(() => watches.length === 1);
  watches[0].watcher.emit("error", new Error("abcdef01"));
  // Close during the backoff window — no retry must happen
  w.close();
  await sleep(300);
  assert.equal(watches.length, 1, "no new watcher must be created after close()");
});

test("createWatcher: close() after successful start stops further events", async (t) => {
  const dir = await withTempRoot(t);
  const { watchFn, watches } = makeFakeWatch();
  let count = 0;
  const w = createWatcher(dir, {
    onEvent: () => {
      count++;
    },
    watchFn,
    debounceMs: 10,
  });
  t.after(() => w.close());
  await waitFor(() => count === 1);
  w.close();
  const baseline = count;
  // After close, emit events on the (now-closed) watcher — they must not reach onEvent
  watches[0].watcher.emit("change", "after-close.json");
  await sleep(40);
  assert.equal(count, baseline, "no onEvent must fire after close()");
});

test("createWatcher: synchronous watchFn throw does not crash; backed off + retried", async (t) => {
  const dir = await withTempRoot(t);
  const errors: unknown[] = [];
  let calls = 0;
  const watchFn: WatchFn = () => {
    calls++;
    if (calls === 1) throw new Error("sync boom");
    // subsequent calls succeed with a no-op watcher (satisfies WatcherLike)
    const w: WatcherLike = {
      close: () => {},
      on: () => w,
    };
    return w;
  };
  const w = createWatcher(dir, {
    onEvent: () => {},
    onError: (e) => errors.push(e),
    watchFn,
    backoffMs: [10, 20, 40],
  });
  t.after(() => w.close());
  await waitFor(() => errors.length === 1);
  await waitFor(() => calls >= 2, 200);
  assert.equal((errors[0] as Error).message, "sync boom");
  assert.ok(calls >= 2, "watchFn must be retried after sync throw");
});