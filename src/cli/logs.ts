import { defineCommand } from "citty";
import {
  getDiagnosticLogStatus,
  humanBytes,
  parseDiagnosticLogMode,
  resetDiagnosticLogs,
  resolveDiagnosticLogPath,
  setDiagnosticLogMode,
} from "../diagnostic-log";
import { log } from "../log";

interface LogsCommandArgs {
  action?: string;
  value?: string;
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
  },
  run({ args }: { args: LogsCommandArgs }) {
    const action = args.action ?? "status";
    switch (action) {
      case "enable": {
        const status = setDiagnosticLogMode("on");
        log.success("Kesha diagnostic logs enabled");
        log.info(`Mode: ${status.mode}`);
        log.info(`Path: ${status.activePath}`);
        log.info(`Rotation: ${humanBytes(status.maxBytes)}, keep ${status.retain}`);
        return;
      }
      case "disable": {
        const status = setDiagnosticLogMode("off");
        log.info("Kesha diagnostic logs disabled");
        log.info(`Mode: ${status.mode}`);
        log.info(`Path: ${status.activePath}`);
        return;
      }
      case "status": {
        const status = getDiagnosticLogStatus();
        log.info(`Kesha diagnostic logs: ${status.mode === "off" ? "disabled" : "enabled"}`);
        log.info(`Mode: ${status.mode}`);
        log.info(`Path: ${status.activePath}`);
        log.info(`Size: ${humanBytes(status.totalSizeBytes)}`);
        log.info(`Rotated files: ${status.rotatedFiles.length}`);
        log.info(`Rotation: ${humanBytes(status.maxBytes)}, keep ${status.retain}`);
        return;
      }
      case "mode": {
        if (!args.value) {
          const status = getDiagnosticLogStatus();
          log.info(`Kesha diagnostic log mode: ${status.mode}`);
          return;
        }
        const mode = parseDiagnosticLogMode(args.value);
        if (!mode) {
          log.error("usage: kesha logs mode <off|on|retain-on-failure>");
          process.exit(2);
        }
        const status = setDiagnosticLogMode(mode);
        log.info(`Kesha diagnostic log mode set to ${status.mode}`);
        log.info(`Path: ${status.activePath}`);
        return;
      }
      case "path": {
        log.info(resolveDiagnosticLogPath());
        return;
      }
      case "reset": {
        const result = resetDiagnosticLogs();
        log.info(`Kesha diagnostic logs reset: ${result.deleted} file(s), ${humanBytes(result.bytes)} deleted`);
        return;
      }
      default:
        log.error(`unknown logs action '${action}'`);
        log.warn("supported: enable, disable, mode, status, path, reset");
        process.exit(2);
    }
  },
});
