#!/usr/bin/env bun
/**
 * Decide whether a set of changed paths can alter what a user installs.
 *
 * The answer comes from `npm pack --dry-run`, not from mirroring npm's rules: `files`,
 * its negations and `.npmignore` interact in ways that are easy to get subtly wrong —
 * `.npmignore` is inert for anything `files` already allows, for one (#704).
 */
export function publishableChanges(changed: string[], packed: string[]): string[] {
  const shipped = new Set(packed);
  return changed.filter((path) => shipped.has(path));
}

export function packedFiles(packOutput: string): string[] {
  const parsed = JSON.parse(packOutput);
  const files = parsed?.[0]?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("npm pack reported no files — refusing to guess what ships");
  }
  return files.map((f: { path: string }) => f.path);
}

if (import.meta.main) {
  // Paths arrive on stdin, one per line: a git path may contain spaces, and argv would
  // depend on the caller's word-splitting rules.
  const changed = (await Bun.stdin.text()).split("\n").map((l) => l.trim()).filter(Boolean);
  const pack = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"]);
  if (pack.exitCode !== 0) {
    console.error(`npm pack --dry-run failed:\n${pack.stderr.toString()}`);
    process.exit(1);
  }
  const matched = publishableChanges(changed, packedFiles(pack.stdout.toString()));
  process.stdout.write(`publish=${matched.length > 0}\n`);
  console.error(
    matched.length === 0
      ? `No packed path changed among ${changed.length} file(s) — skipping the alpha.`
      : `Packed paths changed: ${matched.join(", ")}`,
  );
}
