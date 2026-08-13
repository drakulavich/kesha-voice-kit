import { describe, test, expect } from "bun:test";
import {
  classifyFirstArg,
  unknownCommandMessages,
  SUBCOMMAND_NAMES,
  USAGE_MESSAGE,
} from "../../src/cli/dispatch";

// ---------------------------------------------------------------------------
// classifyFirstArg
// ---------------------------------------------------------------------------

const KNOWN = ["doctor", "init", "install", "logs", "status", "record", "say", "stats", "support-bundle", "completions", "manpage", "mcp"];

describe("classifyFirstArg — subcommand", () => {
  test("exact subcommand name → 'subcommand'", () => {
    expect(classifyFirstArg("install", KNOWN)).toBe("subcommand");
    expect(classifyFirstArg("say", KNOWN)).toBe("subcommand");
    expect(classifyFirstArg("support-bundle", KNOWN)).toBe("subcommand");
  });
});

describe("classifyFirstArg — main (falls through to transcribe/help)", () => {
  test("undefined → 'main'", () => {
    expect(classifyFirstArg(undefined, KNOWN)).toBe("main");
  });

  test("leading dash (flag) → 'main'", () => {
    expect(classifyFirstArg("--json", KNOWN)).toBe("main");
    expect(classifyFirstArg("-q", KNOWN)).toBe("main");
    expect(classifyFirstArg("--format=json", KNOWN)).toBe("main");
  });

  test("arg with a dot (file extension) → 'main'", () => {
    expect(classifyFirstArg("audio.ogg", KNOWN)).toBe("main");
    expect(classifyFirstArg("file.wav", KNOWN)).toBe("main");
    expect(classifyFirstArg("./audio.mp3", KNOWN)).toBe("main");
  });

  test("arg containing a slash (path) → 'main'", () => {
    expect(classifyFirstArg("/tmp/audio", KNOWN)).toBe("main");
    expect(classifyFirstArg("./audio", KNOWN)).toBe("main");
    expect(classifyFirstArg("subdir/file", KNOWN)).toBe("main");
  });
});

describe("classifyFirstArg — unknown (typo detection)", () => {
  test("bare word not in subcommands and not path-like → 'unknown'", () => {
    expect(classifyFirstArg("instal", KNOWN)).toBe("unknown");
    expect(classifyFirstArg("transcrib", KNOWN)).toBe("unknown");
    expect(classifyFirstArg("hlep", KNOWN)).toBe("unknown");
  });

  test("empty string → 'main' (falsy guard at top of function)", () => {
    expect(classifyFirstArg("", KNOWN)).toBe("main");
  });
});

describe("bare-invocation usage block names every dispatchable subcommand (#938)", () => {
  test.each(SUBCOMMAND_NAMES)("usage block lists 'kesha %s'", (name) => {
    expect(USAGE_MESSAGE).toContain(`kesha ${name}`);
  });
});

describe("unknownCommandMessages", () => {
  test("typo of a real subcommand suggests it", () => {
    const { errorLine, warnLines } = unknownCommandMessages("statsu", KNOWN);
    expect(errorLine).toBe("unknown command 'statsu'");
    expect(warnLines).toContain("(Did you mean stats?)");
    expect(warnLines).toContain("If this is an audio file, pass a path like './statsu'.");
    expect(warnLines.some((line) => line.startsWith("To transcribe,"))).toBe(false);
  });

  test("typo of 'transcribe' adds the direct-invocation hint", () => {
    const { errorLine, warnLines } = unknownCommandMessages("transcrib", KNOWN);
    expect(errorLine).toBe("unknown command 'transcrib'");
    expect(warnLines.some((line) => line.includes("Did you mean"))).toBe(false);
    expect(warnLines).toContain("If this is an audio file, pass a path like './transcrib'.");
    expect(warnLines).toContain("To transcribe, pass the audio path directly: kesha ./recording.ogg");
  });

  test("unrelated token gets only the generic file hint", () => {
    const { warnLines } = unknownCommandMessages("xyzabc", KNOWN);
    expect(warnLines).toEqual(["If this is an audio file, pass a path like './xyzabc'."]);
  });
});
