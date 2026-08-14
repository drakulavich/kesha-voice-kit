import { describe, expect, test } from "bun:test";
import { resolveRecordArgs } from "../../src/cli/record";

describe("record live auto-stop", () => {
  test("is an explicit opt-in with configurable endpointing", () => {
    expect(
      resolveRecordArgs({
        live: true,
        "auto-stop": true,
        "auto-stop-silence-ms": "800",
        "auto-stop-threshold": "0.4",
        "auto-stop-min-speech-ms": "300",
      }),
    ).toEqual({
      ok: true,
      target: {
        live: true,
        autoStop: { silenceMs: 800, threshold: 0.4, minSpeechMs: 300 },
      },
      maxSeconds: 120,
    });
  });

  test("rejects endpointing settings outside opt-in live recording", () => {
    expect(resolveRecordArgs({ out: "mic.wav", "auto-stop": true })).toEqual({
      ok: false,
      error: "--auto-stop requires --live.",
    });
    expect(resolveRecordArgs({ live: true, "auto-stop-threshold": "0.4" })).toEqual({
      ok: false,
      error: "auto-stop settings require --auto-stop.",
    });
  });
});
