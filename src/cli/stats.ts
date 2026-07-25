import { defineCommand } from "citty";
import {
  disableStats,
  enableStats,
  exportStats,
  getRecentErrors,
  getStatsStatus,
  getWeekSummary,
  renderErrors,
  renderWeekSummary,
  resetStats,
  setStatsRetentionDays,
  vacuumStats,
  type StatsExportFormat,
} from "../stats";
import { emitActionResult, type ActionMessage, type ActionResult } from "./action-result";

export interface StatsCommandArgs {
  action?: string;
  value?: string;
  format?: string;
}

const SUPPORTED_ACTIONS = "enable, disable, status, week, errors, export, reset, vacuum, retention";

/** Runs one `kesha stats` action and reports what to print; all output happens in the caller. */
export function runStatsAction(args: StatsCommandArgs): ActionResult {
  const action = args.action ?? "status";
  switch (action) {
    case "enable": {
      enableStats();
      return {
        ok: true,
        messages: [
          { level: "success", text: "Kesha Stats enabled" },
          { level: "info", text: `Database: ${getStatsStatus().dbPath}` },
        ],
      };
    }
    case "disable": {
      disableStats();
      return {
        ok: true,
        messages: [
          { level: "info", text: "Kesha Stats disabled" },
          { level: "info", text: `Database: ${getStatsStatus().dbPath}` },
        ],
      };
    }
    case "status": {
      const status = getStatsStatus();
      return {
        ok: true,
        messages: info(
          `Kesha Stats: ${status.enabled ? "enabled" : "disabled"}`,
          `Database: ${status.dbPath}`,
          `Runs: ${status.runCount}`,
          `Retention: ${formatRetention(status.retentionDays)}`,
        ),
      };
    }
    case "week":
      return { ok: true, messages: info(renderWeekSummary(getWeekSummary())) };
    case "errors":
      return { ok: true, messages: info(renderErrors(getRecentErrors())) };
    case "export": {
      const format = parseExportFormat(args.format ?? args.value ?? "json");
      if (!format) return { ok: false, error: "usage: kesha stats export --format json|csv" };
      return { ok: true, messages: [], stdout: exportStats(format) };
    }
    case "reset": {
      const result = resetStats();
      return {
        ok: true,
        messages: info(
          `Kesha Stats reset: ${result.runs} run(s), ${result.stageTimings} stage timing(s), ` +
            `${result.artifacts} artifact(s), ${result.errors} error(s) deleted`,
        ),
      };
    }
    case "vacuum": {
      const result = vacuumStats();
      return {
        ok: true,
        messages: info(
          `Kesha Stats vacuumed: ${result.beforeBytes} -> ${result.afterBytes} bytes`,
          `Database: ${result.dbPath}`,
        ),
      };
    }
    case "retention":
      return runRetentionAction(args.value);
    default:
      return {
        ok: false,
        error: `unknown stats action '${action}'`,
        hint: `supported: ${SUPPORTED_ACTIONS}`,
      };
  }
}

function runRetentionAction(value: string | undefined): ActionResult {
  if (!value) {
    const status = getStatsStatus();
    return { ok: true, messages: info(`Kesha Stats retention: ${formatRetention(status.retentionDays)}`) };
  }
  const retention = parseRetention(value);
  if (retention === undefined) return { ok: false, error: "usage: kesha stats retention <days|off>" };
  setStatsRetentionDays(retention);
  return { ok: true, messages: info(`Kesha Stats retention set to ${formatRetention(retention)}`) };
}

function info(...texts: string[]): ActionMessage[] {
  return texts.map((text) => ({ level: "info", text }));
}

export const statsCommand = defineCommand({
  meta: {
    name: "stats",
    description: "Manage local anonymous Kesha Stats",
  },
  args: {
    action: {
      type: "positional",
      required: false,
      description: "Action: enable | disable | status | week | errors | export | reset | vacuum | retention",
    },
    value: {
      type: "positional",
      required: false,
      description: "Action value: export format or retention days",
    },
    format: {
      type: "string",
      description: "Export format: json | csv",
    },
  },
  run({ args }: { args: StatsCommandArgs }) {
    emitActionResult(runStatsAction(args));
  },
});

function parseExportFormat(value: string): StatsExportFormat | null {
  return value === "json" || value === "csv" ? value : null;
}

function parseRetention(value: string): number | null | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "off" || normalized === "none" || normalized === "never") return null;
  const days = Number(normalized);
  if (Number.isInteger(days) && days >= 1) return days;
  return undefined;
}

function formatRetention(days: number | null): string {
  return days === null ? "off" : `${days} day(s)`;
}
