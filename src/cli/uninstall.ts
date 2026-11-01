import { confirm, isCancel } from "@clack/prompts";
import { defineCommand } from "citty";
import { existsSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { isInsideDir } from "../cache-layout";
import { exitCodeFor, KeshaError } from "../engine/events";
import { errorMessage } from "../error-utils";
import { humanBytes } from "../format";
import { takeInstallLockNow } from "../install-lock";
import { log } from "../log";
import { buildUninstallPlan, type UninstallPlan } from "../uninstall-plan";

const CLI_PACKAGE_HINT = "The kesha CLI itself stays: remove it with the package manager that installed it, e.g. `bun remove -g @drakulavich/kesha-voice-kit`.";

const entries = (n: number): string => `${n} ${n === 1 ? "entry" : "entries"}`;

export interface RemovalFailure {
  path: string;
  reason: string;
}

function fail(err: KeshaError): void {
  log.error(errorMessage(err));
  process.exitCode = exitCodeFor(err);
}

function reportFailure(f: RemovalFailure): void {
  fail(
    new KeshaError("E_UNINSTALL_PARTIAL", `could not remove ${f.path}: ${f.reason}`, {
      hint: "make the path writable or remove it by hand, then re-run `kesha uninstall`",
    }),
  );
}

function renderPlan(plan: UninstallPlan): void {
  const removing = plan.entries.filter((e) => e.action === "remove");
  log.notice("Kesha uninstall plan:");
  for (const e of plan.entries) {
    const what = e.action === "remove" ? `${e.label}: ${e.path}` : `${e.path} (${e.reason})`;
    log.notice(`  ${e.action.padEnd(6)} ${humanBytes(e.bytes).padStart(9)}  ${what}`);
  }
  log.notice(`Total to remove: ${humanBytes(removing.reduce((n, e) => n + e.bytes, 0))} in ${entries(removing.length)}.`);
}

/** The directories `path` would need created, deepest first: what taking the lock leaves behind. */
function missingDirs(path: string): string[] {
  const missing: string[] = [];
  for (let d = path; !existsSync(d) && dirname(d) !== d; d = dirname(d)) missing.push(d);
  return missing;
}

const codeOf = (e: unknown): string | undefined => (e as NodeJS.ErrnoException).code;

/**
 * Removes `path` except the protected paths inside it and the directories leading to them,
 * which it returns so they can go once empty.
 */
export function removeAround(path: string, protectedPaths: string[], failures: RemovalFailure[]): string[] {
  if (protectedPaths.includes(path)) return [];
  if (!protectedPaths.some((p) => isInsideDir(p, path))) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (e) {
      failures.push({ path, reason: errorMessage(e) });
    }
    return [];
  }
  let names: string[];
  try {
    names = readdirSync(path);
  } catch (e) {
    failures.push({ path, reason: errorMessage(e) });
    return [];
  }
  return [path, ...names.flatMap((name) => removeAround(join(path, name), protectedPaths, failures))];
}

/** Removes each directory a listing shows empty, deepest first; anything but "missing" or "not empty" is a failure. */
export function removeEmptyDirs(dirs: string[], failures: RemovalFailure[]): void {
  for (const dir of [...new Set(dirs)].sort((a, b) => b.length - a.length)) {
    try {
      if (readdirSync(dir).length > 0) continue;
      rmdirSync(dir);
    } catch (e) {
      if (!["ENOENT", "ENOTDIR", "ENOTEMPTY", "EEXIST"].includes(codeOf(e) ?? "")) failures.push({ path: dir, reason: errorMessage(e) });
    }
  }
}

export const uninstallCommand = defineCommand({
  meta: {
    name: "uninstall",
    description: "Remove the engine, models, logs, stats and MCP audio Kesha created (the CLI package stays)",
  },
  args: {
    yes: {
      type: "boolean",
      description: "Remove without asking; required without a terminal",
      default: false,
    },
  },
  async run({ args }: { args: { yes: boolean } }) {
    const plan = buildUninstallPlan();
    const removing = plan.entries.filter((e) => e.action === "remove");
    if (plan.entries.length > 0) renderPlan(plan);
    for (const dir of plan.unreadable) {
      fail(
        new KeshaError("E_UNINSTALL_PARTIAL", `could not read ${dir.path}, so Kesha files in it stay: ${dir.reason}`, {
          hint: "make the directory readable and re-run `kesha uninstall`, or remove its kesha* files by hand",
        }),
      );
    }
    const failures: RemovalFailure[] = [];
    // An unreadable directory is already reported above.
    const emptyDirs = plan.emptyDirs.filter((d) => !plan.unreadable.some((u) => u.path === d));
    if (removing.length === 0) {
      removeEmptyDirs(emptyDirs, failures);
      for (const f of failures) reportFailure(f);
      log.notice("Nothing to remove: no Kesha engine, models, logs, stats or MCP audio found.");
      log.notice(CLI_PACKAGE_HINT);
      return;
    }

    if (!args.yes) {
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        fail(
          new KeshaError("E_INVALID_ARG", "kesha uninstall asks before removing anything and needs a terminal", {
            hint: "run `kesha uninstall --yes` to remove the entries marked remove above",
          }),
        );
        return;
      }
      const answer = await confirm({
        message: `Remove ${entries(removing.length)} (${humanBytes(removing.reduce((n, e) => n + e.bytes, 0))})?`,
        initialValue: false,
      });
      if (isCancel(answer)) {
        fail(new KeshaError("E_INTERRUPTED", "uninstall cancelled; nothing was removed"));
        return;
      }
      if (!answer) {
        log.notice("Nothing removed.");
        return;
      }
    }

    const lockDir = `${plan.engineBin}.lock`;
    const lockCreates = missingDirs(dirname(plan.engineBin));
    let release: () => void;
    try {
      release = takeInstallLockNow(plan.engineBin, "kesha uninstall");
    } catch (e) {
      removeEmptyDirs(lockCreates, []);
      if (e instanceof KeshaError) return fail(e);
      throw e;
    }

    const protectedPaths = [...plan.entries.filter((e) => e.action === "keep").map((e) => e.path), lockDir];
    const walked: string[] = [];
    let failedEntries = 0;
    try {
      for (const entry of removing) {
        const before = failures.length;
        walked.push(...removeAround(entry.path, protectedPaths, failures));
        if (failures.length > before) failedEntries++;
      }
    } finally {
      release();
    }
    removeEmptyDirs([...walked, ...lockCreates, ...emptyDirs], failures);
    for (const f of failures) reportFailure(f);

    log.notice(failedEntries === 0 ? `Removed ${entries(removing.length)}.` : `Removed ${removing.length - failedEntries} of ${entries(removing.length)}.`);
    log.notice(CLI_PACKAGE_HINT);
  },
});
