import { randomUUID } from "node:crypto";
import { readRegistry, type RegistryEntry } from "./registry.ts";
import type { Scope } from "./list.ts";
import {
  inboxDir,
  resolveTarget,
  writeMessage,
  type Message,
  type MessageFrom,
} from "./transport.ts";

function senderRef(entry: RegistryEntry): MessageFrom {
  return {
    instanceId: entry.instanceId,
    metroName: entry.metroName,
    sessionName: entry.sessionName,
  };
}

async function sendChat(
  rootDir: string,
  callerEntry: RegistryEntry,
  toInstanceId: string,
  message: string,
  msgType: "chat" | "trigger" = "chat",
): Promise<string> {
  const msg: Message = {
    version: 1,
    id: randomUUID(),
    type: msgType,
    from: senderRef(callerEntry),
    toInstanceId,
    payload: { text: message },
    timestamp: Date.now(),
  };
  const r = await writeMessage(await inboxDir(rootDir, toInstanceId), msg);
  if (!r.ok) throw new Error(`metrol: ${r.error}`);
  return msg.id;
}

/** Write a `chat` (or, with triggerTurn wiring, `trigger`) message into the target's inbox. Returns the message ID. */
export async function sendDirect(
  rootDir: string,
  callerEntry: RegistryEntry,
  target: string,
  message: string,
  scope: Scope = "project",
  msgType: "chat" | "trigger" = "chat",
): Promise<string> {
  const r = resolveTarget(await readRegistry(rootDir), target, callerEntry, scope);
  if (!r.ok) throw new Error(`metrol: ${r.error}`);
  return sendChat(rootDir, callerEntry, r.target.instanceId, message, msgType);
}

/** Write a `chat`/`trigger` to every live session in scope except the caller. Returns recipient count. */
export async function broadcast(
  rootDir: string,
  callerEntry: RegistryEntry,
  message: string,
  scope: Scope = "cwd",
  msgType: "chat" | "trigger" = "chat",
): Promise<number> {
  const entries = await readRegistry(rootDir);
  const recipients = entries.filter(
    (e) =>
      e.instanceId !== callerEntry.instanceId &&
      (scope === "all" ||
        (scope === "cwd"
          ? e.cwd === callerEntry.cwd
          : e.projectRoot === callerEntry.projectRoot)),
  );
  for (const e of recipients) {
    await sendChat(rootDir, callerEntry, e.instanceId, message, msgType);
  }
  return recipients.length;
}
