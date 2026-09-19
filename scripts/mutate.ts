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

const EXIT_NOT_PINNED = 1;
const EXIT_REFUSED = 2;
const EXIT_NOT_A_VALID_RUN = 3;
const DEFAULT_TIMEOUT_SECONDS = 600;
const USAGE = "usage: bun scripts/mutate.ts [--timeout S] <file> <find> <replace> <test-command>";

type Options = { timeoutSeconds: number; file: string; find: string; replace: string; command: string[] };

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(EXIT_REFUSED);
}

function positiveNumber(name: string, raw: string | undefined): number {
  const value = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(value) || value <= 0) {
    usage(`${name} needs a positive number of seconds, got '${raw ?? ""}'`);
  }
  return value;
}

function parseOptions(argv: string[], env: NodeJS.ProcessEnv): Options {
  const envTimeout = env.MUTATE_TIMEOUT_SECONDS;
  let timeoutSeconds = envTimeout === undefined ? DEFAULT_TIMEOUT_SECONDS : positiveNumber("MUTATE_TIMEOUT_SECONDS", envTimeout);
  const rest = [...argv];
  while (rest[0]?.startsWith("--")) {
    const flag = rest.shift()!;
    if (flag === "--timeout") timeoutSeconds = positiveNumber("--timeout", rest.shift());
    else usage(`unknown option ${flag}`);
  }
  const [file, find, replace, ...command] = rest;
  if (!file || find === undefined || replace === undefined || command.length === 0) usage("missing argument");
  return { timeoutSeconds, file, find, replace, command };
}

function descendantsOf(pid: number): number[] {
  const children = Bun.spawnSync(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "ignore" })
    .stdout.toString()
    .split("\n")
    .map(Number)
    .filter((child) => Number.isInteger(child) && child > 0);
  return children.flatMap((child) => [child, ...descendantsOf(child)]);
}

/** SIGKILL to the whole tree: a hung `Drop` in `child.wait()` (#956) outlives its parent's death and a polite signal alike. */
function killTree(pid: number): void {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    return;
  }
  for (const victim of [...descendantsOf(pid), pid]) {
    try {
      process.kill(victim, "SIGKILL");
    } catch {}
  }
}

async function runCommand(command: string[], timeoutSeconds: number): Promise<{ exitCode: number } | { timedOut: true }> {
  const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killTree(proc.pid);
  }, timeoutSeconds * 1000);
  try {
    const exitCode = await proc.exited;
    return timedOut ? { timedOut } : { exitCode };
  } finally {
    clearTimeout(timer);
  }
}

function notAValidRun(message: string): never {
  console.error(`NOT A VALID RUN: ${message}`);
  process.exit(EXIT_NOT_A_VALID_RUN);
}

async function main(): Promise<void> {
  const { timeoutSeconds, file, find, replace, command } = parseOptions(process.argv.slice(2), process.env);

  const original = readFileSync(file, "utf8");
  const { replacements, source } = mutate(original, find, replace);
  if (replacements === 0) {
    console.error(`refusing: '${find}' does not occur in ${file} — an unapplied mutation proves nothing`);
    process.exit(EXIT_REFUSED);
  }

  const timedOut = `the test command ran longer than ${timeoutSeconds} s — a hang is not a caught mutation`;
  // A command that cannot build, find its crate or start at all exits non-zero on the mutated file too, and read as PINNED (#1155).
  console.error(`==> baseline on the unmodified ${file}; running: ${command.join(" ")}`);
  const baseline = await runCommand(command, timeoutSeconds);
  if ("timedOut" in baseline) notAValidRun(timedOut);
  if (baseline.exitCode !== 0) {
    notAValidRun(`the test command failed before any mutation (exit ${baseline.exitCode}) — fix the command, cwd or build first`);
  }

  let mutated: { exitCode: number } | { timedOut: true };
  try {
    writeFileSync(file, source);
    console.error(`==> mutated ${file} (${replacements} occurrence${replacements === 1 ? "" : "s"}); running: ${command.join(" ")}`);
    mutated = await runCommand(command, timeoutSeconds);
  } finally {
    writeFileSync(file, original);
    console.error(`==> restored ${file}`);
  }

  if ("timedOut" in mutated) notAValidRun(timedOut);
  if (mutated.exitCode === 0) {
    console.error(`NOT PINNED: the mutation survived — nothing failed when '${find}' was replaced`);
    process.exit(EXIT_NOT_PINNED);
  }
  console.error("PINNED: the mutation was caught");
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`mutate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_REFUSED);
  });
}
