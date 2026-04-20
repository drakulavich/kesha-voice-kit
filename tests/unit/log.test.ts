import { describe, test, expect, spyOn, afterEach, beforeEach } from "bun:test";
import { log } from "../../src/log";

describe("log.debug (#148)", () => {
  let stderrSpy: ReturnType<typeof spyOn<Console, "error">>;
  const savedEnv = process.env.KESHA_DEBUG;
  const savedEnabled = log.debugEnabled;

  beforeEach(() => {
    stderrSpy = spyOn(console, "error").mockImplementation(() => {});
    delete process.env.KESHA_DEBUG;
    log.debugEnabled = false;
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (savedEnv === undefined) delete process.env.KESHA_DEBUG;
    else process.env.KESHA_DEBUG = savedEnv;
    log.debugEnabled = savedEnabled;
  });

  test("is a no-op when disabled", () => {
    log.debug("hello");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("writes to stderr when debugEnabled is true", () => {
    log.debugEnabled = true;
    log.debug("hello");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const msg = stderrSpy.mock.calls[0][0] as string;
    expect(msg).toContain("[debug]");
    expect(msg).toContain("hello");
  });

  test("writes to stderr when KESHA_DEBUG=1", () => {
    process.env.KESHA_DEBUG = "1";
    log.debug("from env");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0][0]).toContain("from env");
  });

  test("treats KESHA_DEBUG=0 as disabled", () => {
    process.env.KESHA_DEBUG = "0";
    log.debug("nope");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("treats KESHA_DEBUG=false as disabled", () => {
    process.env.KESHA_DEBUG = "false";
    log.debug("nope");
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test("treats KESHA_DEBUG=true as enabled", () => {
    process.env.KESHA_DEBUG = "true";
    log.debug("yep");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });
});
