import { describe, expect, test } from "bun:test";
import {
  engineFailure,
  exitCodeFor,
  KeshaError,
  parseEventLine,
  readEvents,
  renderError,
  renderEvent,
  setEngineDebugSink,
  type DebugEvent,
} from "../../src/engine/events";
import { errorMessage } from "../../src/error-utils";

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new Response(text).body!;
}

describe("parseEventLine", () => {
  test("accepts each published kind", () => {
    expect(parseEventLine('{"kind":"progress","phase":"diarize","message":"loading"}')).toEqual({
      ok: true,
      event: { kind: "progress", phase: "diarize", message: "loading" },
    });
    expect(parseEventLine('{"kind":"warn","code":"W_VAD_NO_SPEECH","message":"no speech"}')).toEqual({
      ok: true,
      event: { kind: "warn", code: "W_VAD_NO_SPEECH", message: "no speech" },
    });
    expect(
      parseEventLine('{"kind":"error","code":"E_MODEL_MISSING","message":"no model","hint":"kesha install --tts"}'),
    ).toEqual({
      ok: true,
      event: { kind: "error", code: "E_MODEL_MISSING", message: "no model", hint: "kesha install --tts" },
    });
    expect(parseEventLine('{"kind":"debug","t_ms":12,"message":"tts::say","fields":{"chars":2}}')).toEqual({
      ok: true,
      event: { kind: "debug", t_ms: 12, message: "tts::say", fields: { chars: 2 } },
    });
  });

  test("a progress pct is a whole number, present or absent, never anything else", () => {
    expect(parseEventLine('{"kind":"progress","phase":"download","message":"GET model.onnx","pct":12}')).toStrictEqual({
      ok: true,
      event: { kind: "progress", phase: "download", message: "GET model.onnx", pct: 12 },
    });
    expect(parseEventLine('{"kind":"progress","message":"GET model.onnx","pct":0}')).toStrictEqual({
      ok: true,
      event: { kind: "progress", message: "GET model.onnx", pct: 0 },
    });
    expect(parseEventLine('{"kind":"progress","phase":"download","message":"GET model.onnx"}')).toStrictEqual({
      ok: true,
      event: { kind: "progress", phase: "download", message: "GET model.onnx" },
    });
    for (const line of [
      '{"kind":"progress","message":"GET model.onnx","pct":"12"}',
      '{"kind":"progress","message":"GET model.onnx","pct":null}',
      '{"kind":"progress","message":"GET model.onnx","pct":12.5}',
      '{"kind":"progress","message":"GET model.onnx","pct":99.9}',
    ]) {
      expect(parseEventLine(line)).toEqual({ ok: false, raw: line });
    }
  });

  test("rejects prose, arrays, unknown kinds and a missing code", () => {
    for (const line of [
      "error [E_INTERNAL]: prose from an old engine",
      "[]",
      '{"kind":"shout","message":"x"}',
      '{"kind":"error","message":"no code"}',
      '{"kind":"progress"}',
      "",
    ]) {
      expect(parseEventLine(line)).toEqual({ ok: false, raw: line });
    }
  });
});

describe("rendering", () => {
  test("matches the protocol 3 lines byte for byte", () => {
    expect(renderEvent({ kind: "progress", phase: "diarize", message: "loading the CoreML model" })).toBe(
      "diarize: loading the CoreML model",
    );
    expect(renderEvent({ kind: "progress", message: "Downloading" })).toBe("Downloading");
    expect(renderEvent({ kind: "warn", code: "W_GENERIC", message: "warning: careful" })).toBe("warning: careful");
    expect(renderEvent({ kind: "error", code: "E_BAD_AUDIO", message: "cannot decode" })).toBe(
      "error [E_BAD_AUDIO]: cannot decode",
    );
    expect(renderEvent({ kind: "debug", t_ms: 7, message: "x" })).toBe("[debug/engine +7ms] x");
  });

  test("a pct lands in parentheses after the message", () => {
    expect(renderEvent({ kind: "progress", phase: "download", message: "GET model.onnx", pct: 12 })).toBe(
      "download: GET model.onnx (12%)",
    );
    expect(renderEvent({ kind: "progress", message: "GET model.onnx", pct: 100 })).toBe("GET model.onnx (100%)");
  });

  test("a hint lands on its own indented line", () => {
    expect(renderError({ code: "E_MODEL_MISSING", message: "no voice", hint: "kesha install --tts" })).toBe(
      "error [E_MODEL_MISSING]: no voice\n  hint: kesha install --tts",
    );
  });
});

