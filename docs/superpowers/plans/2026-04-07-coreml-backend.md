# CoreML Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CoreML as a fast transcription backend on macOS Apple Silicon via a pre-built Swift helper binary, falling back to ONNX on other platforms.

**Architecture:** A minimal Swift executable (`parakeet-coreml`) wraps FluidAudio for CoreML inference. `parakeet install` downloads the pre-built binary on macOS arm64, or ONNX models elsewhere. At transcription time, the runtime auto-detects the best available backend.

**Tech Stack:** Swift 6 + FluidAudio (CoreML binary), Bun + TypeScript (CLI/library), GitHub Actions (CI)

---

## File Map

### New files

| File | Responsibility |
|------|---------------|
| `swift/Package.swift` | Swift package manifest, depends on FluidAudio |
| `swift/Sources/ParakeetCoreML/main.swift` | Minimal Swift binary: load audio, transcribe, print text |
| `src/coreml.ts` | CoreML backend: detection, subprocess invocation |
| `.github/workflows/build-coreml.yml` | CI: build Swift binary, attach to GitHub release |

### Modified files

| File | Changes |
|------|---------|
| `src/models.ts` | Add `isMacArm64()`, `getCoreMLBinPath()`, `isCoreMLInstalled()`, `downloadCoreML()`. Update `requireModel` error to use `bunx`. |
| `src/transcribe.ts` | Try CoreML first, fall back to ONNX, error if neither |
| `src/cli.ts` | Smart install with `--coreml`/`--onnx` flags, updated usage |
| `src/lib.ts` | Re-export `downloadCoreML` |
| `package.json` | Version bump to 0.5.0 |

---

### Task 1: Swift helper binary

**Files:**
- Create: `swift/Package.swift`
- Create: `swift/Sources/ParakeetCoreML/main.swift`

- [ ] **Step 1: Create `swift/Package.swift`**

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ParakeetCoreML",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ParakeetCoreML",
            dependencies: [
                .product(name: "FluidAudio", package: "FluidAudio"),
            ]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "1.0.0"),
    ]
)
```

Note: Check the actual FluidAudio version tag on GitHub. If there are no semver tags, use `.branch("main")` instead of `from: "1.0.0"`.

- [ ] **Step 2: Create `swift/Sources/ParakeetCoreML/main.swift`**

```swift
import FluidAudio
import Foundation

