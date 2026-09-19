import { describe, expect, test } from "bun:test";
import {
  describeToCapabilities,
  parseDescribe,
  protocolMismatch,
  validateArgv,
  type DescribeDocument,
} from "../../src/engine/describe";
import { KeshaError } from "../../src/engine/events";

const DOC: DescribeDocument = {
  protocolVersion: 4,
  backend: "onnx",
  profile: "linux",
  features: ["transcribe", "transcribe.itn", "tts", "tts.prosody_rate", "record.live"],
  commands: {
    transcribe: {
      flags: {
        json: { gate: null },
        vad: { gate: null, conflicts: ["no-vad"] },
        "no-vad": { gate: null, conflicts: ["vad"] },
        speakers: { gate: "transcribe.diarize", requires: ["json"], conflicts: ["no-vad"] },
        itn: { gate: "transcribe.itn" },
      },
    },
    record: {
      flags: {
        live: { gate: "record.live" },
        "auto-stop": { gate: "record.live.auto-stop", requires: ["live"] },
        "max-seconds": { gate: null },
      },
    },
    say: {
      flags: {
        voice: { gate: "tts" },
        rate: { gate: "tts.prosody_rate" },
        "no-expand-abbrev": {
          gate: ["tts.ru_acronym_expansion", "tts.en_acronym_expansion"],
          whenUngated: "drop",
        },
      },
    },
    describe: { flags: {} },
  },
  tts: { languages: [{ code: "en", engines: ["kokoro"] }] },
};

function failure(fn: () => unknown): KeshaError {
  try {
    fn();
  } catch (err) {
    if (err instanceof KeshaError) return err;
    throw err;
  }
  throw new Error("expected validateArgv to throw");
}

describe("validateArgv", () => {
  test("a valid argv reaches the engine unchanged", () => {
    const argv = ["transcribe", "audio.wav", "--json", "--vad", "--itn"];
    expect(validateArgv(argv, DOC)).toEqual({ argv, warnings: [] });
  });

  test("a flag the schema does not list is E_INVALID_ARG with no subprocess", () => {
    const err = failure(() => validateArgv(["transcribe", "a.wav", "--diarize"], DOC));
    expect(err.code).toBe("E_INVALID_ARG");
    expect(err.message).toContain("--diarize");
    expect(err.message).toContain("transcribe");
  });

  test("a flag whose gate the build lacks is E_INVALID_ARG naming the feature and the build", () => {
    const err = failure(() => validateArgv(["transcribe", "a.wav", "--json", "--speakers"], DOC));
    expect(err.code).toBe("E_INVALID_ARG");
    expect(err.message).toContain("--speakers");
    expect(err.message).toContain("transcribe.diarize");
    expect(err.message).toContain("onnx");
    expect(err.hint).toContain("darwin-arm64");
  });

  test("--itn on an engine without the pass says how to upgrade", () => {
    const stale = { ...DOC, features: ["transcribe"] };
    const err = failure(() => validateArgv(["transcribe", "a.wav", "--itn"], stale));
    expect(err.code).toBe("E_INVALID_ARG");
    expect(err.hint).toContain("bun add -g @drakulavich/kesha-voice-kit@latest");
    expect(err.hint).toContain("kesha install");
  });

  test("requires and conflicts are enforced by name", () => {
    const withDiarize = { ...DOC, features: [...DOC.features, "transcribe.diarize"] };
    expect(failure(() => validateArgv(["transcribe", "a.wav", "--speakers"], withDiarize)).message).toContain(
      "--speakers requires --json",
    );
    expect(
      failure(() => validateArgv(["transcribe", "a.wav", "--json", "--speakers", "--no-vad"], withDiarize)).message,
    ).toContain("--speakers cannot be combined with --no-vad");
    expect(failure(() => validateArgv(["transcribe", "a.wav", "--vad", "--no-vad"], DOC)).message).toContain(
      "--vad cannot be combined with --no-vad",
    );
    expect(failure(() => validateArgv(["record", "--auto-stop"], DOC)).code).toBe("E_INVALID_ARG");
  });

  test("a conflict with a documented remedy carries it as a hint (#768)", () => {
    const withDiarize = { ...DOC, features: [...DOC.features, "transcribe.diarize"] };
    const err = failure(() =>
      validateArgv(["transcribe", "a.wav", "--json", "--speakers", "--no-vad"], withDiarize),
    );
    expect(err.hint).toContain("VAD engages automatically");
  });

  test("a gate hint names its remedy (record --auto-stop)", () => {
    const err = failure(() => validateArgv(["record", "--live", "--auto-stop"], DOC));
    expect(err.code).toBe("E_INVALID_ARG");
    expect(err.message).toContain("record.live.auto-stop");
    expect(err.hint).toContain("kesha install");
  });

  test("an unlisted conflict pair carries no hint", () => {
    const err = failure(() => validateArgv(["transcribe", "a.wav", "--vad", "--no-vad"], DOC));
    expect(err.hint).toBeUndefined();
  });

  test("a whenUngated: drop flag is omitted with one warning and the command proceeds", () => {
    const out = validateArgv(["say", "--voice", "en-am_michael", "--no-expand-abbrev", "hello"], DOC);
    expect(out.argv).toEqual(["say", "--voice", "en-am_michael", "hello"]);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain("--no-expand-abbrev");
    expect(out.warnings[0]).toContain("ignored");
  });

  test("an any-of gate passes when one member is present", () => {
    const doc = { ...DOC, features: [...DOC.features, "tts.en_acronym_expansion"] };
    expect(validateArgv(["say", "--no-expand-abbrev", "hi"], doc).argv).toContain("--no-expand-abbrev");
  });

  test("flag values, --flag=value and everything after -- are not flags", () => {
    expect(validateArgv(["say", "--voice=en-am_michael", "--rate", "1.2", "--", "--not-a-flag"], DOC).argv).toEqual([
      "say",
      "--voice=en-am_michael",
      "--rate",
      "1.2",
      "--",
      "--not-a-flag",
    ]);
  });

  test("an unknown subcommand is E_INVALID_ARG", () => {
    expect(failure(() => validateArgv(["shout", "--loud"], DOC)).message).toContain("shout");
  });
});

