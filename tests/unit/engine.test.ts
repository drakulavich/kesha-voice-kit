import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { waitForPidExit, waitForPidFile } from "../helpers/process";
import {
  detectTextLanguageEngine,
  parseLangResult,
  getEngineBinPath,
  preflightRecordLive,
  preflightTranscribeEngineItn,
  preflightTranscribeEngineWithSegments,
  recordEngine,
  spawnStdioWithDebugFd,
  textLangFailureWarning,
  transcribeEngine,
  transcribeEngineWithSegments,
} from "../../src/engine";

function fakeEngine(features: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "kesha-engine-test-"));
  const path = join(dir, "kesha-engine");
  writeFileSync(
    path,
    `#!/bin/sh
if [ "$1" = "--capabilities-json" ]; then
  printf '%s\\n' '${JSON.stringify({ protocolVersion: 2, backend: "fake", features })}'
  exit 0
fi
if [ "$1" = "transcribe" ]; then
  printf '%s\\n' '{"text":"ok","segments":[{"start":0,"end":1,"text":"ok","speaker":0}]}'
  exit 0
fi
exit 2
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const fakeEngineTest = process.platform === "win32" ? test.skip : test;

/** Echoes the `transcribe` argv it was handed as the transcript, so a test can assert which flags were forwarded. */
async function argEchoEngine(features: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kesha-engine-argecho-"));
  const path = join(dir, "kesha-engine");
  await Bun.write(
    path,
    `#!/bin/sh
if [ "$1" = "--capabilities-json" ]; then
  printf '%s\\n' '${JSON.stringify({ protocolVersion: 3, backend: "fake", features })}'
  exit 0
fi
if [ "$1" = "transcribe" ]; then
  shift
  printf '%s\\n' "$*"
  exit 0
fi
exit 2
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function fakeLongRunningEngine(dir: string, helperPidFile: string): string {
  const path = join(dir, "kesha-engine-long-running");
  writeFileSync(
    path,
    `#!${process.execPath}
const args = Bun.argv.slice(2);
if (args[0] === "transcribe") {
  const child = Bun.spawn(["sh", "-c", "trap '' TERM INT; while :; do sleep 1; done"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await Bun.write(${JSON.stringify(helperPidFile)}, String(child.pid));
  await new Promise(() => {});
}
console.error("unexpected args: " + JSON.stringify(args));
process.exit(2);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

async function withEngineEnv<T>(
  enginePath: string,
  fn: () => T | Promise<T>,
  extraEnv: Record<string, string | undefined> = {},
): Promise<T> {
  const savedEngine = process.env.KESHA_ENGINE_BIN;
  const savedDiarize = process.env.KESHA_DIARIZE_MODEL_PATH;
  const savedExtra = Object.keys(extraEnv).map((key) => [key, process.env[key]] as const);
  try {
    process.env.KESHA_ENGINE_BIN = enginePath;
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await fn();
  } finally {
    if (savedEngine === undefined) delete process.env.KESHA_ENGINE_BIN;
    else process.env.KESHA_ENGINE_BIN = savedEngine;
    if (savedDiarize === undefined) delete process.env.KESHA_DIARIZE_MODEL_PATH;
    else process.env.KESHA_DIARIZE_MODEL_PATH = savedDiarize;
    for (const [key, value] of savedExtra) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** #768: `--speakers` preflight requires the VAD model alongside the diarize model. */
function cacheDirWithVadModel(): string {
  const cache = mkdtempSync(join(tmpdir(), "kesha-cache-vad-"));
  mkdirSync(join(cache, "models", "silero-vad"), { recursive: true });
  writeFileSync(join(cache, "models", "silero-vad", "silero_vad.onnx"), "");
  return cache;
}

const engineBasename = process.platform === "win32" ? "kesha-engine.exe" : "kesha-engine";

/** Runs `fn` with the two path-resolution vars forced to `env`, restoring whatever the shell had. */
function withPathEnv<T>(env: Record<"KESHA_CACHE_DIR" | "KESHA_ENGINE_BIN", string | undefined>, fn: () => T): T {
  const saved = { ...process.env };
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const key of ["KESHA_CACHE_DIR", "KESHA_ENGINE_BIN"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe("engine", () => {
  test("getEngineBinPath defaults to the XDG-style cache under $HOME", () => {
    withPathEnv({ KESHA_CACHE_DIR: undefined, KESHA_ENGINE_BIN: undefined }, () => {
      expect(getEngineBinPath()).toBe(
        join(homedir(), ".cache", "kesha", "engine", "bin", engineBasename),
      );
    });
  });

  test("getEngineBinPath lets KESHA_ENGINE_BIN outrank KESHA_CACHE_DIR", () => {
    withPathEnv(
      { KESHA_CACHE_DIR: "/tmp/kesha-cache", KESHA_ENGINE_BIN: "/tmp/kesha-explicit-engine" },
      () => expect(getEngineBinPath()).toBe("/tmp/kesha-explicit-engine"),
    );
  });

  test("getEngineBinPath follows KESHA_CACHE_DIR", () => {
    withPathEnv({ KESHA_CACHE_DIR: "/tmp/kesha-cache", KESHA_ENGINE_BIN: undefined }, () => {
      expect(getEngineBinPath()).toBe(join("/tmp/kesha-cache", "engine", "bin", engineBasename));
    });
  });

  test("getEngineBinPath treats an empty KESHA_ENGINE_BIN as unset", () => {
    withPathEnv({ KESHA_CACHE_DIR: "/tmp/kesha-cache", KESHA_ENGINE_BIN: "" }, () => {
      expect(getEngineBinPath()).toBe(join("/tmp/kesha-cache", "engine", "bin", engineBasename));
    });
  });

  test("parseLangResult parses valid JSON", () => {
    expect(parseLangResult('{"code":"ru","confidence":0.94}')).toEqual({ code: "ru", confidence: 0.94 });
  });

  test("parseLangResult returns null for invalid JSON", () => {
    expect(parseLangResult("not json")).toBeNull();
  });

  test("parseLangResult returns null for empty string", () => {
    expect(parseLangResult("")).toBeNull();
  });

  test("parseLangResult returns null for missing code field", () => {
    expect(parseLangResult('{"confidence":0.94}')).toBeNull();
  });

  fakeEngineTest("itn preflight rejects when the engine does not advertise transcribe.itn (#710)", async () => {
    await withEngineEnv(fakeEngine(["transcribe.segments"]), async () => {
      await expect(preflightTranscribeEngineItn({ itn: true })).rejects.toThrow(
        "--itn requires a newer kesha-engine",
      );
    });
  });

  fakeEngineTest("itn preflight is a no-op when itn was not requested", async () => {
    await withEngineEnv(fakeEngine([]), async () => {
      await expect(preflightTranscribeEngineItn({})).resolves.toBeUndefined();
    });
  });

  fakeEngineTest("itn preflight passes when the engine advertises the capability", async () => {
    await withEngineEnv(fakeEngine(["transcribe.itn"]), async () => {
      await expect(preflightTranscribeEngineItn({ itn: true })).resolves.toBeUndefined();
    });
  });

  fakeEngineTest("--itn forwards to the engine on the plain-text path", async () => {
    await withEngineEnv(await argEchoEngine(["transcribe.itn"]), async () => {
      expect(await transcribeEngine("audio.wav", { itn: true })).toBe("audio.wav --itn");
      expect(await transcribeEngine("audio.wav", {})).toBe("audio.wav");
    });
  });

  fakeEngineTest("--itn forwards to the engine on the --json path", async () => {
    await withEngineEnv(await argEchoEngine(["transcribe.segments", "transcribe.itn"]), async () => {
      // The arg-echo engine returns argv, not JSON, so the parse failure carries the argv we want to assert on.
      await expect(transcribeEngineWithSegments("audio.wav", { itn: true })).rejects.toThrow(
        "audio.wav --json --itn",
      );
    });
  });

  fakeEngineTest("the plain-text helper refuses --itn on an engine without the capability", async () => {
    // Direct ./engine callers bypass the CLI preflight, and would otherwise get
    // clap usage noise from the old engine instead of the upgrade hint.
    await withEngineEnv(await argEchoEngine(["transcribe.segments"]), async () => {
      await expect(transcribeEngine("audio.wav", { itn: true })).rejects.toThrow(
        "--itn requires a newer kesha-engine",
      );
    });
  });

  fakeEngineTest("the --json helper refuses --itn on an engine without the capability", async () => {
    await withEngineEnv(await argEchoEngine(["transcribe.segments"]), async () => {
      await expect(
        transcribeEngineWithSegments("audio.wav", { itn: true }),
      ).rejects.toThrow("--itn requires a newer kesha-engine");
    });
  });

  fakeEngineTest("preflight rejects timestamp requests when the engine lacks segment support", async () => {
    await withEngineEnv(fakeEngine([]), async () => {
      await expect(preflightTranscribeEngineWithSegments()).rejects.toThrow("Timestamped segments require");
    });
  });

  fakeEngineTest("preflight rejects speakers when the engine lacks diarization support", async () => {
    await withEngineEnv(fakeEngine(["transcribe.segments"]), async () => {
      await expect(preflightTranscribeEngineWithSegments({ speakers: true })).rejects.toThrow(
        "speaker diarization is currently darwin-arm64 only",
      );
    });
  });

  fakeEngineTest("preflight rejects --live when the engine lacks record.live", async () => {
    await withEngineEnv(fakeEngine(["transcribe"]), async () => {
      await expect(preflightRecordLive()).rejects.toThrow(
        "live transcription requires a CoreML engine on Apple Silicon",
      );
      await expect(preflightRecordLive()).rejects.toThrow("kesha record --out note.wav");
    });
  });

  fakeEngineTest("preflight accepts --live when the engine advertises record.live", async () => {
    await withEngineEnv(fakeEngine(["transcribe", "record.live"]), async () => {
      await expect(preflightRecordLive()).resolves.toBeUndefined();
    });
  });

  // An unreadable probe must not be read as "supported" — that would forward
  // --live into an engine that has no such flag. It is also not the same failure
  // as an engine that answered and lacks the feature, so it says so.
  fakeEngineTest("preflight rejects --live when capabilities cannot be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-engine-caps-fail-"));
    const broken = join(dir, "kesha-engine");
    writeFileSync(broken, "#!/bin/sh\nexit 3\n");
    chmodSync(broken, 0o755);
    await withEngineEnv(broken, async () => {
      const err = await preflightRecordLive().then(
        () => null,
        (e: unknown) => String(e),
      );
      expect(err).toContain("could not read kesha-engine's capabilities");
      expect(err).not.toContain("requires a CoreML engine on Apple Silicon");
    });
  });

  fakeEngineTest("preflight rejects missing KESHA_DIARIZE_MODEL_PATH before transcription", async () => {
    await withEngineEnv(
      fakeEngine(["transcribe.segments", "transcribe.diarize"]),
      async () => {
        await expect(preflightTranscribeEngineWithSegments({ speakers: true })).rejects.toThrow(
          "KESHA_DIARIZE_MODEL_PATH set but path does not exist",
        );
      },
      { KESHA_DIARIZE_MODEL_PATH: "/tmp/kesha-missing-diarize-model" },
    );
  });

  test("preflight rejects speakers + vad:off before resolving capabilities or models (#768)", async () => {
    const emptyCache = mkdtempSync(join(tmpdir(), "kesha-cache-empty-"));
    await withEngineEnv(
      join(emptyCache, "no-such-kesha-engine"),
      async () => {
        await expect(
          preflightTranscribeEngineWithSegments({ speakers: true, vad: "off" }),
        ).rejects.toThrow("E_INVALID_ARG");
      },
      { KESHA_CACHE_DIR: emptyCache, KESHA_DIARIZE_MODEL_PATH: undefined },
    );
  });

  fakeEngineTest("preflight rejects speakers when the VAD model is missing (#768)", async () => {
    const modelPath = mkdtempSync(join(tmpdir(), "kesha-diarize-model-"));
    mkdirSync(join(modelPath, "Data", "com.apple.CoreML", "weights"), { recursive: true });
    await withEngineEnv(
      fakeEngine(["transcribe.segments", "transcribe.diarize"]),
      async () => {
        await expect(preflightTranscribeEngineWithSegments({ speakers: true })).rejects.toThrow(
          "speaker diarization requires the VAD model",
        );
      },
      {
        KESHA_DIARIZE_MODEL_PATH: modelPath,
        KESHA_CACHE_DIR: mkdtempSync(join(tmpdir(), "kesha-cache-no-vad-")),
      },
    );
  });

  fakeEngineTest("transcribeEngineWithSegments accepts a valid diarize override and parses speakers", async () => {
    const modelPath = mkdtempSync(join(tmpdir(), "kesha-diarize-model-"));
    mkdirSync(join(modelPath, "Data", "com.apple.CoreML", "weights"), { recursive: true });
    await withEngineEnv(
      fakeEngine(["transcribe.segments", "transcribe.diarize"]),
      async () => {
        const out = await transcribeEngineWithSegments("audio.wav", {
          vad: "on",
          speakers: true,
        });
        expect(out.segments[0]).toEqual({ start: 0, end: 1, text: "ok", speaker: 0 });
      },
      { KESHA_DIARIZE_MODEL_PATH: modelPath, KESHA_CACHE_DIR: cacheDirWithVadModel() },
    );
  });

  fakeEngineTest("transcribeEngine surfaces E_ENGINE_SPAWN instead of a raw spawn exception", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-engine-not-exec-"));
    const notExecutable = join(dir, "kesha-engine");
    writeFileSync(notExecutable, "not a binary");
    chmodSync(notExecutable, 0o644);
    await withEngineEnv(notExecutable, async () => {
      await expect(transcribeEngine("audio.wav")).rejects.toThrow(
        new RegExp(`error \\[E_ENGINE_SPAWN\\]: failed to launch kesha-engine at ${notExecutable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      );
    });
  });

  fakeEngineTest("recordEngine surfaces E_ENGINE_SPAWN instead of a raw spawn exception", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-engine-not-exec-record-"));
    const notExecutable = join(dir, "kesha-engine");
    writeFileSync(notExecutable, "not a binary");
    chmodSync(notExecutable, 0o644);
    await withEngineEnv(notExecutable, async () => {
      const out = join(dir, "out.wav");
      await expect(recordEngine({ out }, 10)).rejects.toThrow(/error \[E_ENGINE_SPAWN\]: failed to launch kesha-engine at/);
      await expect(recordEngine({ out }, 10)).rejects.toThrow(/Run `kesha install` \(or set KESHA_ENGINE_BIN\)/);
    });
  });

  fakeEngineTest("abort terminates the spawned engine process tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-engine-tree-"));
    const helperPidFile = join(dir, "helper.pid");
    const enginePath = fakeLongRunningEngine(dir, helperPidFile);
    await withEngineEnv(enginePath, async () => {
      const controller = new AbortController();
      const run = transcribeEngine("audio.wav", { signal: controller.signal });
      const helperPid = await waitForPidFile(helperPidFile);

      controller.abort();

      await expect(run).rejects.toThrow("kesha-engine process aborted");
      expect(await waitForPidExit(helperPid)).toBe(true);
    });
  });
});

