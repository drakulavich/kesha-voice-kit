import { defineCommand } from "citty";
import { showStatus } from "../status";

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show backend installation status",
  },
  async run() {
    await showStatus();
  },
});
