import { mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

export const LINES = [
  "Red", "Blue", "Green", "Yellow", "Orange", "Purple",
  "Pink", "Teal", "Indigo", "Coral", "Lime", "Slate", "Silver", "Bronze",
];
export const MAX_RUN = 99;

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
): Promise<string> {
  await mkdir(claimsDir(rootDir), { recursive: true });
  if (previousAlias && (await tryClaim(rootDir, previousAlias, instanceId))) {
    return previousAlias;
  }
  for (const line of LINES) {
    for (let run = 1; run <= MAX_RUN; run++) {
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
  for (const name of entries) {
    const dir = path.join(claimsDir(rootDir), name);
    const owner = await readOwner(dir);
    if (!owner || !validInstanceIds.has(owner.instanceId)) {
      await rm(dir, { recursive: true, force: true });
      removed.push(name);
    }
  }
  return removed;
}
