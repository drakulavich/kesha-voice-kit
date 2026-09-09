import { describe, it, expect, spyOn } from "bun:test";
import { chmodSync, writeFileSync } from "fs";
import { join } from "path";
import { buildSayArgs, engineCrashMessage, say, SayError, type SayOptions } from "../../src/synth";
import { validateArgv } from "../../src/engine/describe";
import { KeshaError } from "../../src/engine/events";
import { describeDocument, describeJson, saveEngineEnv } from "../helpers/fake-engine";
import { errorMessage } from "../../src/error-utils";
import { tempDir } from "../helpers/temp-dir";

describe("SayOptions type contract", () => {
  const oggOpusOptions: SayOptions = {
    format: "ogg-opus",
    bitrate: 32_000,
    sampleRate: 24_000,
  };
  const wavOptions: SayOptions = { format: "wav" };

  // @ts-expect-error bitrate is only valid with format: "ogg-opus"
  const wavWithBitrate: SayOptions = {
    format: "wav",
    bitrate: 64_000,
  };
  const flacWithSampleRate: SayOptions = {
    format: "flac",
    // @ts-expect-error sampleRate is only valid with format: "ogg-opus"
    sampleRate: 24_000,
  };
  // @ts-expect-error bitrate requires an explicit format: "ogg-opus"
  const defaultFormatWithBitrate: SayOptions = {
    bitrate: 64_000,
  };
  const opusWithUnsupportedSampleRate: SayOptions = {
    format: "ogg-opus",
    // @ts-expect-error 44100 is not an Opus sample rate supported by kesha-engine
    sampleRate: 44_100,
  };

  void oggOpusOptions;
  void wavOptions;
  void wavWithBitrate;
  void flacWithSampleRate;
  void defaultFormatWithBitrate;
  void opusWithUnsupportedSampleRate;
});

describe("buildSayArgs", () => {
  it("starts with the 'say' subcommand", () => {
    expect(buildSayArgs({})[0]).toBe("say");
  });

  it("appends text as a trailing positional", () => {
    expect(buildSayArgs({ text: "Hello" })).toContain("Hello");
  });

  it("omits empty/undefined text (caller will pipe via stdin)", () => {
    expect(buildSayArgs({ text: "" })).toEqual(["say"]);
    expect(buildSayArgs({})).toEqual(["say"]);
  });

  it("passes --voice when given", () => {
    expect(buildSayArgs({ text: "Hi", voice: "en-am_michael" })).toEqual(
      expect.arrayContaining(["--voice", "en-am_michael"]),
    );
  });

  it("passes --lang when given", () => {
    expect(buildSayArgs({ text: "Hi", lang: "en-gb" })).toEqual(
      expect.arrayContaining(["--lang", "en-gb"]),
    );
  });

  it("passes --out when given", () => {
    expect(buildSayArgs({ text: "Hi", out: "reply.wav" })).toEqual(
      expect.arrayContaining(["--out", "reply.wav"]),
    );
  });

  it("omits --rate when default (1.0)", () => {
    expect(buildSayArgs({ text: "Hi", rate: 1.0 })).not.toContain("--rate");
  });

  it("includes --rate when non-default", () => {
    expect(buildSayArgs({ text: "Hi", rate: 1.25 })).toEqual(
      expect.arrayContaining(["--rate", "1.25"]),
    );
  });

  it("omits --ssml when false or undefined", () => {
    expect(buildSayArgs({ text: "hi" })).not.toContain("--ssml");
    expect(buildSayArgs({ text: "hi", ssml: false })).not.toContain("--ssml");
  });

  it("includes --ssml when true", () => {
    const args = buildSayArgs({ text: "<speak>hi</speak>", ssml: true });
    expect(args).toContain("--ssml");
  });
});

