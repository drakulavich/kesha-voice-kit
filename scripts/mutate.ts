#!/usr/bin/env bun
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

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
const USAGE = "usage: bun scripts/mutate.ts [--timeout S] [--occurrences N] <file> <find> <replace> <test-command>";

type Options = {
  timeoutSeconds: number;
  occurrences: number | undefined;
  file: string;
  find: string;
  replace: string;
  command: string[];
};

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(EXIT_REFUSED);
}

function positiveNumber(name: string, raw: string | undefined, unit: string, integer = false): number {
  const value = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(value) || value <= 0 || (integer && !Number.isInteger(value))) {
    usage(`${name} needs a positive ${unit}, got '${raw ?? ""}'`);
  }
  return value;
}

function parseOptions(argv: string[], env: NodeJS.ProcessEnv): Options {
  const envTimeout = env.MUTATE_TIMEOUT_SECONDS;
  let timeoutSeconds =
    envTimeout === undefined ? DEFAULT_TIMEOUT_SECONDS : positiveNumber("MUTATE_TIMEOUT_SECONDS", envTimeout, "number of seconds");
  let occurrences: number | undefined;
  const rest = [...argv];
  while (rest[0]?.startsWith("--")) {
    const flag = rest.shift()!;
    if (flag === "--") break;
    if (flag === "--timeout") timeoutSeconds = positiveNumber("--timeout", rest.shift(), "number of seconds");
    else if (flag === "--occurrences") occurrences = positiveNumber("--occurrences", rest.shift(), "whole count", true);
    else usage(`unknown option ${flag}`);
  }
  const [file, find, replace, ...command] = rest;
  if (!file || find === undefined || replace === undefined || command.length === 0) usage("missing argument");
  return { timeoutSeconds, occurrences, file, find, replace, command };
}

/** Parent → children for every live process, or null when the table cannot be read; a null is treated as "no children" so the exit contract still holds. */
function childrenByParent(): Map<number, number[]> | null {
  try {
    const table = Bun.spawnSync(["ps", "-eo", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
    if (!table.success) return null;
    const children = new Map<number, number[]>();
    for (const line of table.stdout.toString().split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (!pid || ppid === undefined) continue;
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
    return children;
  } catch {
    return null;
  }
}

function safeSignal(pid: number, signal: "SIGSTOP" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Gone between the listing and the signal.
  }
}

/** Freezes the tree before enumerating it — a stopped process cannot fork, so nothing spawned mid-sweep escapes — then SIGKILLs it leaves first, root last; a hung `Drop` in `child.wait()` (#956) outlives a polite signal. */
function killTree(root: number): void {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(root), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    return;
  }
  safeSignal(root, "SIGSTOP");
  const frozen = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    const children = childrenByParent();
    if (!children) break;
    for (const parent of [...frozen]) {
      for (const child of children.get(parent) ?? []) {
        if (frozen.has(child)) continue;
        safeSignal(child, "SIGSTOP");
        frozen.add(child);
        grew = true;
      }
    }
  }
  for (const pid of [...frozen].reverse()) safeSignal(pid, "SIGKILL");
}

let runningPid: number | null = null;
let restoreMutated: (() => void) | null = null;

type RunOutcome = { exitCode: number } | { timedOut: true } | { notStarted: string };

async function runCommand(command: string[], timeoutSeconds: number): Promise<RunOutcome> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  } catch (error) {
    return { notStarted: error instanceof Error ? error.message : String(error) };
  }
  runningPid = proc.pid;
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
    runningPid = null;
  }
}

function onInterrupt(): void {
  if (runningPid !== null) killTree(runningPid);
  restoreMutated?.();
  notAValidRun("interrupted");
}

function notAValidRun(message: string): never {
  console.error(`NOT A VALID RUN: ${message}`);
  process.exit(EXIT_NOT_A_VALID_RUN);
}

function exitCodeOf(outcome: RunOutcome, timeoutSeconds: number): number {
  if ("notStarted" in outcome) notAValidRun(`the test command could not be started (${outcome.notStarted})`);
  if ("timedOut" in outcome) notAValidRun(`the test command ran longer than ${timeoutSeconds} s — a hang is not a caught mutation`);
  return outcome.exitCode;
}

/** 1-based line of each match start; a needle spanning lines is listed where it begins. */
function matchLines(source: string, find: string): number[] {
  const lines: number[] = [];
  for (let at = source.indexOf(find); at !== -1; at = source.indexOf(find, at + find.length)) {
    lines.push(source.slice(0, at).split("\n").length);
  }
  return lines;
}

async function main(): Promise<void> {
  const { timeoutSeconds, occurrences, file, find, replace, command } = parseOptions(process.argv.slice(2), process.env);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);

  const sidecar = `${file}.mutate-orig`;
  if (existsSync(sidecar)) {
    console.error(`refusing: a previous run was interrupted — restore with: mv ${sidecar} ${file}`);
    process.exit(EXIT_REFUSED);
  }
  const original = readFileSync(file, "utf8");
  const { replacements, source } = mutate(original, find, replace);
  if (replacements === 0) {
    console.error(`refusing: '${find}' does not occur in ${file} — an unapplied mutation proves nothing`);
    process.exit(EXIT_REFUSED);
  }
  // #956: the second match sat in a cleanup path nobody meant to mutate, and the run hung there.
  const lines = matchLines(original, find).join(", ");
  const where = `occurs ${replacements} time${replacements === 1 ? "" : "s"} in ${file} (lines ${lines})`;
  if (occurrences === undefined && replacements > 1) {
    console.error(
      `refusing: '${find}' ${where} — pass --occurrences ${replacements} to replace all ${replacements}, or narrow the text`,
    );
    process.exit(EXIT_REFUSED);
  }
  if (occurrences !== undefined && occurrences !== replacements) {
    console.error(`refusing: '${find}' ${where}, not the ${occurrences} that --occurrences names`);
    process.exit(EXIT_REFUSED);
  }

  // A command that cannot build, find its crate or start at all exits non-zero on the mutated file too, and read as PINNED (#1155).
  console.error(`==> baseline on the unmodified ${file}; running: ${command.join(" ")}`);
  const baseline = exitCodeOf(await runCommand(command, timeoutSeconds), timeoutSeconds);
  if (baseline !== 0) {
    notAValidRun(`the test command failed before any mutation (exit ${baseline}) — fix the command, cwd or build first`);
  }

  // A SIGKILL reaches no handler; the sidecar is what tells the next reader the tree is mutated, not edited (#1211).
  copyFileSync(file, sidecar);
  restoreMutated = () => {
    writeFileSync(file, original);
    rmSync(sidecar, { force: true });
    restoreMutated = null;
  };
  let mutated: RunOutcome;
  try {
    writeFileSync(file, source);
    console.error(`==> mutated ${file} (${replacements} occurrence${replacements === 1 ? "" : "s"}); running: ${command.join(" ")}`);
    mutated = await runCommand(command, timeoutSeconds);
  } finally {
    restoreMutated?.();
    console.error(`==> restored ${file}`);
  }

  if (exitCodeOf(mutated, timeoutSeconds) === 0) {
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
