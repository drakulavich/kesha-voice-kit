#!/usr/bin/env bun
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";

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
const USAGE = [
  "usage: bun scripts/mutate.ts [--timeout S] [--occurrences N] [--] <file> <find> <replace> <test-command>",
  "exit 0  PINNED — baseline green, mutated run red",
  "exit 1  NOT PINNED — the mutation survived",
  "exit 2  usage or refusal — needle absent or ambiguous, --occurrences mismatch, bad option, sidecar present",
  "exit 3  NOT A VALID RUN — baseline red, timeout, interrupted, could not start",
].join("\n");

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

function counted(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
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

const SWEEP_ROUNDS = 10;

export type FrozenTree = { frozen: number[]; rounds: number; bounded: boolean };

/** Stops the root, then walks each fresh table transitively and stops every descendant it shows, re-reading until a read finds nothing new or `rounds` reads are spent: a stopped process cannot fork, so only an unstopped one can keep the set growing, and the bound is what guarantees the kill still happens. */
export function collectFrozenTree(
  root: number,
  readChildren: () => Map<number, number[]> | null,
  stop: (pid: number) => void,
  rounds: number,
): FrozenTree {
  stop(root);
  const frozen = new Set([root]);
  for (let round = 1; round <= rounds; round++) {
    const children = readChildren() ?? new Map<number, number[]>();
    let grew = false;
    for (const queue = [...frozen]; queue.length > 0; ) {
      for (const child of children.get(queue.shift()!) ?? []) {
        if (frozen.has(child)) continue;
        stop(child);
        frozen.add(child);
        queue.push(child);
        grew = true;
      }
    }
    if (!grew) return { frozen: [...frozen], rounds: round, bounded: false };
  }
  return { frozen: [...frozen], rounds, bounded: true };
}

/** Freezes the tree before enumerating it, then SIGKILLs it leaves first, root last; a hung `Drop` in `child.wait()` (#956) outlives a polite signal. */
function killTree(root: number): void {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(root), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    return;
  }
  const tree = collectFrozenTree(root, childrenByParent, (pid) => safeSignal(pid, "SIGSTOP"), SWEEP_ROUNDS);
  const bound = tree.bounded ? ` (bound of ${SWEEP_ROUNDS} hit; a descendant was still forking)` : "";
  console.error(`==> froze ${counted(tree.frozen.length, "process", "processes")} in ${counted(tree.rounds, "round")}${bound}`);
  for (const pid of [...tree.frozen].reverse()) safeSignal(pid, "SIGKILL");
}

let runningPid: number | null = null;
let restoreMutated: (() => void) | null = null;
let ownedSidecar: string | null = null;

function releaseSidecar(): void {
  if (ownedSidecar !== null) rmSync(ownedSidecar, { force: true });
  ownedSidecar = null;
}

function refuse(message: string): never {
  releaseSidecar();
  console.error(`refusing: ${message}`);
  process.exit(EXIT_REFUSED);
}

export type SidecarFs = {
  openSync(file: string, flags: "wx"): number;
  writeSync(fd: number, buffer: Buffer, offset: number, length: number): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  linkSync(from: string, to: string): void;
  unlinkSync(file: string): void;
};

const nodeFs: SidecarFs = { openSync, writeSync, fsyncSync, closeSync, linkSync, unlinkSync };

/** The sidecar is only ever seen holding the whole original: the bytes go to a same-directory temp file first and `link` publishes it in one step, refusing (EEXIST) rather than overwriting — a `rename` would replace a sidecar another run still owns. */
export function publishSidecar(sidecar: string, content: string, fs: SidecarFs = nodeFs, pid = process.pid): "published" | "exists" {
  const tmp = `${sidecar}.${pid}.tmp`;
  const fd = fs.openSync(tmp, "wx");
  try {
    const bytes = Buffer.from(content);
    for (let written = 0; written < bytes.length; ) {
      written += fs.writeSync(fd, bytes, written, bytes.length - written);
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.linkSync(tmp, sidecar);
    return "published";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw error;
  } finally {
    fs.unlinkSync(tmp);
  }
}

/** Publishes the sidecar before anything else happens, so two runs on one file cannot both pass the check and the second cannot record the first's mutation as "original" (#1241 review). */
function acquireSidecar(file: string, original: string): void {
  const sidecar = `${file}.mutate-orig`;
  if (publishSidecar(sidecar, original) === "exists") {
    refuse(`a previous run was interrupted — restore with: mv ${sidecar} ${file}`);
  }
  ownedSidecar = sidecar;
}

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
  releaseSidecar();
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

  const original = readFileSync(file, "utf8");
  // A SIGKILL reaches no handler; the sidecar is what tells the next reader the tree is mutated, not edited (#1211).
  acquireSidecar(file, original);
  const { replacements, source } = mutate(original, find, replace);
  if (replacements === 0) refuse(`'${find}' does not occur in ${file} — an unapplied mutation proves nothing`);
  // #956: the second match sat in a cleanup path nobody meant to mutate, and the run hung there.
  const lines = matchLines(original, find).join(", ");
  const where = `occurs ${counted(replacements, "time")} in ${file} (lines ${lines})`;
  if (occurrences === undefined && replacements > 1) {
    refuse(`'${find}' ${where} — pass --occurrences ${replacements} to replace all ${replacements}, or narrow the text`);
  }
  if (occurrences !== undefined && occurrences !== replacements) {
    refuse(`'${find}' ${where}, not the ${occurrences} that --occurrences names`);
  }

  // A command that cannot build, find its crate or start at all exits non-zero on the mutated file too, and read as PINNED (#1155).
  console.error(`==> baseline on the unmodified ${file}; running: ${command.join(" ")}`);
  const baseline = exitCodeOf(await runCommand(command, timeoutSeconds), timeoutSeconds);
  if (baseline !== 0) {
    notAValidRun(`the test command failed before any mutation (exit ${baseline}) — fix the command, cwd or build first`);
  }

  restoreMutated = () => {
    writeFileSync(file, original);
    releaseSidecar();
    restoreMutated = null;
  };
  let mutated: RunOutcome;
  try {
    writeFileSync(file, source);
    console.error(`==> mutated ${file} (${counted(replacements, "occurrence")}); running: ${command.join(" ")}`);
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
    releaseSidecar();
    console.error(`mutate: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_REFUSED);
  });
}
