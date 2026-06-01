import { defineCommand } from "citty";
import { downloadEngine } from "../engine-install";
import { getEngineBinPath, getEngineCapabilities } from "../engine";
import { renderInstallPlan } from "../install-plan";
import { maybeAskForStar } from "../star";
import { log } from "../log";
import { packageVersion } from "../package-info";
import { createDiagnosticLogSession, type DiagnosticLogSession } from "../diagnostic-log";

export interface InstallCommandArgs {
  /** Positional args after `install` — candidate TTS language codes. */
  _?: string[];
  coreml: boolean;
  onnx: boolean;
  "no-cache": boolean;
  noCache?: boolean;
  no_cache?: boolean;
  tts: boolean;
  vad: boolean;
  diarize: boolean;
  plan: boolean;
}

/**
 * TTS languages installable on EVERY build, used when the engine binary isn't
 * installed yet (capabilities unavailable). hi/ja/zh are darwin-arm64-only and
 * can't be assumed without capabilities, so they're excluded here.
 */
export const TTS_LANG_FALLBACK = ["en", "es", "fr", "it", "pt", "ru"];

export interface TtsArgInput {
  /** Whether --tts was passed. */
  tts: boolean;
  /** Positional args after the install command (candidate language codes). */
  positionals: string[];
}

/**
 * Resolve the requested TTS language list. Bare `--tts` defaults to English.
 * Positionals without `--tts` are an error. When `supported` is provided,
 * unsupported codes are a hard error (nothing downloads); when it's undefined
 * (engine not yet installed, capabilities unavailable) the check is skipped and
 * the engine validates authoritatively at download time.
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

export function resolveBackendFlag(coreml: boolean, onnx: boolean): string | undefined {
  if (coreml && onnx) {
    log.error('Choose only one backend: "--coreml" or "--onnx".');
    process.exit(1);
  }
  if (coreml) return "coreml";
  if (onnx) return "onnx";
  return undefined;
}

function defaultBackendForPlatform(): string | undefined {
  if (process.platform === "darwin" && process.arch === "arm64") return "coreml";
  if (process.platform === "linux" && process.arch === "x64") return "onnx";
  return undefined;
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
    log.debug(`install diagnostic log finish dropped: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function performInstall(
  noCache: boolean,
  backend: string | undefined,
  ttsLangs: string[],
  vad = false,
  diarize = false,
  plan = false,
) {
  if (plan) {
    log.info(await renderInstallPlan({ noCache, backend, ttsLangs, vad, diarize }));
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
    });

    if (diarize && !(process.platform === "darwin" && process.arch === "arm64")) {
      errorKind = "validation_failed";
      throw new Error(
        "--diarize is currently darwin-arm64 only " +
        "(see https://github.com/drakulavich/kesha-voice-kit/issues/199).",
      );
    }
    const platformBackend = defaultBackendForPlatform();
    if (backend && !process.env.KESHA_ENGINE_BIN && platformBackend && backend !== platformBackend) {
      errorKind = "validation_failed";
      throw new Error(
        `Requested backend "${backend}" is not available on this platform; ` +
          `the release engine uses "${platformBackend}".`,
      );
    }
    await downloadEngine(noCache, backend, { ttsLangs, vad, diarize });
    await maybeAskForStar(getEngineBinPath(), packageVersion, log);
    finishInstallDiagnostic(diagnosticLog, startedAt, "success");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
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
      description: "Also install TTS models (Kokoro EN + Vosk-TTS RU, ~990MB)",
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
  },
  async run({ args, rawArgs }: { args: InstallCommandArgs; rawArgs: string[] }) {
    const backend = resolveBackendFlag(args.coreml, args.onnx);
    const positionals = (args._ ?? []).map(String);
    const caps = await getEngineCapabilities();
    const supported = caps?.tts?.languages.map((l) => l.code);
    let ttsLangs: string[];
    try {
      ttsLangs = resolveTtsLangs({ tts: args.tts === true, positionals }, supported);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    await performInstall(
      resolveNoCacheFlag(args, rawArgs),
      backend,
      ttsLangs,
      args.vad,
      args.diarize,
      args.plan,
    );
  },
});
