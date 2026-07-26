import { runMain, type CommandDef } from "citty";
import { existsSync } from "fs";
import { log } from "../log";
import { suggestCommand } from "../suggest-command";
import { applyCliContext, resolveCliContext } from "./context";

// Lazy loaders so a cold CLI spawn transpiles only the invoked command, not the whole graph (#568).
// `CommandDef<any>`: citty's generic is invariant in the arg shape and each command has its own schema.
type CommandLoader = () => Promise<CommandDef<any>>;
const SUBCOMMANDS: Record<string, CommandLoader> = {
  doctor: async () => (await import("./doctor")).doctorCommand,
  init: async () => (await import("./init")).initCommand,
  install: async () => (await import("./install")).installCommand,
  logs: async () => (await import("./logs")).logsCommand,
  status: async () => (await import("./status")).statusCommand,
  record: async () => (await import("./record")).recordCommand,
  say: async () => (await import("./say")).sayCommand,
  stats: async () => (await import("./stats")).statsCommand,
  "support-bundle": async () => (await import("./support-bundle")).supportBundleCommand,
  completions: async () => (await import("./completions")).completionsCommand,
  manpage: async () => (await import("./manpage")).manpageCommand,
  mcp: async () => (await import("./mcp")).mcpCommand,
};

function isPathLike(arg: string): boolean {
  return arg.includes(".") || arg.includes("/") || existsSync(arg);
}

/**
 * Classify the first positional arg for routing.
 *
 * - `"subcommand"` — exact match in the known subcommand set
 * - `"unknown"`    — bare token that looks like a typo (not a flag, not path-like)
 * - `"main"`       — flags, path-like args, or no arg (→ transcribe / help)
 */
export function classifyFirstArg(
  firstArg: string | undefined,
  subcommandKeys: string[],
): "subcommand" | "unknown" | "main" {
  if (!firstArg) return "main";
  if (subcommandKeys.includes(firstArg)) return "subcommand";
  // Flags and path-like tokens fall through to the main transcribe command.
  if (firstArg.startsWith("-") || isPathLike(firstArg)) return "main";
  return "unknown";
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const context = resolveCliContext(argv);
  applyCliContext(context);

  const [firstArg, ...restArgs] = context.rawArgs;
  const subcommandKeys = Object.keys(SUBCOMMANDS);

  switch (classifyFirstArg(firstArg, subcommandKeys)) {
    case "subcommand":
      await runMain(await SUBCOMMANDS[firstArg!]!(), { rawArgs: restArgs });
      return;

    case "unknown": {
      // Extensionless existing files are valid transcription inputs; bare non-path tokens are likely command typos.
      const suggestion = suggestCommand(firstArg!, subcommandKeys);
      log.error(`unknown command '${firstArg}'`);
      if (suggestion && suggestion !== firstArg) {
        log.warn(`(Did you mean ${suggestion}?)`);
      }
      log.warn(`If this is an audio file, pass a path like './${firstArg}'.`);
      process.exit(1);
      break;
    }

    default: {
      const { createMainCommand } = await import("./main");
      await runMain(createMainCommand(context), { rawArgs: context.rawArgs });
    }
  }
}
