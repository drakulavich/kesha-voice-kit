#!/usr/bin/env bun
/**
 * Fails when any tracked file is 1 MiB or larger. Git LFS was dropped because its bandwidth quota
 * was the only thing it produced; this is what keeps a multi-megabyte fixture from landing in git
 * instead. Large corpora ship as a release asset with a SHA-256 pin.
 */
export const LIMIT_BYTES = 1_048_576;

/** The Raycast store reads its 2000x1250 listing screenshot from here: 2 144 887 bytes of PNG, no fixture. */
export const EXEMPT_PATHS = ["raycast/metadata/kesha-voice-kit-1.png"];

export interface TrackedFile {
  path: string;
  bytes: number;
}

export function oversized(entries: TrackedFile[], limitBytes: number): TrackedFile[] {
  return entries
    .filter((entry) => entry.bytes >= limitBytes)
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
}

async function run(cwd: string, argv: string[], stdin: string): Promise<string> {
  const proc = Bun.spawn(argv, { cwd, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed (exit ${exitCode}) in ${cwd}: ${stderr.trim()}`);
  return stdout;
}

/** Sizes come from the index blobs, not the worktree: the index is what a push ships, and a deleted worktree copy hides nothing. */
export async function trackedFiles(cwd: string): Promise<TrackedFile[]> {
  const oidOf = new Map<string, string>();
  for (const line of (await run(cwd, ["git", "ls-files", "-z", "--stage"], "")).split("\0")) {
    if (line === "") continue;
    const match = /^(\d{6}) ([0-9a-f]{40,64}) \d\t(.+)$/s.exec(line);
    if (!match) throw new Error(`git ls-files --stage: unparsable entry ${JSON.stringify(line)}`);
    const [, mode = "", oid = "", path = ""] = match;
    // A symlink's blob is its target text and a gitlink is another repository's commit; neither ships bytes here.
    if (mode === "120000" || mode === "160000") continue;
    oidOf.set(path, oid);
  }

  const sizeOf = new Map<string, number>();
  const batch = await run(
    cwd,
    ["git", "cat-file", "--batch-check=%(objectname) %(objectsize)"],
    [...new Set(oidOf.values())].map((oid) => `${oid}\n`).join(""),
  );
  for (const line of batch.split("\n")) {
    if (line === "") continue;
    const [oid = "", size = ""] = line.split(" ");
    if (!/^\d+$/.test(size)) throw new Error(`git cat-file --batch-check: ${line}`);
    sizeOf.set(oid, Number(size));
  }

  return [...oidOf].map(([path, oid]) => {
    const bytes = sizeOf.get(oid);
    if (bytes === undefined) throw new Error(`no size for ${path} (${oid})`);
    return { path, bytes };
  });
}

if (import.meta.main) {
  const tracked = (await trackedFiles(process.cwd())).filter(({ path }) => !EXEMPT_PATHS.includes(path));
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
