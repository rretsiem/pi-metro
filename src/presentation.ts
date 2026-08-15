import type { SessionInfo } from "./list.ts";
import { fmtAgo, fmtContext } from "./cli.ts";
import type { RequestRecord } from "./asks.ts";

export const MAX_INBOX_ITEMS = 30;
export const MAX_STATUS_FAILURES = 3;

/** Single-line, length-capped preview for compact UI output. */
export function compact(value: unknown, max = 80): string {
  const s = (typeof value === "string" ? value : JSON.stringify(value) ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// One-line "alias · session · state · tool · ctx · ago" row, matching
// formatMetroMap's per-session segments. Extracted so both the map and
// the status renderer stay in lock-step.
function sessionSegs(s: SessionInfo): string[] {
  const segs: string[] = [s.metroName];
  if (s.sessionName) segs.push(s.sessionName);
  segs.push(s.state);
  if (s.activeToolName) segs.push(s.activeToolName);
  const ctx = fmtContext(s.contextUsage);
  if (ctx) segs.push(ctx);
  const ago = fmtAgo(s.lastActivity);
  if (ago) segs.push(`${ago} ago`);
  return segs;
}

/**
 * Live sessions grouped by projectRoot, then cwd, then one line per
 * session (alias · session label · state). Plain text for ctx.ui.notify.
 */
export function formatMetroMap(sessions: SessionInfo[]): string {
  const lines = [`Metro map · ${sessions.length} session(s)`];
  const byProject = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const list = byProject.get(s.projectRoot) ?? [];
    list.push(s);
    byProject.set(s.projectRoot, list);
  }
  for (const [project, members] of [...byProject].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(project);
    const byCwd = new Map<string, SessionInfo[]>();
    for (const s of members) {
      const list = byCwd.get(s.cwd) ?? [];
      list.push(s);
      byCwd.set(s.cwd, list);
    }
    for (const [cwd, group] of [...byCwd].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${cwd}`);
      for (const s of [...group].sort((a, b) => a.metroName.localeCompare(b.metroName))) {
        lines.push(`    ${sessionSegs(s).join(" · ")}`);
      }
    }
  }
  return lines.join("\n");
}

interface InboxItem {
  ts: number;
  line: string;
}

function entryTs(entry: { timestamp?: unknown }, dataTs: unknown): number {
  if (typeof dataTs === "number") return dataTs;
  if (typeof entry.timestamp === "number") return entry.timestamp;
  return 0;
}

const hhmm = (ts: number) =>
  ts > 0
    ? new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : "--:--";

/**
 * Recent Metrol activity (metrol:in / metrol:out / metrol:request custom
 * entries), newest first, capped at maxItems. Plain text for ctx.ui.notify.
 */
export function formatMetroInbox(entries: unknown[], maxItems = MAX_INBOX_ITEMS): string {
  const items: InboxItem[] = [];
  for (const e of entries) {
    const en = e as { type?: string; customType?: string; data?: any; timestamp?: unknown };
    if (en?.type !== "custom") continue;
    const d = en.data ?? {};
    if (en.customType === "metrol:in") {
      items.push({ ts: entryTs(en, d.timestamp), line: `${hhmm(entryTs(en, d.timestamp))} ← ${d.from ?? "?"}: ${compact(d.preview)}` });
    } else if (en.customType === "metrol:out") {
      items.push({ ts: entryTs(en, d.timestamp), line: `${hhmm(entryTs(en, d.timestamp))} → ${d.to ?? "?"}: ${compact(d.preview)}` });
    } else if (en.customType === "metrol:request") {
      const ts = entryTs(en, d.updatedAt);
      const kind = typeof d.kind === "string" ? d.kind : "ask";
      const body = d.error ?? d.reply ?? d.question ?? "";
      items.push({ ts, line: `${hhmm(ts)} ⚙ ${kind} ${d.target ?? "?"} · ${d.status ?? "?"}${body ? `: ${compact(body)}` : ""}` });
    }
  }
  // newest first; stable so same-ms entries keep append order reversed
  items.sort((a, b) => b.ts - a.ts);
  const shown = items.slice(0, maxItems);
  const header = `Metrol activity · ${shown.length} of ${items.length} item(s)`;
  return [header, ...shown.map((i) => i.line)].join("\n");
}

/**
 * One-line summary of a metrol custom entry for the TUI entry renderer.
 * Returns null for non-metrol types.
 */
export function formatEntryLine(customType: string, data: any): string | null {
  const d = data ?? {};
  switch (customType) {
    case "metrol:identity": {
      const short = typeof d.instanceId === "string" ? ` · ${d.instanceId.slice(0, 8)}` : "";
      return `[metro] alias ${d.metroName ?? "?"}${short}`;
    }
    case "metrol:in":
      return `[metro] ← ${d.from ?? "?"}: ${compact(d.preview)}`;
    case "metrol:out":
      return `[metro] → ${d.to ?? "?"}: ${compact(d.preview)}`;
    case "metrol:request": {
      const kind = typeof d.kind === "string" ? d.kind : "ask";
      const body = d.error ?? d.reply ?? d.question ?? "";
      return `[metro] ${kind} ${d.target ?? "?"} · ${d.status ?? "?"}${body ? `: ${compact(body)}` : ""}`;
    }
    default:
      return null;
  }
}

/**
 * Pure renderer for `/metro status`. Caller hands in already-fetched data
 * (self snapshot, peer list, recent request records); no I/O. The peers
 * block is delegated to `formatMetroMap` so the per-session line shape
 * stays identical to `/metro map`.
 */
export function formatMetroStatus(
  self: SessionInfo | undefined,
  peers: SessionInfo[],
  recentRequests: RequestRecord[],
): string {
  const lines: string[] = [];
  if (!self) {
    lines.push("Metro status · metrol not started");
  } else {
    lines.push(`Metro status · ${self.metroName}`);
    lines.push(`  ${sessionSegs(self).join(" · ")}`);
    if (self.cwd) lines.push(`  cwd: ${self.cwd}`);
    if (self.projectRoot && self.projectRoot !== self.cwd) lines.push(`  project: ${self.projectRoot}`);
    if (self.model) lines.push(`  model: ${self.model}`);
    if (self.stateSince !== undefined) {
      const dur = fmtAgo(self.stateSince);
      if (dur) lines.push(`  state for ${dur}`);
    }

    const active = recentRequests.filter(
      (r) => r.status === "queued" || r.status === "accepted" || r.status === "running",
    );
    if (active.length) {
      const r = active[0]; // rebuildRequests sorted newest first
      const q = typeof r.question === "string" ? ` · ${compact(r.question)}` : "";
      const kind = r.kind === "query" ? "query" : "ask";
      lines.push(`  ${kind} ${r.status} → ${r.target}${q}`);
    }

    const failures = recentRequests.filter((r) => r.status === "failed").slice(0, MAX_STATUS_FAILURES);
    if (failures.length) {
      lines.push(`  recent failures (${failures.length}, newest first):`);
      for (const r of failures) {
        const short = r.requestId.slice(0, 8);
        const err = compact(r.error ?? "?", 60);
        lines.push(`    · ${short} ${r.target}: ${err}`);
      }
    }
  }
  lines.push("");
  lines.push(formatMetroMap(peers));
  return lines.join("\n");
}
