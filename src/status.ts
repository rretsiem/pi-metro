import { HEARTBEAT_INTERVAL_MS, type RegistryEntry } from "./registry.ts";

/** Non-transition writes coalesce within this window. State transitions bypass it. */
export const STATUS_WRITE_THROTTLE_MS = 2_000;

/** Random extra delay added to the heartbeat interval, in milliseconds. */
export const HEARTBEAT_JITTER_MS = 3_000;

/** Heartbeat delay = HEARTBEAT_INTERVAL_MS + floor(rng() * HEARTBEAT_JITTER_MS). */
export function heartbeatDelayMs(rng: () => number = Math.random): number {
  return HEARTBEAT_INTERVAL_MS + Math.floor(rng() * HEARTBEAT_JITTER_MS);
}

/** Initial stateSince/lastActivity seed for a fresh entry. */
export function initialStatus(now: number): { stateSince: number; lastActivity: number } {
  return { stateSince: now, lastActivity: now };
}

/**
 * pi's getContextUsage() may return any shape; reduce to our two-number
 * contract. Returns undefined for missing/garbage input.
 */
function normalizeContextUsage(
  raw: unknown,
): { tokens: number; contextWindow: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as { tokens?: unknown; contextWindow?: unknown };
  if (typeof o.tokens !== "number" || typeof o.contextWindow !== "number") {
    return undefined;
  }
  return { tokens: o.tokens, contextWindow: o.contextWindow };
}

export interface StatusWriterOptions {
  now: () => number;
  getContextUsage?: () => unknown;
  /**
   * Write the current full entry to disk. The StatusWriter keeps the
   * in-memory `entry` as the single source of truth (each method patches
   * it synchronously) and flushes the whole thing on every dispatch —
   * eliminating the read-modify-write race that the v0.2.0 updateRegistry
   * path had when two events landed in the same tick (one event's write
   * could overwrite another's partial patch because both had read the same
   * baseline).
   */
  writeFull: (
    rootDir: string,
    entry: RegistryEntry,
  ) => Promise<void>;
  /** Called after each method that bumps lastActivity so callers can mirror it. */
  setLastActivity?: (ts: number) => void;
}

/**
 * Centralises registry writes for status updates. Non-transition events
 * (tool_start/end, session_info_changed, heartbeat) coalesce within
 * STATUS_WRITE_THROTTLE_MS; state transitions (agent_start, agent_settled)
 * bypass the throttle and flush any pending fields.
 */
export class StatusWriter {
  private lastWriteAt = -Infinity;
  private pending: Partial<RegistryEntry> = {};

  constructor(
    private readonly rootDir: string,
    private readonly entry: RegistryEntry,
    private readonly opts: StatusWriterOptions,
  ) {}

  async agentStart(): Promise<void> {
    const now = this.opts.now();
    const patch: Partial<RegistryEntry> = {
      state: "running",
      stateSince: now,
      lastActivity: now,
    };
    await this.dispatch(patch, true);
    this.entry.state = "running";
    this.entry.stateSince = now;
    this.entry.lastActivity = now;
    this.opts.setLastActivity?.(now);
  }

  async agentSettled(): Promise<void> {
    const now = this.opts.now();
    const ctx = normalizeContextUsage(this.opts.getContextUsage?.());
    const patch: Partial<RegistryEntry> = {
      state: "idle",
      stateSince: now,
      lastActivity: now,
      activeToolName: undefined,
      contextUsage: ctx,
    };
    await this.dispatch(patch, true);
    this.entry.state = "idle";
    this.entry.stateSince = now;
    this.entry.lastActivity = now;
    delete this.entry.activeToolName;
    if (ctx) this.entry.contextUsage = ctx;
    else delete this.entry.contextUsage;
    this.opts.setLastActivity?.(now);
  }

  async toolStart(name: string): Promise<void> {
    const now = this.opts.now();
    const patch: Partial<RegistryEntry> = { activeToolName: name, lastActivity: now };
    await this.dispatch(patch, false);
    this.entry.activeToolName = name;
    this.entry.lastActivity = now;
    this.opts.setLastActivity?.(now);
  }

  async toolEnd(): Promise<void> {
    const now = this.opts.now();
    const ctx = normalizeContextUsage(this.opts.getContextUsage?.());
    const patch: Partial<RegistryEntry> = {
      activeToolName: undefined,
      lastActivity: now,
      contextUsage: ctx,
    };
    await this.dispatch(patch, false);
    delete this.entry.activeToolName;
    this.entry.lastActivity = now;
    if (ctx) this.entry.contextUsage = ctx;
    else delete this.entry.contextUsage;
    this.opts.setLastActivity?.(now);
  }

  async sessionInfoChanged(name: string): Promise<void> {
    const now = this.opts.now();
    const patch: Partial<RegistryEntry> = { sessionName: name, lastActivity: now };
    await this.dispatch(patch, false);
    this.entry.sessionName = name;
    this.entry.lastActivity = now;
    this.opts.setLastActivity?.(now);
  }

  async heartbeat(): Promise<void> {
    const now = this.opts.now();
    const ctx =
      this.entry.state === "running"
        ? normalizeContextUsage(this.opts.getContextUsage?.())
        : undefined;
    const patch: Partial<RegistryEntry> = {
      lastHeartbeat: now,
      state: this.entry.state,
    };
    if (ctx) patch.contextUsage = ctx;
    await this.dispatch(patch, false);
    this.entry.lastHeartbeat = now;
    if (ctx) this.entry.contextUsage = ctx;
  }

  private async dispatch(
    patch: Partial<RegistryEntry>,
    isTransition: boolean,
  ): Promise<void> {
    const now = this.opts.now();
    let toMerge: Partial<RegistryEntry>;
    if (isTransition) {
      toMerge = { ...this.pending, ...patch };
      this.pending = {};
    } else {
      this.pending = { ...this.pending, ...patch };
      if (now - this.lastWriteAt < STATUS_WRITE_THROTTLE_MS) return;
      toMerge = this.pending;
      this.pending = {};
    }
    this.lastWriteAt = now;
    // Write the WHOLE current entry, not just the patch. The in-memory
    // `entry` was patched synchronously by the calling method; this merge
    // here produces the snapshot we'll hand to the disk. Two concurrent
    // dispatches (e.g., a heartbeat racing a toolEnd) no longer overwrite
    // each other's partial patches — both writes carry the full current
    // entry, and the rename is atomic per file.
    const merged: RegistryEntry = { ...this.entry, ...toMerge };
    await this.opts.writeFull(this.rootDir, merged);
    // Mirror back so subsequent in-memory reads match what the disk has.
    Object.assign(this.entry, merged);
  }
}
