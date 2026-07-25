import { defineCommand } from "citty";
import {
  getDiagnosticLogStatus,
  humanBytes,
  parseDiagnosticLogMode,
  resetDiagnosticLogs,
  resolveDiagnosticLogPath,
  setDiagnosticLogMode,
} from "../diagnostic-log";
import { emitActionResult, type ActionMessage, type ActionResult } from "./action-result";

export interface LogsCommandArgs {
  action?: string;
  value?: string;
  json?: boolean;
}

const SUPPORTED_ACTIONS = "enable, disable, mode, status, path, reset";

/** Runs one `kesha logs` action and reports what to print; all output happens in the caller. */
export function runLogsAction(args: LogsCommandArgs): ActionResult {
  const action = args.action ?? "status";
  if (args.json && action !== "status") {
    return { ok: false, error: "usage: kesha logs status --json" };
  }
  switch (action) {
    case "enable": {
      const status = setDiagnosticLogMode("on");
      return {
        ok: true,
        messages: [
          { level: "success", text: "Kesha diagnostic logs enabled" },
          ...info(
            `Mode: ${status.mode}`,
            `Path: ${status.activePath}`,
            `Rotation: ${humanBytes(status.maxBytes)}, keep ${status.retain}`,
          ),
        ],
      };
    }
    case "disable": {
      const status = setDiagnosticLogMode("off");
      return {
        ok: true,
        messages: info(
          "Kesha diagnostic logs disabled",
          `Mode: ${status.mode}`,
          `Path: ${status.activePath}`,
        ),
      };
    }
    case "status": {
      const status = getDiagnosticLogStatus();
      if (args.json) {
        return { ok: true, messages: [], stdout: `${JSON.stringify(status, null, 2)}\n` };
      }
      return {
        ok: true,
        messages: info(
          `Kesha diagnostic logs: ${status.mode === "off" ? "disabled" : "enabled"}`,
          `Mode: ${status.mode}`,
          `Path: ${status.activePath}`,
          `Size: ${humanBytes(status.totalSizeBytes)}`,
          `Rotated files: ${status.rotatedFiles.length}`,
          `Rotation: ${humanBytes(status.maxBytes)}, keep ${status.retain}`,
        ),
      };
    }
    case "mode":
      return runModeAction(args.value);
    case "path":
      return { ok: true, messages: info(resolveDiagnosticLogPath()) };
    case "reset": {
      const result = resetDiagnosticLogs();
      return {
        ok: true,
        messages: info(
          `Kesha diagnostic logs reset: ${result.deleted} file(s), ${humanBytes(result.bytes)} deleted`,
        ),
      };
    }
    default:
      return {
        ok: false,
        error: `unknown logs action '${action}'`,
        hint: `supported: ${SUPPORTED_ACTIONS}`,
      };
  }
}

function runModeAction(value: string | undefined): ActionResult {
  if (!value) {
    return { ok: true, messages: info(`Kesha diagnostic log mode: ${getDiagnosticLogStatus().mode}`) };
  }
  const mode = parseDiagnosticLogMode(value);
  if (!mode) return { ok: false, error: "usage: kesha logs mode <off|on|retain-on-failure>" };
  const status = setDiagnosticLogMode(mode);
  return {
    ok: true,
    messages: info(`Kesha diagnostic log mode set to ${status.mode}`, `Path: ${status.activePath}`),
  };
}

function info(...texts: string[]): ActionMessage[] {
  return texts.map((text) => ({ level: "info", text }));
}

export const logsCommand = defineCommand({
  meta: {
    name: "logs",
    description: "Manage local privacy-safe diagnostic logs",
  },
  args: {
    action: {
      type: "positional",
      required: false,
      description: "Action: status | enable | disable | mode | path | reset",
    },
    value: {
      type: "positional",
      required: false,
      description: "Action value: off | on | retain-on-failure",
    },
    json: {
      type: "boolean",
      description: "Output status as JSON",
      default: false,
    },
  },
  run({ args }: { args: LogsCommandArgs }) {
    emitActionResult(runLogsAction(args));
  },
});
