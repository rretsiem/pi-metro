import type { SessionInfo } from "./list.ts";

/** "45K/272K" or "" when usage is missing. Rounds to nearest K. */
export function fmtContext(u?: { tokens: number; contextWindow: number }): string {
  if (!u) return "";
  return `${Math.round(u.tokens / 1000)}K/${Math.round(u.contextWindow / 1000)}K`;
}

/** "<1m" | "3m" | "2h" | "" when timestamp is absent. The caller appends " ago" in display contexts. */
export function fmtAgo(ts?: number, now: number = Date.now()): string {
  if (ts === undefined) return "";
  const min = Math.floor((now - ts) / 60_000);
  if (min < 1) return "<1m";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/**
 * One fixed-width row per session. Columns: alias (13) · state (8) · tool (8) ·
 * context (9) · activity (8) · session name (17) · cwd. Missing fields render
 * as blanks so old peers keep the same layout with gaps.
 */
export function formatSessionRow(s: SessionInfo): string {
  const name = s.metroName.padEnd(13);
  const state = s.state.padEnd(8);
  const tool = (s.activeToolName ?? "").padEnd(8);
  const ctx = fmtContext(s.contextUsage).padEnd(9);
  const ago = s.lastActivity === undefined ? "" : `${fmtAgo(s.lastActivity)} ago`;
  const agoCol = ago.padEnd(8);
  const session = (s.sessionName ?? "").padEnd(17);
  return `  ${name}${state}${tool}${ctx}${agoCol}${session}${s.cwd}`.trimEnd();
}
