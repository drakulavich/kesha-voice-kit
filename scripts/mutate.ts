#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";

export type MutationResult = { replacements: number; source: string };

/// Literal, not regex: the caller names the exact text to neutralise, and a regex that
/// silently matches nothing is the failure this whole script exists to prevent (#1075).
export function mutate(source: string, find: string, replace: string): MutationResult {
  if (find.length === 0) throw new Error("the text to replace must not be empty");
  const replacements = source.split(find).length - 1;
  return { replacements, source: replacements === 0 ? source : source.split(find).join(replace) };
}

function usage(message: string): never {
  console.error(`${message}\nusage: bun scripts/mutate.ts <file> <find> <replace> <test-command>`);
  process.exit(2);
}

async function main(): Promise<void> {
  const [file, find, replace, ...command] = process.argv.slice(2);
  if (!file || find === undefined || replace === undefined || command.length === 0) usage("missing argument");

  const original = readFileSync(file, "utf8");
  const { replacements, source } = mutate(original, find, replace);
  if (replacements === 0) {
    console.error(`refusing: '${find}' does not occur in ${file} — an unapplied mutation proves nothing`);
    process.exit(2);
  }

  let survived = false;
  try {
    writeFileSync(file, source);
    console.error(`==> mutated ${file} (${replacements} occurrence${replacements === 1 ? "" : "s"}); running: ${command.join(" ")}`);
    survived = (await Bun.spawn(command, { stdout: "inherit", stderr: "inherit" }).exited) === 0;
  } finally {
    writeFileSync(file, original);
    console.error(`==> restored ${file}`);
  }

  if (survived) {
    console.error(`NOT PINNED: the mutation survived — nothing failed when '${find}' was replaced`);
    process.exit(1);
  }
  console.error("PINNED: the mutation was caught");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`mutate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  });
}
