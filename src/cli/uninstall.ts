import { confirm, isCancel } from "@clack/prompts";
import { defineCommand } from "citty";
import { existsSync, rmdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { exitCodeFor, KeshaError } from "../engine/events";
import { errorMessage } from "../error-utils";
import { humanBytes } from "../format";
import { takeInstallLockNow } from "../install-lock";
import { log } from "../log";
import { buildUninstallPlan, type UninstallEntry, type UninstallPlan } from "../uninstall-plan";

const CLI_PACKAGE_HINT = "The kesha CLI itself stays: remove it with the package manager that installed it, e.g. `bun remove -g @drakulavich/kesha-voice-kit`.";

const entries = (n: number): string => `${n} ${n === 1 ? "entry" : "entries"}`;

function fail(err: KeshaError): void {
  log.error(errorMessage(err));
  process.exitCode = exitCodeFor(err);
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

function removeIfEmpty(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // Not empty, or already gone: either way it is not ours to remove.
  }
}

/** The Engine directory holds the install lock, so it goes last. */
function removalOrder(entries: UninstallEntry[], engineBin: string): UninstallEntry[] {
  const engineDir = dirname(dirname(engineBin));
  return [...entries].sort((a, b) => Number(a.path === engineDir) - Number(b.path === engineDir));
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
    if (removing.length === 0) {
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

    const lockCreates = missingDirs(dirname(plan.engineBin));
    let release: () => void;
    try {
      release = takeInstallLockNow(plan.engineBin, "kesha uninstall");
    } catch (e) {
      for (const d of lockCreates) removeIfEmpty(d);
      if (e instanceof KeshaError) return fail(e);
      throw e;
    }

    let failed = 0;
    try {
      for (const entry of removalOrder(removing, plan.engineBin)) {
        try {
          rmSync(entry.path, { recursive: true, force: true });
        } catch (e) {
          failed++;
          fail(
            new KeshaError("E_UNINSTALL_PARTIAL", `could not remove ${entry.path}: ${errorMessage(e)}`, {
              hint: "make the path writable or remove it by hand, then re-run `kesha uninstall`",
            }),
          );
        }
      }
    } finally {
      release();
    }
    for (const d of [...lockCreates, ...plan.emptyDirs]) removeIfEmpty(d);

    log.notice(failed === 0 ? `Removed ${entries(removing.length)}.` : `Removed ${removing.length - failed} of ${entries(removing.length)}.`);
    log.notice(CLI_PACKAGE_HINT);
  },
});
