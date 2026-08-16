import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import { claimMetroAlias, releaseMetroAlias } from "./identity.ts";
import { findProjectRoot } from "./project.ts";
import {
  readRegistry,
  writeRegistryEntry,
  updateRegistry,
  removeRegistryEntry,
  type RegistryEntry,
} from "./registry.ts";
import {
  STORAGE_SWEEP_INTERVAL_MS,
  isSweepDisabled,
  sweepMetrolStorage,
} from "./sweep.ts";
import {
  StatusWriter,
  heartbeatDelayMs,
  initialStatus,
} from "./status.ts";
import { listSessions, SCOPES, type CallerRef, type ListFilter, type Scope, type SessionInfo } from "./list.ts";
import { selectPeer } from "./select.ts";
import { formatSessionRow } from "./cli.ts";
import {
  formatMetroInbox,
  formatMetroMap,
  formatEntryLine,
  formatMetroStatus,
} from "./presentation.ts";
import { sendDirect, broadcast } from "./messaging.ts";
import { safeInboxDir } from "./transport.ts";
import {
  claimLease,
  leaseNameForPath,
  readLease,
  releaseLease,
  renewLease,
} from "./leases.ts";
import { InboxDispatcher } from "./dispatcher.ts";
import { runDelegate, type DelegateResult } from "./delegate.ts";
import {
  QUERY_KINDS,
  answerQuery,
  handleQuery,
  runQuery,
  type QuerySnapshot,
} from "./queries.ts";
import {
  AskQueue,
  ackAsk,
  applyRankedTransition,
  enqueueAsk,
  extractAskReply,
  findRequest,
  formatAskPrompt,
  livenessMonitor,
  rebuildRequests,
  replyAsk,
  sendFail,
  sendProgress,
  type AskOutcome,
  type FailReason,
  type LivenessMonitor,
  type RequestRecord,
} from "./asks.ts";
import {
  TriggerBuffer,
  type TriggerItem,
} from "./triggers.ts";
import {
  CompactPendingMap,
  decideCompactResponse,
  requestCompact,
  respondCompact,
  type CompactRequestPayload,
} from "./compact.ts";
import type { Message } from "./transport.ts";

const preview = (s: string) => (s.length > 120 ? s.slice(0, 117) + "..." : s);

// ponytail: minimal local pi/ctx shapes until pi types become a dependency
interface PiLike {
  on(event: string, handler: (event: any, ctx: any) => unknown): void;
  setSessionName(name: string): void;
  appendEntry(customType: string, data?: unknown): void;
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
  ): void;
  registerCommand(
    name: string,
    options: {
      description: string;
      handler: (args: string | undefined, ctx: any) => unknown;
    },
  ): void;
  registerEntryRenderer(
    customType: string,
    renderer: (entry: any, options: { expanded: boolean }, theme: any) => unknown,
  ): void;
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: any,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: any,
    ) => Promise<unknown>;
  }): void;
}

