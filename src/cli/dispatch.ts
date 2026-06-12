import { runMain, type CommandDef } from "citty";
import { existsSync } from "fs";
import { log, setColorEnabled } from "../log";
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
import { mcpCommand } from "./mcp";

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
  mcp: mcpCommand,
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

// Whether the process was launched with NO_COLOR already forced on. Captured
// once at import (before any runCli) so re-enabling colors never clobbers an
// externally-set NO_COLOR — we only clear the var on re-enable when WE set it.
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

export async function runCli(rawArgs = process.argv.slice(2)): Promise<void> {
  // Global flags resolved before citty so they apply to every command (and help
  // output) and never reach a subcommand's arg schema.
  const color = resolveColorMode(rawArgs);
  // Reset on EVERY invocation (not just the disable path): an earlier
  // --no-color / CI call must not leave colors permanently off for later
  // in-process calls (unit tests, `kesha mcp`). picocolors already honors
  // NO_COLOR at startup; setting the env var also propagates to the engine.
  setColorEnabled(!color.disableColor);
  // Keep NO_COLOR symmetric so it doesn't leak to engine subprocesses spawned
  // by a later in-process call: set it when WE disable, clear it on re-enable —
  // but never clear a NO_COLOR the user exported themselves.
  if (color.disableColor) {
    process.env.NO_COLOR = "1";
  } else if (!USER_FORCED_NO_COLOR) {
    delete process.env.NO_COLOR;
  }

  const quiet = resolveQuietMode(color.rawArgs);
  log.quietEnabled = quiet.quiet;

  rawArgs = quiet.rawArgs;
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
