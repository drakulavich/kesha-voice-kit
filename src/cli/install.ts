import { defineCommand } from "citty";
import { errorMessage } from "../error-utils";
import { installEngine } from "../engine-install";
import { engineTarget, isDarwinArm64 } from "../engine-targets";
import { getEngineBinPath, getEngineCapabilities, type EngineCapabilities } from "../engine";
import { renderInstallPlan } from "../install-plan";
import { maybeAskForStar } from "../star";
import { log } from "../log";
import { packageVersion } from "../package-info";
import { isSemver } from "../semver.mjs";
import { createDiagnosticLogSession, type DiagnosticLogSession } from "../diagnostic-log";
import { getPendingSignalExitCode, waitForPendingSignalCleanup } from "../process-tree";
import type { SharedInstallArgs } from "./types";

export interface InstallCommandArgs extends SharedInstallArgs {
  /** Positional args after `install` — candidate TTS language codes. */
  _?: string[];
  /** `init` deliberately has no such flag: an override is an expert action, not a guided one. */
  "engine-version"?: string;
  engineVersion?: string;
}

/** TTS languages every build installs. */
const TTS_LANGS_EVERYWHERE = ["en", "es", "fr", "it", "pt", "ru"];

/** hi/ja/zh need FluidAudio's ANE Kokoro, which only the darwin-arm64 engine is built with. */
const DARWIN_ARM64_ONLY_TTS_LANGS = ["hi", "ja", "zh"];

/**
 * What `--tts` may name when the Engine cannot be asked. Without it, a bogus code is only
 * caught by the engine that a full download had to install first (#770).
 */
export function installableTtsLangs(
  platform = process.platform,
  arch = process.arch,
): string[] {
  return isDarwinArm64(platform, arch)
    ? [...TTS_LANGS_EVERYWHERE, ...DARWIN_ARM64_ONLY_TTS_LANGS]
    : TTS_LANGS_EVERYWHERE;
}

export interface TtsArgInput {
  tts: boolean;
  positionals: string[];
}

/**
 * Resolve the requested TTS language list. Bare `--tts` defaults to English.
 * Positionals without `--tts` are an error. When `supported` is provided,
 * unsupported codes are a hard error (nothing downloads); the CLI passes the
 * Engine's own list when it has one and `installableTtsLangs()` otherwise, and
 * the installed Engine re-validates authoritatively at download time.
 */
export function resolveTtsLangs(input: TtsArgInput, supported: string[] | undefined): string[] {
  if (!input.tts) {
    if (input.positionals.length > 0) {
      throw new Error(
        `Language codes (${input.positionals.join(", ")}) require the --tts flag, ` +
          `e.g. \`kesha install --tts ${input.positionals.join(" ")}\`.`,
      );
    }
    return [];
  }
  const langs = input.positionals.length > 0 ? input.positionals : ["en"];
  if (supported) {
    const bad = langs.filter((l) => !supported.includes(l));
    if (bad.length > 0) {
      throw new Error(
        `Unsupported TTS language(s): ${bad.join(", ")}. ` +
          `Supported on this platform: ${supported.join(", ")}.`,
      );
    }
  }
  return langs;
}

/**
 * Validates `--engine-version` before any network call. Returns undefined when the flag is
 * absent, so the Pinned Engine version stays the default; throws on anything the version
 * drift gate would not accept either — one SemVer 2.0 definition across the repo.
 */
export function resolveEngineVersionFlag(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === false) return undefined;
  const value = String(raw).trim();
  if (isSemver(value)) return value;
  const hint = /^v\d/.test(value)
    ? ' Drop the leading "v" — that belongs to the release tag, not the version.'
    : "";
  throw new Error(
    `--engine-version needs an exact SemVer 2.0 version like 1.24.8 or 1.24.8-alpha.1, got "${value}".${hint}`,
  );
}

export function resolveNoCacheFlag(
  args: Pick<InstallCommandArgs, "no-cache" | "noCache" | "no_cache">,
  rawArgs: string[] = [],
): boolean {
  return (
    rawArgs.includes("--no-cache") ||
    args["no-cache"] === true ||
    args.noCache === true ||
    args.no_cache === true
  );
}

/**
 * Capabilities for `--tts` validation, tolerating an engine that cannot be spawned (#770).
 *
 * A corrupt or wrong-arch binary used to throw here and kill the command before the
 * re-download that repairs it. Without capabilities the language codes simply go
 * unvalidated locally — the freshly installed engine rejects unsupported ones at
 * download time, which is authoritative anyway.
 */
export async function probeCapabilitiesForInstall(): Promise<EngineCapabilities | null> {
  try {
    return await getEngineCapabilities();
  } catch (err) {
    log.debug(`capabilities probe failed before install: ${errorMessage(err)}`);
    return null;
  }
}

export type BackendSelection =
  | { ok: true; backend: string | undefined }
  | { ok: false; error: string };

export function selectBackend(coreml: boolean, onnx: boolean): BackendSelection {
  if (coreml && onnx) {
    return { ok: false, error: 'Choose only one backend: "--coreml" or "--onnx".' };
  }
  if (coreml) return { ok: true, backend: "coreml" };
  if (onnx) return { ok: true, backend: "onnx" };
  return { ok: true, backend: undefined };
}

export function resolveBackendFlag(coreml: boolean, onnx: boolean): string | undefined {
  const selection = selectBackend(coreml, onnx);
  if (!selection.ok) {
    log.error(selection.error);
    process.exit(1);
  }
  return selection.backend;
}

export function defaultBackendForPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  return engineTarget(platform, arch)?.backend;
}

type InstallDiagnosticErrorKind = "validation_failed" | "install_failed";

