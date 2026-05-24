import { runMain, type CommandDef } from "citty";
import { existsSync } from "fs";
import { log } from "../log";
import { suggestCommand } from "../suggest-command";
import { completionsCommand } from "./completions";
import { doctorCommand } from "./doctor";
import { initCommand } from "./init";
import { installCommand } from "./install";
import { logsCommand } from "./logs";
import { manpageCommand } from "./manpage";
import { recordCommand } from "./record";
import { sayCommand } from "./say";
import { statsCommand } from "./stats";
import { statusCommand } from "./status";
import { supportBundleCommand } from "./support-bundle";
import { mainCommand } from "./main";

// Single source of truth: keyed lookup also feeds the `did you mean` suggester.
// `CommandDef<any>` is intentional — citty's generic is invariant in the args
// shape, and each subcommand has its own arg schema; the value here is only
// passed back to `runMain`, which re-reads the schema from the def itself.
const SUBCOMMANDS: Record<string, CommandDef<any>> = {
  doctor: doctorCommand,
  init: initCommand,
  install: installCommand,
  logs: logsCommand,
  status: statusCommand,
  record: recordCommand,
  say: sayCommand,
  stats: statsCommand,
  "support-bundle": supportBundleCommand,
  completions: completionsCommand,
  manpage: manpageCommand,
};

function isPathLike(arg: string): boolean {
  return arg.includes(".") || arg.includes("/") || existsSync(arg);
}

export async function runCli(rawArgs = process.argv.slice(2)): Promise<void> {
  const [firstArg, ...restArgs] = rawArgs;

  if (firstArg && Object.hasOwn(SUBCOMMANDS, firstArg)) {
    await runMain(SUBCOMMANDS[firstArg], { rawArgs: restArgs });
    return;
  }

  // Check for unknown subcommands (non-flag, non-file-path args).
  // Extensionless existing files remain valid transcription inputs; missing
  // bare tokens are more likely command typos and should not start the engine.
  if (firstArg && !firstArg.startsWith("-") && !isPathLike(firstArg)) {
    const suggestion = suggestCommand(firstArg, Object.keys(SUBCOMMANDS));
    log.error(`unknown command '${firstArg}'`);
    if (suggestion && suggestion !== firstArg) {
      log.warn(`(Did you mean ${suggestion}?)`);
    }
    log.warn(`If this is an audio file, pass a path like './${firstArg}'.`);
    process.exit(1);
  }

  await runMain(mainCommand, { rawArgs });
}
