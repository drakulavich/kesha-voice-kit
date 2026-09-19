import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mutate } from "../../scripts/mutate";
import { pidIsAlive, trackPid, waitForPidExit, waitForPidFile } from "../helpers/process";
import { tempDir } from "../helpers/temp-dir";

describe("mutate", () => {
  // A perl one-liner whose pattern misses exits 0 and changes nothing, so the test passes and the
  // run reads as "the pin is useless" — that false verdict is what this counts away (#1075).
  test("reports zero replacements rather than a silent no-op", () => {
    const source = "let owner = lock();";
    expect(mutate(source, "absent", "x")).toEqual({ replacements: 0, source });
  });

  test("counts and applies every occurrence", () => {
    const result = mutate("a; b; a;", "a", "z");
    expect(result).toEqual({ replacements: 2, source: "z; b; z;" });
  });

  test("treats the needle as literal text, not a pattern", () => {
    // `.` and `(` are the common case in real guards; a regex would match far too much.
    expect(mutate("if (x) { drop(); }", "drop()", "keep()").source).toBe("if (x) { keep(); }");
    expect(mutate("a.b", ".", "!")).toEqual({ replacements: 1, source: "a!b" });
  });

  test("refuses an empty needle instead of splitting every character", () => {
    expect(() => mutate("abc", "", "x")).toThrow("must not be empty");
  });
});

const MUTATE = join(import.meta.dir, "../../scripts/mutate.ts");
const ORIGINAL = "if (locked) return;\nrun();\n";
const NEEDLE = "if (locked) return;";
const SEPARATOR = "\n---\n";

/** A target file plus a log every test command appends the target's content to, so a test can prove which content each run saw. */
function scenario(): { dir: string; target: string; log: string; script: (name: string, body: string) => string } {
  const dir = tempDir("mutate-");
  const target = join(dir, "target.ts");
  const log = join(dir, "seen.log");
  writeFileSync(target, ORIGINAL);
  writeFileSync(log, "");
  return {
    dir,
    target,
    log,
    script(name, body) {
      const path = join(dir, name);
      writeFileSync(path, body);
      return path;
    },
  };
}

