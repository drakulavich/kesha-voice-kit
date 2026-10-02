import type { ArgsDef } from "citty";
import { renderError } from "../engine/events";
import { log } from "../log";
import { suggestCommand } from "../suggest-command";

export interface UnknownOption {
  name: string;
  suggestion: string | null;
}

const RUNNER_LONG = ["help", "version"];
const RUNNER_SHORT = ["h", "v"];

function camelCase(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** The first flag `argsDef` does not declare, or null; citty parses non-strict, so the flag would otherwise vanish and its value become a positional (S9-F3). */
export function findUnknownOption(rawArgs: string[], argsDef: ArgsDef): UnknownOption | null {
  return scanArgs(rawArgs, argsDef).unknown;
}

function scanArgs(rawArgs: string[], argsDef: ArgsDef): { unknown: UnknownOption | null; positionals: string[] } {
  const long = new Set(RUNNER_LONG);
  const short = new Set(RUNNER_SHORT);
  const valued = new Set<string>();
  const suggestable: string[] = [];
  for (const [name, def] of Object.entries(argsDef)) {
    if (def.type === "positional") continue;
    const alias = "alias" in def ? def.alias : undefined;
    const aliases = alias === undefined ? [] : Array.isArray(alias) ? alias : [alias];
    for (const spelling of [name, ...aliases]) {
      if (spelling.length === 1) {
        short.add(spelling);
      } else {
        long.add(spelling);
        long.add(camelCase(spelling));
        suggestable.push(spelling);
      }
      if (def.type === "boolean") long.add(`no-${spelling}`);
      else valued.add(spelling);
    }
  }
  const suggest = (name: string): string | null => {
    const match = suggestCommand(name, suggestable);
    return match === null ? null : `--${match}`;
  };
  const positionals: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;
    if (arg === "--") {
      positionals.push(...rawArgs.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-" || /^-\d/.test(arg)) {
      positionals.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      if (!long.has(name)) return { unknown: { name: `--${name}`, suggestion: suggest(name) }, positionals };
      if (eq === -1 && valued.has(name)) i++;
      continue;
    }
    for (const letter of arg.slice(1)) {
      if (!short.has(letter)) return { unknown: { name: `-${letter}`, suggestion: null }, positionals };
    }
    if (valued.has(arg[arg.length - 1]!)) i++;
  }
  return { unknown: null, positionals };
}

/** The coded line for a usage error the CLI refuses before doing anything (S9-F2). */
export function renderInvalidArg(message: string): string {
  return renderError({ code: "E_INVALID_ARG", message });
}

export function renderUnknownOption(option: UnknownOption): string {
  const tail = option.suggestion === null ? "" : ` (did you mean ${option.suggestion}?)`;
  return renderInvalidArg(`unknown option ${option.name}${tail}`);
}

/** Exits 2 with one coded stderr line when `rawArgs` carries a flag the command does not declare. */
export function rejectUnknownOptions(rawArgs: string[], argsDef: ArgsDef): void {
  const unknown = findUnknownOption(rawArgs, argsDef);
  if (unknown === null) return;
  log.error(renderUnknownOption(unknown));
  process.exit(2);
}

/** Exits 2 with one coded stderr line when `rawArgs` carries more positionals than the command declares. */
export function rejectExtraPositionals(rawArgs: string[], argsDef: ArgsDef): void {
  const declared = Object.values(argsDef).filter((def) => def.type === "positional").length;
  const extra = scanArgs(rawArgs, argsDef).positionals[declared];
  if (extra === undefined) return;
  const tail = "output" in argsDef ? ` (did you mean --output ${extra}?)` : "";
  log.error(renderInvalidArg(`unexpected argument '${extra}'${tail}`));
  process.exit(2);
}
