import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  capabilities,
  install,
  KeshaError,
  say,
  transcribe,
  type EngineDescription,
  type InstallOptions,
  type SayOptions,
  type TranscribeOptions,
  type TranscribeResult,
  type TranscriptionSegment,
  type VadMode,
  type WordTiming,
} from "../../src/lib";
// @ts-expect-error -- removed in 2.0.0; `transcribe` returns the structured result (docs/api.md#migrating-to-200)
import type { TranscriptionOutput } from "../../src/lib";
import { describeJson, isolateEngineCache, saveEngineEnv, writeFakeEngine, writeTranscribingEngine } from "../helpers/fake-engine";
import { transcribeWithSegments, validateTranscribeRequest } from "../../src/transcribe";
import { SIDECARS } from "../../src/engine-install";
import { isDarwinArm64 } from "../../src/engine-targets";
import { defaultBackendForPlatform } from "../../src/cli/install";
import { engineVersion } from "../../src/package-info";
import { tempDir } from "../helpers/temp-dir";
import { waitForPidExit, waitForPidFile } from "../helpers/process";

function fakeEngine(features: string[]): string {
  return writeTranscribingEngine(
    "kesha-transcribe-test-",
    features,
    `  if [ "$3" = "--json" ] || [ "$2" = "--json" ]; then
    printf '%s\\n' '{"text":"ok","segments":[{"start":0,"end":1,"text":"ok"}]}'
  else
    printf '%s\\n' 'ok'
  fi`,
  );
}

const fakeEngineIt = process.platform === "win32" ? it.skip : it;

async function withEngine<T>(enginePath: string, fn: () => T | Promise<T>): Promise<T> {
  const saved = process.env.KESHA_ENGINE_BIN;
  try {
    process.env.KESHA_ENGINE_BIN = enginePath;
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.KESHA_ENGINE_BIN;
    else process.env.KESHA_ENGINE_BIN = saved;
  }
}

