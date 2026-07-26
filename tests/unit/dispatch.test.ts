import { describe, test, expect } from "bun:test";
import { classifyFirstArg } from "../../src/cli/dispatch";

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