describe("--no-expand-abbrev", () => {
  const baseOpts = { voice: "ru-vosk-m02", out: "/tmp/x.wav", text: "ВОЗ" };

  it("is not present by default", () => {
    expect(buildSayArgs({ ...baseOpts, noExpandAbbrev: false })).not.toContain("--no-expand-abbrev");
  });

  it("is built whenever asked for; the describe document decides whether it is sent", () => {
    const argv = buildSayArgs({ ...baseOpts, noExpandAbbrev: true });
    expect(argv).toContain("--no-expand-abbrev");
    const expands = describeDocument({ features: ["tts", "tts.ru_acronym_expansion"] });
    expect(validateArgv(argv, expands)).toEqual({ argv, warnings: [] });
    const cannot = describeDocument({ features: ["tts"] });
    const out = validateArgv(argv, cannot);
    expect(out.argv).not.toContain("--no-expand-abbrev");
    expect(out.warnings[0]).toContain("--no-expand-abbrev");
    expect(out.warnings[0]).toContain("ignored");
  });
});

describe("say on protocol 4", () => {
  const posixIt = process.platform === "win32" ? it.skip : it;

  function sayEngine(body: string): string {
    const path = join(tempDir("kesha-say-v4-"), "kesha-engine");
    writeFileSync(
      path,
      `#!/bin/sh\nif [ "$1" = "describe" ]; then\n  printf '%s\\n' '${describeJson({ features: ["tts"] })}'\n  exit 0\nfi\nif [ "$1" = "say" ]; then\n${body}\nfi\nexit 2\n`,
    );
    chmodSync(path, 0o755);
    return path;
  }

  posixIt("carries the engine's error code and hint on a SayError", async () => {
    const engine = sayEngine(
      `  printf '%s\\n' '{"kind":"error","code":"E_VOICE_UNKNOWN","message":"no such voice: xx","hint":"kesha say --list-voices"}' >&2\n  exit 1`,
    );
    const restore = saveEngineEnv();
    process.env.KESHA_ENGINE_BIN = engine;
    try {
      const err = await say({ text: "hi", voice: "xx" }).then(() => null, (e: unknown) => e as SayError);
      expect(err).toBeInstanceOf(SayError);
      expect(err).toBeInstanceOf(KeshaError);
      expect(err!.code).toBe("E_VOICE_UNKNOWN");
      expect(err!.hint).toBe("kesha say --list-voices");
      expect(err!.exitCode).toBe(1);
      expect(err!.stderr).toContain("error [E_VOICE_UNKNOWN]: no such voice: xx");
      expect(err!.origin).toBe("engine");
    } finally {
      restore();
    }
  });

  posixIt("a non-event stderr line renders as E_INTERNAL, not as the raw line", async () => {
    const engine = sayEngine(`  echo "loading voice pack..." >&2
  printf 'RIFF'
  exit 0`);
    const restore = saveEngineEnv();
    process.env.KESHA_ENGINE_BIN = engine;
    try {
      const err = await say({ text: "hi" }).then(() => null, (e: unknown) => e as SayError);
      expect(err).toBeInstanceOf(SayError);
      expect(err!.code).toBe("E_INTERNAL");
      expect(err!.exitCode).toBe(4);
      expect(errorMessage(err)).toMatch(/^error \[E_INTERNAL\]: kesha-engine say wrote a line that is not a protocol event: "loading voice pack\.\.\."/);
    } finally {
      restore();
    }
  });

  posixIt("a panic before a signal death keeps the crash explanation after the coded line", async () => {
    const engine = sayEngine(`  echo "thread 'main' panicked at src/tts/kokoro.rs:88" >&2
  exit 134`);
    const restore = saveEngineEnv();
    process.env.KESHA_ENGINE_BIN = engine;
    try {
      const err = await say({ text: "hi" }).then(() => null, (e: unknown) => e as SayError);
      expect(err!.code).toBe("E_INTERNAL");
      const rendered = errorMessage(err);
      expect(rendered).toMatch(/^error \[E_INTERNAL\]: kesha-engine say wrote a line that is not a protocol event: "thread 'main' panicked/);
      expect(rendered).toContain("kesha-engine was killed by SIGABRT and produced no audio");
    } finally {
      restore();
    }
  });

  posixIt("a signal death with no event renders one coded line and the crash explanation", async () => {
    const engine = sayEngine(`  printf '%s\\n' '{"kind":"warn","code":"W_GENERIC","message":"warning: slow"}' >&2
  exit 134`);
    const restore = saveEngineEnv();
    process.env.KESHA_ENGINE_BIN = engine;
    try {
      const err = await say({ text: "hi" }).then(() => null, (e: unknown) => e as SayError);
      expect(err!.code).toBe("E_INTERNAL");
      expect(err!.exitCode).toBe(134);
      const rendered = errorMessage(err);
      expect(rendered).toMatch(/^error \[E_INTERNAL\]: kesha-engine say exited with code 134\nwarning: slow\n/);
      expect(rendered).toContain("killed by SIGABRT");
      expect(rendered.match(/error \[/g)).toHaveLength(1);
    } finally {
      restore();
    }
  });

  posixIt("an error event fails the run even though the engine exits 0 with audio bytes", async () => {
    const engine = sayEngine(
      `  printf '%s\\n' '{"kind":"error","code":"E_VOICE_UNKNOWN","message":"no such voice: xx"}' >&2\n  printf 'RIFF'\n  exit 0`,
    );
    const restore = saveEngineEnv();
    process.env.KESHA_ENGINE_BIN = engine;
    try {
      const err = await say({ text: "hi", voice: "xx" }).then(() => null, (e: unknown) => e as SayError);
      expect(err).toBeInstanceOf(SayError);
      expect(err!.code).toBe("E_VOICE_UNKNOWN");
      expect(err!.exitCode).toBe(4);
      expect(err!.stderr).toContain("error [E_VOICE_UNKNOWN]: no such voice: xx");
      expect(err!.origin).toBe("engine");
    } finally {
      restore();
    }
  });

  posixIt("returns the audio and is spawned with KESHA_PROTOCOL=4", async () => {
    const engine = sayEngine(`  printf '{"kind":"progress","message":"proto=%s"}\\n' "$KESHA_PROTOCOL" >&2\n  printf 'RIFF'\n  exit 0`);
    const restore = saveEngineEnv();
    process.env.KESHA_ENGINE_BIN = engine;
    const written: string[] = [];
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk) => (written.push(String(chunk)), true));
    try {
      const audio = await say({ text: "hi" });
      expect(new TextDecoder().decode(audio)).toBe("RIFF");
    } finally {
      stderrSpy.mockRestore();
      restore();
    }
    expect(written.join("")).toContain("proto=4");
  });
});

