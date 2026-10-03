import { defineCommand } from "citty";
import { errorMessage } from "../error-utils";
import { exitCodeFor, KeshaError } from "../engine/events";
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
      if (args.output === "") {
        throw new KeshaError("E_INVALID_ARG", "--output needs a file path", { hint: "pass --output path.tar.gz." });
      }
      if (args.output === "-") {
        throw new KeshaError("E_INVALID_ARG", "--output - is not a file path", {
          hint: "to write the archive to stdout, pass --output /dev/stdout.",
        });
      }
      const bundle = await createSupportBundle({
        output: args.output,
        includeLogs: Boolean(args["include-logs"]),
      });
      log.notice(`Created support bundle: ${bundle.path}`);
      log.status(`Entries: ${bundle.entries.length}`);
      log.status(`Size: ${bundle.sizeBytes} bytes`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPIPE") return;
      log.error(errorMessage(err));
      process.exit(err instanceof KeshaError ? exitCodeFor(err) : 1);
    }
  },
});
