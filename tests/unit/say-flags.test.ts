import { describe, expect, test } from "bun:test";
import { resolveSayFlags } from "../../src/cli/say";

function ok(input: Parameters<typeof resolveSayFlags>[0]) {
  const r = resolveSayFlags(input);
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r;
}

function err(input: Parameters<typeof resolveSayFlags>[0]): string {
  const r = resolveSayFlags(input);
  if (r.ok) throw new Error("expected an error");
  return r.error;
}

describe("resolveSayFlags: --format", () => {
  test("accepts the three wire formats", () => {
    expect(ok({ format: "wav" }).format).toBe("wav");
    expect(ok({ format: "ogg-opus" }).format).toBe("ogg-opus");
    expect(ok({ format: "flac" }).format).toBe("flac");
  });

  test("normalizes case and the opus/ogg aliases", () => {
    expect(ok({ format: "WAV" }).format).toBe("wav");
    expect(ok({ format: "opus" }).format).toBe("ogg-opus");
    expect(ok({ format: "ogg" }).format).toBe("ogg-opus");
  });

  test("omitted format stays undefined so the engine picks the default", () => {
    expect(ok({}).format).toBeUndefined();
  });

  test("rejects an unknown format", () => {
    expect(err({ format: "mp3" })).toBe("unknown --format 'mp3'. supported: wav, ogg-opus, flac");
  });
});

describe("resolveSayFlags: --rate", () => {
  test("accepts the documented 0.5–2.0 range", () => {
    expect(ok({ rate: "0.5" }).rate).toBe(0.5);
    expect(ok({ rate: "1.0" }).rate).toBe(1.0);
    expect(ok({ rate: "2.0" }).rate).toBe(2.0);
  });

  test("rejects out-of-range values", () => {
    expect(err({ rate: "0.4" })).toBe("--rate must be between 0.5 and 2.0.");
    expect(err({ rate: "2.1" })).toBe("--rate must be between 0.5 and 2.0.");
  });

  test("rejects non-numeric values", () => {
    expect(err({ rate: "fast" })).toBe("--rate must be a finite number.");
    expect(err({ rate: "Infinity" })).toBe("--rate must be a finite number.");
  });
});

// T1-3: citty hands a trailing valueless string flag back as `true`, which the ternaries discarded.
describe("resolveSayFlags: a string flag given no value", () => {
  test("names the flag that needs a value, for every string-typed flag", () => {
    expect(err({ voice: true })).toBe("--voice needs a value");
    expect(err({ lang: true })).toBe("--lang needs a value");
    expect(err({ out: true })).toBe("--out needs a value");
    expect(err({ format: true })).toBe("--format needs a value");
    expect(err({ rate: true })).toBe("--rate needs a value");
    expect(err({ bitrate: true })).toBe("--bitrate needs a value");
    expect(err({ "sample-rate": true })).toBe("--sample-rate needs a value");
  });

  test("an empty value (`--out=`) is the same usage error", () => {
    expect(err({ out: "" })).toBe("--out needs a value");
    expect(err({ voice: "" })).toBe("--voice needs a value");
    expect(err({ rate: "" })).toBe("--rate needs a value");
  });

  test("an absent flag stays absent", () => {
    expect(ok({}).out).toBeUndefined();
    expect(ok({ voice: undefined, lang: false }).voice).toBeUndefined();
    expect(ok({ voice: undefined, lang: false }).lang).toBeUndefined();
  });

  test("a value that is present still resolves", () => {
    const r = ok({ voice: "en-am_michael", lang: "en-us", out: "note.wav" });
    expect(r.voice).toBe("en-am_michael");
    expect(r.lang).toBe("en-us");
    expect(r.out).toBe("note.wav");
  });

  test("a missing value outranks a bad value elsewhere", () => {
    expect(err({ out: true, format: "mp3" })).toBe("--out needs a value");
  });
});

describe("resolveSayFlags: --bitrate and --sample-rate", () => {
  test("accepts opus encoder settings when the format resolves to opus", () => {
    const r = ok({ format: "ogg-opus", bitrate: "32000", "sample-rate": "24000" });
    expect(r.bitrate).toBe(32000);
    expect(r.sampleRate).toBe(24000);
  });

  test("rejects a non-positive or fractional bitrate", () => {
    expect(err({ format: "ogg-opus", bitrate: "0" })).toBe("--bitrate must be a positive integer.");
    expect(err({ format: "ogg-opus", bitrate: "-1" })).toBe("--bitrate must be a positive integer.");
    expect(err({ format: "ogg-opus", bitrate: "1.5" })).toBe("--bitrate must be a positive integer.");
  });

  // T1-5: `--bitrate 1` parsed fine here and became E_INTERNAL exit 4 after two seconds of synthesis.
  test("rejects a bitrate outside the documented Opus range, naming the bounds", () => {
    const expected = "--bitrate must be between 6000 and 510000 bps.";
    expect(err({ format: "ogg-opus", bitrate: "1" })).toBe(expected);
    expect(err({ format: "ogg-opus", bitrate: "5999" })).toBe(expected);
    expect(err({ format: "ogg-opus", bitrate: "510001" })).toBe(expected);
    expect(ok({ format: "ogg-opus", bitrate: "6000" }).bitrate).toBe(6000);
    expect(ok({ format: "ogg-opus", bitrate: "510000" }).bitrate).toBe(510000);
  });

  test("rejects an unsupported sample rate", () => {
    expect(err({ format: "ogg-opus", "sample-rate": "44100" })).toBe(
      "--sample-rate must be one of 8000, 12000, 16000, 24000, 48000.",
    );
  });

  test("rejects opus-only flags on lossless formats", () => {
    const expected = "--bitrate and --sample-rate are only valid with --format ogg-opus";
    expect(err({ format: "wav", bitrate: "32000" })).toBe(expected);
    expect(err({ format: "flac", "sample-rate": "24000" })).toBe(expected);
    expect(err({ bitrate: "32000" })).toBe(expected);
  });

  test("infers opus from the --out extension when --format is omitted", () => {
    expect(ok({ out: "note.ogg", bitrate: "32000" }).bitrate).toBe(32000);
    expect(ok({ out: "note.opus", bitrate: "32000" }).bitrate).toBe(32000);
    expect(ok({ out: "note.OGA", bitrate: "32000" }).bitrate).toBe(32000);
    expect(err({ out: "note.wav", bitrate: "32000" })).toBe(
      "--bitrate and --sample-rate are only valid with --format ogg-opus",
    );
  });
});

describe("resolveSayFlags: validation order", () => {
  test("an unknown format is reported before a bad rate", () => {
    expect(err({ format: "mp3", rate: "9" })).toContain("unknown --format");
  });

  test("a bad rate is reported before a bad bitrate", () => {
    expect(err({ rate: "9", bitrate: "0" })).toContain("--rate");
  });

  test("a bad bitrate value is reported before the opus-only mismatch", () => {
    expect(err({ format: "wav", bitrate: "0" })).toBe("--bitrate must be a positive integer.");
  });
});