describe("say input preflight", () => {
  it("rejects empty text before checking the engine", async () => {
    try {
      await say({ text: "" });
      throw new Error("expected say() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(SayError);
      expect((err as SayError).exitCode).toBe(2);
      expect((err as Error).message).toBe("text is empty");
      expect((err as SayError).origin).toBe("cli");
    }
  });
});

describe("engineCrashMessage", () => {
  it("says nothing for an ordinary non-zero exit", () => {
    expect(engineCrashMessage(1, null)).toBeNull();
    expect(engineCrashMessage(2, null)).toBeNull();
  });

  it("names the signal that killed the engine", () => {
    expect(engineCrashMessage(139, "SIGSEGV", "darwin")).toContain("SIGSEGV");
    expect(engineCrashMessage(134, "SIGABRT", "darwin")).toContain("SIGABRT");
  });

  it("derives the signal from the exit code when Bun reports none", () => {
    expect(engineCrashMessage(139, null, "darwin")).toContain("SIGSEGV");
  });

  // Bun names signal 10 SIGUSR1 — its linux value — even on darwin, where the
  // engine's exit 138 means SIGBUS. The wait status wins.
  it("does not repeat Bun's linux signal name on darwin", () => {
    const msg = engineCrashMessage(138, "SIGUSR1", "darwin");
    expect(msg).toContain("SIGBUS");
    expect(msg).not.toContain("SIGUSR1");
  });

  it("uses each platform's own SIGBUS number", () => {
    expect(engineCrashMessage(135, null, "linux")).toContain("SIGBUS");
    expect(engineCrashMessage(138, null, "darwin")).toContain("SIGBUS");
  });

  it("explains the ANE-less CoreML crash for a darwin SIGBUS (#742)", () => {
    const msg = engineCrashMessage(138, "SIGBUS", "darwin");
    expect(msg).toContain("Neural Engine");
    expect(msg).toContain("742");
  });

  it("keeps the CoreML explanation off non-darwin platforms", () => {
    const msg = engineCrashMessage(135, null, "linux");
    expect(msg).toContain("SIGBUS");
    expect(msg).not.toContain("Neural Engine");
  });
});
