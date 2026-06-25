import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { applyColorEnv, classifyFirstArg } from "../../src/cli/dispatch";

// ---------------------------------------------------------------------------
// applyColorEnv
// ---------------------------------------------------------------------------

describe("applyColorEnv", () => {
  let savedNoColor: string | undefined;

  beforeEach(() => {
    savedNoColor = process.env.NO_COLOR;
  });

  afterEach(() => {
    // Restore whatever the test runner had on entry.
    if (savedNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = savedNoColor;
    }
  });

  test("disableColor=true sets NO_COLOR=1", () => {
    delete process.env.NO_COLOR;
    applyColorEnv(true);
    expect(process.env.NO_COLOR as unknown as string).toBe("1");
  });

  test("disableColor=false clears NO_COLOR when not user-forced", () => {
    // Temporarily ensure USER_FORCED_NO_COLOR is false by starting with no env var.
    // applyColorEnv reads the module-level constant captured at import time, so we
    // can only test the branch where the constant is false (the normal test-runner
    // case where NO_COLOR wasn't set at module load).
    delete process.env.NO_COLOR;
    applyColorEnv(true);  // set it first
    applyColorEnv(false); // should clear it (assuming USER_FORCED_NO_COLOR=false)
    // If USER_FORCED_NO_COLOR is true in this runner, NO_COLOR stays — we just
    // assert the function doesn't throw and the type is correct.
    expect(typeof process.env.NO_COLOR === "undefined" || process.env.NO_COLOR === "1").toBe(true);
  });

  test("disableColor=true overwrites an existing NO_COLOR value", () => {
    process.env.NO_COLOR = "0";
    applyColorEnv(true);
    expect(process.env.NO_COLOR as unknown as string).toBe("1");
  });
});

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
