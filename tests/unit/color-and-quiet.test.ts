import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveColorMode, resolveQuietMode } from "../../src/cli/dispatch";
import { log, setColorEnabled } from "../../src/log";
import { shouldReportTranscribeProgress } from "../../src/cli";

describe("resolveColorMode (#531)", () => {
  test("bare --no-color disables color and is stripped from rawArgs", () => {
    const r = resolveColorMode(["--no-color", "a.ogg"], {});
    expect(r.disableColor).toBe(true);
    expect(r.rawArgs).toEqual(["a.ogg"]);
  });

  test("--no-color=true / =1 disables color and is stripped", () => {
    expect(resolveColorMode(["--no-color=true"], {}).disableColor).toBe(true);
    expect(resolveColorMode(["--no-color=1"], {}).disableColor).toBe(true);
    expect(resolveColorMode(["--no-color=true", "a.ogg"], {}).rawArgs).toEqual(["a.ogg"]);
  });

  test("--no-color=false opts back in but is still stripped", () => {
    const r = resolveColorMode(["--no-color=false", "a.ogg"], {});
    expect(r.disableColor).toBe(false);
    expect(r.rawArgs).toEqual(["a.ogg"]);
  });

  test("CI set to a truthy value disables color", () => {
    expect(resolveColorMode([], { CI: "true" }).disableColor).toBe(true);
    expect(resolveColorMode([], { CI: "1" }).disableColor).toBe(true);
  });

  test("CI falsey or unset keeps color", () => {
    expect(resolveColorMode([], { CI: "false" }).disableColor).toBe(false);
    expect(resolveColorMode([], { CI: "0" }).disableColor).toBe(false);
    expect(resolveColorMode([], {}).disableColor).toBe(false);
  });

  test("no color tokens leaves rawArgs untouched", () => {
    expect(resolveColorMode(["a.ogg", "--json"], {}).rawArgs).toEqual(["a.ogg", "--json"]);
  });
});

describe("resolveQuietMode (#526)", () => {
  test("--quiet / -q / --quiet=true enable and are stripped", () => {
    expect(resolveQuietMode(["--quiet", "a.ogg"])).toEqual({ quiet: true, rawArgs: ["a.ogg"] });
    expect(resolveQuietMode(["-q", "a.ogg"])).toEqual({ quiet: true, rawArgs: ["a.ogg"] });
    expect(resolveQuietMode(["--quiet=1"])).toEqual({ quiet: true, rawArgs: [] });
  });

  test("--quiet=false opts out but is still stripped", () => {
    expect(resolveQuietMode(["--quiet=false", "a.ogg"])).toEqual({ quiet: false, rawArgs: ["a.ogg"] });
  });

  test("strips the flag even when it precedes a subcommand", () => {
    expect(resolveQuietMode(["-q", "say", "hello"])).toEqual({ quiet: true, rawArgs: ["say", "hello"] });
  });

  test("no quiet token leaves rawArgs untouched", () => {
    expect(resolveQuietMode(["say", "hello"])).toEqual({ quiet: false, rawArgs: ["say", "hello"] });
  });
});

describe("setColorEnabled (#531)", () => {
  let chunks: string[];
  let originalWrite: typeof process.stderr.write;

  beforeEach(() => {
    chunks = [];
    originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    setColorEnabled(true); // restore default for other suites
  });

  test("disabled → log.error emits plain text with no ANSI escapes", () => {
    setColorEnabled(false);
    log.error("boom");
    const out = chunks.join("");
    expect(out).toContain("boom");
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(out)).toBe(false);
  });

  test("re-enabling does not throw and still emits the message", () => {
    setColorEnabled(false);
    setColorEnabled(true);
    log.warn("heads up");
    expect(chunks.join("")).toContain("heads up");
  });
});

describe("--quiet gating (#526)", () => {
  test("shouldReportTranscribeProgress is false when quiet", () => {
    expect(
      shouldReportTranscribeProgress({ stderrIsTty: true, stdoutIsTty: false, debugEnabled: false, quiet: true }),
    ).toBe(false);
    expect(
      shouldReportTranscribeProgress({ stderrIsTty: true, stdoutIsTty: false, debugEnabled: false }),
    ).toBe(true);
  });

  test("log.quietEnabled suppresses log.progress but not warn/error", () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = ((msg: string) => void logs.push(String(msg))) as typeof console.log;
    try {
      log.quietEnabled = true;
      log.progress("hidden-progress");
      expect(logs.join("")).not.toContain("hidden-progress");
      log.quietEnabled = false;
      log.progress("shown-progress");
      expect(logs.join("")).toContain("shown-progress");
    } finally {
      console.log = originalLog;
      log.quietEnabled = false;
    }
  });

  test("log.status (stderr) is suppressed under --quiet", () => {
    const chunks: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      log.quietEnabled = true;
      log.status("hidden-status");
      expect(chunks.join("")).not.toContain("hidden-status");
      log.quietEnabled = false;
      log.status("shown-status");
      expect(chunks.join("")).toContain("shown-status");
    } finally {
      process.stderr.write = originalWrite;
      log.quietEnabled = false;
    }
  });
});
