#!/usr/bin/env bun
/**
 * Fails when any tracked file is 1 MiB or larger. Git LFS was dropped because its bandwidth quota
 * was the only thing it produced; this is what keeps a multi-megabyte fixture from landing in git
 * instead. Large corpora ship as a release asset with a SHA-256 pin.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";

export const LIMIT_BYTES = 1_048_576;

/** Raycast store listing screenshots: 2000x1250 PNGs the store reads from the repo, 2 MiB each and no fixture. */
export const EXEMPT_PREFIXES = ["raycast/metadata/"];

export interface TrackedFile {
  path: string;
  bytes: number;
}

export function oversized(entries: TrackedFile[], limitBytes: number): TrackedFile[] {
  return entries
    .filter((entry) => entry.bytes >= limitBytes)
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
}

export async function trackedFiles(cwd: string): Promise<TrackedFile[]> {
  const proc = Bun.spawn(["git", "ls-files", "-z"], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`git ls-files failed (exit ${exitCode}) in ${cwd}: ${stderr.trim()}`);

  const files: TrackedFile[] = [];
  for (const path of stdout.split("\0")) {
    if (path === "") continue;
    try {
      files.push({ path, bytes: lstatSync(join(cwd, path)).size });
    } catch (err) {
      // Deleted in the working tree but still in the index: nothing on disk to measure.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return files;
}

if (import.meta.main) {
  const tracked = (await trackedFiles(process.cwd())).filter(
    ({ path }) => !EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
  const large = oversized(tracked, LIMIT_BYTES);
  if (large.length > 0) {
    console.error(
      `check:file-sizes: ${large.length} tracked file${large.length === 1 ? "" : "s"} at or above 1 MiB (${LIMIT_BYTES} bytes):`,
    );
    for (const { path, bytes } of large) {
      console.error(`  ${path}  ${bytes} bytes (${(bytes / LIMIT_BYTES).toFixed(2)} MiB)`);
    }
    console.error("large fixtures ship as a release asset with a SHA-256 pin, never in git or LFS");
    process.exit(1);
  }
}
