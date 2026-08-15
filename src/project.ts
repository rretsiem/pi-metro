import { stat } from "node:fs/promises";
import path from "node:path";

/** Nearest ancestor (incl. `cwd`) containing `.git` (file or dir); falls back to `cwd`. */
export async function findProjectRoot(cwd: string): Promise<string> {
  const start = path.resolve(cwd);
  let dir = start;
  while (true) {
    try {
      await stat(path.join(dir, ".git"));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return start;
      dir = parent;
    }
  }
}
