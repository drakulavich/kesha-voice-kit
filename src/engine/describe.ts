import { KeshaError } from "./events";

export const PROTOCOL_VERSION = 4;

export type Gate = null | string | string[];

export interface FlagSchema {
  gate: Gate;
  requires?: string[];
  conflicts?: string[];
  whenUngated?: "reject" | "drop";
  values?: string;
}

export interface CommandSchema {
  flags: Record<string, FlagSchema>;
}

export interface TtsLanguageCapability {
  code: string;
  engines: string[];
}

export interface EngineCapabilities {
  protocolVersion: number;
  backend: string;
  features: string[];
  tts?: { languages: TtsLanguageCapability[] };
}

export interface DescribeDocument {
  protocolVersion: number;
  backend: string;
  profile: string;
  features: string[];
  commands: Record<string, CommandSchema>;
  tts?: { languages: TtsLanguageCapability[] };
}

const UPGRADE_CLI = "bun add -g @drakulavich/kesha-voice-kit@latest";

/** Remedies validateArgv attaches when a flag's gate is missing; keyed `<command> --<flag>`. */
const GATE_HINTS: Record<string, string> = {
  "transcribe --speakers":
    "speaker diarization is darwin-arm64 only (https://github.com/drakulavich/kesha-voice-kit/issues/199)",
  "transcribe --itn": `the installed engine predates the written-form pass; run \`${UPGRADE_CLI}\`, then \`kesha install\``,
  "record --live":
    "live transcription needs the CoreML engine on Apple Silicon; elsewhere record to a file, then transcribe it: `kesha record --out note.wav` and `kesha note.wav`",
  "record --auto-stop": "live auto-stop needs a newer CoreML engine with Silero VAD endpointing; run `kesha install`",
};

/** Remedies validateArgv attaches when two present flags conflict; keyed `<command> --<flag> --<other>`. */
const CONFLICT_HINTS: Record<string, string> = {
  "transcribe --speakers --no-vad":
    "speaker labels attach to VAD-windowed speech segments, and disabling VAD leaves the whole file as one segment with nothing to label; drop --no-vad (VAD engages automatically for --speakers), or drop --speakers",
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parseGate(value: unknown): Gate | undefined {
  if (value === null || typeof value === "string") return value;
  if (isStringArray(value)) return value;
  return undefined;
}

function parseFlag(raw: unknown): FlagSchema | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (!("gate" in o)) return null;
  const gate = parseGate(o.gate);
  if (gate === undefined) return null;
  const flag: FlagSchema = { gate };
  if (o.requires !== undefined) {
    if (!isStringArray(o.requires)) return null;
    flag.requires = o.requires;
  }
  if (o.conflicts !== undefined) {
    if (!isStringArray(o.conflicts)) return null;
    flag.conflicts = o.conflicts;
  }
  if (o.whenUngated !== undefined) {
    if (o.whenUngated !== "reject" && o.whenUngated !== "drop") return null;
    flag.whenUngated = o.whenUngated;
  }
  if (o.values !== undefined) {
    if (typeof o.values !== "string") return null;
    flag.values = o.values;
  }
  return flag;
}

function parseCommands(raw: unknown): Record<string, CommandSchema> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const commands: Record<string, CommandSchema> = {};
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    const flagsRaw = (entry as { flags?: unknown } | null)?.flags;
    if (!flagsRaw || typeof flagsRaw !== "object" || Array.isArray(flagsRaw)) return null;
    const flags: Record<string, FlagSchema> = {};
    for (const [flagName, flagRaw] of Object.entries(flagsRaw as Record<string, unknown>)) {
      const flag = parseFlag(flagRaw);
      if (!flag) return null;
      flags[flagName] = flag;
    }
    commands[name] = { flags };
  }
  return commands;
}

function parseTtsLanguages(raw: unknown): TtsLanguageCapability[] | null {
  const languages = (raw as { languages?: unknown } | null | undefined)?.languages;
  if (!Array.isArray(languages)) return null;
  const out: TtsLanguageCapability[] = [];
  for (const entry of languages) {
    const l = entry as Record<string, unknown> | null;
    if (typeof l?.code !== "string" || !isStringArray(l.engines)) return null;
    out.push({ code: l.code, engines: l.engines });
  }
  return out;
}

