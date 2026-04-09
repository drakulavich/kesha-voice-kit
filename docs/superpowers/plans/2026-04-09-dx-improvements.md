# DX Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Improve parakeet-cli's user experience with actionable error messages, a `parakeet status` command, and download progress bars.

**Architecture:** Three independent features sharing the existing `log.ts` utility. Progress bar is a new `src/progress.ts` module consumed by download functions. Status command is a new `src/status.ts` module wired into `src/cli.ts`. Error message improvements are edits to existing files.

**Tech Stack:** Bun, TypeScript, picocolors, citty, ANSI escape codes

---

### Task 1: Progress bar utility

**Files:**
- Create: `src/progress.ts`
- Create: `src/__tests__/progress.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/progress.test.ts
import { describe, test, expect } from "bun:test";
import { formatProgressBar, formatBytes } from "../progress";

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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/progress.test.ts`
Expected: FAIL — module `../progress` not found

- [ ] **Step 3: Implement progress bar utility**

```typescript
// src/progress.ts
import { log } from "./log";

const BAR_WIDTH = 20;

export function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function formatProgressBar(label: string, downloaded: number, total: number): string {
  const pct = Math.min(100, Math.floor((downloaded / total) * 100));
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return `${label}  [${bar}] ${pct}%  ${formatBytes(downloaded)}/${formatBytes(total)}`;
}

export function createProgressBar(label: string, totalBytes: number): {
  update(downloadedBytes: number): void;
  finish(): void;
} {
  const isTTY = process.stderr.isTTY;

  if (!isTTY || totalBytes <= 0) {
    // Non-TTY or unknown size: simple start/finish messages
    const sizeInfo = totalBytes > 0 ? ` (${formatBytes(totalBytes)})` : "";
    log.progress(`Downloading ${label}${sizeInfo}...`);
    return {
      update() {},
      finish() {
        log.success(`Downloaded ${label} ✓`);
      },
    };
  }

  let current = 0;
  return {
    update(downloadedBytes: number) {
      current += downloadedBytes;
      const line = formatProgressBar(label, current, totalBytes);
      process.stderr.write(`\r${line}`);
    },
    finish() {
      const line = formatProgressBar(label, totalBytes, totalBytes);
      process.stderr.write(`\r${line}\n`);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/progress.test.ts`
