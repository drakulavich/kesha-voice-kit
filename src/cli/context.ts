import { log, setColorEnabled } from "../log";

/** The global flags resolved before citty, so every command sees the same decision. */
export interface CliContext {
  quiet: boolean;
  disableColor: boolean;
}

export interface ResolvedCliContext extends CliContext {
  /** `rawArgs` with the global flag tokens removed, ready to hand to citty. */
  rawArgs: string[];
}

// Falsey grammar shared by --no-color, --quiet, and CI. Mirrors KESHA_DEBUG so
// `CI=false`/`CI=0` and `--no-color=false` opt back in.
const FALSEY_VALUES = new Set(["", "0", "false", "no", "off"]);
function isFalsey(v: string): boolean {
  return FALSEY_VALUES.has(v.trim().toLowerCase());
}

/** True when NO_COLOR came from the user's environment, so re-enabling colors must not clear it. */
export const USER_FORCED_NO_COLOR =
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

/** Resolves every pre-citty global flag into one value, with the tokens stripped from rawArgs. */
export function resolveCliContext(
  rawArgs: string[],
  env: { CI?: string } = process.env as { CI?: string },
): ResolvedCliContext {
  const color = resolveColorMode(rawArgs, env);
  const quiet = resolveQuietMode(color.rawArgs);
  return { quiet: quiet.quiet, disableColor: color.disableColor, rawArgs: quiet.rawArgs };
}

/**
 * Sync NO_COLOR with the resolved color decision so engine subprocesses inherit
 * the right value. Separated from setColorEnabled so it can be tested without
 * picocolors side-effects.
 *
 * Never clears a NO_COLOR the user exported before this process started.
 */
export function applyColorEnv(disableColor: boolean): void {
  if (disableColor) {
    process.env.NO_COLOR = "1";
  } else if (!USER_FORCED_NO_COLOR) {
    delete process.env.NO_COLOR;
  }
}

/** Applies the context to the process-wide output sinks, writing every value so an earlier in-process run (unit tests, `kesha mcp`) can't leak its settings into a later one. */
export function applyCliContext(context: CliContext): void {
  setColorEnabled(!context.disableColor);
  applyColorEnv(context.disableColor);
  log.quietEnabled = context.quiet;
}