/** A non-null return means the engine described itself; every field the CLI reads is rebuilt, never cast (#647, #928). */
export function parseDescribe(parsed: unknown): DescribeDocument | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { protocolVersion, backend, profile, features, commands, tts } = parsed as Record<string, unknown>;
  if (typeof protocolVersion !== "number") return null;
  if (typeof backend !== "string" || typeof profile !== "string") return null;
  if (!isStringArray(features)) return null;
  const parsedCommands = parseCommands(commands);
  if (!parsedCommands) return null;
  const doc: DescribeDocument = { protocolVersion, backend, profile, features, commands: parsedCommands };
  if (tts !== undefined) {
    const languages = parseTtsLanguages(tts);
    if (!languages) return null;
    doc.tts = { languages };
  }
  return doc;
}

export function protocolMismatch(doc: DescribeDocument, binPath: string): KeshaError | null {
  if (doc.protocolVersion === PROTOCOL_VERSION) return null;
  const stale = doc.protocolVersion < PROTOCOL_VERSION;
  return new KeshaError(
    "E_ENGINE_PROTOCOL",
    `kesha-engine at ${binPath} speaks protocol ${doc.protocolVersion}; this CLI speaks protocol ${PROTOCOL_VERSION}`,
    {
      hint: stale
        ? "run `kesha install` to fetch the engine this CLI expects"
        : `the engine is newer than this CLI; run \`${UPGRADE_CLI}\``,
      versionMismatch: true,
    },
  );
}

export function describeToCapabilities(doc: DescribeDocument): EngineCapabilities {
  const caps: EngineCapabilities = {
    protocolVersion: doc.protocolVersion,
    backend: doc.backend,
    features: doc.features,
  };
  if (doc.tts) caps.tts = doc.tts;
  return caps;
}

function gateSatisfied(gate: Gate, features: string[]): boolean {
  if (gate === null) return true;
  if (typeof gate === "string") return features.includes(gate);
  return gate.some((f) => features.includes(f));
}

function gateText(gate: Gate): string {
  return typeof gate === "string" ? gate : `one of ${(gate as string[]).join(", ")}`;
}

function flagNameAt(argv: string[], index: number): string | null {
  const token = argv[index]!;
  if (!token.startsWith("--") || token === "--") return null;
  const eq = token.indexOf("=");
  return (eq === -1 ? token : token.slice(0, eq)).slice(2);
}

/** Checks an engine argv (subcommand first) against the describe document; unknown flags, absent gates, missing requires and present conflicts are E_INVALID_ARG, a whenUngated: drop flag is removed with one warning. */
export function validateArgv(argv: string[], doc: DescribeDocument): { argv: string[]; warnings: string[] } {
  const command = argv[0] ?? "";
  const schema = doc.commands[command];
  if (!schema) {
    throw new KeshaError("E_INVALID_ARG", `kesha-engine has no \`${command}\` subcommand`);
  }
  const build = `${doc.backend}/${doc.profile}`;
  const present = new Set<string>();
  const drop = new Set<number>();
  const warnings: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--") break;
    const name = flagNameAt(argv, i);
    if (name === null) continue;
    const flag = schema.flags[name];
    if (!flag) {
      throw new KeshaError("E_INVALID_ARG", `kesha-engine ${command} does not accept --${name}`);
    }
    if (!gateSatisfied(flag.gate, doc.features)) {
      const needs = `--${name} needs ${gateText(flag.gate)}, which this kesha-engine build (${build}) does not provide`;
      if (flag.whenUngated === "drop") {
        drop.add(i);
        warnings.push(`${needs}; the flag was ignored`);
        continue;
      }
      throw new KeshaError("E_INVALID_ARG", needs, { hint: GATE_HINTS[`${command} --${name}`] });
    }
    present.add(name);
  }
  for (const name of present) {
    const flag = schema.flags[name]!;
    for (const req of flag.requires ?? []) {
      if (!present.has(req)) throw new KeshaError("E_INVALID_ARG", `--${name} requires --${req}`);
    }
    for (const other of flag.conflicts ?? []) {
      if (present.has(other)) {
        throw new KeshaError("E_INVALID_ARG", `--${name} cannot be combined with --${other}`, {
          hint: CONFLICT_HINTS[`${command} --${name} --${other}`],
        });
      }
    }
  }
  return { argv: argv.filter((_, i) => !drop.has(i)), warnings };
}
