import { describe, test, expect } from "bun:test";
import {
  createPercentProgress,
  createProgressBar,
  estimatePercent,
  formatPercentProgress,
  formatProgressBar,
  formatBytes,
} from "../../src/progress";

describe("formatBytes", () => {
  test("formats bytes to MB", () => {
    expect(formatBytes(104857600)).toBe("100.0MB");
  });

  test("formats small values", () => {
    expect(formatBytes(1048576)).toBe("1.0MB");
  });

  test("formats zero", () => {
    expect(formatBytes(0)).toBe("0.0MB");
  });
});

describe("formatProgressBar", () => {
  test("renders 0%", () => {
    const bar = formatProgressBar("encoder.onnx", 0, 100);
    expect(bar).toContain("encoder.onnx");
    expect(bar).toContain("0%");
    expect(bar).toContain("░");
  });

  test("renders 50%", () => {
    const bar = formatProgressBar("encoder.onnx", 50, 100);
    expect(bar).toContain("50%");
    expect(bar).toContain("█");
  });

  test("renders 100%", () => {
    const bar = formatProgressBar("encoder.onnx", 100, 100);
    expect(bar).toContain("100%");
  });

  test("includes byte counts in MB", () => {
    const bar = formatProgressBar("file.onnx", 104857600, 209715200);
    expect(bar).toContain("100.0MB");
    expect(bar).toContain("200.0MB");
  });

  test("handles zero total without NaN", () => {
    const bar = formatProgressBar("file.onnx", 0, 0);
    expect(bar).toContain("0%");
    expect(bar).not.toContain("NaN");
  });
});

describe("formatPercentProgress", () => {
  test("renders a determinate percentage bar", () => {
    const bar = formatPercentProgress("Transcribing workshop.mp4", 42);
    expect(bar).toContain("Transcribing workshop.mp4");
    expect(bar).toContain("[");
    expect(bar).toContain("42%");
    expect(bar).toContain("█");
    expect(bar).toContain("░");
  });

  test("clamps percentages to the display range", () => {
    expect(formatPercentProgress("Transcribing file.wav", -10)).toContain("0%");
    expect(formatPercentProgress("Transcribing file.wav", 120)).toContain("100%");
  });
});

