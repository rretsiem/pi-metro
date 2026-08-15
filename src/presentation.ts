import type { SessionInfo } from "./list.ts";
import { fmtAgo, fmtContext } from "./cli.ts";

export const MAX_INBOX_ITEMS = 30;

/** Single-line, length-capped preview for compact UI output. */
export function compact(value: unknown, max = 80): string {
  const s = (typeof value === "string" ? value : JSON.stringify(value) ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
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
        const segs: string[] = [s.metroName];
        if (s.sessionName) segs.push(s.sessionName);
        segs.push(s.state);
        if (s.activeToolName) segs.push(s.activeToolName);
        const ctx = fmtContext(s.contextUsage);
        if (ctx) segs.push(ctx);
        const ago = fmtAgo(s.lastActivity);
        if (ago) segs.push(`${ago} ago`);
        lines.push(`    ${segs.join(" · ")}`);
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