describe("transcribe.ts internals", () => {
  it("uses canonical Bun install commands when transcription backend is missing", async () => {
    const saved = process.env.KESHA_ENGINE_BIN;
    process.env.KESHA_ENGINE_BIN = `/tmp/kesha-missing-engine-${Date.now()}`;
    try {
      let hint = "";
      try {
        await validateTranscribeRequest({});
      } catch (err) {
        hint = err instanceof KeshaError ? (err.hint ?? "") : String(err);
      }
      expect(hint).toContain("bun add -g @drakulavich/kesha-voice-kit");
      expect(hint).toContain("kesha install");
      expect(hint).not.toContain("bunx");
    } finally {
      if (saved === undefined) delete process.env.KESHA_ENGINE_BIN;
      else process.env.KESHA_ENGINE_BIN = saved;
    }
  });

  it("reports the missing engine even for an invalid combo like speakers + vad:off (#768)", async () => {
    const saved = process.env.KESHA_ENGINE_BIN;
    try {
      process.env.KESHA_ENGINE_BIN = join(tempDir("kesha-no-engine-"), "absent");
      let err: unknown;
      try {
        await validateTranscribeRequest({ speakers: true, vad: "off" });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(KeshaError);
      expect((err as KeshaError).code).toBe("E_ENGINE_SPAWN");
      expect((err as KeshaError).hint).toContain("kesha install");
    } finally {
      if (saved === undefined) delete process.env.KESHA_ENGINE_BIN;
      else process.env.KESHA_ENGINE_BIN = saved;
    }
  });

  fakeEngineIt("routes timestamp requests through the JSON segment path", async () => {
    await withEngine(fakeEngine(["transcribe.segments"]), async () => {
      await expect(transcribeWithSegments("audio.wav", { timestamps: true })).resolves.toEqual({
        text: "ok",
        segments: [{ start: 0, end: 1, text: "ok" }],
      });
    });
  });

  fakeEngineIt("plain transcription still returns an empty segment list", async () => {
    await withEngine(fakeEngine(["transcribe.segments"]), async () => {
      await expect(transcribeWithSegments("audio.wav")).resolves.toEqual({
        text: "ok",
        segments: [],
      });
    });
  });

  // transcribeWithSegments skips the CLI gate, so the refusal comes from the spawn-side validation (#710).
  fakeEngineIt("refuses itn on the plain-text path when the engine lacks it", async () => {
    await withEngine(fakeEngine(["transcribe.segments"]), async () => {
      await expect(transcribeWithSegments("audio.wav", { itn: true })).rejects.toThrow(
        "--itn needs transcribe.itn",
      );
    });
  });

  fakeEngineIt("refuses itn alongside timestamps when the engine lacks it", async () => {
    await withEngine(fakeEngine(["transcribe.segments"]), async () => {
      await expect(
        transcribeWithSegments("audio.wav", { timestamps: true, itn: true }),
      ).rejects.toThrow("--itn needs transcribe.itn");
    });
  });

  fakeEngineIt("lets itn through when the engine advertises it", async () => {
    await withEngine(fakeEngine(["transcribe.segments", "transcribe.itn"]), async () => {
      await expect(transcribeWithSegments("audio.wav", { itn: true })).resolves.toEqual({
        text: "ok",
        segments: [],
      });
    });
  });
});

// Exploratory S8-1: abort was the one rejection on this surface that was not a KeshaError.
describe("transcribe() abort", () => {
  fakeEngineIt("an aborted call rejects with E_INTERRUPTED and leaves no engine running", async () => {
    const dir = tempDir("kesha-lib-abort-");
    const pidFile = join(dir, "engine.pid");
    const audio = join(dir, "audio.wav");
    writeFileSync(audio, "");
    const enginePath = writeTranscribingEngine(
      "kesha-lib-abort-engine-",
      [],
      `  printf '%s' "$$" > '${pidFile}'\n  sleep 30`,
    );
    await withEngine(enginePath, async () => {
      const controller = new AbortController();
      const run = transcribe(audio, { signal: controller.signal });
      const enginePid = await waitForPidFile(pidFile);
      controller.abort();
      const err = await run.catch((e) => e);
      expect(err).toBeInstanceOf(KeshaError);
      expect((err as KeshaError).code).toBe("E_INTERRUPTED");
      expect((err as KeshaError).origin).toBe("cli");
      expect((err as KeshaError).exitCode).toBe(130);
      expect((err as KeshaError).hint).toContain("AbortSignal");
      expect(await waitForPidExit(enginePid)).toBe(true);
    });
  });

  fakeEngineIt("an already-aborted signal rejects with E_INTERRUPTED before any engine is spawned", async () => {
    const dir = tempDir("kesha-lib-preaborted-");
    const marker = join(dir, "spawned");
    const audio = join(dir, "audio.wav");
    writeFileSync(audio, "");
    const enginePath = writeTranscribingEngine("kesha-lib-preaborted-engine-", [], `  : > '${marker}'`);
    await withEngine(enginePath, async () => {
      const err = await transcribe(audio, { signal: AbortSignal.abort() }).catch((e) => e);
      expect(err).toBeInstanceOf(KeshaError);
      expect((err as KeshaError).code).toBe("E_INTERRUPTED");
      expect(existsSync(marker)).toBe(false);
    });
  });
});

// Exploratory S8-3: the CLI answered a directory with E_INVALID_ARG while the API let the engine call it E_BAD_AUDIO.
describe("transcribe() on a directory", () => {
  fakeEngineIt("rejects with E_INVALID_ARG before any engine is spawned, with or without timestamps", async () => {
    const dir = tempDir("kesha-lib-directory-");
    const marker = join(dir, "spawned");
    const enginePath = writeTranscribingEngine("kesha-lib-directory-engine-", [], `  : > '${marker}'`);
    await withEngine(enginePath, async () => {
      for (const call of [transcribe(dir), transcribe(dir, { timestamps: true })]) {
        const err = await call.catch((e) => e);
        expect(err).toBeInstanceOf(KeshaError);
        expect((err as KeshaError).code).toBe("E_INVALID_ARG");
        expect((err as KeshaError).message).toContain("is a directory (expected an audio file)");
      }
      expect(existsSync(marker)).toBe(false);
    });
  });
});

/** Compile-time pin, checked by `bun run lint`: every public type resolves from `./core`; the removed one is the `@ts-expect-error` import above. */
export type PublicSurface = [
  EngineDescription, InstallOptions, SayOptions, TranscribeOptions, TranscribeResult,
  TranscriptionSegment, VadMode, WordTiming, TranscriptionOutput,
];

async function rejectionOf(promise: Promise<unknown>): Promise<KeshaError> {
  const err = await promise.then(
    () => new Error("expected a rejection"),
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(KeshaError);
  return err as KeshaError;
}

const ENGLISH = "the quick brown fox jumps over the lazy dog every morning";

describe("transcribe() resolves to a TranscribeResult", () => {
  function englishEngine(): string {
    return writeTranscribingEngine(
      "kesha-lib-result-",
      ["transcribe.segments"],
      `  if [ "$3" = "--json" ] || [ "$2" = "--json" ]; then
    printf '%s\\n' '{"text":"${ENGLISH}","segments":[{"start":0,"end":2.5,"text":"${ENGLISH}"}]}'
  else
    printf '%s\\n' '${ENGLISH}'
  fi`,
    );
  }

  fakeEngineIt("carries file, text and lang, and no segments unless asked", async () => {
    const audio = join(tempDir("kesha-lib-result-audio-"), "note.wav");
    writeFileSync(audio, "");
    await withEngine(englishEngine(), async () => {
      const result = await transcribe(audio);
      expect(result.file).toBe(audio);
      expect(result.text).toBe(ENGLISH);
      expect(result.lang).toBe("en");
      expect(result.textLanguage?.source).toBe("tinyld");
      expect(result.segments).toBeUndefined();
      expect(typeof result.sttTimeMs).toBe("number");
    });
  });

  fakeEngineIt("carries the segments when timestamps are requested", async () => {
    const audio = join(tempDir("kesha-lib-result-audio-"), "note.wav");
    writeFileSync(audio, "");
    await withEngine(englishEngine(), async () => {
      const result = await transcribe(audio, { timestamps: true });
      expect(result.text).toBe(ENGLISH);
      expect(result.segments).toEqual([{ start: 0, end: 2.5, text: ENGLISH }]);
    });
  });

  fakeEngineIt("carries the segments when speakers are requested", async () => {
    const audio = join(tempDir("kesha-lib-result-audio-"), "note.wav");
    writeFileSync(audio, "");
    const engine = writeTranscribingEngine(
      "kesha-lib-speakers-",
      ["transcribe.segments", "transcribe.diarize"],
      `  printf '%s\n' '{"text":"${ENGLISH}","segments":[{"start":0,"end":2.5,"text":"${ENGLISH}","speaker":1}]}'`,
    );
    // --speakers checks for the diarize and VAD model files before the spawn; stage both instead of relying on the host cache.
    const models = tempDir("kesha-lib-speakers-models-");
    mkdirSync(join(models, "models", "silero-vad"), { recursive: true });
    writeFileSync(join(models, "models", "silero-vad", "silero_vad.onnx"), "");
    const restoreEnv = saveEngineEnv();
    const savedDiarize = process.env.KESHA_DIARIZE_MODEL_PATH;
    process.env.KESHA_CACHE_DIR = models;
    process.env.KESHA_DIARIZE_MODEL_PATH = models;
    try {
      await withEngine(engine, async () => {
        const result = await transcribe(audio, { speakers: true });
        expect(result.segments).toEqual([{ start: 0, end: 2.5, text: ENGLISH, speaker: 1 }]);
      });
    } finally {
      restoreEnv();
      if (savedDiarize === undefined) delete process.env.KESHA_DIARIZE_MODEL_PATH;
      else process.env.KESHA_DIARIZE_MODEL_PATH = savedDiarize;
    }
  });

  it("rejects a missing file with E_INPUT_NOT_FOUND naming the path", async () => {
    const err = await rejectionOf(transcribe("/nonexistent/ghost.ogg"));
    expect(err.code).toBe("E_INPUT_NOT_FOUND");
    expect(err.message).toContain("/nonexistent/ghost.ogg");
  });

  it("rejects with E_ENGINE_SPAWN and a kesha install hint when no engine is installed", async () => {
    const dir = tempDir("kesha-lib-no-engine-");
    const audio = join(dir, "note.wav");
    writeFileSync(audio, "");
    await withEngine(join(dir, "absent"), async () => {
      const err = await rejectionOf(transcribe(audio));
      expect(err.code).toBe("E_ENGINE_SPAWN");
      expect(err.hint).toContain("kesha install");
    });
  });
});

describe("capabilities() resolves to the describe document", () => {
  fakeEngineIt("names the installed engine's features and profile", async () => {
    const bin = writeFakeEngine(join(tempDir("kesha-lib-caps-"), "bin"), ["tts", "transcribe.diarize"]);
    await withEngine(bin, async () => {
      const doc = await capabilities();
      expect(doc.features).toContain("transcribe.diarize");
      expect(doc.profile).toBe("darwin");
      expect(doc.commands.install?.flags.diarize).toBeDefined();
    });
  });

  fakeEngineIt("hands out a copy, so a caller's edit cannot reach the next call", async () => {
    const bin = writeFakeEngine(join(tempDir("kesha-lib-caps-copy-"), "bin"), ["tts"]);
    await withEngine(bin, async () => {
      const first = await capabilities();
      first.features.push("transcribe.diarize");
      expect((await capabilities()).features).toEqual(["tts"]);
    });
  });

  it("rejects with E_ENGINE_SPAWN and a kesha install hint when no engine is installed", async () => {
    await withEngine(join(tempDir("kesha-lib-caps-absent-"), "absent"), async () => {
      const err = await rejectionOf(capabilities());
      expect(err.code).toBe("E_ENGINE_SPAWN");
      expect(err.hint).toContain("kesha install");
    });
  });
});

describe("say() rejects with a coded KeshaError", () => {
  it("empty text is E_TEXT_EMPTY with exit code 2", async () => {
    const err = await rejectionOf(say({ text: "" }));
    expect(err.code).toBe("E_TEXT_EMPTY");
    expect(err.exitCode).toBe(2);
  });

  it("text over the limit is E_TEXT_TOO_LONG with exit code 5", async () => {
    const err = await rejectionOf(say({ text: "x".repeat(5001) }));
    expect(err.code).toBe("E_TEXT_TOO_LONG");
    expect(err.exitCode).toBe(5);
  });
});

describe("install() mirrors kesha install", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;
  let restore: () => void = () => {};
  const realFetch = globalThis.fetch;
  let requested: string[] = [];

  afterEach(() => {
    restore();
    restore = () => {};
    globalThis.fetch = realFetch;
  });

  /** Records every URL the installer asks for and serves none, so "nothing was downloaded" is an empty list. */
  function recordDownloads(): void {
    requested = [];
    globalThis.fetch = (async (input: Request | URL | string) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;
  }

  /** A cache-valid engine whose model-install spawn records its argv and runs `installBody`. */
  function stageInstalledEngine(installBody = ""): { binPath: string; argvFile: string } {
    restore = isolateEngineCache();
    const dir = tempDir("kesha-lib-install-");
    const binDir = join(dir, "bin");
    mkdirSync(binDir, { recursive: true });
    for (const spec of SIDECARS) {
      const path = join(binDir, spec.fileBasename);
      writeFileSync(path, "#!/bin/sh\nexit 0\n");
      chmodSync(path, 0o755);
    }
    const binPath = join(binDir, "kesha-engine");
    const argvFile = join(dir, "install-argv");
    writeFileSync(
      binPath,
      `#!/bin/sh
case "$1" in
  describe) printf '%s\\n' '${describeJson({ features: ["tts"] })}'; exit 0 ;;
  --version) printf 'kesha-engine ${engineVersion}\\n'; exit 0 ;;
  install) printf '%s\\n' "$*" > '${argvFile}'
${installBody}
    exit 0 ;;
esac
exit 0
`,
    );
    chmodSync(binPath, 0o755);
    writeFileSync(`${binPath}.version`, `${engineVersion}\n`);
    process.env.KESHA_ENGINE_BIN = binPath;
    return { binPath, argvFile };
  }

  /** An isolated cache with no engine in it, and no network. */
  function stageAbsentEngine(): void {
    restore = isolateEngineCache();
    recordDownloads();
  }

  posixIt("installs the TTS languages and VAD it is asked for", async () => {
    const { argvFile } = stageInstalledEngine();
    await install({ tts: ["en", "ru"], vad: true });
    const argv = readFileSync(argvFile, "utf8").trim().split(" ");
    expect(argv[0]).toBe("install");
    expect(argv.slice(argv.indexOf("--tts") + 1, argv.indexOf("--tts") + 3)).toEqual(["en", "ru"]);
    expect(argv).toContain("--vad");
  });

  posixIt("with no options installs the engine and ASR models only", async () => {
    const { argvFile } = stageInstalledEngine();
    await install();
    expect(readFileSync(argvFile, "utf8").trim()).toBe("install");
  });

  posixIt("an install failure nothing coded still rejects as E_INTERNAL", async () => {
    stageInstalledEngine("    exit 3");
    const err = await rejectionOf(install());
    expect(err.code).toBe("E_INTERNAL");
    expect(err.message).toContain("exited with code 3");
  });

  it("refuses a malformed engine version with E_INVALID_ARG before downloading", async () => {
    stageAbsentEngine();
    const err = await rejectionOf(install({ engineVersion: "latest" }));
    expect(err.code).toBe("E_INVALID_ARG");
    expect(requested).toEqual([]);
  });

  it("refuses a TTS language this platform cannot serve with E_INVALID_ARG before downloading", async () => {
    stageAbsentEngine();
    const err = await rejectionOf(install({ tts: ["xx"] }));
    expect(err.code).toBe("E_INVALID_ARG");
    expect(err.message).toContain("xx");
    expect(requested).toEqual([]);
  });

  const platformBackend = defaultBackendForPlatform();
  (platformBackend ? it : it.skip)("refuses the backend this platform does not ship with E_INVALID_ARG", async () => {
    stageAbsentEngine();
    const other: InstallOptions["backend"] = platformBackend === "coreml" ? "onnx" : "coreml";
    const err = await rejectionOf(install({ backend: other }));
    expect(err.code).toBe("E_INVALID_ARG");
    expect(err.message).toContain(other);
    expect(requested).toEqual([]);
  });

  (isDarwinArm64() ? it.skip : it)("refuses diarize off darwin-arm64 with E_UNSUPPORTED_PLATFORM", async () => {
    stageAbsentEngine();
    const err = await rejectionOf(install({ diarize: true }));
    expect(err.code).toBe("E_UNSUPPORTED_PLATFORM");
    expect(requested).toEqual([]);
  });

  (isDarwinArm64() || !platformBackend ? it.skip : it)("reports diarize before an unavailable backend, in the CLI's order", async () => {
    stageAbsentEngine();
    const other: InstallOptions["backend"] = platformBackend === "coreml" ? "onnx" : "coreml";
    const err = await rejectionOf(install({ diarize: true, backend: other }));
    expect(err.code).toBe("E_UNSUPPORTED_PLATFORM");
  });
});