export default function metrol(pi: PiLike) {
  const rootDir = path.join(os.homedir(), ".pi", "agent", "metrol");
  const instanceId = randomUUID();
  let selfEntry: RegistryEntry | undefined;
  let dispatcher: InboxDispatcher | undefined;
  // Status field source of truth; the registry is the durable mirror, the
  // StatusWriter keeps it in sync as pi events fire. metro_query reads from
  // selfEntry.lastActivity for the QuerySnapshot.
  let lastActivity = Date.now();
  // Incoming asks: FIFO, one active at a time. askSettled is resolved by the
  // single agent_settled handler registered in session_start.
  interface IncomingAsk {
    msg: Message;
    requestId: string;
    question: string;
  }
  let askQueue: AskQueue<IncomingAsk> | undefined;
  let askSettled: (() => void) | null = null;

  type LeaseMode = "manual" | "turn";
  const ownedLeases = new Map<string, LeaseMode>();
  const conflictNotices = new Set<string>();
  const leaseLocks = new Map<string, Promise<void>>();
  const withLeaseLock = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
    const previous = leaseLocks.get(name) ?? Promise.resolve();
    let unlock!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const queued = previous.then(() => gate);
    leaseLocks.set(name, queued);
    await previous;
    try {
      return await operation();
    } finally {
      unlock();
      if (leaseLocks.get(name) === queued) leaseLocks.delete(name);
    }
  };
  const leaseResource = (cwd: string, rawPath: string) => {
    const filePath = path.resolve(cwd, rawPath);
    return { filePath, name: leaseNameForPath(filePath) };
  };
  const releaseTurnLeases = async () => {
    const names = [...ownedLeases]
      .filter(([, mode]) => mode === "turn")
      .map(([name]) => name);
    try {
      await Promise.all(names.map((name) => withLeaseLock(name, async () => {
        if (ownedLeases.get(name) !== "turn") return;
        await releaseLease(rootDir, name, instanceId);
        ownedLeases.delete(name);
      })));
    } finally {
      conflictNotices.clear();
    }
  };
  const releaseAllLeases = async () => {
    try {
      await Promise.all([...ownedLeases.keys()].map((name) => withLeaseLock(name, async () => {
        await releaseLease(rootDir, name, instanceId);
        ownedLeases.delete(name);
      })));
    } finally {
      conflictNotices.clear();
    }
  };
  const notifyLeaseConflict = async (
    name: string,
    filePath: string,
    ctx: any,
  ) => {
    const owner = await readLease(rootDir, name);
    if (!owner || owner.instanceId === instanceId) return owner;
    const key = `${name}:${owner.instanceId}`;
    const peer = (await readRegistry(rootDir)).find(
      (entry) => entry.instanceId === owner.instanceId,
    );
    if (peer && !conflictNotices.has(key) && selfEntry) {
      conflictNotices.add(key);
      void sendDirect(
        rootDir,
        selfEntry,
        peer.instanceId,
        `Lease conflict: ${filePath} is currently held by ${peer.metroName}; this write was blocked.`,
        "all",
      ).catch(() => {});
    }
    ctx.ui?.notify?.(
      `blocked write: ${filePath} is leased by ${peer?.metroName ?? owner.instanceId}`,
      "warning",
    );
    return owner;
  };

  // Outgoing-ask liveness (Task 03): one monitor per non-terminal outgoing
  // ask, started right after enqueueAsk resolves a target. Stopped when a
  // terminal reply/fail is persisted, or by its own onFailure firing.
  const outgoingAskMonitors = new Map<string, LivenessMonitor>();
  const stopOutgoingAskMonitor = (requestId: string) => {
    outgoingAskMonitors.get(requestId)?.stop();
    outgoingAskMonitors.delete(requestId);
  };
  const recordOutgoingAskEvent = (requestId: string) => {
    outgoingAskMonitors.get(requestId)?.recordEvent();
  };
  const startOutgoingAskMonitor = (
    requestId: string,
    targetInstanceId: string,
    targetLabel: string,
  ) => {
    const monitor = livenessMonitor({
      requestId,
      targetInstanceId,
      rootDir,
      onFailure: (reason) => {
        outgoingAskMonitors.delete(requestId);
        pi.appendEntry("metrol:request", {
          requestId,
          target: targetLabel,
          status: "failed",
          reason: reason as FailReason,
          error: `liveness: ${reason}`,
          updatedAt: Date.now(),
        });
      },
    });
    outgoingAskMonitors.set(requestId, monitor);
    monitor.start();
  };
  /** Persist ACK-derived "accepted" and arm the liveness monitor. Shared by
   * the /metro ask command and the metro_ask tool. */
  const afterAskEnqueued = (
    r: { requestId: string; ack: string | null; targetInstanceId: string },
    target: string,
  ) => {
    if (!r.ack) {
      pi.appendEntry("metrol:request", {
        requestId: r.requestId,
        target,
        status: "accepted",
        updatedAt: Date.now(),
      });
    }
    startOutgoingAskMonitor(r.requestId, r.targetInstanceId, target);
  };

  // Outgoing-compact liveness: correlation map for metro_compact (Task 09).
  const compactPending = new CompactPendingMap();

  const callerRef = async (cwd: string): Promise<CallerRef> => ({
    instanceId,
    cwd,
    projectRoot: await findProjectRoot(cwd),
  });

  pi.registerCommand("metro", {
    description:
      "Metrol bus: /metro list [cwd|project|all] [--foreground|--exclude-subagents] · map · inbox · send [--all] <target> <msg> · broadcast [--project|--all] <msg> · query [--all] <target> <status|last_assistant_text> · ask [--all] <target> <question> · status · compact [--all] <target> [instructions] · read [requestId]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = parts.shift();
      if (sub === "map") {
        const caller = await callerRef(ctx.cwd);
        const sessions = await listSessions(rootDir, caller, "all");
        const self: SessionInfo | undefined = selfEntry && {
          metroName: `${selfEntry.metroName} (you)`,
          sessionName: selfEntry.sessionName,
          cwd: selfEntry.cwd,
          projectRoot: selfEntry.projectRoot,
          pid: selfEntry.pid,
          model: selfEntry.model,
          state: selfEntry.state,
          lastHeartbeat: selfEntry.lastHeartbeat,
          instanceId: selfEntry.instanceId,
        };
        ctx.ui.notify(
          formatMetroMap(self ? [self, ...sessions] : sessions),
          "info",
        );
        return;
      }
      if (sub === "inbox") {
        // Reads session entries only — the InboxDispatcher remains the sole
        // reader of inbox files.
        ctx.ui.notify(formatMetroInbox(ctx.sessionManager.getEntries()), "info");
        return;
      }
      if (sub === "list") {
        // Extract --foreground / --exclude-subagents anywhere in args;
        // first non-flag token is the scope (default project).
        let foregroundOnly = false;
        let subagentsOnly = false;
        const positional: string[] = [];
        for (const p of parts) {
          if (p === "--foreground") foregroundOnly = true;
          else if (p === "--exclude-subagents") subagentsOnly = true;
          else positional.push(p);
        }
        if (foregroundOnly && subagentsOnly) {
          ctx.ui.notify(
            "--foreground and --exclude-subagents are mutually exclusive",
            "warning",
          );
          return;
        }
        const scope = (positional[0] ?? "project") as string;
        if (!(SCOPES as readonly string[]).includes(scope)) {
          ctx.ui.notify(
            `Unknown scope "${positional[0]}" — use cwd, project, or all`,
            "warning",
          );
          return;
        }
        const filter: ListFilter = { foregroundOnly, subagentsOnly };
        const sessions = await listSessions(
          rootDir,
          await callerRef(ctx.cwd),
          scope as Scope,
          filter,
        );
        const header = `${sessions.length} metrol session(s) · scope ${scope}${
          foregroundOnly ? " · foreground" : subagentsOnly ? " · subagents" : ""
        }`;
        ctx.ui.notify(
          [header, ...sessions.map(formatSessionRow)].join("\n"),
          "info",
        );
        return;
      }
      if (sub === "send") {
        if (!selfEntry) {
          ctx.ui.notify("metrol not started yet", "warning");
          return;
        }
        let scope: Scope = "project";
        if (parts[0] === "--all") {
          scope = "all";
          parts.shift();
        }
        const target = parts.shift();
        const message = parts.join(" ");
        if (!target || !message) {
          ctx.ui.notify("Usage: /metro send [--all] <target> <message>", "warning");
          return;
        }
        try {
          const id = await sendDirect(rootDir, selfEntry, target, message, scope);
          pi.appendEntry("metrol:out", {
            id,
            to: target,
            type: "chat",
            preview: preview(message),
            timestamp: Date.now(),
          });
          ctx.ui.notify(`\u2192 ${target}: ${preview(message)}`, "info");
        } catch (err) {
          ctx.ui.notify(
            err instanceof Error ? err.message : String(err),
            "warning",
          );
        }
        return;
      }
      if (sub === "broadcast") {
        if (!selfEntry) {
          ctx.ui.notify("metrol not started yet", "warning");
          return;
        }
        let scope: Scope = "cwd";
        if (parts[0] === "--project" || parts[0] === "--all") {
          scope = parts[0] === "--all" ? "all" : "project";
          parts.shift();
        }
        const message = parts.join(" ");
        if (!message) {
          ctx.ui.notify(
            "Usage: /metro broadcast [--project|--all] <message>",
            "warning",
          );
          return;
        }
        const n = await broadcast(rootDir, selfEntry, message, scope);
        pi.appendEntry("metrol:out", {
          id: null,
          to: `broadcast:${scope}`,
          type: "chat",
          preview: preview(message),
          timestamp: Date.now(),
        });
        ctx.ui.notify(`broadcast to ${n} session(s) \u00b7 scope ${scope}`, "info");
        return;
      }
      if (sub === "query") {
        if (!selfEntry || !dispatcher) {
          ctx.ui.notify("metrol not started yet", "warning");
          return;
        }
        let scope: Scope = "project";
        if (parts[0] === "--all") {
          scope = "all";
          parts.shift();
        }
        const target = parts.shift();
        const kind = parts.shift();
        if (!target || !kind || !(QUERY_KINDS as readonly string[]).includes(kind)) {
          ctx.ui.notify(
            "Usage: /metro query [--all] <target> <status|last_assistant_text>",
            "warning",
          );
          return;
        }
        try {
          const r = await runQuery(rootDir, dispatcher, selfEntry, target, kind, scope);
          pi.appendEntry("metrol:request", {
            requestId: r.id,
            target,
            kind,
            status: r.error ? "failed" : "answered",
            reply: r.value,
            updatedAt: Date.now(),
          });
          if (r.error) {
            ctx.ui.notify(`query ${target}: ${r.error}`, "warning");
            return;
          }
          const p = r.value as { error?: string } | undefined;
          if (p?.error) {
            ctx.ui.notify(`query ${target}: ${p.error}`, "warning");
            return;
          }
          ctx.ui.notify(
            `${target} · ${kind}:\n${JSON.stringify((p as { value: unknown }).value, null, 2)}`,
            "info",
          );
        } catch (err) {
          ctx.ui.notify(
            err instanceof Error ? err.message : String(err),
            "warning",
          );
        }
        return;
      }
      if (sub === "ask") {
        if (!selfEntry || !dispatcher) {
          ctx.ui.notify("metrol not started yet", "warning");
          return;
        }
        let scope: Scope = "project";
        if (parts[0] === "--all") {
          scope = "all";
          parts.shift();
        }
        const target = parts.shift();
        const question = parts.join(" ");
        if (!target || !question) {
          ctx.ui.notify("Usage: /metro ask [--all] <target> <question>", "warning");
          return;
        }
        try {
          const r = await enqueueAsk(
            rootDir,
            dispatcher,
            selfEntry,
            target,
            question,
            scope,
            (data) => pi.appendEntry("metrol:request", data),
          );
          afterAskEnqueued(r, target);
          ctx.ui.notify(
            `ask queued \u2192 ${target} \u00b7 ${r.requestId}${r.ack ? ` \u00b7 ack: ${r.ack}` : " \u00b7 acked"}`,
            r.ack ? "warning" : "info",
          );
        } catch (err) {
          ctx.ui.notify(
            err instanceof Error ? err.message : String(err),
            "warning",
          );
        }
        return;
      }
      if (sub === "read") {
        const r = findRequest(ctx.sessionManager.getEntries(), parts[0]);
        if (!r.ok) {
          ctx.ui.notify(r.error, "warning");
          return;
        }
        ctx.ui.notify(JSON.stringify(r.request, null, 2), "info");
        return;
      }
      if (sub === "status") {
        const self: SessionInfo | undefined = selfEntry && {
          metroName: selfEntry.metroName,
          sessionName: selfEntry.sessionName,
          cwd: selfEntry.cwd,
          projectRoot: selfEntry.projectRoot,
          pid: selfEntry.pid,
          model: selfEntry.model,
          state: selfEntry.state,
          lastHeartbeat: selfEntry.lastHeartbeat,
          instanceId: selfEntry.instanceId,
          stateSince: selfEntry.stateSince,
          activeToolName: selfEntry.activeToolName,
          contextUsage: selfEntry.contextUsage,
          lastActivity: selfEntry.lastActivity,
        };
        const caller = await callerRef(ctx.cwd);
        const peers = await listSessions(rootDir, caller, "all");
        const recentRequests = rebuildRequests(ctx.sessionManager.getEntries());
        ctx.ui.notify(formatMetroStatus(self, peers, recentRequests), "info");
        return;
      }
      if (sub === "compact") {
        if (!selfEntry) {
          ctx.ui.notify("metrol not started yet", "warning");
          return;
        }
        let scope: Scope = "project";
        if (parts[0] === "--all") {
          scope = "all";
          parts.shift();
        }
        const target = parts.shift();
        const instructions = parts.join(" ") || undefined;
        if (!target) {
          ctx.ui.notify("Usage: /metro compact [--all] <target> [instructions]", "warning");
          return;
        }
        try {
          const outcome = await requestCompact(
            rootDir,
            compactPending,
            selfEntry,
            target,
            instructions,
            scope,
            (data) => pi.appendEntry("metrol:request", data),
          );
          ctx.ui.notify(
            outcome.status === "ok"
              ? `compacted \u2192 ${target}`
              : `compact \u2192 ${target}: ${outcome.status}${outcome.status === "failed" ? ` (${outcome.error})` : ""}`,
            outcome.status === "ok" ? "info" : "warning",
          );
        } catch (err) {
          ctx.ui.notify(
            err instanceof Error ? err.message : String(err),
            "warning",
          );
        }
        return;
      }
      ctx.ui.notify(
        "Usage: /metro list [cwd|project|all] | map | inbox | send [--all] <target> <msg> | broadcast [--project|--all] <msg> | query [--all] <target> <status|last_assistant_text> | ask [--all] <target> <question> | status | compact [--all] <target> [instructions] | read [requestId]",
        "warning",
      );
    },
  });

  pi.registerTool({
    name: "metro_list_sessions",
    label: "Metro List Sessions",
    description:
      "List other live Metrol Pi sessions: cwd = same directory, project (default) = same git root, all = every session. Use metro_select_peer to pick the best idle peer (lowest context usage) instead of picking one yourself.",
    parameters: Type.Object({
      scope: Type.Optional(StringEnum(SCOPES, { default: "project" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessions = await listSessions(
        rootDir,
        await callerRef(ctx.cwd),
        params.scope ?? "project",
      );
      return {
        content: [{ type: "text", text: JSON.stringify(sessions, null, 2) }],
        details: { sessions },
      };
    },
  });

  pi.registerTool({
    name: "metro_select_peer",
    label: "Metro Select Peer",
    description:
      "Pick the best Metrol peer for an ask or notification: prefer idle, then lower context usage. targetHint (optional) forces a specific metroName or instanceId when present in scope. scope: cwd | project (default) | all.",
    parameters: Type.Object({
      targetHint: Type.Optional(Type.String()),
      scope: Type.Optional(StringEnum(SCOPES, { default: "project" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const caller = await callerRef(ctx.cwd);
      const scope: Scope = params.scope ?? "project";
      const all = await listSessions(rootDir, caller, scope);
      const hint = params.targetHint;
      const pool = hint
        ? all.filter((s) => s.metroName === hint || s.instanceId === hint)
        : all;
      const picked = selectPeer(pool.length > 0 ? pool : all, caller, { scope });
      if (!picked) {
        return {
          content: [{ type: "text", text: "no peer matched" }],
          details: { error: "no_peer" },
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(picked, null, 2) }],
        details: { peer: picked },
      };
    },
  });

  pi.registerTool({
    name: "metro_whoami",
    label: "Metro Whoami",
    description:
      "Return the calling session's own Metrol identity (alias, instanceId, sessionName, model, cwd). Use this before composing any message that mentions your own alias — the bus metadata is the source of truth for sender identity, and self-identification in the message body is not verified.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      if (!selfEntry) {
        return {
          content: [{ type: "text", text: "metrol not started yet" }],
          details: { error: "not_started" },
        };
      }
      return {
        content: [
          { type: "text", text: JSON.stringify(selfEntry, null, 2) },
        ],
        details: { self: selfEntry },
      };
    },
  });

  pi.registerTool({
    name: "metro_claim",
    label: "Metro Claim",
    description:
      "Claim one or more file paths before a multi-step edit. Claims are atomic; if another Metrol session owns any path, none are acquired. Structured write/edit calls are lease-checked automatically.",
    parameters: Type.Object({
      paths: Type.Array(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!selfEntry) {
        return {
          content: [{ type: "text", text: "metrol not started yet" }],
          details: { error: "not_started" },
        };
      }
      const paths = [...new Set(
        (Array.isArray(params.paths) ? params.paths : []).filter(
          (p): p is string => typeof p === "string" && p.length > 0,
        ),
      )];
      if (paths.length === 0) {
        return {
          content: [{ type: "text", text: "paths must not be empty" }],
          details: { error: "invalid_paths" },
        };
      }
      const resources = [...new Map(
        paths.map((raw) => {
          const resource = leaseResource(ctx.cwd, raw);
          return [resource.name, resource] as const;
        }),
      ).values()];
      const acquired: string[] = [];
      const upgraded = new Map<string, LeaseMode>();
      for (const resource of [...resources].sort((a, b) => a.name.localeCompare(b.name))) {
        const result = await withLeaseLock(resource.name, async () => {
          const previousMode = ownedLeases.get(resource.name);
          if (previousMode) {
            if (previousMode === "turn") upgraded.set(resource.name, previousMode);
            ownedLeases.set(resource.name, "manual");
            return { ok: true, fresh: false };
          }
          if (!(await claimLease(rootDir, resource.name, instanceId))) {
            return { ok: false, fresh: false };
          }
          ownedLeases.set(resource.name, "manual");
          return { ok: true, fresh: true };
        });
        if (!result.ok) {
          await Promise.all(acquired.map((name) => withLeaseLock(name, async () => {
            await releaseLease(rootDir, name, instanceId).catch(() => {});
            ownedLeases.delete(name);
          })));
          for (const [name, mode] of upgraded) ownedLeases.set(name, mode);
          const owner = await notifyLeaseConflict(resource.name, resource.filePath, ctx);
          return {
            content: [{ type: "text", text: `lease conflict for ${resource.filePath}` }],
            details: { error: "conflict", path: resource.filePath, owner },
          };
        }
        if (result.fresh) acquired.push(resource.name);
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ claimed: resources.map((r) => r.filePath) }) }],
        details: { claimed: resources.map((r) => r.filePath) },
      };
    },
  });

  pi.registerTool({
    name: "metro_release",
    label: "Metro Release",
    description: "Release file claims owned by this Metrol session. Omit paths to release all claims.",
    parameters: Type.Object({
      paths: Type.Optional(Type.Array(Type.String())),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!selfEntry) {
        return {
          content: [{ type: "text", text: "metrol not started yet" }],
          details: { error: "not_started" },
        };
      }
      const paths = (params.paths as unknown[] | undefined)?.filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      ) ?? [];
      const resources = paths.length
        ? [...new Set(paths.map((raw) => leaseResource(ctx.cwd, raw).name))]
        : [...ownedLeases.keys()];
      await Promise.all(resources.map((name) => withLeaseLock(name, async () => {
        await releaseLease(rootDir, name, instanceId);
        ownedLeases.delete(name);
      })));
      return {
        content: [{ type: "text", text: JSON.stringify({ released: resources.length }) }],
        details: { released: resources.length },
      };
    },
  });

  pi.registerTool({
    name: "metro_publish",
    label: "Metro Publish",
    description:
      "Send a chat message to another live Metrol session by alias or instanceId, or broadcast with target \"*\". scope: cwd | project (default) | all. triggerTurn=true delivers as an idle-gated user-turn on the receiver (debounced + batched) instead of a plain chat notification — use metro_ask instead if you need a reply back. If you refer to yourself by alias in the message, run metro_whoami first; the bus metadata (Message.from) is the authoritative sender identity for recipients, not anything you type in the body.",
    parameters: Type.Object({
      target: Type.String(),
      message: Type.String(),
      scope: Type.Optional(StringEnum(SCOPES, { default: "project" })),
      triggerTurn: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!selfEntry) {
        return {
          content: [{ type: "text", text: "metrol not started yet" }],
          details: { error: "not_started" },
        };
      }
      const scope: Scope = params.scope ?? "project";
      const triggerTurn = params.triggerTurn ?? false;
      const msgType = triggerTurn ? "trigger" : "chat";
      let id: string | null = null;
      let recipients: number;
      try {
        if (params.target === "*") {
          recipients = await broadcast(rootDir, selfEntry, params.message, scope, msgType);
        } else {
          id = await sendDirect(
            rootDir,
            selfEntry,
            params.target,
            params.message,
            scope,
            msgType,
          );
          recipients = 1;
        }
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text }], details: { error: text } };
      }
      pi.appendEntry("metrol:out", {
        id,
        to: params.target,
        type: msgType,
        preview: preview(params.message),
        timestamp: Date.now(),
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ id, recipients, triggerTurn }) }],
        details: { id, recipients, triggerTurn },
      };
    },
  });

  pi.registerTool({
    name: "metro_delegate",
    label: "Metro Delegate",
    description:
      "Send a task to an idle peer (lowest context usage preferred) and optionally wait for the result. Composes metro_select_peer + metro_ask. scope: cwd | project (default) | all. targetHint forces a specific peer. waitForReply blocks until the answer lands (or timeoutMs).",
    parameters: Type.Object({
      question: Type.String(),
      scope: Type.Optional(StringEnum(SCOPES, { default: "project" })),
      targetHint: Type.Optional(Type.String()),
      waitForReply: Type.Optional(Type.Boolean({ default: false })),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!selfEntry || !dispatcher) {
        return {
          content: [{ type: "text", text: "metrol not started yet" }],
          details: { error: "not_started" },
        };
      }
      const caller = await callerRef(ctx.cwd);
      const result: DelegateResult = await runDelegate({
        rootDir,
        dispatcher,
        callerEntry: selfEntry,
        caller,
        options: {
          question: params.question,
          scope: params.scope ?? "project",
          targetHint: params.targetHint,
          waitForReply: params.waitForReply ?? false,
          timeoutMs: params.timeoutMs,
        },
        appendAskEntry: (data) => pi.appendEntry("metrol:request", data),
        appendHandoffEntry: (data) => pi.appendEntry("metrol:handoff", data),
        getEntries: () => ctx.sessionManager.getEntries(),
      });
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `no idle peer in scope ${result.scope}` }],
          details: { error: result.error, scope: result.scope },
        };
      }
      if (result.status === "queued") {
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      }
      const isTimeout = result.status === "timeout";
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result),
          },
        ],
        details: result,
        ...(isTimeout ? { isError: false } : {}),
      };
    },
  });

  pi.registerTool({
    name: "metro_query",
    label: "Metro Query",
    description:
      "Short non-LLM lookup on another live Metrol session: status (names, cwd, project, model, thinking level, idle/busy, current context usage, last activity) or last_assistant_text. scope: cwd | project (default) | all.",
    parameters: Type.Object({
      target: Type.String(),
      kind: StringEnum(QUERY_KINDS),
      scope: Type.Optional(StringEnum(SCOPES, { default: "project" })),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!selfEntry || !dispatcher) {
        return {
          content: [{ type: "text", text: "metrol not started yet" }],
          details: { error: "not_started" },
        };
      }
      try {
        const r = await runQuery(
          rootDir,
          dispatcher,
          selfEntry,
          params.target,
          params.kind,
          params.scope ?? "project",
          params.timeoutMs ?? 10_000,
        );
        pi.appendEntry("metrol:request", {
          requestId: r.id,
          target: params.target,
          kind: params.kind,
          status: r.error ? "failed" : "answered",
          reply: r.value,
          updatedAt: Date.now(),
        });
        const p = r.value as { value?: unknown; error?: string } | undefined;
        if (r.error) {
          return {
            content: [{ type: "text", text: r.error }],
            details: { error: r.error, requestId: r.id },
          };
        }
        if (p?.error) {
          return {
            content: [{ type: "text", text: p.error }],
            details: { error: p.error, requestId: r.id },
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(p?.value ?? null) }],
          details: { requestId: r.id, value: p?.value },
        };
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text }], details: { error: text } };
      }
    },
  });

  pi.registerTool({
    name: "metro_ask",
    label: "Metro Ask",
    description:
      "Queue a context-aware question on another live Metrol session. Returns immediately with { requestId, status: \"queued\" }; the target agent answers using its own session context and the reply arrives later. Use metro_read(requestId) to poll the state/reply. scope: cwd | project (default) | all. Sender identity on the bus is taken from Message.from, not from the question text — do not introduce your alias into the question body to identify yourself.",
    parameters: Type.Object({
      target: Type.String(),
      question: Type.String(),
      scope: Type.Optional(StringEnum(SCOPES, { default: "project" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!selfEntry || !dispatcher) {
        return {
          content: [{ type: "text", text: "metrol not started yet" }],
          details: { error: "not_started" },
        };
      }
      try {
        const r = await enqueueAsk(
          rootDir,
          dispatcher,
          selfEntry,
          params.target,
          params.question,
          params.scope ?? "project",
          (data) => pi.appendEntry("metrol:request", data),
        );
        afterAskEnqueued(r, params.target);
        return {
          content: [{ type: "text", text: JSON.stringify(r) }],
          details: r,
        };
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text }], details: { error: text } };
      }
    },
  });

  pi.registerTool({
    name: "metro_read",
    label: "Metro Read",
    description:
      "Read the latest state/reply of a Metrol request (from metro_ask or metro_query) by requestId, or the most recent request when omitted. States: queued | accepted | running | answered | failed. Rebuilt from persisted session entries, so late replies stay readable.",
    parameters: Type.Object({
      requestId: Type.Optional(Type.String()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const r = findRequest(ctx.sessionManager.getEntries(), params.requestId);
      if (!r.ok) {
        return {
          content: [{ type: "text", text: r.error }],
          details: { error: "not_found", requestId: params.requestId },
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(r.request, null, 2) }],
        details: { request: r.request },
      };
    },
  });

  pi.registerTool({
    name: "metro_compact",
    label: "Metro Compact",
    description:
      "Ask another live Metrol session to compact its context window and wait until it finishes (default timeout 3 min). Busy or unsupported targets decline immediately — this never queues like metro_ask does. scope: cwd | project (default) | all.",
    parameters: Type.Object({
      target: Type.String(),
      instructions: Type.Optional(Type.String()),
      scope: Type.Optional(StringEnum(SCOPES, { default: "project" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!selfEntry) {
        return {
          content: [{ type: "text", text: "metrol not started yet" }],
          details: { error: "not_started" },
        };
      }
      try {
        const outcome = await requestCompact(
          rootDir,
          compactPending,
          selfEntry,
          params.target,
          params.instructions,
          params.scope ?? "project",
          (data) => pi.appendEntry("metrol:request", data),
        );
        const isError = outcome.status !== "ok";
        return {
          content: [{ type: "text", text: JSON.stringify(outcome) }],
          details: { outcome, error: isError ? outcome.status : undefined },
        };
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text }], details: { error: text } };
      }
    },
  });

  // Compact TUI renderers for metrol custom entries (single-line Text).
  for (const customType of [
    "metrol:identity",
    "metrol:request",
    "metrol:in",
    "metrol:out",
    "metrol:handoff",
  ]) {
    pi.registerEntryRenderer(customType, (entry) => {
      const line = formatEntryLine(customType, entry.data);
      return new Text(line ?? `[metro] ${customType}`);
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    await mkdir(rootDir, { recursive: true, mode: 0o700 });

    // Recover previous auto-assigned alias from custom entries (latest wins).
    let previousAlias: string | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "metrol:identity") {
        const name = entry.data?.metroName;
        if (typeof name === "string") previousAlias = name;
      }
    }

    const metroName = await claimMetroAlias(rootDir, instanceId, previousAlias);

    const sessionName: string | undefined = ctx.sessionManager.getSessionName();
    if (sessionName === undefined || sessionName === previousAlias) {
      pi.setSessionName(metroName);
    }
    pi.appendEntry("metrol:identity", { metroName, instanceId });

    const projectRoot = await findProjectRoot(ctx.cwd);
    const now = Date.now();
    const parentInstanceId = process.env.METROL_PARENT_INSTANCE_ID || undefined;
    const entry: RegistryEntry = {
      version: 1,
      instanceId,
      sessionId: ctx.sessionManager.getSessionId?.(),
      metroName,
      sessionName,
      cwd: ctx.cwd,
      projectRoot,
      pid: process.pid,
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      state: "idle",
      startedAt: now,
      lastHeartbeat: now,
      parentInstanceId,
      ...initialStatus(now),
    };
    await writeRegistryEntry(rootDir, entry);
    selfEntry = entry;
    lastActivity = now;

    // Status writer: every status-changing event flows through here so the
    // registry and the in-memory entry stay in lock-step, with throttling on
    // non-transition churn and immediate writes on state transitions.
    const statusWriter = new StatusWriter(rootDir, entry, {
      now: () => Date.now(),
      getContextUsage: () => ctx.getContextUsage(),
      writeFull: async (dir, fullEntry) => {
        await writeRegistryEntry(dir, fullEntry).catch(() => {});
      },
      setLastActivity: (ts) => {
        lastActivity = ts;
      },
    });

    // Lease gates structured file mutations before they execute. A turn lease
    // is automatic; metro_claim upgrades a path to a durable session lease.
    pi.on("tool_call", async (event, callCtx) => {
      if (!selfEntry || (event.toolName !== "write" && event.toolName !== "edit")) {
        return;
      }
      const rawPath = event.input?.path;
      if (typeof rawPath !== "string" || rawPath.length === 0) return;
      const { filePath, name } = leaseResource(callCtx.cwd, rawPath);
      return withLeaseLock(name, async () => {
        if (ownedLeases.has(name)) return;
        if (await claimLease(rootDir, name, instanceId)) {
          ownedLeases.set(name, "turn");
          return;
        }
        const owner = await notifyLeaseConflict(name, filePath, callCtx);
        if (!owner || owner.instanceId === instanceId) {
          if (await claimLease(rootDir, name, instanceId)) {
            ownedLeases.set(name, "turn");
            return;
          }
        }
        return {
          block: true,
          reason: `Metrol lease conflict: ${filePath} is owned by ${owner?.instanceId ?? "another session"}`,
        };
      });
    });

    // Keep coordination guidance in code rather than requiring AGENTS.md.
    const coordinationPrompt =
      "Metrol coordination: write/edit calls are automatically blocked when another session holds a file lease. Use metro_claim before multi-step edits, and do not bypass a blocked write with bash.";
    pi.on("before_agent_start", (event) => {
      if (event.systemPrompt.includes(coordinationPrompt)) return;
      return { systemPrompt: `${event.systemPrompt}\n\n${coordinationPrompt}` };
    });

    // Incoming ask FIFO: one active ask at a time. The run injects the ask
    // as a user message, waits for that request's run to settle (matched by
    // the marker in the injected prompt), then replies and persists state.
    const runIncomingAsk = async (item: IncomingAsk): Promise<void> => {
      if (!selfEntry) return;
      const { msg, requestId, question } = item;
      const persist = (status: RequestRecord["status"], extra: Partial<RequestRecord> = {}) =>
        pi.appendEntry("metrol:request", {
          requestId,
          target: msg.from.metroName,
          status,
          question,
          updatedAt: Date.now(),
          ...extra,
        });
      persist("running");
      // Informational ping so the sender's liveness monitor resets its clock
      // and can persist "running" — best-effort, never blocks the ask flow.
      void sendProgress(rootDir, selfEntry, msg, requestId, "started").catch(() => {});
      try {
        const prompt = formatAskPrompt({ requestId, question, from: msg.from });
        if (ctx.isIdle()) {
          pi.sendUserMessage(prompt);
        } else {
          pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        persist("failed", { error });
        await replyAsk(rootDir, selfEntry, msg, { status: "failed", error });
        return;
      }
      // ponytail: waits until a settled run contains this request's marker;
      // if the followUp is never delivered (the documented Pi platform race
      // where steered/followUp messages sent mid-run can be dropped), this
      // hangs forever — the deadline below caps it so the queue slot
      // releases and the next queued ask can proceed.
      const ASK_DEADLINE_MS = 5 * 60 * 1000;
      const outcome = await new Promise<AskOutcome>((resolve) => {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const check = () => {
          const o = extractAskReply(ctx.sessionManager.getBranch(), requestId);
          if (o) {
            if (deadline) clearTimeout(deadline);
            askSettled = null;
            resolve(o);
          }
        };
        askSettled = check;
        check();
        deadline = setTimeout(() => {
          askSettled = null;
          resolve({ status: "failed", error: "deadline_exceeded", reason: "deadline_exceeded" });
        }, ASK_DEADLINE_MS);
        deadline.unref?.();
      });
      if (outcome.status === "answered") {
        persist("answered", { reply: outcome.reply });
      } else {
        persist("failed", { error: outcome.error });
      }
      await replyAsk(rootDir, selfEntry, msg, outcome);
    };
    askQueue = new AskQueue<IncomingAsk>(runIncomingAsk);

    // Single inbox dispatcher: sole reader of this instance's inbox.
    const triggers = new TriggerBuffer({
      isIdle: () => ctx.isIdle(),
      deliver: (prompt) => {
        pi.sendUserMessage(prompt);
        return { kind: "delivered" };
      },
      deliverFollowUp: (prompt) => {
        pi.sendUserMessage(prompt, { deliverAs: "followUp" });
        return { kind: "deferred" };
      },
    });

    /** Rank-based persist for an incoming ACK-substitute/progress/reply/fail
     * update on an OUTGOING ask. Ignores stale/duplicate/regressive updates
     * (e.g. a late PROGRESS after REPLY, or a duplicate ACK) via
     * applyRankedTransition — terminal states are sticky. */
    const persistRankedAskUpdate = (
      requestId: string,
      target: string,
      incoming: RequestRecord["status"],
      extra: Partial<RequestRecord> = {},
    ) => {
      const existing = findRequest(ctx.sessionManager.getEntries(), requestId);
      const current = existing.ok ? existing.request.status : "queued";
      const winner = applyRankedTransition(current, incoming);
      if (winner !== incoming) return; // current already wins; ignore stale/duplicate
      pi.appendEntry("metrol:request", {
        requestId,
        target,
        status: winner,
        updatedAt: Date.now(),
        ...extra,
      });
    };

    dispatcher = new InboxDispatcher(
      await safeInboxDir(rootDir, instanceId),
      {
      onChat: (msg) => {
        const p = msg.payload as { text?: unknown };
        const text = typeof p?.text === "string" ? p.text : JSON.stringify(p);
        const label = msg.from.sessionName
          ? `${msg.from.metroName} · ${msg.from.sessionName}`
          : msg.from.metroName;
        ctx.ui.notify(`[metro] ${label}: ${preview(text)}`, "info");
        pi.appendEntry("metrol:in", {
          id: msg.id,
          from: msg.from.metroName,
          preview: preview(text),
          timestamp: msg.timestamp,
        });
      },
      onTrigger: (msg) => {
        const p = msg.payload as { text?: unknown };
        const content = typeof p?.text === "string" ? p.text : "";
        const item: TriggerItem = { from: msg.from, content };
        const enqueueResult = triggers.enqueue(item);
        const inboxEntry: Record<string, unknown> = {
          id: msg.id,
          from: msg.from.metroName,
          preview: preview(content),
          timestamp: msg.timestamp,
          triggerTurn: true,
        };
        if (enqueueResult.droppedCount > 0) {
          // Surface the overflow so the user can see in their inbox log
          // that peer messages were dropped due to queue saturation. The
          // dropped sample is capped at 5 items by TriggerBuffer.
          inboxEntry.queueOverflow = {
            droppedCount: enqueueResult.droppedCount,
            droppedFrom: enqueueResult.droppedSamples.map(
              (it) =>
                it.from.sessionName
                  ? `${it.from.metroName} · ${it.from.sessionName}`
                  : it.from.metroName,
            ),
          };
        }
        pi.appendEntry("metrol:in", inboxEntry);
      },
      onQuery: async (msg) => {
        if (!selfEntry) return;
        const snap: QuerySnapshot = {
          metroName: selfEntry.metroName,
          sessionName: selfEntry.sessionName,
          cwd: selfEntry.cwd,
          projectRoot: selfEntry.projectRoot,
          model: selfEntry.model,
          thinkingLevel: ctx.thinkingLevel,
          state: ctx.isIdle() ? "idle" : "running",
          contextUsage: ctx.getContextUsage() ?? undefined,
          lastActivity,
          branch: ctx.sessionManager.getBranch(),
        };
        await handleQuery(rootDir, selfEntry, msg, snap);
      },
      onAsk: async (msg) => {
        if (!selfEntry) return;
        const p = msg.payload as { requestId?: unknown; question?: unknown };
        const requestId = typeof p?.requestId === "string" ? p.requestId : msg.id;
        const question = typeof p?.question === "string" ? p.question : "";
        const accepted = askQueue?.enqueue({ msg, requestId, question }) ?? false;
        if (!accepted) {
          await sendFail(rootDir, selfEntry, msg, requestId, "busy", "ask queue full (max 4)");
          pi.appendEntry("metrol:request", {
            requestId,
            target: msg.from.metroName,
            status: "failed",
            reason: "busy" as FailReason,
            question,
            updatedAt: Date.now(),
          });
          return;
        }
        await ackAsk(rootDir, selfEntry, msg);
        pi.appendEntry("metrol:request", {
          requestId,
          target: msg.from.metroName,
          status: "accepted",
          question,
          updatedAt: Date.now(),
        });
      },
      onProgress: (msg) => {
        const p = msg.payload as { requestId?: unknown } | null;
        if (typeof p?.requestId !== "string") return;
        recordOutgoingAskEvent(p.requestId);
        persistRankedAskUpdate(p.requestId, msg.from.metroName, "running");
      },
      onFail: (msg) => {
        const p = msg.payload as { requestId?: unknown; reason?: unknown; error?: unknown } | null;
        if (typeof p?.requestId !== "string") return;
        stopOutgoingAskMonitor(p.requestId);
        persistRankedAskUpdate(p.requestId, msg.from.metroName, "failed", {
          reason: typeof p.reason === "string" ? (p.reason as FailReason) : undefined,
          error: typeof p.error === "string" ? p.error : undefined,
        });
      },
      onReply: (msg) => {
        // Late ask replies land here (ack/final reply were not awaited).
        const p = msg.payload as {
          requestId?: unknown;
          status?: unknown;
          reply?: unknown;
          error?: unknown;
        };
        if (typeof p?.requestId !== "string") return;
        if (p.status !== "answered" && p.status !== "failed") return;
        stopOutgoingAskMonitor(p.requestId);
        persistRankedAskUpdate(p.requestId, msg.from.metroName, p.status, {
          reply: typeof p.reply === "string" ? p.reply : undefined,
          error: typeof p.error === "string" ? p.error : undefined,
        });
      },
      onCompactRequest: async (msg) => {
        if (!selfEntry) return;
        const decision = decideCompactResponse({
          agentRunning: !ctx.isIdle(),
          hasCompactCapability: typeof ctx.compact === "function",
        });
        if (!decision.ok) {
          await respondCompact(rootDir, selfEntry, msg, decision);
          return;
        }
        const p = msg.payload as CompactRequestPayload | null;
        const instructions = typeof p?.instructions === "string" ? p.instructions : undefined;
        const self = selfEntry;
        try {
          ctx.compact({
            customInstructions: instructions,
            onComplete: () => {
              void respondCompact(rootDir, self, msg, { ok: true });
            },
            onError: () => {
              // CompactDecision's ok:false branch only models busy/unsupported;
              // a runtime compaction failure is reported the same way the
              // caller already handles "unsupported" (retry or ask elsewhere).
              void respondCompact(rootDir, self, msg, { ok: false, reason: "unsupported" });
            },
          });
        } catch {
          await respondCompact(rootDir, self, msg, { ok: false, reason: "unsupported" });
        }
      },
      onCompactResponse: (msg) => {
        // compact.ts owns its own correlation map, independent of this
        // dispatcher's internal `pending` — always forward here.
        compactPending.resolve(msg);
      },
      },
      { onWakeUp: () => { void dispatcher?.poll(); } },
    );
    dispatcher.start();

    if (!isSweepDisabled()) {
      // Drop stale registry files, alias claims, and instance directories
      // left behind by crashed/shut-down neighbors. One snapshot of
      // readRegistry() drives the live-instance-id set for the claim and
      // instance-dir sweeps; the registry-file sweep uses its own identical
      // staleness test. See src/sweep.ts for boundary + idempotence.
      sweepMetrolStorage(rootDir).catch(() => {});

      // Periodic re-sweep so a long-running session doesn't accumulate stale
      // state from neighbors that died earlier in its lifetime.
      const storageSweepTimer = setInterval(() => {
        void sweepMetrolStorage(rootDir);
      }, STORAGE_SWEEP_INTERVAL_MS);
      storageSweepTimer.unref();
    }

    const heartbeat = setInterval(() => {
      void statusWriter.heartbeat();
      for (const name of [...ownedLeases.keys()]) {
        void withLeaseLock(name, async () => {
          if (!ownedLeases.has(name)) return;
          const renewed = await renewLease(rootDir, name, instanceId);
          if (!renewed) ownedLeases.delete(name);
        }).catch(() => {});
      }
    }, heartbeatDelayMs());
    heartbeat.unref();

    pi.on("session_info_changed", (event) => {
      // Never touch metroName; only the mutable display label.
      void statusWriter.sessionInfoChanged(event.name);
    });

    pi.on("tool_execution_start", (event) => {
      void statusWriter.toolStart(event.toolName);
    });
    pi.on("tool_execution_end", () => {
      void statusWriter.toolEnd();
    });

    pi.on("agent_start", () => {
      void statusWriter.agentStart();
    });
    // agent_end is intentionally NOT a state transition: agent_settled is
    // the canonical idle predicate (retries/compaction/queued continuations
    // may follow agent_end).
    pi.on("agent_settled", () => {
      void statusWriter.agentSettled();
      void releaseTurnLeases();
      askSettled?.();
    });
    // Fallback safety net: if a queued/followUp-delivered ask prompt is ever
    // silently stranded by the documented Pi platform race (steering/followUp
    // messages sent mid-run can be dropped), agent_settled for that specific
    // run may never fire. Re-check on agent_end too, but only when the
    // runtime has explicitly told us `willRetry === false` (checking during
    // a pending retry risks resolving the ask on a partial/failed attempt
    // right before a successful retry). The `event?.willRetry === false`
    // guard, not `!event?.willRetry`, so a missing willRetry field is treated
    // as "not safe to fire" rather than "safe to fire".
    pi.on("agent_end", (event) => {
      if (event?.willRetry === false) askSettled?.();
    });

    pi.on("session_shutdown", async () => {
      clearInterval(heartbeat);
      clearInterval(storageSweepTimer);
      triggers.shutdown();
      compactPending.clear();
      for (const monitor of outgoingAskMonitors.values()) monitor.stop();
      outgoingAskMonitors.clear();
      await dispatcher?.stop().catch(() => {});
      await releaseAllLeases().catch(() => {});
      await removeRegistryEntry(rootDir, instanceId).catch(() => {});
      await releaseMetroAlias(rootDir, metroName, instanceId).catch(() => {});
    });
  });
}
