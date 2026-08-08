import { describe, expect, test } from "bun:test";
import {
  canInstallDiarizeOnPlatform,
  initInstallArgs,
  initSuggestionCommands,
  omitUnsupportedDiarize,
  promptInitSelection,
  renderInitOverview,
  resolveInitSelection,
  type InitCommandArgs,
} from "../../src/cli";

function initArgs(overrides: Partial<InitCommandArgs> = {}): InitCommandArgs {
  return {
    coreml: false,
    onnx: false,
    "no-cache": false,
    noCache: false,
    no_cache: false,
    tts: false,
    vad: false,
    diarize: false,
    plan: false,
    yes: false,
    ...overrides,
  };
}

describe("init onboarding", () => {
  test("defaults to base install only", () => {
    const selection = resolveInitSelection(initArgs(), undefined);
    expect(selection).toEqual({
      noCache: false,
      backend: undefined,
      ttsLangs: [],
      vad: false,
      diarize: false,
    });
    expect(initInstallArgs(selection)).toEqual(["kesha", "install"]);
  });

  test("preselected feature flags map to install flags", () => {
    const selection = resolveInitSelection(
      initArgs({ "no-cache": true, tts: true, vad: true, diarize: true }),
      "coreml",
    );
    expect(initInstallArgs(selection)).toEqual([
      "kesha",
      "install",
      "--no-cache",
      "--coreml",
      "--tts",
      "en",
      "--vad",
      "--diarize",
    ]);
  });

  test("multiple tts languages emit positional codes after --tts", () => {
    expect(
      initInstallArgs({
        noCache: false,
        backend: undefined,
        ttsLangs: ["en", "ru"],
        vad: false,
        diarize: false,
      }),
    ).toEqual(["kesha", "install", "--tts", "en", "ru"]);
  });

  test("interactive selection drops unsupported diarize preselection before confirmation", async () => {
    const prompts: string[] = [];
    const ttsPreselects: string[][] = [];
    const savedError = console.error;
    console.error = () => {};
    try {
      const selection = await promptInitSelection(
        initArgs({ diarize: true }),
        async (message, initialValue) => {
          prompts.push(message);
          return initialValue;
        },
        undefined,
        false,
        false,
        async (preselect) => {
          ttsPreselects.push(preselect);
          return [];
        },
      );

      expect(selection.diarize).toBe(false);
      expect(selection.ttsLangs).toEqual([]);
      expect(initInstallArgs(selection)).toEqual(["kesha", "install"]);
      // TTS is a multiselect, diarize is skipped off darwin — only VAD is a yes/no here.
      expect(prompts).toHaveLength(1);
      expect(prompts.join("\n")).not.toContain("diarization");
      expect(ttsPreselects).toEqual([[]]);
    } finally {
      console.error = savedError;
    }
  });

  test("interactive TTS multiselect result flows into the selection", async () => {
    const savedError = console.error;
    console.error = () => {};
    try {
      const selection = await promptInitSelection(
        initArgs({ tts: true }),
        async (_message, initialValue) => initialValue,
        undefined,
        false,
        false,
        async () => ["en", "ru"],
      );
      expect(selection.ttsLangs).toEqual(["en", "ru"]);
      expect(initInstallArgs(selection)).toEqual(["kesha", "install", "--tts", "en", "ru"]);
    } finally {
      console.error = savedError;
    }
  });

  test("preselect flags arrive as the confirm prompt's initial value", async () => {
    const initialValues: boolean[] = [];
    const selection = await promptInitSelection(
      initArgs({ vad: true }),
      async (_message, initialValue) => {
        initialValues.push(initialValue);
        return initialValue;
      },
      undefined,
      false,
      false,
      async () => [],
    );

    expect(initialValues).toEqual([true]);
    expect(selection.vad).toBe(true);
  });

  test("init drives every prompt through @clack/prompts", async () => {
    // #677: a node:readline interface sharing stdin with clack deadlocks after clack closes.
    const source = await Bun.file(new URL("../../src/cli/init.ts", import.meta.url)).text();
    const imported = [...source.matchAll(/^import .*?from "(.+?)";$/gm)].map((m) => m[1]);

    expect(imported).toContain("@clack/prompts");
    expect(imported.filter((m) => m.startsWith("node:readline"))).toEqual([]);
  });

  test("non-interactive suggestions preserve backend and cache flags", () => {
    const commands = initSuggestionCommands(
      { noCache: true, backend: "coreml", ttsLangs: [], vad: false, diarize: false },
      true,
    ).map((command) => command.join(" "));

    expect(commands).toContain("kesha install --no-cache --coreml");
    expect(commands).toContain("kesha install --no-cache --coreml --vad");
    expect(commands).toContain("kesha install --no-cache --coreml --tts en --vad");
    // #768: --diarize installs VAD itself, so the suggestion no longer repeats --vad.
    expect(commands).toContain("kesha install --no-cache --coreml --diarize");
  });

  test("--yes install selection drops unsupported diarize preselection", () => {
    const selection = {
      noCache: true,
      backend: "onnx",
      ttsLangs: ["en"],
      vad: true,
      diarize: true,
    };

    expect(omitUnsupportedDiarize(selection, false)).toEqual({
      noCache: true,
      backend: "onnx",
      ttsLangs: ["en"],
      vad: true,
      diarize: false,
    });
    expect(initInstallArgs(omitUnsupportedDiarize(selection, false))).toEqual([
      "kesha",
      "install",
      "--no-cache",
      "--onnx",
      "--tts",
      "en",
      "--vad",
    ]);
  });

  test("diarization availability is darwin-arm64 only", () => {
    expect(canInstallDiarizeOnPlatform("darwin", "arm64")).toBe(true);
    expect(canInstallDiarizeOnPlatform("darwin", "x64")).toBe(false);
    expect(canInstallDiarizeOnPlatform("linux", "x64")).toBe(false);
  });

  test("overview explains base install and optional features", () => {
    const overview = renderInitOverview(false);
    expect(overview).toContain("The base install downloads the engine");
    expect(overview).toContain("Text-to-speech");
    expect(overview).toContain("VAD");
    expect(overview).toContain("darwin-arm64 only");
    expect(overview).toContain("Nothing downloads until you confirm");
  });
});
