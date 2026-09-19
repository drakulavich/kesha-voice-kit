import { describe, expect, test } from "bun:test";
import { parseDescribe } from "../../src/engine/describe";
import { describeDocument } from "../helpers/fake-engine";
import { readRepoFile } from "../helpers/repo";

describe("the fake engine's describe template", () => {
  // The capability pact is the only describe recording a workflow re-derives from the published binary (#798).
  const recorded = parseDescribe(JSON.parse(readRepoFile("tests/fixtures/capabilities/darwin-arm64.json")))!;

  test("reproduces the released darwin-arm64 document from its features alone", () => {
    expect(recorded).not.toBeNull();
    expect(
      describeDocument({ backend: recorded.backend, profile: recorded.profile, features: recorded.features, tts: recorded.tts }),
    ).toEqual(recorded);
  });

  test("drops the build-time rows the way the engine does", () => {
    const onnx = describeDocument({ backend: "onnx", profile: "linux", features: ["transcribe", "tts"] });
    expect(onnx.commands.install!.flags).not.toHaveProperty("diarize");
    expect(onnx.commands.say!.flags).toHaveProperty("voice");
    const noTts = describeDocument({ features: ["transcribe"] });
    expect(noTts.commands).not.toHaveProperty("say");
    expect(noTts.commands.install!.flags).not.toHaveProperty("tts");
  });
});
