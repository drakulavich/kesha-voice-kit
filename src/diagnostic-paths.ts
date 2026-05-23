import { readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export function diagnosticHomeDir(): string {
  return process.env.HOME ?? homedir();
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
