import { runMain } from "citty";
import { log } from "../log";
import { suggestCommand } from "../suggest-command";
import { installCommand } from "./install";
import { sayCommand } from "./say";
import { statusCommand } from "./status";
import { mainCommand } from "./main";

const SUBCOMMANDS = ["install", "status", "say"];

export async function runCli(rawArgs = process.argv.slice(2)): Promise<void> {
  const [firstArg, ...restArgs] = rawArgs;

  if (firstArg === "install") {
    await runMain(installCommand, { rawArgs: restArgs });
    return;
  }

  if (firstArg === "status") {
    await runMain(statusCommand, { rawArgs: restArgs });
    return;
  }

  if (firstArg === "say") {
    await runMain(sayCommand, { rawArgs: restArgs });
    return;
  }

  // Check for unknown subcommands (non-flag, non-file-path args)
  if (firstArg && !firstArg.startsWith("-") && !firstArg.includes(".") && !firstArg.includes("/")) {
    const suggestion = suggestCommand(firstArg, SUBCOMMANDS);
    if (suggestion && suggestion !== firstArg) {
      log.error(`unknown command '${firstArg}'`);
      log.warn(`(Did you mean ${suggestion}?)`);
      process.exit(1);
    }
  }

  await runMain(mainCommand, { rawArgs });
}