describe("spawnStdioWithDebugFd", () => {
  let savedFd: string | undefined;
  beforeEach(() => {
    savedFd = process.env.KESHA_DEBUG_FD;
    delete process.env.KESHA_DEBUG_FD;
  });
  afterEach(() => {
    if (savedFd === undefined) {
      delete process.env.KESHA_DEBUG_FD;
    } else {
      process.env.KESHA_DEBUG_FD = savedFd;
    }
  });

  test("returns base unchanged when KESHA_DEBUG_FD is unset", () => {
    expect(spawnStdioWithDebugFd(["ignore", "pipe", "pipe"])).toEqual(["ignore", "pipe", "pipe"]);
  });

  test("returns base unchanged on invalid KESHA_DEBUG_FD values", () => {
    const invalidValues = ["", "abc", "-1", "3.5", "1000000"];
    for (const value of invalidValues) {
      process.env.KESHA_DEBUG_FD = value;
      expect(spawnStdioWithDebugFd(["ignore", "pipe", "pipe"])).toEqual(["ignore", "pipe", "pipe"]);
    }
  });

  test("returns base unchanged for stdio range fd (0/1/2)", () => {
    for (const fd of ["0", "1", "2"]) {
      process.env.KESHA_DEBUG_FD = fd;
      expect(spawnStdioWithDebugFd(["ignore", "pipe", "pipe"])).toEqual(["ignore", "pipe", "pipe"]);
    }
  });

  test("forwards parent fd 3 as child fd 3 (no padding needed)", () => {
    process.env.KESHA_DEBUG_FD = "3";
    expect(spawnStdioWithDebugFd(["ignore", "pipe", "pipe"])).toEqual(["ignore", "pipe", "pipe", 3]);
  });

  test("pads with ignore up to the target fd and identity-maps it", () => {
    process.env.KESHA_DEBUG_FD = "5";
    // fd 5 needs ignore at slots 3, 4 then identity-map at 5.
    expect(spawnStdioWithDebugFd(["ignore", "pipe", "pipe"])).toEqual([
      "ignore",
      "pipe",
      "pipe",
      "ignore",
      "ignore",
      5,
    ]);
  });

  test("preserves alternative base stdin choices (e.g. say-side 'pipe')", () => {
    process.env.KESHA_DEBUG_FD = "3";
    // `kesha say` opens stdin to write the text payload through.
    expect(spawnStdioWithDebugFd(["pipe", "pipe", "pipe"])).toEqual(["pipe", "pipe", "pipe", 3]);
  });

});