describe("parseDescribe", () => {
  test("rebuilds a well-formed document field by field", () => {
    const parsed = parseDescribe(JSON.parse(JSON.stringify({ ...DOC, errors: [], warnings: [] })));
    expect(parsed).toEqual(DOC);
  });

  for (const [shape, payload] of [
    ["an array", []],
    ["a scalar", "onnx"],
    ["no protocolVersion", { backend: "onnx", profile: "linux", features: [], commands: {} }],
    ["no profile", { protocolVersion: 4, backend: "onnx", features: [], commands: {} }],
    ["no commands", { protocolVersion: 4, backend: "onnx", profile: "linux", features: [] }],
    ["a command without flags", { protocolVersion: 4, backend: "onnx", profile: "linux", features: [], commands: { say: {} } }],
    ["a flag without a gate key", { protocolVersion: 4, backend: "onnx", profile: "linux", features: [], commands: { say: { flags: { voice: {} } } } }],
    ["a non-string feature", { protocolVersion: 4, backend: "onnx", profile: "linux", features: [7], commands: {} }],
    ["a tts key that is not an object", { protocolVersion: 4, backend: "onnx", profile: "linux", features: [], commands: {}, tts: "yes" }],
    ["a tts language with no engines", { protocolVersion: 4, backend: "onnx", profile: "linux", features: [], commands: {}, tts: { languages: [{ code: "en" }] } }],
  ] as const) {
    test(`${shape} is not a describe document`, () => {
      expect(parseDescribe(payload)).toBeNull();
    });
  }
});

describe("protocolMismatch", () => {
  test("version 4 passes", () => {
    expect(protocolMismatch(DOC, "/x/kesha-engine")).toBeNull();
  });
  test("an older engine points at kesha install", () => {
    const err = protocolMismatch({ ...DOC, protocolVersion: 3 }, "/x/kesha-engine")!;
    expect(err.code).toBe("E_ENGINE_PROTOCOL");
    expect(err.message).toContain("/x/kesha-engine");
    expect(err.hint).toContain("kesha install");
    expect(err.hint).not.toContain("bun add");
  });
  test("a newer engine points at upgrading the CLI", () => {
    const err = protocolMismatch({ ...DOC, protocolVersion: 5 }, "/x/kesha-engine")!;
    expect(err.code).toBe("E_ENGINE_PROTOCOL");
    expect(err.hint).toContain("bun add -g @drakulavich/kesha-voice-kit@latest");
  });
});

test("describeToCapabilities keeps the capabilities shape the status and init screens read", () => {
  expect(describeToCapabilities(DOC)).toEqual({
    protocolVersion: 4,
    backend: "onnx",
    features: DOC.features,
    tts: { languages: [{ code: "en", engines: ["kokoro"] }] },
  });
  const { tts: _tts, ...noTts } = DOC;
  expect(describeToCapabilities(noTts)).not.toHaveProperty("tts");
});
