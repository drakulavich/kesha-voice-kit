#!/usr/bin/env bun
/**
 * Decide whether a set of changed paths can alter what a user installs.
 *
 * Derived from `package.json#files` — the list npm actually ships — so adding a file to the
 * package extends this filter without a second edit. A path filter on the workflow trigger
 * could not report a deliberate skip, because it prevents the run from existing (#685).
 */
import { readFileSync } from "node:fs";

export function shippedPrefixes(files: string[]): string[] {
  return files.map((entry) => entry.replace(/\/+$/, ""));
}

export function publishableChanges(changed: string[], files: string[]): string[] {
  const prefixes = shippedPrefixes(files);
  return changed.filter((path) =>
    prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)),
  );
}

if (import.meta.main) {
  // Paths arrive on stdin, one per line: a git path may contain spaces, and argv would
  // depend on the caller's word-splitting rules.
  const changed = (await Bun.stdin.text()).split("\n").map((l) => l.trim()).filter(Boolean);
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  if (!Array.isArray(pkg.files) || pkg.files.length === 0) {
    console.error("package.json#files is missing — refusing to guess what ships");
    process.exit(1);
  }
  const matched = publishableChanges(changed, pkg.files);
  process.stdout.write(`publish=${matched.length > 0}\n`);
  if (matched.length === 0) {
    console.error(`No shipped path changed among ${changed.length} file(s) — skipping the alpha.`);
  } else {
    console.error(`Shipped paths changed: ${matched.join(", ")}`);
  }
}
