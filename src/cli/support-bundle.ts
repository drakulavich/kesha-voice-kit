import { defineCommand } from "citty";
import { createSupportBundle } from "../support-bundle";
import { log } from "../log";

interface SupportBundleCommandArgs {
  output?: string;
  "include-logs"?: boolean;
}

export const supportBundleCommand = defineCommand({
  meta: {
    name: "support-bundle",
    description: "Create a redacted diagnostics archive for support",
  },
  args: {
    output: {
      type: "string",
      description: "Write archive to this .tar.gz path",
    },
    "include-logs": {
      type: "boolean",
      description: "Include a bounded tail of privacy-safe diagnostic logs",
      default: false,
    },
  },
  async run({ args }: { args: SupportBundleCommandArgs }) {
    try {
      const bundle = await createSupportBundle({
        output: args.output,
        includeLogs: Boolean(args["include-logs"]),
      });
      log.success(`Created support bundle: ${bundle.path}`);
      log.info(`Entries: ${bundle.entries.length}`);
      log.info(`Size: ${bundle.sizeBytes} bytes`);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