function finishInstallDiagnostic(
  diagnosticLog: DiagnosticLogSession | null,
  startedAt: number,
  status: "success" | "failed",
  errorKind?: InstallDiagnosticErrorKind,
): void {
  if (!diagnosticLog) return;
  try {
    diagnosticLog.event("command.finish", {
      command: "install",
      status,
      durationMs: Math.round(performance.now() - startedAt),
      ...(errorKind ? { errorKind } : {}),
    });
    diagnosticLog.finish(status);
  } catch (err) {
    log.debug(`install diagnostic log finish dropped: ${errorMessage(err)}`);
  }
}

/** Null when the requested backend is installable here. `KESHA_ENGINE_BIN` opts out — the user supplied their own engine. */
export function unavailableBackendError(backend: string | undefined): string | null {
  const platformBackend = defaultBackendForPlatform();
  if (!backend || process.env.KESHA_ENGINE_BIN || !platformBackend) return null;
  if (backend === platformBackend) return null;
  return (
    `Requested backend "${backend}" is not available on this platform; ` +
    `the release engine uses "${platformBackend}".`
  );
}

export interface PerformInstallOptions {
  noCache: boolean;
  backend?: string;
  ttsLangs: string[];
  vad?: boolean;
  diarize?: boolean;
  plan?: boolean;
  /** Engine release to install instead of the pin, for this invocation only. */
  engineVersion?: string;
}

export async function performInstall(options: PerformInstallOptions) {
  const { noCache, backend, ttsLangs, vad = false, diarize = false, plan = false, engineVersion } =
    options;
  // A plan for an unavailable backend previews what its own printed command rejects (#684).
  const backendError = unavailableBackendError(backend);
  if (plan) {
    if (backendError) {
      log.error(backendError);
      process.exitCode = 2;
      return;
    }
    log.info(
      await renderInstallPlan({ noCache, backend, ttsLangs, vad, diarize, engineVersion }),
    );
    return;
  }

  let diagnosticLog: DiagnosticLogSession | null = null;
  let errorKind: InstallDiagnosticErrorKind = "install_failed";
  const startedAt = performance.now();
  try {
    diagnosticLog = createDiagnosticLogSession();
    diagnosticLog.event("command.start", {
      command: "install",
      backend: backend ?? "auto",
      noCache,
      tts: ttsLangs.length > 0,
      vad,
      diarize,
      engineVersionOverride: engineVersion !== undefined,
    });

    if (diarize && !(process.platform === "darwin" && process.arch === "arm64")) {
      errorKind = "validation_failed";
      throw new Error(
        "--diarize is currently darwin-arm64 only " +
        "(see https://github.com/drakulavich/kesha-voice-kit/issues/199).",
      );
    }
    if (backendError) {
      errorKind = "validation_failed";
      throw new Error(backendError);
    }
    await installEngine({ noCache, backend, ttsLangs, vad, diarize, version: engineVersion });
    await maybeAskForStar(getEngineBinPath(), packageVersion, log);
    finishInstallDiagnostic(diagnosticLog, startedAt, "success");
  } catch (err: unknown) {
    const signalExitCode = getPendingSignalExitCode();
    if (signalExitCode !== null) {
      await waitForPendingSignalCleanup();
      process.exit(signalExitCode);
    }
    const message = errorMessage(err);
    finishInstallDiagnostic(diagnosticLog, startedAt, "failed", errorKind);
    log.error(message);
    process.exit(1);
  }
}

export const installCommand = defineCommand({
  meta: {
    name: "install",
    description: "Download inference engine and models",
  },
  args: {
    coreml: {
      type: "boolean",
      description: "Force CoreML backend (macOS arm64)",
      default: false,
    },
    onnx: {
      type: "boolean",
      description: "Force ONNX backend",
      default: false,
    },
    "no-cache": {
      type: "boolean",
      description: "Re-download even if cached",
      default: false,
    },
    plan: {
      type: "boolean",
      description: "Show download, disk, and warm-up plan without changing local state",
      default: false,
    },
    tts: {
      type: "boolean",
      description: "Also install TTS models (English only; add codes for more, e.g. --tts en ru (preview sizes: kesha install --plan))",
      default: false,
    },
    vad: {
      type: "boolean",
      description: "Also install Silero VAD (~2.3MB) for long-audio preprocessing",
      default: false,
    },
    diarize: {
      type: "boolean",
      description: "Also install the Sortformer streaming-diarization model (~245MB, darwin-arm64 only — #199)",
      default: false,
    },
    "engine-version": {
      type: "string",
      description:
        "Install this exact engine release instead of the pinned one (expert; the next install returns to the pin)",
    },
  },
  async run({ args, rawArgs }: { args: InstallCommandArgs; rawArgs: string[] }) {
    let engineVersion: string | undefined;
    try {
      engineVersion = resolveEngineVersionFlag(args["engine-version"] ?? args.engineVersion);
    } catch (err) {
      log.error(errorMessage(err));
      process.exit(2);
    }
    const backend = resolveBackendFlag(args.coreml, args.onnx);
    const positionals = (args._ ?? []).map(String);
    const caps = await probeCapabilitiesForInstall();
    const supported = caps?.tts?.languages.map((l) => l.code) ?? installableTtsLangs();
    let ttsLangs: string[];
    try {
      ttsLangs = resolveTtsLangs({ tts: args.tts === true, positionals }, supported);
    } catch (err) {
      log.error(errorMessage(err));
      process.exit(1);
    }
    await performInstall({
      noCache: resolveNoCacheFlag(args, rawArgs),
      backend,
      ttsLangs,
      vad: args.vad,
      diarize: args.diarize,
      plan: args.plan,
      engineVersion,
    });
  },
});
