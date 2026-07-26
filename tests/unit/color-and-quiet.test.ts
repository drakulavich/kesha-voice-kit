import { describe, test, expect } from "bun:test";
import { resolveColorMode } from "../../src/cli/context";
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

describe("--quiet gating (#526)", () => {
  test("shouldReportTranscribeProgress is false when quiet", () => {
    expect(
      shouldReportTranscribeProgress({ stderrIsTty: true, stdoutIsTty: false, debugEnabled: false, quiet: true }),
    ).toBe(false);
    expect(
      shouldReportTranscribeProgress({ stderrIsTty: true, stdoutIsTty: false, debugEnabled: false }),
    ).toBe(true);
  });
});