describe("createPercentProgress", () => {
  test("non-TTY mode writes stable log lines", () => {
    const originalIsTTY = process.stderr.isTTY;
    const originalWrite = process.stderr.write;
    const writes: string[] = [];

    try {
      Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
      process.stderr.write = ((chunk: string) => {
        writes.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      const progress = createPercentProgress("Transcribing file.wav");
      progress.finish("Transcribed file.wav");

      expect(writes.join("")).toContain("Transcribing file.wav  [░░░░░░░░░░░░░░░░░░░░] 0%\n");
      expect(writes.join("")).toContain("Transcribed file.wav  [████████████████████] 100%\n");
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
      process.stderr.write = originalWrite;
    }
  });

  test("TTY mode clears the live bar and writes the final line", () => {
    const originalIsTTY = process.stderr.isTTY;
    const originalWrite = process.stderr.write;
    const writes: string[] = [];

    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      process.stderr.write = ((chunk: string) => {
        writes.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      const progress = createPercentProgress("Transcribing file.wav", { intervalMs: 10_000 });
      progress.finish("Transcribed file.wav");

      const combined = writes.join("");
      expect(combined).toContain("Transcribing file.wav");
      expect(combined).toContain("Transcribing file.wav  [░░░░░░░░░░░░░░░░░░░░] 0%");
      expect(combined).toContain("Transcribed file.wav  [████████████████████] 100%\n");
      expect(combined).toContain("\r");
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
      process.stderr.write = originalWrite;
    }
  });

  test("TTY mode can interrupt the live bar for side-band output", () => {
    const originalIsTTY = process.stderr.isTTY;
    const originalWrite = process.stderr.write;
    const writes: string[] = [];

    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      process.stderr.write = ((chunk: string) => {
        writes.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      const progress = createPercentProgress("Transcribing file.wav", { intervalMs: 10_000 });
      progress.interrupt(() => process.stderr.write("warning: language mismatch\n"));
      progress.finish("Transcribed file.wav");

      const combined = writes.join("");
      expect(combined).toContain("warning: language mismatch\n");
      expect(combined).toContain("Transcribing file.wav");
      expect(combined).toContain("Transcribed file.wav  [████████████████████] 100%\n");
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
      process.stderr.write = originalWrite;
    }
  });

  test("TTY interrupt after stop writes without restarting the timer", () => {
    const originalIsTTY = process.stderr.isTTY;
    const originalWrite = process.stderr.write;
    const writes: string[] = [];

    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      process.stderr.write = ((chunk: string) => {
        writes.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      const progress = createPercentProgress("Transcribing file.wav", { intervalMs: 10_000 });
      progress.stop();
      writes.length = 0;

      progress.interrupt(() => process.stderr.write("warning after stop\n"));

      expect(writes).toEqual(["warning after stop\n"]);
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
      process.stderr.write = originalWrite;
    }
  });
});

describe("createProgressBar", () => {
  test("a non-numeric Content-Length falls back to the sizeless line, not a NaN bar", () => {
    const originalIsTTY = process.stderr.isTTY;
    const writes: string[] = [];
    const originalWrite = process.stderr.write;

    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      process.stderr.write = ((chunk: string) => {
        writes.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      const bar = createProgressBar("model.onnx", Number("not-a-number"));
      bar.update(100);
      bar.update(50);
      bar.finish();

      expect(writes.join("")).not.toContain("NaN");
    } finally {
      process.stderr.write = originalWrite;
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
    }
  });

  test("TTY mode ends with 100% and a newline", () => {
    // Contract: user sees progress culminating in 100% + newline.
    // Intentionally does not assert write count or per-write content —
    // coalescing writes or changing the intermediate-step cadence is a
    // legitimate refactor and shouldn't fail this test (#161, Rossi
    // liability P3).
    const originalIsTTY = process.stderr.isTTY;
    const writes: string[] = [];
    const originalWrite = process.stderr.write;

    try {
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      process.stderr.write = ((chunk: string) => {
        writes.push(chunk);
        return true;
      }) as typeof process.stderr.write;

      const bar = createProgressBar("model.onnx", 200);
      bar.update(100);
      bar.update(50);
      bar.finish();

      const combined = writes.join("");
      expect(combined).toContain("model.onnx");
      expect(combined).toContain("100%");
      expect(combined.endsWith("\n")).toBe(true);
    } finally {
      Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
      process.stderr.write = originalWrite;
    }
  });
});

describe("estimatePercent", () => {
  test("stays silent until the clock has actually moved", () => {
    expect(estimatePercent(0, 1000)).toBe(0);
    expect(estimatePercent(-5, 1000)).toBe(0);
  });

  // A bar that reads 0% while work is under way is indistinguishable from a hang.
  test("never reads 0% once the work is running", () => {
    expect(estimatePercent(1, 30 * 60 * 1000)).toBe(1);
    expect(estimatePercent(0.5, 30 * 60 * 1000)).toBe(1);
  });

  // 100% belongs to finish(); an estimate reaching it would announce a completion it cannot know.
  test("never reaches 100%, however far past the estimate it runs", () => {
    expect(estimatePercent(1000, 1000)).toBe(99);
    expect(estimatePercent(100_000, 1000)).toBe(99);
  });

  test("a zero or negative estimate does not divide by zero", () => {
    expect(estimatePercent(10, 0)).toBe(99);
    expect(estimatePercent(10, -1000)).toBe(99);
  });

  test("tracks the fraction elapsed in between", () => {
    expect(estimatePercent(500, 1000)).toBe(49);
    expect(estimatePercent(250, 1000)).toBe(24);
  });
});

function withCapturedStderr(isTTY: boolean, fn: () => void): string {
  const originalIsTTY = process.stderr.isTTY;
  const originalWrite = process.stderr.write;
  const writes: string[] = [];
  try {
    Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true });
    process.stderr.write = ((chunk: string) => {
      writes.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    fn();
  } finally {
    process.stderr.write = originalWrite;
    Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
  }
  return writes.join("");
}

describe("the live bar cleans up after itself", () => {
  const label = "Transcribing a-rather-long-file-name.wav";
  const liveLine = `${label}  [░░░░░░░░░░░░░░░░░░░░] 0%`;

  // A shorter final line drawn over a longer one leaves the tail of the old line on screen.
  test("finishing blanks the whole live line before the final one", () => {
    const out = withCapturedStderr(true, () => {
      const progress = createPercentProgress(label, { intervalMs: 10_000 });
      progress.finish("Done");
    });

    expect(out).toContain(`\r${" ".repeat(liveLine.length)}\r`);
    expect(out.endsWith("Done  [████████████████████] 100%\n")).toBe(true);
  });

  test("stopping blanks the line and says nothing further", () => {
    const out = withCapturedStderr(true, () => {
      const progress = createPercentProgress(label, { intervalMs: 10_000 });
      progress.stop();
    });

    expect(out).toBe(`\r${liveLine}\r${" ".repeat(liveLine.length)}\r`);
  });
});

/** The sizeless fallback reports through `log`, which splits across console.log/error. */
function withCapturedLog(fn: () => void): string {
  const saved = { log: console.log, error: console.error, isTTY: process.stderr.isTTY };
  const lines: string[] = [];
  const collect = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
    console.log = collect;
    console.error = collect;
    fn();
  } finally {
    console.log = saved.log;
    console.error = saved.error;
    Object.defineProperty(process.stderr, "isTTY", { value: saved.isTTY, configurable: true });
  }
  return lines.join("\n");
}

describe("the download line reports the size it knows", () => {
  test("a known Content-Length is quoted in the non-TTY line", () => {
    const out = withCapturedLog(() => {
      const bar = createProgressBar("model.onnx", 5 * 1024 * 1024);
      bar.update(1024);
      bar.finish();
    });

    expect(out).toContain("Downloading model.onnx (5.0MB)...");
    expect(out).toContain("Downloaded model.onnx ✓");
  });

  test("an unknown size is left out rather than printed as zero", () => {
    const out = withCapturedLog(() => createProgressBar("model.onnx", 0).finish());

    expect(out).toContain("Downloading model.onnx...");
    expect(out).not.toContain("0.0MB");
  });
});
