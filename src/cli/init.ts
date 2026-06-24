import { defineCommand } from "citty";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { multiselect, isCancel, cancel } from "@clack/prompts";
import { renderInstallPlan } from "../install-plan";
import { log } from "../log";
import { getEngineCapabilities } from "../engine";
import {
  performInstall,
  resolveBackendFlag,
  resolveNoCacheFlag,
  TTS_LANG_FALLBACK,
  type SharedInstallArgs,
} from "./install";

const TTS_LANG_LABELS: Record<string, string> = {
  en: "English (Kokoro)",
  es: "Spanish (Kokoro)",
  fr: "French (Kokoro)",
  hi: "Hindi (Kokoro ANE)",
  it: "Italian (Kokoro)",
  ja: "Japanese (Kokoro ANE)",
  pt: "Portuguese (Kokoro)",
  zh: "Chinese (Kokoro ANE)",
  ru: "Russian (Vosk-TTS)",
};

/** Signature of the interactive TTS-language picker (injectable for tests). */
export type TtsLangPrompt = (preselect: string[]) => Promise<string[]>;

async function promptTtsLangs(preselect: string[]): Promise<string[]> {
  const caps = await getEngineCapabilities();
  const supported = caps?.tts?.languages.map((l) => l.code) ?? TTS_LANG_FALLBACK;
  const selected = await multiselect({
    message:
      "Select TTS languages to install (space to toggle, enter to confirm; none = skip TTS):",
    options: supported.map((code) => ({ value: code, label: TTS_LANG_LABELS[code] ?? code })),
    initialValues: preselect.filter((l) => supported.includes(l)),
    required: false,
  });
  if (isCancel(selected)) {
    cancel("Init cancelled.");
    process.exit(0);
  }
  return selected as string[];
}

export interface InitCommandArgs extends SharedInstallArgs {
  yes: boolean;
}

export interface InitSelection {
  noCache: boolean;
  backend?: string;
  ttsLangs: string[];
  vad: boolean;
  diarize: boolean;
}

interface PromptApi {
  question(prompt: string): Promise<string>;
}

export function canInstallDiarizeOnPlatform(
  platform = process.platform,
  arch = process.arch,
): boolean {
  return platform === "darwin" && arch === "arm64";
}

export function resolveInitSelection(
  args: InitCommandArgs,
  backend = resolveBackendFlag(args.coreml, args.onnx),
  noCache = resolveNoCacheFlag(args),
): InitSelection {
  return {
    noCache,
    backend,
    ttsLangs: args.tts ? ["en"] : [],
    vad: args.vad,
    diarize: args.diarize,
  };
}

export function initInstallArgs(selection: InitSelection): string[] {
  return [
    "kesha",
    "install",
    selection.noCache ? "--no-cache" : "",
    selection.backend === "coreml" ? "--coreml" : "",
    selection.backend === "onnx" ? "--onnx" : "",
    ...(selection.ttsLangs.length > 0 ? ["--tts", ...selection.ttsLangs] : []),
    selection.vad ? "--vad" : "",
    selection.diarize ? "--diarize" : "",
  ].filter(Boolean);
}

