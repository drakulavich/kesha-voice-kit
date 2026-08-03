import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../.github/scripts/smoke-synthesis";

const ids = (argv: string[]) => parseArgs(argv)?.voices.map((v) => v.voice);

describe("parseArgs", () => {
  // The form all three ci.yml callers use; a regression here broke published-engine-smoke.
  test("bare work-dir keeps the full round-trip voice list", () => {
    const parsed = parseArgs(["/tmp/kesha-linux-synth"]);
    expect(parsed?.workDir).toBe("/tmp/kesha-linux-synth");
    expect(parsed?.noRoundtrip).toBe(false);
    expect(parsed?.voices.map((v) => v.voice)).toEqual(["en-am_michael", "ru-vosk-m02"]);
  });

  test("--no-roundtrip drops to English and sets the flag", () => {
    const parsed = parseArgs(["--no-roundtrip", "out"]);
    expect(parsed?.workDir).toBe("out");
    expect(parsed?.noRoundtrip).toBe(true);
    expect(parsed?.voices.map((v) => v.voice)).toEqual(["en-am_michael"]);
  });

  test("--voice overrides the list on either side of the work-dir", () => {
    expect(ids(["--voice", "macos-Sam", "out"])).toEqual(["macos-Sam"]);
    expect(ids(["out", "--voice", "macos-Sam"])).toEqual(["macos-Sam"]);
    expect(parseArgs(["out", "--voice", "macos-Sam"])?.workDir).toBe("out");
  });

  test("the voice value is never mistaken for the work-dir", () => {
    expect(parseArgs(["--voice", "macos-Sam"])).toBeNull();
  });

  test("rejects a missing work-dir or a dangling --voice", () => {
    expect(parseArgs([])).toBeNull();
    expect(parseArgs(["--no-roundtrip"])).toBeNull();
    expect(parseArgs(["out", "--voice"])).toBeNull();
    expect(parseArgs(["--voice", "--no-roundtrip", "out"])).toBeNull();
  });
});
