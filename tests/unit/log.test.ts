import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { log, setColorEnabled } from "../../src/log";

// Capture stderr writes without going through console.error (which Bun
// auto-colorizes in a TTY, bypassing picocolors / setColorEnabled).
function captureStderr(fn: () => void): string {
  const chunks: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join("");
}

function captureStdout(fn: () => void): string {
  const chunks: string[] = [];
  const original = console.log;
  console.log = ((msg: string) => void chunks.push(String(msg))) as typeof console.log;
  try {
    fn();
  } finally {
    console.log = original;
  }
  return chunks.join("\n");
}

describe("log routing", () => {
  test("info and success write to stdout (console.log), not stderr", () => {
    const stderr = captureStderr(() => {
      captureStdout(() => {
        log.info("info-msg");
        log.success("success-msg");
      });
    });
    expect(stderr).not.toContain("info-msg");
    expect(stderr).not.toContain("success-msg");
  });

  test("warn writes to stderr via process.stderr.write", () => {
    const out = captureStderr(() => log.warn("warn-msg"));
    expect(out).toContain("warn-msg");
  });

  test("error writes to stderr via process.stderr.write", () => {
    const out = captureStderr(() => log.error("error-msg"));
    expect(out).toContain("error-msg");
  });

  test("status writes to stderr, not stdout", () => {
    const stdout = captureStdout(() => {
      const stderr = captureStderr(() => log.status("status-msg"));
      expect(stderr).toContain("status-msg");
    });
    expect(stdout).not.toContain("status-msg");
  });

  test("progress writes to stdout, not stderr", () => {
    const stderr = captureStderr(() => {
      const stdout = captureStdout(() => log.progress("progress-msg"));
      expect(stdout).toContain("progress-msg");
    });
    expect(stderr).not.toContain("progress-msg");
  });

  test("stderr lines end with a newline", () => {
    expect(captureStderr(() => log.warn("w"))).toMatch(/\n$/);
    expect(captureStderr(() => log.error("e"))).toMatch(/\n$/);
    expect(captureStderr(() => log.status("s"))).toMatch(/\n$/);
  });
});

describe("log.quietEnabled level gating (#526)", () => {
  afterEach(() => {
    log.quietEnabled = false;
  });

  test("progress is suppressed when quietEnabled", () => {
    log.quietEnabled = true;
    const out = captureStdout(() => log.progress("quiet-progress"));
    expect(out).not.toContain("quiet-progress");
  });

  test("progress is emitted when quietEnabled is false", () => {
    log.quietEnabled = false;
    const out = captureStdout(() => log.progress("loud-progress"));
    expect(out).toContain("loud-progress");
  });

  test("status is suppressed when quietEnabled", () => {
    log.quietEnabled = true;
    const out = captureStderr(() => log.status("quiet-status"));
    expect(out).not.toContain("quiet-status");
  });

  test("warn is never suppressed by quietEnabled", () => {
    log.quietEnabled = true;
    const out = captureStderr(() => log.warn("loud-warn"));
    expect(out).toContain("loud-warn");
  });

  test("error is never suppressed by quietEnabled", () => {
    log.quietEnabled = true;
    const out = captureStderr(() => log.error("loud-error"));
    expect(out).toContain("loud-error");
  });
});

describe("log.debug level gating (#148)", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.KESHA_DEBUG;
    delete process.env.KESHA_DEBUG;
    log.debugEnabled = false;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.KESHA_DEBUG;
    } else {
      process.env.KESHA_DEBUG = savedEnv;
    }
    log.debugEnabled = false;
  });

  test("debug is suppressed by default (no env, no flag)", () => {
    const out = captureStderr(() => log.debug("silent-debug"));
    expect(out).not.toContain("silent-debug");
  });

  test("debugEnabled=true enables debug output", () => {
    log.debugEnabled = true;
    const out = captureStderr(() => log.debug("flagged-debug"));
    expect(out).toContain("flagged-debug");
  });

  test("KESHA_DEBUG=1 enables debug output", () => {
    process.env.KESHA_DEBUG = "1";
    const out = captureStderr(() => log.debug("env-debug"));
    expect(out).toContain("env-debug");
  });

  test("KESHA_DEBUG=true enables debug output (case-insensitive)", () => {
    process.env.KESHA_DEBUG = "True";
    const out = captureStderr(() => log.debug("env-debug-true"));
    expect(out).toContain("env-debug-true");
  });

  // OFF values from KESHA_DEBUG grammar (#275 D9)
  test.each(["0", "false", "no", "off", "FALSE", "  Off  "])(
    "KESHA_DEBUG=%s keeps debug silent",
    (val) => {
      process.env.KESHA_DEBUG = val;
      const out = captureStderr(() => log.debug("should-not-appear"));
      expect(out).not.toContain("should-not-appear");
    },
  );

  test("debug lines include a +NNNms prefix", () => {
    log.debugEnabled = true;
    const out = captureStderr(() => log.debug("timing-check"));
    expect(out).toMatch(/\+\d+ms/);
  });

  test("isDebugEnabled reflects both flag and env", () => {
    expect(log.isDebugEnabled()).toBe(false);
    log.debugEnabled = true;
    expect(log.isDebugEnabled()).toBe(true);
    log.debugEnabled = false;
    process.env.KESHA_DEBUG = "yes";
    expect(log.isDebugEnabled()).toBe(true);
  });
});

describe("setColorEnabled / NO_COLOR (#531)", () => {
  afterEach(() => {
    setColorEnabled(true);
  });

  test("disabled → warn emits plain text without ANSI escapes", () => {
    setColorEnabled(false);
    const out = captureStderr(() => log.warn("plain-warn"));
    expect(out).toContain("plain-warn");
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);
  });

  test("disabled → error emits plain text without ANSI escapes", () => {
    setColorEnabled(false);
    const out = captureStderr(() => log.error("plain-error"));
    expect(out).toContain("plain-error");
    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(out)).toBe(false);
  });

  test("re-enabling restores output (no throw, message still arrives)", () => {
    setColorEnabled(false);
    setColorEnabled(true);
    const out = captureStderr(() => log.warn("restored-warn"));
    expect(out).toContain("restored-warn");
  });
});