export function initSuggestionCommands(
  selection: InitSelection,
  canDiarize = canInstallDiarizeOnPlatform(),
): string[][] {
  const variants: InitSelection[] = [
    selection,
    { ...selection, ttsLangs: [], vad: true, diarize: false },
    { ...selection, ttsLangs: ["en"], vad: true, diarize: false },
  ];

  if (canDiarize) {
    variants.push({ ...selection, ttsLangs: [], vad: true, diarize: true });
  }

  const seen = new Set<string>();
  return variants.map(initInstallArgs).filter((command) => {
    const key = command.join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function omitUnsupportedDiarize(
  selection: InitSelection,
  canDiarize = canInstallDiarizeOnPlatform(),
): InitSelection {
  return selection.diarize && !canDiarize ? { ...selection, diarize: false } : selection;
}

export function renderInitOverview(canDiarize = canInstallDiarizeOnPlatform()): string {
  const lines = [
    "Kesha init",
    "",
    "Kesha is a local voice toolkit. The base install downloads the engine, speech-to-text models, and language detection models.",
    "",
    "Optional features:",
    "  - Text-to-speech: enables `kesha say` with Kokoro English and Vosk-TTS Russian voices (~990MB).",
    "  - VAD: skips silence in long audio and improves meeting, lecture, and podcast transcripts (~2.3MB).",
    canDiarize
      ? "  - Speaker diarization: labels speakers in JSON/TOON transcript segments (~245MB, darwin-arm64)."
      : "  - Speaker diarization: labels speakers, but the install is currently darwin-arm64 only.",
    "",
    "Nothing downloads until you confirm the final install plan.",
  ];
  return `${lines.join("\n")}\n`;
}

export async function promptInitSelection(
  args: InitCommandArgs,
  prompt: PromptApi,
  backend = resolveBackendFlag(args.coreml, args.onnx),
  canDiarize = canInstallDiarizeOnPlatform(),
  noCache = resolveNoCacheFlag(args),
  promptTts: TtsLangPrompt = promptTtsLangs,
): Promise<InitSelection> {
  const ttsLangs = await promptTts(args.tts ? ["en"] : []);
  const vad = await askYesNo(prompt, "Install VAD for long or silence-heavy audio?", args.vad);
  let diarize = false;
  if (canDiarize) {
    diarize = await askYesNo(prompt, "Install speaker diarization for `--speakers`?", args.diarize);
  } else if (args.diarize) {
    log.warn("--diarize is currently darwin-arm64 only; omitting it from the interactive install.");
  }

  return {
    noCache,
    backend,
    ttsLangs,
    vad,
    diarize,
  };
}

async function askYesNo(prompt: PromptApi, message: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? "Y/n" : "y/N";
  for (;;) {
    const answer = (await prompt.question(`${message} [${suffix}] `)).trim().toLowerCase();
    if (answer === "") return defaultValue;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    log.warn("Please answer yes or no.");
  }
}

async function printPlan(selection: InitSelection): Promise<void> {
  log.info(
    await renderInstallPlan({
      noCache: selection.noCache,
      backend: selection.backend,
      ttsLangs: selection.ttsLangs,
      vad: selection.vad,
      diarize: selection.diarize,
    }),
  );
}

async function runNonInteractive(selection: InitSelection): Promise<void> {
  const canDiarize = canInstallDiarizeOnPlatform();
  const printableSelection = omitUnsupportedDiarize(selection, canDiarize);
  if (selection.diarize && !canDiarize) {
    log.warn("--diarize is currently darwin-arm64 only; omitting it from non-interactive examples.");
  }
  log.info(renderInitOverview(canDiarize));
  await printPlan(printableSelection);
  log.info("Run one of these commands from an interactive terminal:");
  for (const command of initSuggestionCommands(printableSelection, canDiarize)) {
    log.info(`  ${command.join(" ")}`);
  }
}

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description: "Interactive setup guide for Kesha features",
  },
  args: {
    coreml: {
      type: "boolean",
      description: "Preselect CoreML backend (macOS arm64)",
      default: false,
    },
    onnx: {
      type: "boolean",
      description: "Preselect ONNX backend",
      default: false,
    },
    "no-cache": {
      type: "boolean",
      description: "Re-download even if cached",
      default: false,
    },
    plan: {
      type: "boolean",
      description: "Show the selected install plan without downloading",
      default: false,
    },
    yes: {
      type: "boolean",
      description: "Accept defaults and run without prompts",
      default: false,
    },
    tts: {
      type: "boolean",
      description: "Preselect TTS models (Kokoro EN + Vosk-TTS RU, ~990MB)",
      default: false,
    },
    vad: {
      type: "boolean",
      description: "Preselect Silero VAD (~2.3MB) for long-audio preprocessing",
      default: false,
    },
    diarize: {
      type: "boolean",
      description: "Preselect Sortformer speaker diarization (~245MB, darwin-arm64 only)",
      default: false,
    },
  },
  async run({ args, rawArgs }: { args: InitCommandArgs; rawArgs: string[] }) {
    const backend = resolveBackendFlag(args.coreml, args.onnx);
    const noCache = resolveNoCacheFlag(args, rawArgs);
    const selection = resolveInitSelection(args, backend, noCache);

    if (args.plan) {
      log.info(renderInitOverview());
      await printPlan(selection);
      return;
    }

    if (args.yes) {
      const installSelection = omitUnsupportedDiarize(selection);
      if (selection.diarize && !installSelection.diarize) {
        log.warn("--diarize is currently darwin-arm64 only; omitting it from the --yes install.");
      }
      await performInstall(
        installSelection.noCache,
        installSelection.backend,
        installSelection.ttsLangs,
        installSelection.vad,
        installSelection.diarize,
      );
      return;
    }

    const stdinIsTty = process.stdin.isTTY === true;
    const stdoutIsTty = process.stdout.isTTY === true;
    if (!stdinIsTty || !stdoutIsTty) {
      await runNonInteractive(selection);
      return;
    }

    log.info(renderInitOverview());
    const rl = createInterface({ input, output });
    try {
      const prompted = await promptInitSelection(args, rl, backend, canInstallDiarizeOnPlatform(), noCache);
      log.info("");
      await printPlan(prompted);
      const confirmed = await askYesNo(rl, `Run \`${initInstallArgs(prompted).join(" ")}\` now?`, true);
      if (!confirmed) {
        log.info(`Skipped install. Run later: ${initInstallArgs(prompted).join(" ")}`);
        return;
      }
      await performInstall(
        prompted.noCache,
        prompted.backend,
        prompted.ttsLangs,
        prompted.vad,
        prompted.diarize,
      );
      // Next-steps hint (#523): leave the user with something runnable rather
      // than ending on the install log.
      log.info("");
      log.success("Kesha is ready. Try:");
      log.info("  kesha path/to/audio.ogg     Transcribe a file.");
      if (prompted.ttsLangs.length > 0) {
        log.info('  kesha say "hello"           Speak text (TTS).');
      }
    } finally {
      rl.close();
    }
  },
});
