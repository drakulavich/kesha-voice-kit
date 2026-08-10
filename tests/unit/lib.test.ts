import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { transcribe } from "../../src/lib";
import { writeTranscribingEngine } from "../helpers/fake-engine";
import {
  preflightTranscribeWithSegments,
  transcribe as transcribeWrapper,
  transcribeWithSegments,
} from "../../src/transcribe";

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

  it("uses canonical Bun install commands when transcription backend is missing", async () => {
    const saved = process.env.KESHA_ENGINE_BIN;
    process.env.KESHA_ENGINE_BIN = `/tmp/kesha-missing-engine-${Date.now()}`;
    try {
      let message = "";
      try {
        await transcribeWrapper("audio.wav");
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain("bun add -g @drakulavich/kesha-voice-kit");
      expect(message).toContain("kesha install");
      expect(message).not.toContain("bunx");
    } finally {
      if (saved === undefined) delete process.env.KESHA_ENGINE_BIN;
      else process.env.KESHA_ENGINE_BIN = saved;
    }
  });

  it("rejects speakers + vad:off before the engine-installed check (#768)", async () => {
    const saved = process.env.KESHA_ENGINE_BIN;
    try {
      process.env.KESHA_ENGINE_BIN = join(mkdtempSync(join(tmpdir(), "kesha-no-engine-")), "absent");
      await expect(
        preflightTranscribeWithSegments({ speakers: true, vad: "off" }),
      ).rejects.toThrow("E_INVALID_ARG");
    } finally {
      if (saved === undefined) delete process.env.KESHA_ENGINE_BIN;
      else process.env.KESHA_ENGINE_BIN = saved;
    }
  });

  fakeEngineIt("preflights timestamp support before segment transcription", async () => {
    await withEngine(fakeEngine([]), async () => {
      await expect(preflightTranscribeWithSegments({ timestamps: true })).rejects.toThrow(
        "Timestamped segments require",
      );
    });
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

  // The itn gate sits above the `timestamps || speakers` short-circuit, so it
  // has to fire on the plain-text path too — the one that otherwise reaches the
  // engine with no preflight at all (#710).
  fakeEngineIt("preflights itn support on the plain-text path", async () => {
    await withEngine(fakeEngine(["transcribe.segments"]), async () => {
      await expect(preflightTranscribeWithSegments({ itn: true })).rejects.toThrow(
        "--itn requires a newer kesha-engine",
      );
    });
  });

  fakeEngineIt("preflights itn support alongside timestamps", async () => {
    await withEngine(fakeEngine(["transcribe.segments"]), async () => {
      await expect(
        preflightTranscribeWithSegments({ timestamps: true, itn: true }),
      ).rejects.toThrow("--itn requires a newer kesha-engine");
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
