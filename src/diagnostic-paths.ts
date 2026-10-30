import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function diagnosticHomeDir(): string {
  return process.env.HOME ?? homedir();
}

/** Size in bytes, 0 when the file is missing or unreadable. */
export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export function dirSizeBytes(path: string): number {
  let total = 0;
  try {
    const st = statSync(path);
    if (st.isFile()) return st.size;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const p = join(path, entry.name);
      total += entry.isDirectory() ? dirSizeBytes(p) : statSync(p).size;
    }
  } catch {
    return total;
  }
  return total;
}