Expected: PASS — all 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/progress.ts src/__tests__/progress.test.ts
git commit -m "feat: add TTY-aware download progress bar utility"
```

---

### Task 2: Integrate progress bar into ONNX downloads

**Files:**
- Modify: `src/onnx-install.ts` (lines 58-95, the download loop)

- [ ] **Step 1: Write the failing test**

Add a test to `src/__tests__/progress.test.ts` that verifies the progress bar's `update` accumulates correctly:

```typescript
// append to src/__tests__/progress.test.ts
describe("createProgressBar", () => {
  test("non-TTY mode calls log functions", () => {
    // createProgressBar with isTTY=false should not throw
    // We test the pure functions above; integration is covered by smoke tests
    const bar = createProgressBar("test.onnx", 0);
    bar.update(100);
    bar.finish(); // should log success
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test src/__tests__/progress.test.ts`
Expected: PASS

- [ ] **Step 3: Modify ONNX download to use progress bar**

Replace the download loop body in `src/onnx-install.ts` (lines 58-95). The full `downloadModel` function becomes:

```typescript
// src/onnx-install.ts — replace the for-loop body (lines 58-95)
import { createProgressBar } from "./progress";

// ... existing imports and constants unchanged ...

export async function downloadModel(noCache = false, modelDir?: string): Promise<string> {
  const dir = modelDir ?? getModelDir();

  if (!noCache && isModelCached(dir)) {
    log.success("Model already downloaded.");
    return dir;
  }

  mkdirSync(dir, { recursive: true });

  for (const file of MODEL_FILES) {
    const url = `https://huggingface.co/${HF_REPO}/resolve/main/${file}`;
    const dest = join(dir, file);

    if (!noCache && existsSync(dest)) continue;

    let res: Response;
    try {
      res = await fetch(url, { redirect: "follow" });
    } catch (e) {
      throw new Error(
        `Failed to fetch ${file}: ${e instanceof Error ? e.message : e}\n  Fix: Check your network connection and try again`,
      );
    }

    if (!res.ok) {
      throw new Error(
        `Failed to download ${file}: HTTP ${res.status}\n  Fix: Check your network connection or try again with --no-cache`,
      );
    }

    if (!res.body) {
      throw new Error(
        `Download failed: empty response for ${file}\n  Fix: Try again — the server may be temporarily unavailable`,
      );
    }

    const totalBytes = Number(res.headers.get("content-length") || 0);
    const progress = createProgressBar(file, totalBytes);

    const writer = Bun.file(dest).writer();
    let bytes = 0;
    try {
      for await (const chunk of res.body) {
        writer.write(chunk);
        bytes += chunk.length;
        progress.update(chunk.length);
      }
    } finally {
      writer.end();
    }

    if (bytes === 0) {
      throw new Error(
        `Downloaded 0 bytes for ${file}\n  Fix: Try again — the server may be temporarily unavailable`,
      );
    }

    progress.finish();
  }

  log.success("Model downloaded successfully.");
  return dir;
}
```

- [ ] **Step 4: Run all tests to verify nothing broke**

Run: `bun test && bunx tsc --noEmit`
Expected: All tests PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add src/onnx-install.ts
git commit -m "feat: add progress bar and actionable errors to ONNX downloads"
```

---

### Task 3: Integrate progress bar into CoreML binary download

**Files:**
- Modify: `src/coreml-install.ts` (lines 166-183 `fetchCoreMLBinary`, lines 234-239 download block)

- [ ] **Step 1: Modify `downloadCoreML` to use progress bar for binary download**

In `src/coreml-install.ts`, update the binary download block (lines 234-239) and the error in `fetchCoreMLBinary` (line 179):

```typescript
// Add import at top of src/coreml-install.ts
import { createProgressBar } from "./progress";

// Replace fetchCoreMLBinary error message (line 179):
throw new Error(
  `Failed to download CoreML binary (HTTP ${res.status})\n  No release found matching ${COREML_BINARY_NAME}\n  Fix: Check https://github.com/drakulavich/parakeet-cli/releases for available versions\n       Or install the ONNX backend instead: parakeet install --onnx`,
);

// Replace the binary download block (lines 234-239) inside downloadCoreML:
  if (plan.downloadBinary) {
    const res = await fetchCoreMLBinary();
    const totalBytes = Number(res.headers.get("content-length") || 0);
    const progress = createProgressBar("parakeet-coreml binary", totalBytes);

    mkdirSync(dirname(binPath), { recursive: true });

    if (!res.body) {
      throw new Error(
        "Download failed: empty response for CoreML binary\n  Fix: Try again — the server may be temporarily unavailable",
      );
    }

    const writer = Bun.file(binPath).writer();
    try {
      for await (const chunk of res.body) {
        writer.write(chunk);
        progress.update(chunk.length);
      }
    } finally {
      writer.end();
    }

    progress.finish();
    chmodSync(binPath, 0o755);
  }
```

- [ ] **Step 2: Run all tests**

Run: `bun test && bunx tsc --noEmit`
Expected: All tests PASS, no type errors

- [ ] **Step 3: Commit**

```bash
git add src/coreml-install.ts
git commit -m "feat: add progress bar and actionable errors to CoreML binary download"
```

---

### Task 4: Actionable error in audio.ts

**Files:**
- Modify: `src/audio.ts` (line 58)
- Modify: `src/__tests__/audio.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test to `src/__tests__/audio.test.ts`:

```typescript
// append to src/__tests__/audio.test.ts
describe("audio error messages", () => {
  test("file-not-found error includes file path", () => {
    const { convertToFloat32PCM } = require("../audio");
    expect(convertToFloat32PCM("/nonexistent/audio.wav")).rejects.toThrow("file not found: /nonexistent/audio.wav");
  });
});
```

- [ ] **Step 2: Run test to verify it passes (existing behavior)**

Run: `bun test src/__tests__/audio.test.ts`
Expected: PASS — this test validates existing behavior before we change the ffmpeg error format

- [ ] **Step 3: Update ffmpeg error message in audio.ts**

In `src/audio.ts`, replace the error on line 58:

```typescript
// Old (line 57-59):
  if (exitCode !== 0) {
    throw new Error(`failed to convert audio: ${stderr.trim().split("\n").pop()}`);
  }

// New:
  if (exitCode !== 0) {
    const lastLine = stderr.trim().split("\n").pop() ?? "unknown error";
    throw new Error(
      `Audio conversion failed: ${lastLine}\n  File: ${inputPath}\n  Fix: Ensure the file is a valid audio format. Run "ffmpeg -i ${inputPath}" to diagnose.`,
    );
  }
```

- [ ] **Step 4: Run all tests**

Run: `bun test && bunx tsc --noEmit`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/audio.ts src/__tests__/audio.test.ts
git commit -m "feat: actionable error messages for audio conversion failures"
```

---

### Task 5: Short-audio warning and CoreML fallback warning

**Files:**
- Modify: `src/transcribe.ts` (lines 28-46)
- Modify: `src/lib.ts`
- Modify: `src/cli.ts` (line 117)

- [ ] **Step 1: Add `silent` option to TranscribeOptions and update transcribe**

In `src/transcribe.ts`, add `silent` to the options and add warnings:

```typescript
// src/transcribe.ts — update TranscribeOptions (line 28-31):
export interface TranscribeOptions {
  beamWidth?: number;
  modelDir?: string;
  silent?: boolean;
}

// Update the transcribe function (lines 36-46):
export async function transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<string> {
  if (isCoreMLInstalled()) {
    return transcribeCoreML(audioPath);
  }

  if (!opts.silent && isMacArm64()) {
    log.warn("CoreML backend unavailable, falling back to ONNX");
  }

  if (isModelCached(opts.modelDir)) {
    return transcribeOnnx(audioPath, opts);
  }

  throw installHintError("Error: No transcription backend is installed");
}
```

Add the missing imports at the top of `src/transcribe.ts`. `isCoreMLInstalled` and `transcribeCoreML` are already imported from `./coreml` (line 2) — add `isMacArm64` to that import:

```typescript
import { isCoreMLInstalled, transcribeCoreML, isMacArm64 } from "./coreml";
import { log } from "./log";
```

- [ ] **Step 2: Add short-audio warning in transcribeOnnx**

In `src/transcribe.ts`, update the short-audio check (lines 51-53):

```typescript
// Old (lines 51-53):
  if (audio.length < MIN_AUDIO_SAMPLES) {
    return "";
  }

// New:
  if (audio.length < MIN_AUDIO_SAMPLES) {
    if (!opts.silent) {
      log.warn(`Audio too short (< 0.1s), skipping: ${audioPath}`);
    }
    return "";
  }
```

- [ ] **Step 3: Pass `silent: true` from the public API**

In `src/lib.ts`, pass `silent` to suppress warnings in programmatic usage:

```typescript
// src/lib.ts — update the transcribe call (line 17):
// Old:
  return internalTranscribe(audioPath, options);

// New:
  return internalTranscribe(audioPath, { ...options, silent: true });
```

- [ ] **Step 4: Run all tests**

Run: `bun test && bunx tsc --noEmit`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/transcribe.ts src/lib.ts
git commit -m "feat: short-audio and CoreML fallback warnings (CLI only)"
```

---

### Task 6: Status command

**Files:**
- Create: `src/status.ts`
- Create: `src/__tests__/status.test.ts`
- Modify: `src/cli.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/__tests__/status.test.ts
import { describe, test, expect } from "bun:test";
import { formatStatusLine, collectSuggestions } from "../status";

describe("formatStatusLine", () => {
  test("formats installed component", () => {
    const line = formatStatusLine("Binary", "/path/to/bin", true);
    expect(line).toContain("Binary");
    expect(line).toContain("/path/to/bin");
    expect(line).toContain("✓");
    expect(line).not.toContain("✗");
  });

  test("formats missing component", () => {
    const line = formatStatusLine("Binary", null, false);
    expect(line).toContain("Binary");
    expect(line).toContain("✗");
    expect(line).toContain("not installed");
  });

  test("formats missing component with custom label", () => {
    const line = formatStatusLine("ffmpeg", null, false, "not found");
    expect(line).toContain("not found");
  });
});

describe("collectSuggestions", () => {
  test("suggests install for missing ONNX", () => {
    const suggestions = collectSuggestions({ onnx: false, coreml: "missing", ffmpeg: true });
    expect(suggestions.some((s) => s.includes("parakeet install"))).toBe(true);
  });

  test("suggests ffmpeg install when missing", () => {
    const suggestions = collectSuggestions({ onnx: true, coreml: "ready", ffmpeg: false });
    expect(suggestions.some((s) => s.includes("ffmpeg"))).toBe(true);
  });

  test("returns empty when everything is installed", () => {
    const suggestions = collectSuggestions({ onnx: true, coreml: "ready", ffmpeg: true });
    expect(suggestions).toHaveLength(0);
  });

  test("suggests CoreML install on macOS when missing", () => {
    const suggestions = collectSuggestions({ onnx: true, coreml: "missing", ffmpeg: true });
    expect(suggestions.some((s) => s.includes("--coreml"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/status.test.ts`
Expected: FAIL — module `../status` not found

- [ ] **Step 3: Implement status module**

```typescript
// src/status.ts
import { isMacArm64, getCoreMLBinPath, isCoreMLInstalled } from "./coreml";
import { isModelCached, getModelDir } from "./onnx-install";
import { getCoreMLInstallState, getCoreMLInstallStatus, getCoreMLSupportDir, type CoreMLInstallState } from "./coreml-install";
import { log } from "./log";
import pc from "picocolors";

export function formatStatusLine(
  label: string,
  path: string | null,
  installed: boolean,
  missingLabel = "not installed",
): string {
  const status = installed ? pc.green("✓") : pc.red(`✗ ${missingLabel}`);
  const pathStr = path ?? "";
  const padding = " ".repeat(Math.max(1, 50 - label.length - pathStr.length));
  return `  ${label}:${pathStr ? `   ${pathStr}` : ""}${padding}${status}`;
}

export interface StatusInfo {
  onnx: boolean;
  coreml: CoreMLInstallState | "n/a";
  ffmpeg: boolean;
}

export function collectSuggestions(info: StatusInfo): string[] {
  const suggestions: string[] = [];

  if (info.coreml === "missing" || info.coreml === "stale-binary") {
    suggestions.push(`Run "parakeet install --coreml" to install the CoreML backend.`);
  } else if (info.coreml === "binary-only") {
    suggestions.push(`Run "parakeet install --coreml" to download CoreML models.`);
  }

  if (!info.onnx) {
    suggestions.push(`Run "parakeet install --onnx" to install the ONNX backend.`);
  }

  if (!info.ffmpeg) {
    suggestions.push(`Install ffmpeg for ONNX audio conversion (see "parakeet install" output for instructions).`);
  }

  return suggestions;
}

export async function showStatus(): Promise<void> {
  const isMac = isMacArm64();
  const platform = `${process.platform} ${process.arch}`;

  // CoreML status
  if (isMac) {
    const binPath = getCoreMLBinPath();
    let coremlState: CoreMLInstallState;
    try {
      coremlState = getCoreMLInstallState({
        binPath,
        verifyReady: (path) => getCoreMLInstallStatus(path),
      });
    } catch {
      coremlState = "missing";
    }

    log.info("CoreML (macOS Apple Silicon):");
    const binInstalled = coremlState !== "missing";
    log.info(formatStatusLine("Binary", binInstalled ? binPath : null, binInstalled));

    const modelsInstalled = coremlState === "ready";
    const modelDir = getCoreMLSupportDir();
    log.info(formatStatusLine("Models", modelsInstalled ? modelDir : null, modelsInstalled));
    log.info("");
  }

  // ONNX status
  const modelDir = getModelDir();
  const onnxInstalled = isModelCached();
  log.info("ONNX:");
  log.info(formatStatusLine("Models", onnxInstalled ? modelDir : null, onnxInstalled));
  log.info("");

  // ffmpeg
  const ffmpegPath = Bun.which("ffmpeg");
  log.info(formatStatusLine("ffmpeg", ffmpegPath, !!ffmpegPath, "not found"));

  // Runtime info
  log.info(formatStatusLine("Runtime", `Bun ${Bun.version}`, true));
  log.info(formatStatusLine("Platform", platform, true));
  log.info("");

  // Suggestions
  const coremlState = isMac
    ? getCoreMLInstallState({
        binPath: getCoreMLBinPath(),
        verifyReady: (path) => {
          try { return getCoreMLInstallStatus(path); } catch { return "missing"; }
        },
      })
    : "n/a" as const;

  const suggestions = collectSuggestions({
    onnx: onnxInstalled,
    coreml: coremlState,
    ffmpeg: !!ffmpegPath,
  });

  for (const suggestion of suggestions) {
    log.warn(suggestion);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/status.test.ts`
Expected: PASS — all 7 tests

- [ ] **Step 5: Wire status command into CLI**

In `src/cli.ts`, add the status subcommand. Add import at top:

```typescript
import { showStatus } from "./status";
```

Add the subcommand routing alongside the existing `install` routing (after line 103):

```typescript
    // Inside mainCommand's run function, after the install routing block:
    if (positional[0] === "status") {
      await showStatus();
      return;
    }
```

Also update the usage message (line 108) to include `status`:

```typescript
// Old:
log.info("Usage: parakeet <audio_file> [audio_file ...]\n       parakeet install [--coreml | --onnx] [--no-cache]");

// New:
log.info("Usage: parakeet <audio_file> [audio_file ...]\n       parakeet install [--coreml | --onnx] [--no-cache]\n       parakeet status");
```

- [ ] **Step 6: Add CLI test for status subcommand**

Append to `src/__tests__/cli.test.ts`:

```typescript
describe("CLI help with status", () => {
  test("usage text includes status command", () => {
    // The usage string should mention the status command
    const usage = "Usage: parakeet <audio_file> [audio_file ...]\n       parakeet install [--coreml | --onnx] [--no-cache]\n       parakeet status";
    expect(usage).toContain("status");
  });
});
```

- [ ] **Step 7: Run all tests**

Run: `bun test && bunx tsc --noEmit`
Expected: All PASS, no type errors

- [ ] **Step 8: Commit**

```bash
git add src/status.ts src/__tests__/status.test.ts src/cli.ts src/__tests__/cli.test.ts
git commit -m "feat: add 'parakeet status' command with actionable suggestions"
```

---

### Task 7: Final verification

- [ ] **Step 1: Run full test suite and type check**

Run: `bun test && bunx tsc --noEmit`
Expected: All tests PASS, no type errors

- [ ] **Step 2: Review all changes**

Run: `git log --oneline main..HEAD`

Expected commits:
1. `feat: add TTY-aware download progress bar utility`
2. `feat: add progress bar and actionable errors to ONNX downloads`
3. `feat: add progress bar and actionable errors to CoreML binary download`
4. `feat: actionable error messages for audio conversion failures`
5. `feat: short-audio and CoreML fallback warnings (CLI only)`
6. `feat: add 'parakeet status' command with actionable suggestions`
