import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { transcribe } from "../../src/lib";
import { writeTranscribingEngine } from "../helpers/fake-engine";
import { transcribeWithSegments, validateTranscribeRequest } from "../../src/transcribe";
import { KeshaError } from "../../src/engine/events";

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

describe("lib API", () => {
  it("rejects missing file", async () => {
    await expect(transcribe("/nonexistent/audio.wav")).rejects.toThrow("File not found");
  });

  it("keeps transcribeWithSegments as a compatibility alias", async () => {
    const { transcribeWithSegments, transcribeWithTimestamps } = await import("../../src/lib");
    expect(transcribeWithSegments).toBe(transcribeWithTimestamps);
  });

  it("exports SayError class with code + stderr fields", async () => {
    const { SayError } = await import("../../src/lib");
    const e = new SayError("msg", 1, "stderr");
    expect(e.exitCode).toBe(1);
    expect(e.stderr).toBe("stderr");
  });

  it("exports KeshaError, and SayError extends it", async () => {
    const core = await import("../../src/lib");
    expect(core.KeshaError).toBeDefined();
    expect(new core.SayError("m", 1, "")).toBeInstanceOf(core.KeshaError);
  });

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
      process.env.KESHA_ENGINE_BIN = join(mkdtempSync(join(tmpdir(), "kesha-no-engine-")), "absent");
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

  // validateTranscribeRequest no longer checks argv, so this fires at the transcribeEngine spawn (#710).
  fakeEngineIt("preflights itn support on the plain-text path", async () => {
    await withEngine(fakeEngine(["transcribe.segments"]), async () => {
      await expect(transcribeWithSegments("audio.wav", { itn: true })).rejects.toThrow(
        "--itn needs transcribe.itn",
      );
    });
  });

  fakeEngineIt("preflights itn support alongside timestamps", async () => {
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
