import { runMain, type CommandDef } from "citty";
import { existsSync } from "fs";
import { log, setColorEnabled } from "../log";
import { suggestCommand } from "../suggest-command";

// Lazy loaders, not eager imports: a cold `bun run src/cli.ts` spawn transpiles
// only the command actually invoked instead of the whole CLI graph (`say` pulls
// in the entire TTS/Kokoro/Vosk/normalize/SSML tree). Keyed names also feed the
// `did you mean` suggester. `CommandDef<any>` is intentional — citty's generic is
// invariant in the args shape, and each subcommand has its own arg schema; the
// value is only passed back to `runMain`, which re-reads the schema from the def.
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

// Falsey grammar shared by --no-color and CI. Mirrors KESHA_DEBUG so
// `CI=false`/`CI=0` and `--no-color=false` opt back in to colors.
const FALSEY_VALUES = new Set(["", "0", "false", "no", "off"]);
function isFalsey(v: string): boolean {
  return FALSEY_VALUES.has(v.trim().toLowerCase());
}

// Captured at import so re-enabling colors never clobbers a user-exported NO_COLOR.
const USER_FORCED_NO_COLOR =
  process.env.NO_COLOR !== undefined && !isFalsey(process.env.NO_COLOR);

/**
 * Strip a boolean global flag out of rawArgs so citty never sees it. Matches
 * any of `names` bare (sets the flag) and the `--name=<value>` form for the
 * long names (`<falsey>` explicitly turns the flag back off).
 */
function stripBooleanFlag(
  rawArgs: string[],
  names: string[],
): { value: boolean; rawArgs: string[] } {
  const valuedPrefixes = names.filter((n) => n.startsWith("--")).map((n) => `${n}=`);
  let value = false;
  const cleaned: string[] = [];
  for (const arg of rawArgs) {
    if (names.includes(arg)) {
      value = true;
    } else if (valuedPrefixes.some((prefix) => arg.startsWith(prefix))) {
      value = !isFalsey(arg.slice(arg.indexOf("=") + 1));
    } else {
      cleaned.push(arg);
    }
  }
  return { value, rawArgs: cleaned };
}

/**
 * Decide whether ANSI colors should be disabled (#531) and return rawArgs with
 * any `--no-color[=value]` token stripped so citty never sees it.
 *
 * Colors are disabled when `--no-color` (bare) or `--no-color=<truthy>` is
 * passed, or when the environment looks like CI (`CI` set to a non-falsey value
 * — GitHub Actions, GitLab, CircleCI, … export `CI=true`). `--no-color=false`
 * and `CI=false`/`CI=0` explicitly opt back in.
 */
export function resolveColorMode(
  rawArgs: string[],
  env: { CI?: string } = process.env as { CI?: string },
): { disableColor: boolean; rawArgs: string[] } {
  const { value, rawArgs: cleaned } = stripBooleanFlag(rawArgs, ["--no-color"]);
  const ci = env.CI !== undefined && !isFalsey(env.CI);
  return { disableColor: value || ci, rawArgs: cleaned };
}

/**
 * Detect `--quiet`/`-q` (and `--quiet=<value>`) and return rawArgs with the
 * token stripped (#526). Resolved before citty — like `--no-color` — so quiet
 * is global: it works for every command, not just the transcribe path, and a
 * subcommand that doesn't declare it never sees the flag.
 */
export function resolveQuietMode(rawArgs: string[]): { quiet: boolean; rawArgs: string[] } {
  const { value, rawArgs: cleaned } = stripBooleanFlag(rawArgs, ["--quiet", "-q"]);
  return { quiet: value, rawArgs: cleaned };
}

/**
 * Sync NO_COLOR with the resolved color decision so engine subprocesses inherit
 * the right value. Separated from setColorEnabled so it can be tested without
 * picocolors side-effects.
 *
 * Never clears a NO_COLOR the user exported before this process started
 * (USER_FORCED_NO_COLOR guard).
 */
export function applyColorEnv(disableColor: boolean): void {
  if (disableColor) {
    process.env.NO_COLOR = "1";
  } else if (!USER_FORCED_NO_COLOR) {
    delete process.env.NO_COLOR;
  }
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

export async function runCli(rawArgs = process.argv.slice(2)): Promise<void> {
  // Global flags resolved before citty so they apply to every command and never reach a subcommand's arg schema.
  const color = resolveColorMode(rawArgs);
  // Reset on every invocation so an earlier --no-color/CI call doesn't leave colors off for later in-process calls (unit tests, `kesha mcp`).
  setColorEnabled(!color.disableColor);
  applyColorEnv(color.disableColor);

  const quiet = resolveQuietMode(color.rawArgs);
  log.quietEnabled = quiet.quiet;

  rawArgs = quiet.rawArgs;
  const [firstArg, ...restArgs] = rawArgs;
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

    default:
      await runMain((await import("./main")).mainCommand, { rawArgs });
  }
}
