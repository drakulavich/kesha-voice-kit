#!/usr/bin/env bun
/**
 * Decide whether a change can alter what a user installs.
 *
 * Surviving paths are judged by `npm pack --dry-run` rather than by mirroring npm's rules:
 * `files`, its negations and `.npmignore` interact in ways that are easy to get subtly
 * wrong — `.npmignore` is inert for anything `files` already allows, for one (#704).
 *
 * A deleted path is gone from the tree, so the packer cannot answer for it; it falls back
 * to the shipped prefixes, which errs toward publishing an alpha nobody needed rather than
 * skipping one for a change that did ship.
 */
export type ChangedPath = { status: string; path: string };

export function parseNameStatus(diff: string): ChangedPath[] {
  return diff
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split(/\t+/);
      // A rename reports both sides; the destination is what exists to be packed.
      return { status: status[0], path: rest[rest.length - 1] };
    });
}

export function shippedPrefixes(files: string[]): { allow: string[]; deny: string[] } {
  const normalise = (entry: string) => entry.replace(/^!/, "").replace(/\/+$/, "");
  return {
    allow: files.filter((e) => !e.startsWith("!")).map(normalise),
    deny: files.filter((e) => e.startsWith("!")).map(normalise),
  };
}

function underPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function publishableChanges(
  changed: ChangedPath[],
  packed: string[],
  files: string[],
): string[] {
  const shipped = new Set(packed);
  const { allow, deny } = shippedPrefixes(files);
  return changed
    .filter(({ status, path }) =>
      status === "D"
        ? underPrefix(path, allow) && !underPrefix(path, deny)
        : shipped.has(path),
    )
    .map(({ path }) => path);
}

export function packedFiles(packOutput: string): string[] {
  const files = JSON.parse(packOutput)?.[0]?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("npm pack reported no files — refusing to guess what ships");
  }
  return files.map((f: { path: string }) => f.path);
}

if (import.meta.main) {
  const changed = parseNameStatus(await Bun.stdin.text());
  const pack = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"]);
  if (pack.exitCode !== 0) {
    console.error(`npm pack --dry-run failed:\n${pack.stderr.toString()}`);
    process.exit(1);
  }
  const pkg = JSON.parse(await Bun.file("package.json").text());
  const matched = publishableChanges(changed, packedFiles(pack.stdout.toString()), pkg.files ?? []);
  process.stdout.write(`publish=${matched.length > 0}\n`);
  console.error(
    matched.length === 0
      ? `Nothing that ships changed among ${changed.length} path(s) — skipping the alpha.`
      : `Shipped paths changed: ${matched.join(", ")}`,
  );
}
