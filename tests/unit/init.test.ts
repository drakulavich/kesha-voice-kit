import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/temp-dir";
import {
  canInstallDiarizeOnPlatform,
  initCommand,
  initInstallArgs,
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
    const imported = [...source.matchAll(/^import .*?from "(.+?)";$/gm)].map((m) => m[1] ?? "");

    expect(imported).toContain("@clack/prompts");
    expect(imported.filter((m) => m.startsWith("node:readline"))).toEqual([]);
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

describe("init cancelled at a prompt (Exploratory S4-F1)", () => {
  /** Runs one real clack prompt in its own process, so the exit code Ctrl-C produces is the one a shell sees. */
  async function cancelAtPrompt(which: "confirm" | "tts") {
    const dir = tempDir("kesha-init-cancel-");
    const script = join(dir, "prompt.ts");
    writeFileSync(
      script,
      `import { promptConfirm, promptTtsLangs } from ${JSON.stringify(join(import.meta.dir, "../../src/cli/init.ts"))};\n` +
        `const answer = ${which === "tts" ? "await promptTtsLangs([])" : 'await promptConfirm("Install VAD?", true)'};\n` +
        `console.log("answered " + JSON.stringify(answer));\n`,
    );
    const proc = Bun.spawn([process.execPath, script], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, KESHA_HOME: dir, KESHA_ENGINE_BIN: join(dir, "no-engine") },
    });
    proc.stdin.write("\x03");
    proc.stdin.flush();
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, output: stdout + stderr };
  }

  for (const which of ["confirm", "tts"] as const) {
    test(`Ctrl-C at the ${which} prompt exits 130 after "Init cancelled.", so \`kesha init && …\` stops`, async () => {
      const { exitCode, output } = await cancelAtPrompt(which);
      expect(output).toContain("Init cancelled.");
      expect(output).not.toContain("answered");
      expect(exitCode).toBe(130);
    }, 20_000);
  }
});

describe("init with a terminal on stdin but stdout piped (#1373)", () => {
  test("refuses with E_INVALID_ARG, exit 2, prints nothing on stdout and downloads nothing", async () => {
    const cacheDir = join(tempDir("kesha-init-no-tty-"), "cache");
    const saved = {
      stdinIsTTY: process.stdin.isTTY,
      stdoutIsTTY: process.stdout.isTTY,
      exit: process.exit,
      exitCode: process.exitCode,
      stderrWrite: process.stderr.write,
      consoleLog: console.log,
      cacheDir: process.env.KESHA_CACHE_DIR,
    };
    let stderr = "";
    let stdout = "";
    let exitCode: number | string | undefined;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    process.stderr.write = ((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    console.log = (...parts: unknown[]) => {
      stdout += `${parts.join(" ")}\n`;
    };
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
    process.env.KESHA_CACHE_DIR = cacheDir;
    process.exitCode = 0;
    try {
      await initCommand.run?.({ args: initArgs(), rawArgs: [] } as never);
      exitCode = process.exitCode;
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: saved.stdinIsTTY, configurable: true });
      Object.defineProperty(process.stdout, "isTTY", { value: saved.stdoutIsTTY, configurable: true });
      process.stderr.write = saved.stderrWrite;
      console.log = saved.consoleLog;
      process.exit = saved.exit;
      process.exitCode = saved.exitCode ?? 0;
      if (saved.cacheDir === undefined) delete process.env.KESHA_CACHE_DIR;
      else process.env.KESHA_CACHE_DIR = saved.cacheDir;
    }

    expect(exitCode).toBe(2);
    expect(stderr).toContain("error [E_INVALID_ARG]: kesha init is interactive and needs a terminal");
    expect(stdout).toBe("");
    expect(existsSync(cacheDir)).toBe(false);
  });
});