describe("text language detection degrades loudly (#770)", () => {
  test("a darwin failure names the sidecar and the fix", () => {
    const warning = textLangFailureWarning("kesha-textlang helper exited 137", "darwin");
    expect(warning).toContain("kesha-textlang helper exited 137");
    expect(warning).toContain("kesha install");
  });

  // Text detection is macOS-only, so failing elsewhere is the documented behaviour, not a fault.
  test("no warning on platforms that never supported detection", () => {
    expect(textLangFailureWarning("unsupported on this platform", "linux")).toBeNull();
    expect(textLangFailureWarning("unsupported on this platform", "win32")).toBeNull();
  });

  fakeEngineTest("a failing subprocess warns on stderr and still resolves null", async () => {
    const savedEngineBin = process.env.KESHA_ENGINE_BIN;
    const savedWrite = process.stderr.write;
    const captured: string[] = [];
    process.env.KESHA_ENGINE_BIN = fakeEngine([]);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      expect(await detectTextLanguageEngine("Привет, как дела?")).toBeNull();
    } finally {
      process.stderr.write = savedWrite;
      if (savedEngineBin === undefined) delete process.env.KESHA_ENGINE_BIN;
      else process.env.KESHA_ENGINE_BIN = savedEngineBin;
    }

    const warned = captured.some((line) => line.includes("Text language detection failed"));
    expect(warned).toBe(process.platform === "darwin");
  });
});
