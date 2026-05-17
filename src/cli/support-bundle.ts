import { defineCommand } from "citty";
import { createSupportBundle } from "../support-bundle";
import { log } from "../log";

interface SupportBundleCommandArgs {
  output?: string;
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
  },
  async run({ args }: { args: SupportBundleCommandArgs }) {
    try {
      const bundle = await createSupportBundle({ output: args.output });
      log.success(`Created support bundle: ${bundle.path}`);
      log.info(`Entries: ${bundle.entries.length}`);
      log.info(`Size: ${bundle.sizeBytes} bytes`);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  },
});
