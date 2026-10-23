import { defineCommand } from "citty";
import { assertReady, collectStatus, renderStatus } from "../status";

interface StatusCommandArgs {
  check: boolean;
  disk: boolean;
  json: boolean;
}

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show backend installation status",
  },
  args: {
    check: {
      type: "boolean",
      description: "Print nothing; exit 1 with E_MODEL_MISSING unless the engine and ASR model are installed",
      default: false,
    },
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
    if (args.check) {
      await assertReady();
      return;
    }
    const report = await collectStatus({ disk: args.disk });
    if (args.json) {
      // `log.*` writes to stdout, so the payload must be the only thing printed (#647).
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    renderStatus(report);
  },
});