describe("KeshaError", () => {
  test("carries code, hint, exit code and stderr, and keeps a bare message", () => {
    const err = new KeshaError("E_ENGINE_SPAWN", "failed to launch", {
      hint: "kesha install",
      exitCode: 1,
      stderr: "",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("KeshaError");
    expect(err.message).toBe("failed to launch");
    expect(err.code).toBe("E_ENGINE_SPAWN");
    expect(err.hint).toBe("kesha install");
    expect(err.exitCode).toBe(1);
    expect(errorMessage(err)).toBe("error [E_ENGINE_SPAWN]: failed to launch\n  hint: kesha install");
  });

  test("renders the engine's whole stderr transcript when it has one", () => {
    const transcript = "diarize: loading\nerror [E_DIARIZE_TIMEOUT]: stalled";
    const err = new KeshaError("E_DIARIZE_TIMEOUT", "stalled", { exitCode: 1, stderr: transcript });
    expect(errorMessage(err)).toBe(transcript);
    expect(errorMessage(new Error("plain"))).toBe("plain");
  });
});

describe("readEvents", () => {
  test("hands progress to the sink as it arrives and keeps the rest as rendered text", async () => {
    const seen: string[] = [];
    const out = await readEvents(
      streamOf(
        '{"kind":"progress","phase":"diarize","message":"loading"}\r\n' +
          '{"kind":"warn","code":"W_VAD_NO_SPEECH","message":"no speech found"}\n' +
          '{"kind":"error","code":"E_TRANSCRIBE_FAILED","message":"boom","hint":"retry"}\n',
      ),
      { onProgress: (line) => seen.push(line) },
    );
    expect(seen).toEqual(["diarize: loading"]);
    expect(out.stderr).toBe("no speech found\nerror [E_TRANSCRIBE_FAILED]: boom\n  hint: retry\n");
    expect(out.error).toEqual({ kind: "error", code: "E_TRANSCRIBE_FAILED", message: "boom", hint: "retry" });
    expect(out.invalid).toEqual([]);
  });

  test("without a progress sink, progress stays in the transcript", async () => {
    const out = await readEvents(streamOf('{"kind":"progress","message":"Warming"}\n'));
    expect(out.stderr).toBe("Warming\n");
  });

  test("quotes a line that is not an event and keeps it in the transcript", async () => {
    const out = await readEvents(streamOf('{"kind":"progress","message":"ok"}\nsegfault at 0x0\n'));
    expect(out.invalid).toEqual(["segfault at 0x0"]);
    expect(out.stderr).toBe("ok\nsegfault at 0x0\n");
  });

  test("routes debug events to the installed sink and never into the transcript", async () => {
    const debug: DebugEvent[] = [];
    setEngineDebugSink((event) => debug.push(event));
    try {
      const out = await readEvents(streamOf('{"kind":"debug","t_ms":3,"message":"format::resolved"}\n'));
      expect(out.stderr).toBe("");
      expect(debug).toEqual([{ kind: "debug", t_ms: 3, message: "format::resolved" }]);
    } finally {
      setEngineDebugSink(null);
    }
  });

  test("the last error event wins, and a blank line after it survives into stderr", async () => {
    const out = await readEvents(
      streamOf('{"kind":"error","code":"E_A","message":"1"}\n{"kind":"error","code":"E_B","message":"2"}\n\n'),
    );
    expect(out.error?.code).toBe("E_B");
    expect(out.invalid).toEqual([]);
    expect(out.stderr).toBe("error [E_A]: 1\nerror [E_B]: 2\n\n");
  });

  test("an interior blank line separates an error render from a following prose paragraph", async () => {
    const out = await readEvents(
      streamOf('{"kind":"error","code":"E_A","message":"1"}\n\nsecond paragraph\n'),
    );
    expect(out.stderr).toBe("error [E_A]: 1\n\nsecond paragraph\n");
    expect(out.invalid).toEqual(["second paragraph"]);
  });
});

describe("KeshaError.render() keeps the transcript without letting it hide the code", () => {
  test("the coded line comes first when the transcript does not carry it", () => {
    const transcript = "warning: slow disk\nthread 'main' panicked at src/tts/kokoro.rs:88";
    const err = new KeshaError("E_INTERNAL", "kesha-engine transcribe exited with code 101", { exitCode: 101, stderr: transcript });
    expect(errorMessage(err)).toBe(`error [E_INTERNAL]: kesha-engine transcribe exited with code 101\n${transcript}`);
  });
});

describe("KeshaError.render() only trusts a transcript that renders this very error", () => {
  test("a legacy line with the same code but another message does not hide the diagnosis", () => {
    const err = new KeshaError("E_INTERNAL", 'kesha-engine say wrote a line that is not a protocol event: "error [E_INTERNAL]: kokoro session init failed"', {
      exitCode: 1,
      stderr: "error [E_INTERNAL]: kokoro session init failed",
    });
    expect(errorMessage(err)).toBe(
      'error [E_INTERNAL]: kesha-engine say wrote a line that is not a protocol event: "error [E_INTERNAL]: kokoro session init failed"\nerror [E_INTERNAL]: kokoro session init failed',
    );
  });
});

describe("engineFailure() is the one way a run becomes a KeshaError", () => {
  const clean = { stderr: "", error: null, invalid: [] };

  test("a non-event line is E_INTERNAL quoting it, with the run's status and transcript", () => {
    const err = engineFailure("say", { stderr: "loading\n", error: null, invalid: ["loading"] }, 0);
    expect(err.code).toBe("E_INTERNAL");
    expect(err.message).toBe('kesha-engine say wrote a line that is not a protocol event: "loading"');
    expect(err.exitCode).toBe(0);
    expect(err.stderr).toBe("loading");
  });

  test("an error event carries its code, message and hint", () => {
    const outcome = { stderr: "error [E_VOICE_UNKNOWN]: no such voice: xx\n  hint: kesha say --list-voices\n", error: { kind: "error" as const, code: "E_VOICE_UNKNOWN", message: "no such voice: xx", hint: "kesha say --list-voices" }, invalid: [] };
    const err = engineFailure("say", outcome, 1);
    expect(err.code).toBe("E_VOICE_UNKNOWN");
    expect(err.hint).toBe("kesha say --list-voices");
    expect(err.exitCode).toBe(1);
    expect(errorMessage(err)).toBe("error [E_VOICE_UNKNOWN]: no such voice: xx\n  hint: kesha say --list-voices");
  });

  test("a silent non-zero exit names the command and the code; a caller may substitute the transcript", () => {
    const err = engineFailure("transcribe", clean, 137, "killed by SIGKILL");
    expect(err.code).toBe("E_INTERNAL");
    expect(err.message).toBe("kesha-engine transcribe exited with code 137");
    expect(errorMessage(err)).toBe("error [E_INTERNAL]: kesha-engine transcribe exited with code 137\nkilled by SIGKILL");
  });

  test("with no exit code of its own the error leaves exitCode unset", () => {
    const err = engineFailure("describe", { stderr: "noise\n", error: null, invalid: ["noise"] }, undefined);
    expect(err.exitCode).toBeUndefined();
  });
});

describe("origin says who raised the error", () => {
  const silent = { stderr: "", error: null, invalid: [] };

  test("engineFailure() is the engine's, a bare KeshaError is the CLI's", () => {
    expect(engineFailure("say", silent, 1).origin).toBe("engine");
    expect(new KeshaError("E_INVALID_ARG", "x").origin).toBe("cli");
  });
});

describe("exitCodeFor() is the one rule behind every kesha say exit status", () => {
  const silent = { stderr: "", error: null, invalid: [] };
  const noise = { stderr: "loading\n", error: null, invalid: ["loading"] };

  test("an engine that ran and failed exits with its own status", () => {
    expect(exitCodeFor(engineFailure("say", silent, 3))).toBe(3);
  });

  test("an engine that broke the protocol on a clean exit is 4, never 0", () => {
    expect(exitCodeFor(engineFailure("say", noise, 0))).toBe(4);
    expect(exitCodeFor(engineFailure("describe", noise, undefined))).toBe(4);
  });

  test("a CLI-side code maps through the documented table", () => {
    expect(exitCodeFor(new KeshaError("E_INVALID_ARG", "x"))).toBe(2);
    expect(exitCodeFor(new KeshaError("E_TEXT_EMPTY", "x"))).toBe(2);
    expect(exitCodeFor(new KeshaError("E_TEXT_TOO_LONG", "x"))).toBe(5);
    expect(exitCodeFor(new KeshaError("E_INTERNAL", "x"))).toBe(4);
    expect(exitCodeFor(new KeshaError("E_ENGINE_PROTOCOL", "x"))).toBe(1);
    expect(exitCodeFor(new KeshaError("E_ENGINE_SPAWN", "x"))).toBe(1);
    expect(exitCodeFor(new KeshaError("E_SOMETHING_NEW", "x"))).toBe(1);
  });

  test("an explicit exitCode on a CLI-side error wins over the table", () => {
    expect(exitCodeFor(new KeshaError("E_INVALID_ARG", "x", { exitCode: 7 }))).toBe(7);
  });

  test("anything that is not a KeshaError is the uncoded 4", () => {
    expect(exitCodeFor(new Error("boom"))).toBe(4);
    expect(exitCodeFor("boom")).toBe(4);
  });
});
