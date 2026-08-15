import type { SessionInfo } from "./list.ts";

/** One fixed-width row per session, e.g. `  Red-1        idle    auth-refactor    /work/app/api`. */
export function formatSessionRow(s: SessionInfo): string {
  const name = s.metroName.padEnd(13);
  const state = s.state.padEnd(8);
  const session = (s.sessionName ?? "").padEnd(17);
  return `  ${name}${state}${session}${s.cwd}`.trimEnd();
}