@main
struct ParakeetCoreML {
    static func main() async {
        let arguments = CommandLine.arguments

        guard arguments.count >= 2 else {
            FileHandle.standardError.write(Data("Usage: parakeet-coreml <audio_file>\n".utf8))
            exit(1)
        }

        let audioPath = arguments[1]

        guard FileManager.default.fileExists(atPath: audioPath) else {
            FileHandle.standardError.write(Data("Error: File not found: \(audioPath)\n".utf8))
            exit(1)
        }

        do {
            let models = try await AsrModels.downloadAndLoad(version: .v3)
            let asr = AsrManager(config: .default)
            try await asr.initialize(models: models)
            let samples = try await AudioProcessor.loadAudioFile(path: audioPath)
            let result = try await asr.transcribe(samples, source: .system)
            print(result.text)
            asr.cleanup()
        } catch {
            FileHandle.standardError.write(Data("Error: \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }
}
```

Note: The exact FluidAudio API (`AsrModels.downloadAndLoad`, `AsrManager`, `AudioProcessor.loadAudioFile`, `asr.transcribe`, `result.text`) should be verified against the FluidAudio source. The examples on their HuggingFace model card and README show this pattern, but parameter names may differ. Build locally with `cd swift && swift build` to verify before committing.

- [ ] **Step 3: Verify it builds locally (macOS only)**

```bash
cd swift && swift build -c release 2>&1
```

Expected: successful build, binary at `.build/release/ParakeetCoreML`.

If FluidAudio doesn't have semver tags, update `Package.swift` to use `.branch("main")`:

```swift
.package(url: "https://github.com/FluidInference/FluidAudio.git", branch: "main"),
```

- [ ] **Step 4: Test the binary manually**

```bash
.build/release/ParakeetCoreML /path/to/test-audio.wav
```

Expected: prints transcribed text to stdout. On first run, FluidAudio downloads CoreML model files to its own cache (stderr progress output).

- [ ] **Step 5: Commit**

```bash
git add swift/Package.swift swift/Sources/ParakeetCoreML/main.swift
git commit -m "feat: add Swift helper binary for CoreML transcription"
```

---

### Task 2: GitHub Actions workflow for building the Swift binary

**Files:**
- Create: `.github/workflows/build-coreml.yml`

- [ ] **Step 1: Create `.github/workflows/build-coreml.yml`**

```yaml
name: Build CoreML Binary

on:
  release:
    types: [published]

jobs:
  build:
    runs-on: macos-15
    defaults:
      run:
        working-directory: swift
    steps:
      - uses: actions/checkout@v4

      - name: Build release binary
        run: swift build -c release

      - name: Prepare artifact
        run: |
          cp .build/release/ParakeetCoreML parakeet-coreml-darwin-arm64
          chmod +x parakeet-coreml-darwin-arm64

      - name: Upload to release
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release upload "${{ github.event.release.tag_name }}" parakeet-coreml-darwin-arm64 --repo "${{ github.repository }}"
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/build-coreml.yml
git commit -m "ci: add workflow to build CoreML binary on release"
```

---

### Task 3: CoreML backend module (`src/coreml.ts`)

**Files:**
- Create: `src/coreml.ts`
- Create: `src/__tests__/coreml.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/__tests__/coreml.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { getCoreMLBinPath, isMacArm64, isCoreMLInstalled } from "../coreml";
import { join } from "path";
import { homedir } from "os";

describe("coreml", () => {
  test("getCoreMLBinPath returns correct path", () => {
    expect(getCoreMLBinPath()).toBe(
      join(homedir(), ".cache", "parakeet", "coreml", "bin", "parakeet-coreml")
    );
  });

  test("isMacArm64 returns boolean", () => {
    const result = isMacArm64();
    expect(typeof result).toBe("boolean");
    // On macOS arm64 this should be true, on CI (ubuntu) false
    if (process.platform === "darwin" && process.arch === "arm64") {
      expect(result).toBe(true);
    } else {
      expect(result).toBe(false);
    }
  });

  test("isCoreMLInstalled returns boolean", () => {
    // Without the binary installed, should return false (unless dev has it)
    expect(typeof isCoreMLInstalled()).toBe("boolean");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/__tests__/coreml.test.ts
```

Expected: FAIL — module `../coreml` does not exist.

- [ ] **Step 3: Implement `src/coreml.ts`**

```typescript
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

export function isMacArm64(): boolean {
  return process.platform === "darwin" && process.arch === "arm64";
}

export function getCoreMLBinPath(): string {
  return join(homedir(), ".cache", "parakeet", "coreml", "bin", "parakeet-coreml");
}

export function isCoreMLInstalled(): boolean {
  return isMacArm64() && existsSync(getCoreMLBinPath());
}

export async function transcribeCoreML(audioPath: string): Promise<string> {
  const binPath = getCoreMLBinPath();

  const proc = Bun.spawn([binPath, audioPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `parakeet-coreml exited with code ${exitCode}`);
  }

  return stdout.trim();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/__tests__/coreml.test.ts
```

Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/coreml.ts src/__tests__/coreml.test.ts
git commit -m "feat: add CoreML backend detection and subprocess invocation"
```

---

### Task 4: CoreML binary download in `src/models.ts`

**Files:**
- Modify: `src/models.ts`
- Modify: `src/__tests__/models.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/__tests__/models.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { getModelDir, MODEL_FILES, HF_REPO, getCoreMLDownloadURL } from "../models";
import { join } from "path";
import { homedir } from "os";

describe("models", () => {
  test("getModelDir returns correct cache path", () => {
    const dir = getModelDir();
    expect(dir).toBe(join(homedir(), ".cache", "parakeet", "v3"));
  });

  test("MODEL_FILES lists required files", () => {
    expect(MODEL_FILES).toContain("encoder-model.onnx");
    expect(MODEL_FILES).toContain("encoder-model.onnx.data");
    expect(MODEL_FILES).toContain("decoder_joint-model.onnx");
    expect(MODEL_FILES).toContain("nemo128.onnx");
    expect(MODEL_FILES).toContain("vocab.txt");
  });

  test("HF_REPO points to v3 ONNX repo", () => {
    expect(HF_REPO).toBe("istupakov/parakeet-tdt-0.6b-v3-onnx");
  });

  test("getCoreMLDownloadURL includes version and correct filename", () => {
    const url = getCoreMLDownloadURL("0.5.0");
    expect(url).toBe(
      "https://github.com/drakulavich/parakeet-cli/releases/download/v0.5.0/parakeet-coreml-darwin-arm64"
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test src/__tests__/models.test.ts
```

Expected: FAIL — `getCoreMLDownloadURL` is not exported.

- [ ] **Step 3: Add CoreML download functions to `src/models.ts`**

Add these after the existing `downloadModel` function at the end of `src/models.ts`:

```typescript
export function getCoreMLDownloadURL(version: string): string {
  return `https://github.com/drakulavich/parakeet-cli/releases/download/v${version}/parakeet-coreml-darwin-arm64`;
}

export async function downloadCoreML(noCache = false): Promise<string> {
  const { getCoreMLBinPath } = await import("./coreml");
  const binPath = getCoreMLBinPath();

  if (!noCache && existsSync(binPath)) {
    console.error("CoreML backend already installed.");
    return binPath;
  }

  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const url = getCoreMLDownloadURL(pkg.version);

  console.error("Downloading parakeet-coreml binary...");

  const res = await fetch(url, { redirect: "follow" });

  if (!res.ok) {
    throw new Error(`Failed to download CoreML binary: ${url} (${res.status})`);
  }

  const dir = join(binPath, "..");
  mkdirSync(dir, { recursive: true });

  await Bun.write(binPath, res);

  const { chmodSync } = await import("fs");
  chmodSync(binPath, 0o755);

  console.error("CoreML backend installed successfully.");
  return binPath;
}
```

Also update the `requireModel` error message — change `npx` to `bunx`:

In `src/models.ts`, in the `requireModel` function, change:

```typescript
      "║     npx @drakulavich/parakeet-cli install                ║",
```

to:

```typescript
      "║     bunx @drakulavich/parakeet-cli install               ║",
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test src/__tests__/models.test.ts
```

Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/models.ts src/__tests__/models.test.ts
git commit -m "feat: add CoreML binary download and fix install command in error"
```

---

### Task 5: Update `src/transcribe.ts` for dual-backend support

**Files:**
- Modify: `src/transcribe.ts`

- [ ] **Step 1: Add CoreML-first logic to `src/transcribe.ts`**

Replace the current `transcribe` function. The full updated file:

```typescript
import { requireModel } from "./models";
import { isCoreMLInstalled, transcribeCoreML } from "./coreml";
import { isModelCached } from "./models";
import { convertToFloat32PCM } from "./audio";
import { initPreprocessor, preprocess } from "./preprocess";
import { initEncoder, encode } from "./encoder";
import {
  initDecoder,
  createOnnxDecoderSession,
  beamDecode,
} from "./decoder";
import { Tokenizer } from "./tokenizer";
import { join } from "path";

function transpose2D(data: Float32Array, rows: number, cols: number): Float32Array {
  const out = new Float32Array(cols * rows);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      out[c * rows + r] = data[r * cols + c];
    }
  }
  return out;
}

// Parakeet TDT 0.6B decoder state dimensions (from ONNX model input shapes)
const DECODER_LAYERS = 2;
const DECODER_HIDDEN = 640;

export interface TranscribeOptions {
  beamWidth?: number;
  modelDir?: string;
}

// Minimum 0.1s of audio at 16kHz to produce meaningful output
const MIN_AUDIO_SAMPLES = 1600;

export async function transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<string> {
  // CoreML backend: preferred on macOS arm64 when installed
  if (isCoreMLInstalled()) {
    return transcribeCoreML(audioPath);
  }

  // ONNX backend: fallback
  if (isModelCached(opts.modelDir)) {
    return transcribeOnnx(audioPath, opts);
  }

  // Neither backend available
  const lines = [
    "Error: No backend available",
    "",
    "╔══════════════════════════════════════════════════════════╗",
    "║ No transcription backend is installed.                   ║",
    "║ Please run the following command to get started:         ║",
    "║                                                          ║",
    "║     bunx @drakulavich/parakeet-cli install               ║",
    "╚══════════════════════════════════════════════════════════╝",
  ];
  throw new Error(lines.join("\n"));
}

async function transcribeOnnx(audioPath: string, opts: TranscribeOptions): Promise<string> {
  const audio = await convertToFloat32PCM(audioPath);

  if (audio.length < MIN_AUDIO_SAMPLES) {
    return "";
  }

  const beamWidth = opts.beamWidth ?? 4;
  const modelDir = requireModel(opts.modelDir);
  const tokenizer = await Tokenizer.fromFile(join(modelDir, "vocab.txt"));

  await initPreprocessor(modelDir);
  await initEncoder(modelDir);
  await initDecoder(modelDir);

  const { features, length } = await preprocess(audio);
  const { encoderOutput, encodedLength } = await encode(features, length);

  const encoderData = encoderOutput.data as Float32Array;
  const dims = encoderOutput.dims as readonly number[];
  const D = dims[1];
  const T = dims[2];

  const transposed = transpose2D(encoderData, D, T);

  const session = createOnnxDecoderSession(
    tokenizer.vocabSize,
    tokenizer.blankId,
    DECODER_LAYERS,
    DECODER_HIDDEN,
  );

  const tokens = await beamDecode(session, encodedLength, transposed, D, beamWidth);
  return tokenizer.detokenize(tokens);
}
```

- [ ] **Step 2: Run all unit tests**

```bash
bun test src/__tests__/
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/transcribe.ts
git commit -m "feat: try CoreML backend first, fall back to ONNX"
```

---

### Task 6: Update `src/cli.ts` for smart install

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Update `src/cli.ts` with `--coreml`/`--onnx` flags**

Full updated file:

```typescript
#!/usr/bin/env bun

import { transcribe } from "./lib";
import { downloadModel, downloadCoreML } from "./models";
import { isMacArm64 } from "./coreml";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes("--version")) {
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    console.log(pkg.version);
    process.exit(0);
  }

  const positional = args.filter((a) => !a.startsWith("--"));

  if (positional[0] === "install") {
    const noCache = args.includes("--no-cache");
    const forceCoreML = args.includes("--coreml");
    const forceOnnx = args.includes("--onnx");

    try {
      if (forceCoreML) {
        if (!isMacArm64()) {
          console.error("Error: CoreML backend is only available on macOS Apple Silicon.");
          process.exit(1);
        }
        await downloadCoreML(noCache);
      } else if (forceOnnx) {
        await downloadModel(noCache);
      } else if (isMacArm64()) {
        await downloadCoreML(noCache);
      } else {
        await downloadModel(noCache);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  const file = positional[0];

  if (!file) {
    console.error("Usage: parakeet [--version] <audio_file>");
    console.error("       parakeet install [--coreml | --onnx] [--no-cache]");
    process.exit(1);
  }

  try {
    const text = await transcribe(file);
    if (text) process.stdout.write(text + "\n");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  }
}

main();
```

- [ ] **Step 2: Run e2e CLI tests**

```bash
bun test tests/integration/e2e-cli.test.ts
```

Expected: all 3 tests pass (version, usage, missing file).

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: smart install with --coreml/--onnx flags"
```

---

### Task 7: Update `src/lib.ts` and version bump

**Files:**
- Modify: `src/lib.ts`
- Modify: `package.json`

- [ ] **Step 1: Update `src/lib.ts` to re-export `downloadCoreML`**

```typescript
import { existsSync } from "fs";
import { transcribe as internalTranscribe, type TranscribeOptions } from "./transcribe";
import { downloadModel, downloadCoreML } from "./models";

export type { TranscribeOptions };
export { downloadModel, downloadCoreML };

export async function transcribe(
  audioPath: string,
  options: TranscribeOptions = {},
): Promise<string> {
  if (!existsSync(audioPath)) {
    throw new Error(`File not found: ${audioPath}`);
  }

  return internalTranscribe(audioPath, options);
}
```

- [ ] **Step 2: Bump version in `package.json`**

Change `"version": "0.4.0"` to `"version": "0.5.0"` in `package.json`.

- [ ] **Step 3: Run all tests**

```bash
bun test
```

Expected: all unit and integration tests pass.

- [ ] **Step 4: Run type check**

```bash
bunx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib.ts package.json
git commit -m "feat: export downloadCoreML, bump to 0.5.0"
```

---

### Task 8: Final verification

- [ ] **Step 1: Run full test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 2: Verify CLI usage output**

```bash
bun run src/cli.ts
```

Expected:
```
Usage: parakeet [--version] <audio_file>
       parakeet install [--coreml | --onnx] [--no-cache]
```

- [ ] **Step 3: Verify install help for non-macOS (or without binary)**

```bash
bun run src/cli.ts nonexistent.wav
```

Expected: error message about file not found.

- [ ] **Step 4: Verify type check passes**

```bash
bunx tsc --noEmit
```

Expected: no errors.