const RECORD = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const [target, log] = process.argv.slice(2);
const text = readFileSync(target, "utf8");
appendFileSync(log, text + ${JSON.stringify(SEPARATOR)});
`;

type Outcome = { exitCode: number; stderr: string; stdout: string };

function spawnMutate(args: string[], env: Record<string, string> = {}): { pid: number; result: Promise<Outcome> } {
  const proc = Bun.spawn([process.execPath, MUTATE, ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...env } });
  const result = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]).then(
    ([stdout, stderr, exitCode]) => ({ exitCode, stderr, stdout }),
  );
  return { pid: trackPid(proc.pid), result };
}

function runMutate(args: string[], env: Record<string, string> = {}): Promise<Outcome> {
  return spawnMutate(args, env).result;
}

function seen(log: string): string[] {
  return readFileSync(log, "utf8").split(SEPARATOR).slice(0, -1);
}

describe("bun scripts/mutate.ts — the green baseline (#1155)", () => {
  test("a test command that fails before any mutation is NOT A VALID RUN, exit 3, and the mutated text is never written", async () => {
    const s = scenario();
    const fail = s.script("fail.ts", `${RECORD}process.exit(1);\n`);
    const run = await runMutate([s.target, NEEDLE, "", process.execPath, fail, s.target, s.log]);
    expect(run.exitCode).toBe(3);
    expect(run.stderr).toContain(
      "NOT A VALID RUN: the test command failed before any mutation (exit 1) — fix the command, cwd or build first",
    );
    expect(run.stderr).not.toContain("PINNED");
    expect(readFileSync(s.target, "utf8")).toBe(ORIGINAL);
    expect(seen(s.log)).toEqual([ORIGINAL]);
  });

  test("a test command that cannot be started is NOT A VALID RUN, exit 3, with the file untouched", async () => {
    const s = scenario();
    const run = await runMutate([s.target, NEEDLE, "", join(s.dir, "no-such-executable"), s.target]);
    expect(run.exitCode).toBe(3);
    expect(run.stderr).toContain("NOT A VALID RUN: the test command could not be started (");
    expect(run.stderr).not.toContain("PINNED");
    expect(readFileSync(s.target, "utf8")).toBe(ORIGINAL);
  });

  test("baseline green and mutated red is PINNED, exit 0, with the file restored", async () => {
    const s = scenario();
    const check = s.script("check.ts", `${RECORD}process.exit(text.includes("locked") ? 0 : 1);\n`);
    const run = await runMutate([s.target, NEEDLE, "", process.execPath, check, s.target, s.log]);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain("PINNED: the mutation was caught");
    expect(readFileSync(s.target, "utf8")).toBe(ORIGINAL);
    expect(seen(s.log)).toEqual([ORIGINAL, "\nrun();\n"]);
  });

  test("baseline green and mutated still green is NOT PINNED, exit 1", async () => {
    const s = scenario();
    const pass = s.script("pass.ts", `${RECORD}process.exit(0);\n`);
    const run = await runMutate([s.target, NEEDLE, "", process.execPath, pass, s.target, s.log]);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("NOT PINNED: the mutation survived");
    expect(readFileSync(s.target, "utf8")).toBe(ORIGINAL);
    expect(seen(s.log)).toEqual([ORIGINAL, "\nrun();\n"]);
  });
});

const posixTest = process.platform === "win32" ? test.skip : test;

/** Passes on the untouched file and, once mutated, hangs in a grandchild the way a cleanup-path match did on #956. */
const HANG_WHEN_MUTATED = `${RECORD}if (text.includes("locked")) process.exit(0);
if (process.argv[6]) writeFileSync(process.argv[6], String(process.pid));
const child = Bun.spawn([process.execPath, process.argv[4]!]);
writeFileSync(process.argv[5]!, String(child.pid));
await child.exited;
`;

const SLEEP = "await Bun.sleep(60_000);\n";

/** Forks a sleeper every 50 ms and records each pid, so a snapshot-then-kill sweep has a window to miss one. */
const FORK_LOOP = `import { appendFileSync } from "node:fs";
const [sleep, pids] = process.argv.slice(2);
while (true) {
  appendFileSync(pids!, String(Bun.spawn([process.execPath, sleep!]).pid) + "\\n");
  await Bun.sleep(50);
}
`;

/** Passes untouched; mutated, it hands the hang to a forking grandchild (argv: sleep, pids, own-pid file). */
const FORK_WHEN_MUTATED = `${RECORD}if (text.includes("locked")) process.exit(0);
const child = Bun.spawn([process.execPath, process.argv[4]!, process.argv[5]!, process.argv[6]!]);
writeFileSync(process.argv[7]!, String(child.pid));
await child.exited;
`;

describe("bun scripts/mutate.ts — the timeout (#1211)", () => {
  posixTest("a mutated run that hangs is killed with its whole tree, restored, and NOT A VALID RUN, exit 3", async () => {
    const s = scenario();
    const hang = s.script("hang.ts", HANG_WHEN_MUTATED);
    const sleep = s.script("sleep.ts", SLEEP);
    const pidFile = join(s.dir, "grandchild.pid");
    const started = Date.now();
    const run = runMutate(["--timeout", "2", s.target, NEEDLE, "", process.execPath, hang, s.target, s.log, sleep, pidFile]);
    const grandchild = await waitForPidFile(pidFile);
    expect(pidIsAlive(grandchild)).toBe(true);
    const result = await run;
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("NOT A VALID RUN: the test command ran longer than 2 s — a hang is not a caught mutation");
    expect(result.stderr).not.toContain("PINNED");
    expect(readFileSync(s.target, "utf8")).toBe(ORIGINAL);
    expect(await waitForPidExit(grandchild)).toBe(true);
  });

  posixTest("a grandchild that keeps forking cannot outrun the kill: every process it recorded is gone", async () => {
    const s = scenario();
    const tester = s.script("fork-tester.ts", FORK_WHEN_MUTATED);
    const loop = s.script("fork-loop.ts", FORK_LOOP);
    const sleep = s.script("sleep.ts", SLEEP);
    const pids = join(s.dir, "sleepers.pids");
    const spawnerPid = join(s.dir, "spawner.pid");
    const mutate = spawnMutate([
      "--timeout", "2", s.target, NEEDLE, "", process.execPath, tester, s.target, s.log, loop, sleep, pids, spawnerPid,
    ]);
    const spawner = await waitForPidFile(spawnerPid);
    expect(await waitForPidExit(mutate.pid)).toBe(true);
    expect(readFileSync(s.target, "utf8")).toBe(ORIGINAL);
    const sleepers = readFileSync(pids, "utf8").trim().split("\n").map(Number).map(trackPid);
    expect(sleepers.length).toBeGreaterThan(10);
    expect(await waitForPidExit(spawner)).toBe(true);
    const survivors: number[] = [];
    for (const pid of sleepers) if (!(await waitForPidExit(pid))) survivors.push(pid);
    // A survivor holds mutate's inherited stdio, so it is reaped before the streams are read and named after.
    for (const pid of survivors) process.kill(pid, "SIGKILL");
    const result = await mutate.result;
    expect(result.exitCode).toBe(3);
    expect(survivors).toEqual([]);
  });

  posixTest("MUTATE_TIMEOUT_SECONDS sets the default budget", async () => {
    const s = scenario();
    const hang = s.script("hang.ts", HANG_WHEN_MUTATED);
    const sleep = s.script("sleep.ts", SLEEP);
    const pidFile = join(s.dir, "grandchild.pid");
    const run = runMutate([s.target, NEEDLE, "", process.execPath, hang, s.target, s.log, sleep, pidFile], {
      MUTATE_TIMEOUT_SECONDS: "1",
    });
    const grandchild = await waitForPidFile(pidFile);
    const result = await run;
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("NOT A VALID RUN: the test command ran longer than 1 s — a hang is not a caught mutation");
    expect(readFileSync(s.target, "utf8")).toBe(ORIGINAL);
    expect(await waitForPidExit(grandchild)).toBe(true);
  });
});

const TWICE = "if (locked) return;\nrun();\nif (locked) return;\n";

describe("bun scripts/mutate.ts — the occurrence guard (#1211)", () => {
  test("a needle that occurs twice is refused, naming both lines, unless --occurrences names the count", async () => {
    const s = scenario();
    writeFileSync(s.target, TWICE);
    const check = s.script("check.ts", `${RECORD}process.exit(text.includes("locked") ? 0 : 1);\n`);
    const run = await runMutate([s.target, NEEDLE, "", process.execPath, check, s.target, s.log]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(
      `refusing: '${NEEDLE}' occurs 2 times in ${s.target} (lines 1, 3) — pass --occurrences 2 to replace all 2, or narrow the text`,
    );
    expect(readFileSync(s.target, "utf8")).toBe(TWICE);
    expect(seen(s.log)).toEqual([]);
  });

  test("--occurrences matching the count replaces every match and reaches the PINNED verdict", async () => {
    const s = scenario();
    writeFileSync(s.target, TWICE);
    const check = s.script("check.ts", `${RECORD}process.exit(text.includes("locked") ? 0 : 1);\n`);
    const run = await runMutate(["--occurrences", "2", s.target, NEEDLE, "", process.execPath, check, s.target, s.log]);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toContain("PINNED: the mutation was caught");
    expect(readFileSync(s.target, "utf8")).toBe(TWICE);
    expect(seen(s.log)).toEqual([TWICE, "\nrun();\n\n"]);
  });

  test("--occurrences that disagrees with the count is refused naming both numbers", async () => {
    const s = scenario();
    writeFileSync(s.target, TWICE);
    const check = s.script("check.ts", `${RECORD}process.exit(text.includes("locked") ? 0 : 1);\n`);
    const run = await runMutate(["--occurrences", "3", s.target, NEEDLE, "", process.execPath, check, s.target, s.log]);
    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain(
      `refusing: '${NEEDLE}' occurs 2 times in ${s.target} (lines 1, 3), not the 3 that --occurrences names`,
    );
    expect(readFileSync(s.target, "utf8")).toBe(TWICE);
    expect(seen(s.log)).toEqual([]);
  });
});

describe("bun scripts/mutate.ts — the sidecar (#1211)", () => {
  function hanging(s: ReturnType<typeof scenario>): { args: string[]; childPid: string; grandchildPid: string } {
    const hang = s.script("hang.ts", HANG_WHEN_MUTATED);
    const sleep = s.script("sleep.ts", SLEEP);
    const grandchildPid = join(s.dir, "grandchild.pid");
    const childPid = join(s.dir, "child.pid");
    return { args: [s.target, NEEDLE, "", process.execPath, hang, s.target, s.log, sleep, grandchildPid, childPid], childPid, grandchildPid };
  }

  posixTest("SIGTERM mid-run restores the file, removes the sidecar, kills the test tree and exits 3", async () => {
    const s = scenario();
    const sidecar = `${s.target}.mutate-orig`;
    const { args, childPid, grandchildPid } = hanging(s);
    const mutate = spawnMutate(args);
    const grandchild = await waitForPidFile(grandchildPid);
    const child = await waitForPidFile(childPid);
    expect(readFileSync(s.target, "utf8")).toBe("\nrun();\n");
    expect(readFileSync(sidecar, "utf8")).toBe(ORIGINAL);
    process.kill(mutate.pid, "SIGTERM");
    const result = await mutate.result;
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("NOT A VALID RUN: interrupted");
    expect(readFileSync(s.target, "utf8")).toBe(ORIGINAL);
    expect(existsSync(sidecar)).toBe(false);
    expect(await waitForPidExit(child)).toBe(true);
    expect(await waitForPidExit(grandchild)).toBe(true);
  });

  posixTest("SIGKILL leaves the sidecar as evidence, and the next run refuses until it is restored", async () => {
    const s = scenario();
    const sidecar = `${s.target}.mutate-orig`;
    const { args, childPid, grandchildPid } = hanging(s);
    const mutate = spawnMutate(args);
    const grandchild = await waitForPidFile(grandchildPid);
    const child = await waitForPidFile(childPid);
    process.kill(mutate.pid, "SIGKILL");
    expect(await waitForPidExit(mutate.pid)).toBe(true);
    expect(readFileSync(s.target, "utf8")).toBe("\nrun();\n");
    expect(readFileSync(sidecar, "utf8")).toBe(ORIGINAL);
    // The orphans hold mutate's inherited stdio, so its streams only close once they are gone.
    for (const orphan of [child, grandchild]) process.kill(orphan, "SIGKILL");
    expect(await waitForPidExit(child)).toBe(true);
    expect(await waitForPidExit(grandchild)).toBe(true);
    await mutate.result;

    const rerun = await runMutate(args);
    expect(rerun.exitCode).toBe(2);
    expect(rerun.stderr).toContain(`a previous run was interrupted — restore with: mv ${sidecar} ${s.target}`);
    expect(readFileSync(s.target, "utf8")).toBe("\nrun();\n");
    expect(readFileSync(sidecar, "utf8")).toBe(ORIGINAL);
    expect(seen(s.log)).toEqual([ORIGINAL, "\nrun();\n"]);
  });

  test("a run that finishes leaves no sidecar behind", async () => {
    const s = scenario();
    const check = s.script("check.ts", `${RECORD}process.exit(text.includes("locked") ? 0 : 1);\n`);
    const run = await runMutate([s.target, NEEDLE, "", process.execPath, check, s.target, s.log]);
    expect(run.exitCode).toBe(0);
    expect(existsSync(`${s.target}.mutate-orig`)).toBe(false);
  });
});
