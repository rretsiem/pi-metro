import type { CallerRef, Scope, SessionInfo } from "./list.ts";

/**
 * Pick the best peer for an LLM-side ask or notification.
 *
 * Tier order:
 *   1. Idle peers before running (prefer not waking someone up).
 *   2. Lower `contextUsage.tokens` (more room to answer).
 *      Missing `contextUsage` is treated as best-case (0 tokens): a peer that
 *      has not reported usage ranks alongside peers with plenty of room,
 *      ahead of peers near their ceiling. Stable within tier.
 *
 * Filters:
 *   - Caller itself is never a candidate.
 *   - Default scope `"project"` keeps peers with the same `projectRoot`.
 *   - `"cwd"` requires an exact `cwd` match.
 *   - `"all"` lets cross-project peers through.
 *
 * Returns `null` when no peer matches the scope filter.
 */
export function selectPeer(
  sessions: SessionInfo[],
  caller: CallerRef,
  opts: { scope?: Scope } = {},
): SessionInfo | null {
  const scope: Scope = opts.scope ?? "project";

  const candidates = sessions
    .filter((s) => s.instanceId !== caller.instanceId)
    .filter((s) => {
      if (scope === "all") return true;
      if (scope === "cwd") return s.cwd === caller.cwd;
      return s.projectRoot === caller.projectRoot;
    });

  if (candidates.length === 0) return null;

  // ponytail: missing contextUsage is best-case (0). Stable sort via index tiebreak.
  const tokens = (s: SessionInfo): number => s.contextUsage?.tokens ?? 0;
  const idleRank = (s: SessionInfo): number => (s.state === "idle" ? 0 : 1);
  const indexed = candidates.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => {
    const ir = idleRank(a.s) - idleRank(b.s);
    if (ir !== 0) return ir;
    const tr = tokens(a.s) - tokens(b.s);
    if (tr !== 0) return tr;
    return a.i - b.i;
  });
  return indexed[0].s;
}
