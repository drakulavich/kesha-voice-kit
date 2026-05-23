import { defineCommand } from "citty";
import {
  disableDiagnosticLogs,
  enableDiagnosticLogs,
  getDiagnosticLogStatus,
  humanBytes,
  resetDiagnosticLogs,
  resolveDiagnosticLogPath,
} from "../diagnostic-log";
import { log } from "../log";

interface LogsCommandArgs {
  action?: string;
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
      description: "Action: status | enable | disable | path | reset",
    },
  },
  run({ args }: { args: LogsCommandArgs }) {
    const action = args.action ?? "status";
    switch (action) {
      case "enable": {
        const status = enableDiagnosticLogs();
        log.success("Kesha diagnostic logs enabled");
        log.info(`Path: ${status.activePath}`);
        log.info(`Rotation: ${humanBytes(status.maxBytes)}, keep ${status.retain}`);
        return;
      }
      case "disable": {
        const status = disableDiagnosticLogs();
        log.info("Kesha diagnostic logs disabled");
        log.info(`Path: ${status.activePath}`);
        return;
      }
      case "status": {
        const status = getDiagnosticLogStatus();
        log.info(`Kesha diagnostic logs: ${status.enabled ? "enabled" : "disabled"}`);
        log.info(`Path: ${status.activePath}`);
        log.info(`Size: ${humanBytes(status.totalSizeBytes)}`);
        log.info(`Rotated files: ${status.rotatedFiles.length}`);
        log.info(`Rotation: ${humanBytes(status.maxBytes)}, keep ${status.retain}`);
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
        log.warn("supported: enable, disable, status, path, reset");
        process.exit(2);
    }
  },
});
