import { describe, test, expect } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { stubbornShell, waitForPidExit, waitForPidFile } from "../helpers/process";
import { describeJson, envEchoEngine, saveEngineEnv, writeTranscribingEngine } from "../helpers/fake-engine";
import { applyColorEnv } from "../../src/cli/context";
import {
  detectTextLanguageEngine,
  getDescribe,
  getEngineBinPath,
  getEngineCapabilities,
  parseLangResult,
  recordEngine,
  spawnEngineProcess,
  textLangFailureWarning,
  transcribeEngine,
  transcribeEngineWithSegments,
  validateRecordRequest,
} from "../../src/engine";
import { KeshaError } from "../../src/engine/events";
import { errorMessage } from "../../src/error-utils";
import { validateTranscribeRequest } from "../../src/transcribe";

/** The thrown KeshaError, so a test can assert on code and hint rather than on prose. */
async function failure(run: () => Promise<unknown>): Promise<KeshaError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof KeshaError) return err;
    throw err;
  }
  throw new Error("expected a KeshaError");
}

function fakeEngine(features: string[]): string {
  return writeTranscribingEngine(
    "kesha-engine-test-",
    features,
    `  printf '%s\\n' '{"text":"ok","segments":[{"start":0,"end":1,"text":"ok","speaker":0}]}'`,
  );
}

const fakeEngineTest = process.platform === "win32" ? test.skip : test;

