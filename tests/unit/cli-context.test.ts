import { afterEach, describe, expect, test } from "bun:test";
import {
  applyCliContext,
  applyColorEnv,
  resolveCliContext,
  USER_FORCED_NO_COLOR,
} from "../../src/cli/context";
import { log, setColorEnabled } from "../../src/log";

describe("resolveCliContext", () => {
  test("resolves both global flags in one pass and strips both tokens", () => {
    const ctx = resolveCliContext(["--quiet", "--no-color", "say", "hello"], {});
    expect(ctx.quiet).toBe(true);
    expect(ctx.disableColor).toBe(true);
    expect(ctx.rawArgs).toEqual(["say", "hello"]);
  });

  test("defaults to neither flag when no tokens are present", () => {
    const ctx = resolveCliContext(["a.ogg"], {});
    expect(ctx).toEqual({ quiet: false, disableColor: false, rawArgs: ["a.ogg"] });
  });

  test("CI disables color without affecting quiet", () => {
    const ctx = resolveCliContext(["a.ogg"], { CI: "true" });
    expect(ctx.disableColor).toBe(true);
    expect(ctx.quiet).toBe(false);
  });

  test("explicit opt-outs beat their default", () => {
    const ctx = resolveCliContext(["--no-color=false", "--quiet=false"], { CI: "false" });
    expect(ctx.disableColor).toBe(false);
    expect(ctx.quiet).toBe(false);
    expect(ctx.rawArgs).toEqual([]);
  });

  test("the tokens are stripped even ahead of a subcommand", () => {
    expect(resolveCliContext(["-q", "stats", "status"], {}).rawArgs).toEqual(["stats", "status"]);
  });

  test("resolution does not mutate the caller's rawArgs", () => {
    const rawArgs = ["--quiet", "a.ogg"];
    resolveCliContext(rawArgs, {});
    expect(rawArgs).toEqual(["--quiet", "a.ogg"]);
  });
});

describe("applyCliContext", () => {
  const savedNoColor = process.env.NO_COLOR;

  afterEach(() => {
    if (savedNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
    log.quietEnabled = false;
    setColorEnabled(true);
  });

  test("mirrors quiet onto the log sink", () => {
    applyCliContext({ quiet: true, disableColor: false });
    expect(log.quietEnabled).toBe(true);
  });

  test("re-applying a non-quiet context clears an earlier quiet run", () => {
    applyCliContext({ quiet: true, disableColor: false });
    applyCliContext({ quiet: false, disableColor: false });
    expect(log.quietEnabled).toBe(false);
  });

  test("exports NO_COLOR so engine subprocesses inherit the decision", () => {
    applyCliContext({ quiet: false, disableColor: true });
    expect(process.env.NO_COLOR).toBe("1");
  });

  test("clears NO_COLOR when colors are back on, unless the user exported it", () => {
    applyCliContext({ quiet: false, disableColor: true });
    applyCliContext({ quiet: false, disableColor: false });
    if (USER_FORCED_NO_COLOR) expect(process.env.NO_COLOR).toBe("1");
    else expect(process.env.NO_COLOR).toBeUndefined();
  });
});

describe("applyColorEnv", () => {
  const savedNoColor = process.env.NO_COLOR;

  afterEach(() => {
    if (savedNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = savedNoColor;
  });

  test("disabling color exports NO_COLOR=1", () => {
    delete process.env.NO_COLOR;
    applyColorEnv(true);
    expect(process.env.NO_COLOR as string | undefined).toBe("1");
  });

  test("disabling color overwrites an existing falsey NO_COLOR", () => {
    process.env.NO_COLOR = "0";
    applyColorEnv(true);
    expect(process.env.NO_COLOR).toBe("1");
  });

  test("enabling color clears NO_COLOR only when the user did not export it", () => {
    applyColorEnv(true);
    applyColorEnv(false);
    if (USER_FORCED_NO_COLOR) expect(process.env.NO_COLOR).toBe("1");
    else expect(process.env.NO_COLOR).toBeUndefined();
  });
});
