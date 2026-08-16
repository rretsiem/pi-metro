import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

export const LINES = [
  "Red", "Blue", "Green", "Yellow", "Orange", "Purple",
  "Pink", "Teal", "Indigo", "Coral", "Lime", "Slate", "Silver", "Bronze",
];
export const MAX_RUN = 99;

/** Grace window after a claim: protects a session that has just claimed an
 *  alias but hasn't written its first registry entry yet (so it isn't in the
 *  live-instance-id set) from having its claim swept out from under it. */
export const CLAIM_SWEEP_GRACE_MS = 15_000;

interface Owner {
  instanceId: string;
  claimedAt: number;
}

function claimsDir(rootDir: string) {
  return path.join(rootDir, "claims");
}

async function readOwner(dir: string): Promise<Owner | null> {
  try {
    return JSON.parse(await readFile(path.join(dir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Try to claim `name`. Returns true on fresh claim or reclaim by same instance. */
async function tryClaim(
  rootDir: string,
  name: string,
  instanceId: string,
): Promise<boolean> {
  const dir = path.join(claimsDir(rootDir), name);
  try {
    await mkdir(dir); // non-recursive: atomic, EEXIST = taken
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const owner = await readOwner(dir);
    return owner?.instanceId === instanceId; // reclaim only our own claim
  }
  const owner: Owner = { instanceId, claimedAt: Date.now() };
  try {
    await writeFile(path.join(dir, "owner.json"), JSON.stringify(owner));
  } catch (err) {
    await rm(dir, { recursive: true, force: true }); // release failed claim
    throw err;
  }
  return true;
}

export async function claimMetroAlias(
  rootDir: string,
  instanceId: string,
  previousAlias?: string,
  siblingColor?: string,
): Promise<string> {
  await mkdir(claimsDir(rootDir), { recursive: true });
  if (previousAlias && (await tryClaim(rootDir, previousAlias, instanceId))) {
    return previousAlias;
  }
  // A live session in the same project: share its color, take the next free run.
  if (siblingColor && LINES.includes(siblingColor)) {
    for (let run = 1; run <= MAX_RUN; run++) {
      const name = `${siblingColor}-${run}`;
      if (await tryClaim(rootDir, name, instanceId)) return name;
    }
  }
  // Alone in this project: prefer a color no one holds at all, so a lone session
  // is always "<Color>-1" and doesn't share a color with another live project.
  const used = new Set(
    (await readdir(claimsDir(rootDir)).catch(() => [])).map((n) => n.split("-")[0]),
  );
  for (const line of LINES) {
    if (used.has(line)) continue;
    if (await tryClaim(rootDir, `${line}-1`, instanceId)) return `${line}-1`;
  }
  for (const line of LINES) {
    if (await tryClaim(rootDir, `${line}-1`, instanceId)) return `${line}-1`;
  }
  // Every color's run 1 is taken: any free slot will do.
  for (const line of LINES) {
    for (let run = 2; run <= MAX_RUN; run++) {
      const name = `${line}-${run}`;
      if (await tryClaim(rootDir, name, instanceId)) return name;
    }
  }
  throw new Error("metrol: no aliases available");
}

export async function releaseMetroAlias(
  rootDir: string,
  name: string,
  instanceId: string,
): Promise<boolean> {
  const dir = path.join(claimsDir(rootDir), name);
  const owner = await readOwner(dir);
  if (owner?.instanceId !== instanceId) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

export async function staleClaimsCleanup(
  rootDir: string,
  validInstanceIds: Set<string>,
): Promise<string[]> {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(claimsDir(rootDir));
  } catch {
    return removed;
  }
  const now = Date.now();
  for (const name of entries) {
    const dir = path.join(claimsDir(rootDir), name);
    const owner = await readOwner(dir);
    if (!owner) {
      // Corrupt claim (no owner.json): treat as stale.
      await rm(dir, { recursive: true, force: true });
      removed.push(name);
      continue;
    }
    if (validInstanceIds.has(owner.instanceId)) continue;
    if (now - owner.claimedAt < CLAIM_SWEEP_GRACE_MS) continue;
    await rm(dir, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
