import { describe, expect, test } from "bun:test";
import {
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
