#!/usr/bin/env bun
/**
 * Fails when any tracked file is 1 MiB or larger, is a Git LFS pointer, or is a `.gitattributes`
 * that routes paths through `filter=lfs`. Git LFS was dropped because its bandwidth bill locked the
 * account (#1240), and a 132-byte pointer passes any size limit (#1286). Large corpora ship as a
 * release asset with a SHA-256 pin.
 */
export const LIMIT_BYTES = 1_048_576;

/** The Raycast store reads its 2000x1250 listing screenshot from here: 2 144 887 bytes of PNG, no fixture. */
export const EXEMPT_PATHS = ["raycast/metadata/kesha-voice-kit-1.png"];

export interface TrackedFile {
  path: string;
  bytes: number;
}

export interface TrackedBlob extends TrackedFile {
  oid: string;
}

/** git-lfs never reads more than this much of a file when deciding whether it is a pointer. */
const LFS_POINTER_MAX_BYTES = 1024;
const LFS_SPEC_LINE = "version https://git-lfs.github.com/spec/v1";

export function isLfsPointer(content: Buffer): boolean {
  const end = content.indexOf(0x0a);
  const first = content.subarray(0, end === -1 ? content.length : end).toString("utf8");
  return first.replace(/\r$/, "") === LFS_SPEC_LINE;
}

/** 1-based numbers of the attribute lines that set `filter=lfs` on a pattern. */
export function lfsFilterLines(attributes: string): number[] {
  return attributes.split("\n").flatMap((line, at) => {
    const [pattern, ...attrs] = line.trim().split(/\s+/);
    if (!pattern || pattern.startsWith("#")) return [];
    return attrs.includes("filter=lfs") ? [at + 1] : [];
  });
}

export function oversized(entries: TrackedFile[], limitBytes: number): TrackedFile[] {
  return entries
    .filter((entry) => entry.bytes >= limitBytes)
    .sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
}

async function runBytes(cwd: string, argv: string[], stdin: string): Promise<Buffer> {
  const proc = Bun.spawn(argv, { cwd, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed (exit ${exitCode}) in ${cwd}: ${stderr.trim()}`);
  return Buffer.from(stdout);
}

async function run(cwd: string, argv: string[], stdin: string): Promise<string> {
  return (await runBytes(cwd, argv, stdin)).toString("utf8");
}

/** Sizes come from the index blobs, not the worktree: the index is what a push ships, and a deleted worktree copy hides nothing. */
export async function trackedFiles(cwd: string): Promise<TrackedBlob[]> {
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
    return { path, bytes, oid };
  });
}

/** Contents of the given blobs, keyed by object id, read in one `git cat-file --batch`. */
export async function blobContents(cwd: string, oids: string[]): Promise<Map<string, Buffer>> {
  const unique = [...new Set(oids)];
  const out = await runBytes(cwd, ["git", "cat-file", "--batch"], unique.map((oid) => `${oid}\n`).join(""));
  const contents = new Map<string, Buffer>();
  let at = 0;
  while (at < out.length) {
    const headerEnd = out.indexOf(0x0a, at);
    const [oid = "", type = "", size = ""] = out.subarray(at, headerEnd).toString("utf8").split(" ");
    if (type !== "blob" || !/^\d+$/.test(size)) throw new Error(`git cat-file --batch: ${oid} ${type}`);
    const start = headerEnd + 1;
    contents.set(oid, out.subarray(start, start + Number(size)));
    at = start + Number(size) + 1;
  }
  return contents;
}

/** Every way LFS could come back: a committed pointer, or an attributes line that would mint new ones. */
export async function lfsFindings(cwd: string, tracked: TrackedBlob[]): Promise<string[]> {
  const isAttributes = ({ path }: TrackedFile) => path === ".gitattributes" || path.endsWith("/.gitattributes");
  const candidates = tracked.filter((file) => file.bytes < LFS_POINTER_MAX_BYTES || isAttributes(file));
  const contents = await blobContents(cwd, candidates.map(({ oid }) => oid));
  return candidates.flatMap((file) => {
    const content = contents.get(file.oid) ?? Buffer.alloc(0);
    const found = isAttributes(file)
      ? lfsFilterLines(content.toString("utf8")).map((line) => `  ${file.path}:${line} sets filter=lfs`)
      : [];
    if (isLfsPointer(content)) found.push(`  ${file.path} is a Git LFS pointer`);
    return found;
  });
}

if (import.meta.main) {
  const all = await trackedFiles(process.cwd());
  const lfs = await lfsFindings(process.cwd(), all);
  if (lfs.length > 0) {
    console.error("check:file-sizes: Git LFS is gone from this repository (#1240); these would bring it back:");
    for (const line of lfs) console.error(line);
    console.error("commit the real bytes if they stay under 1 MiB, otherwise ship them as a release asset with a SHA-256 pin");
  }
  const tracked = all.filter(({ path }) => !EXEMPT_PATHS.includes(path));
  const large = oversized(tracked, LIMIT_BYTES);
  if (large.length > 0) {
    console.error(
      `check:file-sizes: ${large.length} tracked file${large.length === 1 ? "" : "s"} at or above 1 MiB (${LIMIT_BYTES} bytes):`,
    );
    for (const { path, bytes } of large) {
      console.error(`  ${path}  ${bytes} bytes (${(bytes / LIMIT_BYTES).toFixed(2)} MiB)`);
    }
    console.error("large fixtures ship as a release asset with a SHA-256 pin, never in git or LFS");
  }
  if (lfs.length > 0 || large.length > 0) process.exit(1);
}
