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

export const SUBCOMMAND_NAMES = Object.keys(SUBCOMMANDS);

// Hand-curated ordering and per-command argument hints; every key in SUBCOMMANDS
// must appear here, guarded by tests/unit/dispatch.test.ts (#938).
export const USAGE_MESSAGE =
  "Usage: kesha <audio_file> [audio_file ...]\n" +
  "       kesha completions <bash|zsh|fish>\n" +
  "       kesha doctor [--json] [--redact]\n" +
  "       kesha init [--yes]\n" +
  "       kesha install [--no-cache]\n" +
  "       kesha logs [enable|disable|mode|status|path|reset]\n" +
  "       kesha manpage\n" +
  "       kesha mcp\n" +
  "       kesha record --out path.wav [--max-seconds 120]\n" +
  "       kesha status\n" +
  "       kesha say <text>\n" +
  "       kesha stats [enable|disable|status|week|errors|export|reset|vacuum|retention]\n" +
  "       kesha support-bundle [--output path.tar.gz]";

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

export interface UnknownCommandMessages {
  errorLine: string;
  warnLines: string[];
}

/**
 * Pure message builder for the unknown-token path (testable without
 * `process.exit`). `transcribe` isn't a real subcommand — bare `kesha
 * <audio-file>` is the invocation — so a near-miss of that word gets its own
 * extra hint alongside the generic "pass a path" one.
 */
export function unknownCommandMessages(token: string, subcommandKeys: string[]): UnknownCommandMessages {
  const suggestion = suggestCommand(token, subcommandKeys);
  const warnLines: string[] = [];
  if (suggestion && suggestion !== token) {
    warnLines.push(`(Did you mean ${suggestion}?)`);
  }
  warnLines.push(`If this is an audio file, pass a path like './${token}'.`);
  if (suggestCommand(token, ["transcribe"]) === "transcribe") {
    warnLines.push("To transcribe, pass the audio path directly: kesha ./recording.ogg");
  }
  return { errorLine: `unknown command '${token}'`, warnLines };
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const context = resolveCliContext(argv);
  applyCliContext(context);

  const [firstArg, ...restArgs] = context.rawArgs;
  const subcommandKeys = SUBCOMMAND_NAMES;

  switch (classifyFirstArg(firstArg, subcommandKeys)) {
    case "subcommand":
      await runMain(await SUBCOMMANDS[firstArg!]!(), { rawArgs: restArgs });
      return;

    case "unknown": {
      // Extensionless existing files are valid transcription inputs; bare non-path tokens are likely command typos.
      const { errorLine, warnLines } = unknownCommandMessages(firstArg!, subcommandKeys);
      log.error(errorLine);
      for (const line of warnLines) log.warn(line);
      process.exit(1);
      break;
    }

    default: {
      const { createMainCommand } = await import("./main");
      await runMain(createMainCommand(context), { rawArgs: context.rawArgs });
    }
  }
}
