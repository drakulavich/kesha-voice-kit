import { describe, expect, test } from "bun:test";
import { findUnknownOption } from "../../src/cli/options";

const ARGS = {
  json: { type: "boolean", default: false },
  timestamps: { type: "boolean", default: false },
  "include-errors": { type: "boolean", default: false },
  format: { type: "string" },
  lang: { type: "string" },
  quiet: { type: "boolean", alias: "q" },
  out: { type: "string", alias: "o" },
  text: { type: "positional", required: false },
} as const;

describe("findUnknownOption", () => {
  test("declared long flags, their values and positionals are not unknown", () => {
    expect(findUnknownOption(["--json", "--format", "json", "--lang=en", "a.wav"], ARGS)).toBeNull();
  });

  test("a near-miss of a real flag names the flag and suggests the real one", () => {
    expect(findUnknownOption(["--timestamp", "a.wav"], ARGS)).toEqual({
      name: "--timestamp",
      suggestion: "--timestamps",
    });
  });

  test("a flag with no close match gets no suggestion", () => {
    expect(findUnknownOption(["--frobnicate", "a.wav"], ARGS)).toEqual({
      name: "--frobnicate",
      suggestion: null,
    });
  });

  test("an unknown flag with a value is reported by name, before its value can become a positional", () => {
    expect(findUnknownOption(["--languge", "en", "a.wav"], ARGS)?.name).toBe("--languge");
  });

  test("the value of a declared string flag is never read as a flag", () => {
    expect(findUnknownOption(["--lang", "-x", "a.wav"], ARGS)).toBeNull();
    expect(findUnknownOption(["-o", "-x"], ARGS)).toBeNull();
  });

  test("negating a declared boolean and the camelCase spelling citty accepts stay legal", () => {
    expect(findUnknownOption(["--no-json", "--includeErrors"], ARGS)).toBeNull();
  });

  test("--help and --version belong to the runner, not the command", () => {
    expect(findUnknownOption(["--help"], ARGS)).toBeNull();
    expect(findUnknownOption(["--version"], ARGS)).toBeNull();
    expect(findUnknownOption(["-h"], ARGS)).toBeNull();
  });

  test("short aliases pass, an unknown short flag is named", () => {
    expect(findUnknownOption(["-q", "a.wav"], ARGS)).toBeNull();
    expect(findUnknownOption(["-z", "a.wav"], ARGS)).toEqual({ name: "-z", suggestion: null });
  });

  test("everything after -- is a positional", () => {
    expect(findUnknownOption(["--", "--frobnicate"], ARGS)).toBeNull();
  });

  test("the first unknown flag wins", () => {
    expect(findUnknownOption(["--jsom", "--speaker"], ARGS)?.name).toBe("--jsom");
  });
});
