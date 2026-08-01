import { defineCommand } from "citty";
import { collectStatus, renderStatus } from "../status";

interface StatusCommandArgs {
  disk: boolean;
  json: boolean;
}

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show backend installation status",
  },
  args: {
    disk: {
      type: "boolean",
      description: "Include recursive cache disk usage",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Output status as JSON",
      default: false,
    },
  },
  async run({ args }: { args: StatusCommandArgs }) {
    const report = await collectStatus({ disk: args.disk });
    if (args.json) {
      // `log.*` writes to stdout, so the payload must be the only thing printed —
      // the setup hint ships inside it instead of on stderr (#647).
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    renderStatus(report);
  },
});