/** Echoes the `transcribe` argv it was handed as the transcript, so a test can assert which flags were forwarded. */
async function argEchoEngine(features: string[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "kesha-engine-argecho-"));
  const path = join(dir, "kesha-engine");
  await Bun.write(
    path,
    `#!/bin/sh
if [ "$1" = "describe" ]; then
  printf '%s\\n' '${describeJson({ features })}'
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

function capsEngineWithVersion(protocolVersion: number): string {
  const path = join(mkdtempSync(join(tmpdir(), "kesha-engine-proto-")), "kesha-engine");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ features: ["transcribe"], protocolVersion })}'\n  exit 0\nfi\nexit 2\n`,
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
if (args[0] === "describe") {
  console.log(${JSON.stringify(describeJson({ features: [] }))});
  process.exit(0);
}
if (args[0] === "transcribe") {
  const child = Bun.spawn(["sh", "-c", ${JSON.stringify(stubbornShell("TERM INT"))}], {
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

type PathEnv = Record<"KESHA_CACHE_DIR" | "KESHA_ENGINE_BIN", string | undefined>;

/** Runs `fn` with the two path-resolution vars forced to `env`, restoring the two it mutated. */
function withPathEnv<T>(env: PathEnv, fn: () => T): T {
  const saved: PathEnv = {
    KESHA_CACHE_DIR: process.env.KESHA_CACHE_DIR,
    KESHA_ENGINE_BIN: process.env.KESHA_ENGINE_BIN,
  };
  const apply = (values: PathEnv) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    apply(env);
    return fn();
  } finally {
    apply(saved);
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

  fakeEngineTest("--itn on an engine without the pass is E_INVALID_ARG with the upgrade path (#710)", async () => {
    await withEngineEnv(await argEchoEngine(["transcribe.segments"]), async () => {
      for (const run of [
        () => transcribeEngine("audio.wav", { itn: true }),
        () => transcribeEngineWithSegments("audio.wav", { itn: true }),
        () => validateTranscribeRequest({ itn: true }),
      ]) {
        const err = await failure(run);
        expect(err.code).toBe("E_INVALID_ARG");
        expect(err.message).toContain("--itn");
        expect(err.hint).toContain("bun add -g @drakulavich/kesha-voice-kit@latest");
      }
    });
  });

  fakeEngineTest("speakers on a build without diarization is E_INVALID_ARG naming the platform", async () => {
    await withEngineEnv(fakeEngine(["transcribe.segments"]), async () => {
      const err = await failure(() => transcribeEngineWithSegments("audio.wav", { speakers: true }));
      expect(err.code).toBe("E_INVALID_ARG");
      expect(err.hint).toContain("darwin-arm64");
    });
  });

  fakeEngineTest("speakers with vad off is E_INVALID_ARG before any model is looked for (#768)", async () => {
    await withEngineEnv(
      fakeEngine(["transcribe.segments", "transcribe.diarize"]),
      async () => {
        const err = await failure(() => validateTranscribeRequest({ speakers: true, vad: "off" }));
        expect(err.code).toBe("E_INVALID_ARG");
        expect(err.message).toContain("--no-vad");
      },
      { KESHA_DIARIZE_MODEL_PATH: "/tmp/kesha-missing-diarize-model" },
    );
  });

  fakeEngineTest("--live is refused where record.live is absent, with the two-step remedy", async () => {
    await withEngineEnv(fakeEngine(["transcribe"]), async () => {
      const err = await failure(() => validateRecordRequest({ live: true }, 10));
      expect(err.code).toBe("E_INVALID_ARG");
      expect(err.hint).toContain("kesha record --out note.wav");
    });
    await withEngineEnv(fakeEngine(["transcribe", "record.live"]), async () => {
      await expect(validateRecordRequest({ live: true }, 10)).resolves.toBeUndefined();
    });
  });

  fakeEngineTest("auto-stop needs record.live.auto-stop", async () => {
    const autoStop = { silenceMs: 800, threshold: 0.5, minSpeechMs: 250 };
    await withEngineEnv(fakeEngine(["transcribe", "record.live"]), async () => {
      const err = await failure(() => validateRecordRequest({ live: true, autoStop }, 10));
      expect(err.code).toBe("E_INVALID_ARG");
      expect(err.message).toContain("--auto-stop");
    });
    await withEngineEnv(fakeEngine(["transcribe", "record.live", "record.live.auto-stop"]), async () => {
      await expect(validateRecordRequest({ live: true, autoStop }, 10)).resolves.toBeUndefined();
    });
  });

  fakeEngineTest("an engine that cannot describe itself is E_ENGINE_PROTOCOL pointing at kesha install", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-engine-old-"));
    const old = join(dir, "kesha-engine");
    writeFileSync(old, "#!/bin/sh\necho 'error: unrecognized subcommand describe' >&2\nexit 2\n");
    chmodSync(old, 0o755);
    await withEngineEnv(old, async () => {
      const err = await failure(() => validateRecordRequest({ out: join(dir, "o.wav") }, 10));
      expect(err.code).toBe("E_ENGINE_PROTOCOL");
      expect(err.hint).toContain("kesha install");
      expect(errorMessage(err)).toMatch(/^error \[E_ENGINE_PROTOCOL\]:/);
      expect(errorMessage(err)).toContain("hint: run `kesha install`");
      expect(await getEngineCapabilities()).toBeNull();
    });
  });

  fakeEngineTest("a newer protocol is E_ENGINE_PROTOCOL pointing at the CLI upgrade", async () => {
    await withEngineEnv(capsEngineWithVersion(5), async () => {
      const err = await failure(() => transcribeEngine("audio.wav"));
      expect(err.code).toBe("E_ENGINE_PROTOCOL");
      expect(err.hint).toContain("bun add -g @drakulavich/kesha-voice-kit@latest");
    });
  });

  fakeEngineTest("preflight rejects missing KESHA_DIARIZE_MODEL_PATH before transcription", async () => {
    await withEngineEnv(
      fakeEngine(["transcribe.segments", "transcribe.diarize"]),
      async () => {
        await expect(transcribeEngineWithSegments("audio.wav", { speakers: true })).rejects.toThrow(
          "KESHA_DIARIZE_MODEL_PATH set but path does not exist",
        );
      },
      { KESHA_DIARIZE_MODEL_PATH: "/tmp/kesha-missing-diarize-model" },
    );
  });

  fakeEngineTest("preflight rejects speakers when the VAD model is missing (#768)", async () => {
    const modelPath = mkdtempSync(join(tmpdir(), "kesha-diarize-model-"));
    mkdirSync(join(modelPath, "Data", "com.apple.CoreML", "weights"), { recursive: true });
    await withEngineEnv(
      fakeEngine(["transcribe.segments", "transcribe.diarize"]),
      async () => {
        await expect(transcribeEngineWithSegments("audio.wav", { speakers: true })).rejects.toThrow(
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

  /** #720: the parser rebuilds each segment field by field, so a new key is lost unless
   * it is copied — and every user path (`--json --timestamps`, `--toon`,
   * `transcribeWithSegments`, MCP) reads the transcript through here. */
  fakeEngineTest("transcribeEngineWithSegments forwards word timings", async () => {
    const payload = JSON.stringify({
      text: "hello world",
      segments: [
        {
          start: 0,
          end: 1,
          text: "hello world",
          words: [
            { word: "hello", start: 0, end: 0.4 },
            { word: "world", start: 0.4, end: 0.96 },
          ],
        },
      ],
    });
    const engine = writeTranscribingEngine(
      "kesha-engine-words-",
      ["transcribe.segments", "transcribe.words"],
      `  printf '%s\\n' '${payload}'`,
    );
    await withEngineEnv(engine, async () => {
      const out = await transcribeEngineWithSegments("audio.wav");
      expect(out.segments[0]!.words).toEqual([
        { word: "hello", start: 0, end: 0.4 },
        { word: "world", start: 0.4, end: 0.96 },
      ]);
    });
  });

  /** An engine without the capability sends no key; the parser must not invent one — a
   * `words: undefined` still counts as a column to TOON, which prints it as `words` / `null`. */
  fakeEngineTest("transcribeEngineWithSegments leaves words absent, not undefined", async () => {
    await withEngineEnv(fakeEngine(["transcribe.segments"]), async () => {
      const out = await transcribeEngineWithSegments("audio.wav");
      expect(out.segments[0]).toStrictEqual({ start: 0, end: 1, text: "ok", speaker: 0 });
    });
  });

  /** A malformed `words` is a bad enrichment, not a bad transcript: drop it, keep the text.
   * Throwing would make a garbled optional field cost the user their transcription. Each
   * of `word`/`start`/`end` is checked on its own, so each gets its own broken payload. */
  fakeEngineTest("transcribeEngineWithSegments drops malformed word timings", async () => {
    for (const words of [
      '"not-an-array"',
      '[{"word":7,"start":0,"end":1}]',
      '[{"word":"hi","start":"0","end":1}]',
      '[{"word":"hi","start":0,"end":"1"}]',
      "[{}]",
      "[null]",
    ]) {
      const payload = `{"text":"hi","segments":[{"start":0,"end":1,"text":"hi","words":${words}}]}`;
      const engine = writeTranscribingEngine(
        "kesha-engine-badwords-",
        ["transcribe.segments", "transcribe.words"],
        `  printf '%s\\n' '${payload}'`,
      );
      await withEngineEnv(engine, async () => {
        const out = await transcribeEngineWithSegments("audio.wav");
        expect(out.text).toBe("hi");
        expect(out.segments[0]).toStrictEqual({ start: 0, end: 1, text: "hi" });
      });
    }
  });

  fakeEngineTest("transcribeEngine surfaces E_ENGINE_SPAWN instead of a raw spawn exception", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-engine-not-exec-"));
    const notExecutable = join(dir, "kesha-engine");
    writeFileSync(notExecutable, "not a binary");
    chmodSync(notExecutable, 0o644);
    await withEngineEnv(notExecutable, async () => {
      const err = await failure(() => transcribeEngine("audio.wav"));
      expect(err.code).toBe("E_ENGINE_SPAWN");
      expect(err.message).toContain(notExecutable);
      expect(errorMessage(err)).toMatch(/^error \[E_ENGINE_SPAWN\]: failed to launch kesha-engine at /);
      expect(err.hint).toContain("kesha install");
    });
  });

  fakeEngineTest("recordEngine surfaces E_ENGINE_SPAWN instead of a raw spawn exception", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-engine-not-exec-record-"));
    const notExecutable = join(dir, "kesha-engine");
    writeFileSync(notExecutable, "not a binary");
    chmodSync(notExecutable, 0o644);
    await withEngineEnv(notExecutable, async () => {
      const out = join(dir, "out.wav");
      await expect(recordEngine({ out }, 10)).rejects.toThrow(/failed to launch kesha-engine at/);
      expect((await failure(() => recordEngine({ out }, 10))).code).toBe("E_ENGINE_SPAWN");
    });
  });

  /**
   * A live session that catches SIGINT/SIGTERM prints the transcript it has and
   * then exits 128+signal, so treating those two codes as a failure would put an
   * error line under a transcript that arrived intact (#962).
   */
  fakeEngineTest("recordEngine accepts a live session that stopped on a signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-engine-record-signal-"));
    const enginePath = join(dir, "kesha-engine");
    writeFileSync(enginePath, "#!/bin/sh\nexit ${KESHA_TEST_RECORD_EXIT:-0}\n");
    chmodSync(enginePath, 0o755);
    await withEngineEnv(enginePath, async () => {
      for (const code of ["130", "143"]) {
        process.env.KESHA_TEST_RECORD_EXIT = code;
        await expect(recordEngine({ live: true }, 10)).resolves.toBeUndefined();
      }
      process.env.KESHA_TEST_RECORD_EXIT = "1";
      await expect(recordEngine({ live: true }, 10)).rejects.toThrow(/exited with code 1/);
      await expect(recordEngine({ out: join(dir, "out.wav") }, 10)).rejects.toThrow(
        /exited with code 1/,
      );
    });
    delete process.env.KESHA_TEST_RECORD_EXIT;
  });

  /** A capture-to-WAV run has no signal handler, so a signalled exit really is a lost recording. */
  fakeEngineTest("recordEngine still reports a signalled capture-to-WAV run as a failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-engine-record-wav-signal-"));
    const enginePath = join(dir, "kesha-engine");
    writeFileSync(enginePath, "#!/bin/sh\nexit 130\n");
    chmodSync(enginePath, 0o755);
    await withEngineEnv(enginePath, async () => {
      await expect(recordEngine({ out: join(dir, "out.wav") }, 10)).rejects.toThrow(
        /exited with code 130/,
      );
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

  /**
   * #1002: a 51 s diarization model load read as a hang because the engine's stderr was
   * collected to EOF before any of it was forwarded, so the lines announcing the wait
   * only landed once the wait was over. The stub blocks until the caller acknowledges
   * the line and reports in its own transcript whether that happened, so the contract —
   * progress reaches the caller while the engine still works — is asserted with no
   * wall-clock comparison to go flaky.
   */
  fakeEngineTest("progress reaches the caller while the engine is still running", async () => {
    const ack = join(mkdtempSync(join(tmpdir(), "kesha-live-progress-")), "ack");
    const engine = writeTranscribingEngine(
      "kesha-engine-live-progress-",
      ["transcribe.segments"],
      `  printf '%s\\n' '{"kind":"progress","phase":"diarize","message":"loading the CoreML model on all"}' >&2
  i=0
  while [ "$i" -lt 20 ]; do
    if [ -e '${ack}' ]; then
      printf '%s\\n' '{"text":"streamed","segments":[]}'
      exit 0
    fi
    sleep 0.05
    i=$((i + 1))
  done
  printf '%s\\n' '{"text":"buffered","segments":[]}'`,
    );

    const seen: string[] = [];
    const out = await withEngineEnv(engine, () =>
      transcribeEngineWithSegments("audio.wav", {
        onProgressLine: (line) => {
          seen.push(line);
          writeFileSync(ack, "");
        },
      }),
    );

    expect(out.text).toBe("streamed");
    expect(seen).toEqual(["diarize: loading the CoreML model on all"]);
  });

  /** The other half of that contract: a failure still arrives whole through the thrown
   *  error, and the progress already shown live is not replayed inside it. */
  fakeEngineTest("a failure keeps its own report and does not repeat live progress", async () => {
    const engine = writeTranscribingEngine(
      "kesha-engine-progress-failure-",
      ["transcribe.segments"],
      `  printf '%s\\n' '{"kind":"progress","phase":"diarize","message":"loading the CoreML model on all"}' >&2
  printf '%s\\n' '{"kind":"error","code":"E_DIARIZE_TIMEOUT","message":"speaker diarization stalled while loading the model"}' >&2
  exit 1`,
    );

    const seen: string[] = [];
    const err = await withEngineEnv(engine, () =>
      failure(() =>
        transcribeEngineWithSegments("audio.wav", {
          onProgressLine: (line) => seen.push(line),
        }),
      ),
    );

    expect(seen).toEqual(["diarize: loading the CoreML model on all"]);
    expect(err.code).toBe("E_DIARIZE_TIMEOUT");
    expect(err.exitCode).toBe(1);
    expect(errorMessage(err)).toContain("error [E_DIARIZE_TIMEOUT]: speaker diarization stalled");
    expect(errorMessage(err)).not.toContain("loading the CoreML model");
  });

  fakeEngineTest("a stderr line that is not an event is E_INTERNAL quoting the line", async () => {
    const engine = writeTranscribingEngine(
      "kesha-engine-prose-",
      ["transcribe.segments"],
      `  echo 'Segmentation fault (core dumped)' >&2
  printf '%s\\n' '{"text":"ok","segments":[]}'`,
    );
    await withEngineEnv(engine, async () => {
      const err = await failure(() => transcribeEngineWithSegments("audio.wav"));
      expect(err.code).toBe("E_INTERNAL");
      expect(err.message).toContain("Segmentation fault (core dumped)");
      expect(errorMessage(err)).toMatch(/^error \[E_INTERNAL\]: kesha-engine transcribe wrote a line that is not a protocol event: "Segmentation fault \(core dumped\)"/);
    });
  });

  fakeEngineTest("a describe that also writes a non-event line is E_INTERNAL, never a cached document", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-engine-babble-"));
    const path = join(dir, "kesha-engine");
    writeFileSync(
      path,
      `#!/bin/sh
if [ "$1" = "describe" ]; then
  echo "loading models..." >&2
  printf '%s\\n' '${describeJson({ features: ["transcribe"] })}'
  exit 0
fi
exit 2
`,
    );
    chmodSync(path, 0o755);
    await withEngineEnv(path, async () => {
      const err = await failure(() => transcribeEngine("audio.wav"));
      expect(err.code).toBe("E_INTERNAL");
      expect(err.exitCode).toBeUndefined();
      expect(errorMessage(err)).toMatch(/^error \[E_INTERNAL\]: kesha-engine describe wrote a line that is not a protocol event: "loading models\.\.\."/);
      expect(await getEngineCapabilities()).toBeNull();
    });
  });

  fakeEngineTest("a newer protocol plus a stray stderr line is still E_ENGINE_PROTOCOL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-engine-newer-babble-"));
    const path = join(dir, "kesha-engine");
    writeFileSync(
      path,
      `#!/bin/sh
if [ "$1" = "describe" ]; then
  echo "ld.so: warning: cannot enable executable stack" >&2
  printf '%s\\n' '${describeJson({ protocolVersion: 5, features: ["transcribe"] })}'
  exit 0
fi
exit 2
`,
    );
    chmodSync(path, 0o755);
    await withEngineEnv(path, async () => {
      const err = await failure(() => transcribeEngine("audio.wav"));
      expect(err.code).toBe("E_ENGINE_PROTOCOL");
      expect(err.hint).toContain("bun add -g @drakulavich/kesha-voice-kit@latest");
    });
  });

  fakeEngineTest("the engine is spawned with KESHA_PROTOCOL=4 and CRLF events are accepted", async () => {
    const engine = writeTranscribingEngine(
      "kesha-engine-crlf-",
      ["transcribe.segments"],
      `  printf '{"kind":"progress","message":"proto=%s"}\\r\\n' "$KESHA_PROTOCOL" >&2
  printf '%s\\n' '{"text":"ok","segments":[]}'`,
    );
    const seen: string[] = [];
    await withEngineEnv(engine, async () => {
      await transcribeEngineWithSegments("audio.wav", { onProgressLine: (line) => seen.push(line) });
    });
    expect(seen).toEqual(["proto=4"]);
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

/**
 * `Bun.spawn` snapshots `process.env` at process start unless an `env` is passed,
 * so a value the CLI resolves at runtime — `NO_COLOR` from `--no-color`
 * (`src/cli/context.ts::applyColorEnv`), or a `KESHA_*` override — reached the
 * parent and not the engine (#874).
 */
describe("engine subprocess env", () => {
  const readStdout = async (vars: string[]) => {
    const { binPath, args } = envEchoEngine(vars);
    const proc = spawnEngineProcess(binPath, args, ["ignore", "pipe", "pipe"]);
    return (await new Response(proc.stdout as ReadableStream).text()).trim();
  };

  test("forwards env resolved after startup, not the startup snapshot", async () => {
    const restore = saveEngineEnv();
    const savedNoColor = process.env.NO_COLOR;
    try {
      process.env.KESHA_CACHE_DIR = "/tmp/kesha-env-probe-cache";
      applyColorEnv(true);
      const out = await readStdout(["KESHA_CACHE_DIR", "NO_COLOR"]);
      expect(out).toContain("KESHA_CACHE_DIR=/tmp/kesha-env-probe-cache");
      expect(out).toContain("NO_COLOR=1");
    } finally {
      restore();
      if (savedNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = savedNoColor;
    }
  });
});

describe("the engine boundary refuses to pass a malformed reply through", () => {
  function transcribingEngine(payload: string): string {
    return writeTranscribingEngine("kesha-engine-malformed-", ["transcribe.segments"], `  printf '%s\\n' '${payload}'`);
  }

  function describingEngine(payload: string, exitCode = 0): string {
    const path = join(mkdtempSync(join(tmpdir(), "kesha-engine-describe-")), "kesha-engine");
    writeFileSync(
      path,
      `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${payload}'\n  exit ${exitCode}\nfi\nexit 2\n`,
    );
    chmodSync(path, 0o755);
    return path;
  }

  for (const [shape, payload] of [
    ["no text field", '{"segments":[]}'],
    ["a non-string text", '{"text":7,"segments":[]}'],
    ["segments that are not an array", '{"text":"ok","segments":{}}'],
    ["no segments field", '{"text":"ok"}'],
    // A bare `null` has no fields to inspect; it must still read as a malformed reply
    // rather than as whatever TypeError reading through it would produce.
    ["a bare null", "null"],
  ] as const) {
    fakeEngineTest(`${shape} is rejected, with the payload named`, async () => {
      await withEngineEnv(transcribingEngine(payload), async () => {
        await expect(transcribeEngineWithSegments("audio.wav")).rejects.toThrow(
          `Invalid transcription JSON returned by kesha-engine: ${payload}`,
        );
      });
    });
  }

  for (const [field, payload] of [
    ["start", '{"text":"ok","segments":[{"start":"0","end":1,"text":"ok"}]}'],
    ["end", '{"text":"ok","segments":[{"start":0,"end":null,"text":"ok"}]}'],
    ["text", '{"text":"ok","segments":[{"start":0,"end":1,"text":7}]}'],
  ] as const) {
    fakeEngineTest(`a segment whose ${field} has the wrong type is rejected`, async () => {
      await withEngineEnv(transcribingEngine(payload), async () => {
        await expect(transcribeEngineWithSegments("audio.wav")).rejects.toThrow(
          "Invalid transcription segment returned by kesha-engine",
        );
      });
    });
  }

  // A speaker label is optional, so a bad one is dropped rather than failing the transcript.
  fakeEngineTest("a non-numeric speaker is dropped instead of forwarded", async () => {
    const payload = '{"text":"ok","segments":[{"start":0,"end":1,"text":"ok","speaker":"alice"}]}';
    await withEngineEnv(transcribingEngine(payload), async () => {
      const out = await transcribeEngineWithSegments("audio.wav");
      expect(out.segments).toEqual([{ start: 0, end: 1, text: "ok" }]);
    });
  });

  fakeEngineTest("a well-formed reply still arrives intact", async () => {
    const payload = '{"text":"ok","segments":[{"start":0,"end":1.5,"text":"ok","speaker":2}]}';
    await withEngineEnv(transcribingEngine(payload), async () => {
      expect(await transcribeEngineWithSegments("audio.wav")).toEqual({
        text: "ok",
        segments: [{ start: 0, end: 1.5, text: "ok", speaker: 2 }],
      });
    });
  });

  // #647: a non-null return means "it described itself" — callers reach straight for .features.
  for (const [shape, payload] of [
    ["a JSON array", "[]"],
    ["a JSON scalar", '"onnx"'],
    ["null", "null"],
    ["no protocolVersion", '{"backend":"onnx","profile":"linux","features":[],"commands":{}}'],
    [
      "a non-numeric protocolVersion",
      '{"protocolVersion":"4","backend":"onnx","profile":"linux","features":[],"commands":{}}',
    ],
    ["a non-string backend", '{"protocolVersion":4,"backend":3,"profile":"linux","features":[],"commands":{}}'],
    ["no profile", '{"protocolVersion":4,"backend":"onnx","features":[],"commands":{}}'],
    ["no commands", '{"protocolVersion":4,"backend":"onnx","profile":"linux","features":[]}'],
    [
      "features that are not an array",
      '{"protocolVersion":4,"backend":"onnx","profile":"linux","features":"tts","commands":{}}',
    ],
    // #928: a present-but-malformed tts is an engine that failed to describe itself, not one without TTS.
    [
      "a tts key that is not an object",
      '{"protocolVersion":4,"backend":"onnx","profile":"linux","features":[],"commands":{},"tts":"yes"}',
    ],
    [
      "tts languages that are not an array",
      '{"protocolVersion":4,"backend":"onnx","profile":"linux","features":[],"commands":{},"tts":{"languages":{}}}',
    ],
    [
      "a tts language with no engines",
      '{"protocolVersion":4,"backend":"onnx","profile":"linux","features":[],"commands":{},"tts":{"languages":[{"code":"en"}]}}',
    ],
  ] as const) {
    fakeEngineTest(`describe carrying ${shape} reads as no capabilities`, async () => {
      await withEngineEnv(describingEngine(payload), async () => {
        expect(await getEngineCapabilities()).toBeNull();
      });
    });
  }

  // The exit code is the engine's own verdict on what it just printed: a probe that failed
  // must read as no capabilities even when the bytes on stdout happen to parse.
  fakeEngineTest("capabilities printed by a failing probe are not trusted", async () => {
    await withEngineEnv(describingEngine(describeJson({ features: ["tts"] }), 3), async () => {
      expect(await getEngineCapabilities()).toBeNull();
    });
  });

  // Null, not undefined: callers branch on `caps === null` for the "could not read it" message.
  fakeEngineTest("stdout that is not JSON at all reads as no capabilities", async () => {
    await withEngineEnv(describingEngine("not json"), async () => {
      expect(await getEngineCapabilities()).toBeNull();
    });
  });

  fakeEngineTest("well-formed capabilities are returned as they came", async () => {
    await withEngineEnv(describingEngine(describeJson({ backend: "onnx", features: ["tts"] })), async () => {
      expect(await getEngineCapabilities()).toMatchObject({
        protocolVersion: 4,
        backend: "onnx",
        features: ["tts"],
      });
    });
  });

  fakeEngineTest("an advertised tts language list survives the probe", async () => {
    const payload = describeJson({
      backend: "onnx",
      features: ["tts"],
      tts: {
        languages: [
          { code: "en", engines: ["kokoro"] },
          { code: "ru", engines: ["vosk"] },
        ],
      },
    });
    await withEngineEnv(describingEngine(payload), async () => {
      const caps = await getEngineCapabilities();
      expect(caps?.tts?.languages).toEqual([
        { code: "en", engines: ["kokoro"] },
        { code: "ru", engines: ["vosk"] },
      ]);
    });
  });
});

describe("the capability probe stays in step with the installed binary", () => {
  function capsEngine(dir: string, features: string[]): string {
    const path = join(dir, "kesha-engine");
    writeFileSync(
      path,
      `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ features })}'\n  exit 0\nfi\nexit 2\n`,
    );
    chmodSync(path, 0o755);
    return path;
  }

  // #248: `kesha install` overwrites the binary in place, so the path alone cannot key the cache.
  fakeEngineTest("an in-place reinstall is not served from the cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kesha-engine-recache-"));
    await withEngineEnv(capsEngine(dir, ["transcribe.segments"]), async () => {
      expect((await getDescribe()).features).toEqual(["transcribe.segments"]);

      const path = capsEngine(dir, ["transcribe.segments", "transcribe.itn"]);
      const later = new Date(Date.now() + 2000);
      utimesSync(path, later, later);

      expect((await getDescribe()).features).toEqual(["transcribe.segments", "transcribe.itn"]);
    });
  });

  fakeEngineTest("a missing binary reads as no capabilities rather than throwing", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "kesha-engine-absent-")), "kesha-engine");
    await withEngineEnv(missing, async () => {
      expect(await getEngineCapabilities()).toBeNull();
      expect((await failure(() => getDescribe())).code).toBe("E_ENGINE_SPAWN");
    });
  });

  // Blank text has no language to detect; spending a subprocess on it would be pure latency.
  fakeEngineTest("blank text resolves null while real text still reaches the engine", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "kesha-engine-textlang-")), "kesha-engine");
    writeFileSync(
      path,
      `#!/bin/sh\nif [ "$1" = "detect-text-lang" ]; then\n  printf '%s\\n' '{"code":"ru","confidence":0.9}'\n  exit 0\nfi\nexit 2\n`,
    );
    chmodSync(path, 0o755);
    await withEngineEnv(path, async () => {
      expect(await detectTextLanguageEngine("привет")).toEqual({ code: "ru", confidence: 0.9 });
      expect(await detectTextLanguageEngine("   \n\t ")).toBeNull();
      expect(await detectTextLanguageEngine("")).toBeNull();
    });
  });
});
