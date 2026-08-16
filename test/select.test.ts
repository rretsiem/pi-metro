import { test } from "node:test";
import assert from "node:assert/strict";
import { selectPeer } from "../src/select.ts";
import type { CallerRef, SessionInfo } from "../src/list.ts";

const CALLER: CallerRef = {
  instanceId: "a1a1a1a1",
  cwd: "/work/app/api",
  projectRoot: "/work/app",
};

function peer(over: Partial<SessionInfo> & { instanceId: string }): SessionInfo {
  return {
    metroName: "Peer-" + over.instanceId,
    cwd: "/work/app/api",
    projectRoot: "/work/app",
    pid: 1,
    state: "idle",
    lastHeartbeat: 0,
    ...over,
  };
}

test("selectPeer: idle peer wins over running peer", () => {
  const idle = peer({ instanceId: "abcdef04", metroName: "Idle" });
  const busy = peer({ instanceId: "abcdef03", metroName: "Busy", state: "running" });
  assert.equal(selectPeer([busy, idle], CALLER)?.instanceId, "abcdef04");
});

test("selectPeer: lower contextUsage.tokens wins among equally-idle peers", () => {
  const light = peer({
    instanceId: "abcdef02",
    contextUsage: { tokens: 1_000, contextWindow: 100_000 },
  });
  const heavy = peer({
    instanceId: "abcdef08",
    contextUsage: { tokens: 50_000, contextWindow: 100_000 },
  });
  assert.equal(selectPeer([heavy, light], CALLER)?.instanceId, "abcdef02");
});

test("selectPeer: missing contextUsage is treated as best-case (0 tokens)", () => {
  const unknown = peer({ instanceId: "abcdef07" }); // no contextUsage
  const known = peer({
    instanceId: "abcdef06",
    contextUsage: { tokens: 5_000, contextWindow: 100_000 },
  });
  assert.equal(selectPeer([known, unknown], CALLER)?.instanceId, "abcdef07");
});

test("selectPeer: idle beats running even when running reports lower tokens", () => {
  const idle = peer({ instanceId: "abcdef04" }); // no contextUsage → 0
  const busy = peer({
    instanceId: "abcdef03",
    state: "running",
    contextUsage: { tokens: 0, contextWindow: 100_000 },
  });
  assert.equal(selectPeer([busy, idle], CALLER)?.instanceId, "abcdef04");
});

test("selectPeer: default scope 'project' excludes cross-project peers", () => {
  const same = peer({ instanceId: "abcdef09" });
  const cross = peer({
    instanceId: "abcdef05",
    metroName: "Cross",
    cwd: "/elsewhere/x",
    projectRoot: "/elsewhere",
  });
  assert.equal(selectPeer([same, cross], CALLER)?.instanceId, "abcdef09");
});

test("selectPeer: scope 'all' lets cross-project peers in (verified by selection)", () => {
  const same = peer({
    instanceId: "abcdef09",
    contextUsage: { tokens: 50_000, contextWindow: 100_000 },
  });
  const cross = peer({
    instanceId: "abcdef05",
    metroName: "Cross",
    cwd: "/elsewhere/x",
    projectRoot: "/elsewhere",
    contextUsage: { tokens: 1_000, contextWindow: 100_000 },
  });
  // cross has lower tokens and is a valid candidate only under "all"
  assert.equal(selectPeer([same, cross], CALLER)?.instanceId, "abcdef09");
  assert.equal(selectPeer([same, cross], CALLER, { scope: "all" })?.instanceId, "abcdef05");
});

test("selectPeer: scope 'cwd' requires an exact cwd match", () => {
  const sib = peer({ instanceId: "b2b2b2b2" });
  const web = peer({
    instanceId: "b3b3b3b3",
    metroName: "Web",
    cwd: "/work/app/web",
  });
  assert.equal(selectPeer([web, sib], CALLER, { scope: "cwd" })?.instanceId, "b2b2b2b2");
});

test("selectPeer: returns null when no peer matches the scope filter", () => {
  const cross = peer({
    instanceId: "abcdef05",
    cwd: "/elsewhere/x",
    projectRoot: "/elsewhere",
  });
  assert.equal(selectPeer([cross], CALLER), null);
});

test("selectPeer: returns null when cwd scope requested but no exact cwd match", () => {
  const web = peer({
    instanceId: "b3b3b3b3",
    metroName: "Web",
    cwd: "/work/app/web",
  });
  assert.equal(selectPeer([web], CALLER, { scope: "cwd" }), null);
});

test("selectPeer: caller itself is excluded even when present in the list", () => {
  const me = peer({
    instanceId: CALLER.instanceId,
    state: "idle",
    contextUsage: { tokens: 0, contextWindow: 100_000 },
  });
  const other = peer({
    instanceId: "b4b4b4b4",
    state: "running",
    contextUsage: { tokens: 80_000, contextWindow: 100_000 },
  });
  assert.equal(selectPeer([me, other], CALLER, { scope: "all" })?.instanceId, "b4b4b4b4");
});

test("selectPeer: returns null when only the caller is in the list", () => {
  const me = peer({ instanceId: CALLER.instanceId });
  assert.equal(selectPeer([me], CALLER, { scope: "all" }), null);
});
