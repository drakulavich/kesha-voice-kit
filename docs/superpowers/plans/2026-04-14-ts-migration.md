# TypeScript Migration Implementation Plan (Plan B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strip TypeScript to a thin CLI shell that calls `parakeet-engine` for all inference, removing `onnxruntime-node`, ffmpeg dependency, and the Swift binary.

**Architecture:** TypeScript CLI (`src/cli.ts`) dispatches to `parakeet-engine` binary via `Bun.spawn`. All ONNX inference code, audio processing, and Swift code removed. Dependencies reduced to `citty`, `picocolors`, `tinyld`.

**Tech Stack:** TypeScript (Bun), parakeet-engine (Rust binary via subprocess)

**Spec:** `docs/superpowers/specs/2026-04-14-rust-engine-design.md`

**Depends on:** Plan A (Rust Engine) — the `parakeet-engine` binary must exist.

---

## File Structure

### Remove entirely
- `src/preprocess.ts` — ONNX mel spectrogram (moved to Rust)
- `src/encoder.ts` — ONNX encoder (moved to Rust)
- `src/decoder.ts` — ONNX decoder (moved to Rust)
- `src/tokenizer.ts` — vocab loading (moved to Rust)
- `src/audio.ts` — ffmpeg audio conversion (moved to Rust/symphonia)
- `src/ort-backend-fix.ts` — CJS/ESM hack for onnxruntime-node
- `swift/` directory — replaced by Rust engine

### Rename and simplify
- `src/coreml.ts` → `src/engine.ts` — generic subprocess interface to `parakeet-engine`
- `src/coreml-install.ts` → `src/engine-install.ts` — download engine binary from GitHub Releases
- `src/lang-id.ts` — remove ONNX inference, delegate to `parakeet-engine detect-lang`
- `src/lang-id-install.ts` — remove model download (engine manages models via `parakeet-engine install`)

### Modify
- `src/cli.ts` — update imports, simplify install flow
- `src/transcribe.ts` — thin wrapper calling engine
- `src/lib.ts` — update public API
- `src/models.ts` — simplify re-exports
- `src/status.ts` — show engine status instead of separate backends
- `package.json` — remove `onnxruntime-node`, update version to 1.0.0

### Update tests
- `tests/unit/cli.test.ts` — update for new imports
- `tests/unit/coreml.test.ts` → `tests/unit/engine.test.ts`
- Remove: `tests/unit/audio.test.ts`, `tests/unit/decoder.test.ts`, `tests/unit/tokenizer.test.ts`, `tests/unit/transcribe.test.ts` (test ONNX pipeline that no longer exists)
- Keep: `tests/unit/progress.test.ts`, `tests/unit/status.test.ts`, `tests/unit/lib.test.ts`

---

### Task 1: Create `src/engine.ts` (replacing `src/coreml.ts`)

**Files:**
- Create: `src/engine.ts`
- Delete: `src/coreml.ts`

- [ ] **Step 1: Create `src/engine.ts`**

Generic subprocess interface to `parakeet-engine`:

```typescript
import { join } from "path";
import { homedir } from "os";
import { existsSync } from "fs";
import type { LangDetectResult } from "./lang-id";

export function getEngineBinPath(): string {
  return join(homedir(), ".cache", "parakeet", "engine", "bin", "parakeet-engine");
}

export function isEngineInstalled(): boolean {
  return existsSync(getEngineBinPath());
}

async function runEngine(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const binPath = getEngineBinPath();
  const proc = Bun.spawn([binPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
}

export async function transcribeEngine(audioPath: string): Promise<string> {
  const { stdout, stderr, exitCode } = await runEngine(["transcribe", audioPath]);
  if (exitCode !== 0) {
    throw new Error(stderr || `parakeet-engine exited with code ${exitCode}`);
  }
  return stdout;
}

export function parseLangResult(stdout: string): LangDetectResult | null {
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed.code !== "string" || typeof parsed.confidence !== "number") {
      return null;
    }
    return { code: parsed.code, confidence: parsed.confidence };
  } catch {
    return null;
  }
}

export async function detectAudioLanguageEngine(audioPath: string): Promise<LangDetectResult | null> {
  if (!isEngineInstalled()) return null;
  const { stdout, exitCode } = await runEngine(["detect-lang", audioPath]);
  if (exitCode !== 0) return null;
  return parseLangResult(stdout);
}

export async function detectTextLanguageEngine(text: string): Promise<LangDetectResult | null> {
  if (!isEngineInstalled()) return null;
  const { stdout, exitCode } = await runEngine(["detect-text-lang", text]);
  if (exitCode !== 0) return null;
  return parseLangResult(stdout);
}

export interface EngineCapabilities {
  protocolVersion: number;
  backend: string;
  features: string[];
}

export async function getEngineCapabilities(): Promise<EngineCapabilities | null> {
  if (!isEngineInstalled()) return null;
  const { stdout, exitCode } = await runEngine(["--capabilities-json"]);
  if (exitCode !== 0) return null;
  try {
    return JSON.parse(stdout) as EngineCapabilities;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Delete `src/coreml.ts`**
- [ ] **Step 3: Commit**

```bash
git add src/engine.ts && git rm src/coreml.ts
git commit -m "feat: replace coreml.ts with generic engine.ts subprocess interface"
```

---

### Task 2: Create `src/engine-install.ts` (replacing `src/coreml-install.ts`)

**Files:**
- Create: `src/engine-install.ts`
- Delete: `src/coreml-install.ts`

- [ ] **Step 1: Create `src/engine-install.ts`**

Downloads the platform-specific engine binary and runs `parakeet-engine install` for models:

```typescript
import { join, dirname } from "path";
import { existsSync, mkdirSync, chmodSync } from "fs";
import { getEngineBinPath } from "./engine";
import { log } from "./log";
import { streamResponseToFile } from "./progress";

const GITHUB_REPO = "drakulavich/kesha-cli";

function getEngineBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "darwin" && arch === "arm64") return "parakeet-engine-darwin-arm64";
  if (platform === "linux" && arch === "x64") return "parakeet-engine-linux-x64";
  if (platform === "win32" && arch === "x64") return "parakeet-engine-windows-x64.exe";

  throw new Error(`Unsupported platform: ${platform} ${arch}`);
}

export async function downloadEngine(noCache = false): Promise<string> {
  const binPath = getEngineBinPath();

  if (!noCache && existsSync(binPath)) {
    log.success("Engine binary already installed.");
  } else {
    const binaryName = getEngineBinaryName();
    const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
    const version = typeof pkg.version === "string" ? pkg.version : "unknown";
    const url = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${binaryName}`;

    mkdirSync(dirname(binPath), { recursive: true });

    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(
        `Failed to download engine binary (HTTP ${res.status})\n  Fix: Check https://github.com/${GITHUB_REPO}/releases for available versions`,
      );
    }

    await streamResponseToFile(res, binPath, "parakeet-engine binary");
    chmodSync(binPath, 0o755);
    log.success("Engine binary downloaded.");
  }

  // Run engine install to download models
  log.progress("Downloading models...");
  const proc = Bun.spawnSync([binPath, "install", ...(noCache ? ["--no-cache"] : [])], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.stderr.toString()) {
    process.stderr.write(proc.stderr.toString());
  }

  if (proc.exitCode !== 0) {
    throw new Error("Failed to download models");
  }

  log.success("Models installed successfully.");
  return binPath;
}
```

- [ ] **Step 2: Delete `src/coreml-install.ts`**
- [ ] **Step 3: Commit**

---

### Task 3: Simplify `src/transcribe.ts`

**Files:**
- Modify: `src/transcribe.ts`

- [ ] **Step 1: Replace with thin wrapper**

```typescript
import { isEngineInstalled, transcribeEngine } from "./engine";

export interface TranscribeOptions {
  silent?: boolean;
}

export async function transcribe(audioPath: string, opts: TranscribeOptions = {}): Promise<string> {
  if (!isEngineInstalled()) {
    const lines = [
      "Error: No transcription backend is installed",
      "",
      "Please run: parakeet install",
    ];
    throw new Error(lines.join("\n"));
  }

  return transcribeEngine(audioPath);
}
```

- [ ] **Step 2: Commit**

---

### Task 4: Simplify `src/lang-id.ts`

**Files:**
- Modify: `src/lang-id.ts`

- [ ] **Step 1: Replace with engine delegation**

```typescript
export interface LangDetectResult {
  code: string;
  confidence: number;
}

export { detectAudioLanguageEngine as detectAudioLanguage } from "./engine";
```

Remove all ONNX inference code, `ort` imports, session management.

- [ ] **Step 2: Commit**

---

### Task 5: Remove dead files and simplify `src/lang-id-install.ts`

**Files:**
- Delete: `src/preprocess.ts`, `src/encoder.ts`, `src/decoder.ts`, `src/tokenizer.ts`, `src/audio.ts`, `src/ort-backend-fix.ts`
- Delete: `swift/` directory
- Simplify: `src/lang-id-install.ts` (remove download logic, keep only cache check for status display)
- Delete: `src/onnx-install.ts` (model download now handled by engine)

- [ ] **Step 1: Delete files**
- [ ] **Step 2: Simplify `src/lang-id-install.ts`** to only export path/cache helpers for status display
- [ ] **Step 3: Commit**

---

### Task 6: Update `src/cli.ts`

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Update imports**

Replace:
```typescript
import { downloadModel } from "./onnx-install";
import { downloadCoreML } from "./coreml-install";
import { downloadLangIdOnnx, downloadLangIdCoreML } from "./lang-id-install";
import { isMacArm64 } from "./coreml";
import { detectAudioLanguageCoreML, detectTextLanguageCoreML } from "./coreml";
import { detectAudioLanguageOnnx } from "./lang-id";
```

With:
```typescript
import { downloadEngine } from "./engine-install";
import { detectAudioLanguageEngine, detectTextLanguageEngine } from "./engine";
```

- [ ] **Step 2: Simplify `performInstall`**

```typescript
async function performInstall(options: InstallOptions) {
  const { noCache } = options;
  try {
    await downloadEngine(noCache);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(message);
    process.exit(1);
  }
}
```

Remove `--coreml`/`--onnx` flags from install command (engine handles backend selection internally).

- [ ] **Step 3: Update transcription loop**

Replace `isMacArm64()` checks and dual backend calls with unified engine calls:
```typescript
const audioResult = await detectAudioLanguageEngine(file);
// ...
const coremlTextResult = await detectTextLanguageEngine(text);
```

- [ ] **Step 4: Commit**

---

### Task 7: Update `src/models.ts`, `src/lib.ts`, `src/status.ts`

**Files:**
- Simplify: `src/models.ts`
- Simplify: `src/lib.ts`
- Modify: `src/status.ts`

- [ ] **Step 1: Simplify `src/models.ts`**

```typescript
import { isEngineInstalled } from "./engine";
export { downloadEngine } from "./engine-install";

export function isModelInstalled(): boolean {
  return isEngineInstalled();
}
```

- [ ] **Step 2: Simplify `src/lib.ts`**

```typescript
import { existsSync } from "fs";
import { transcribe as internalTranscribe, type TranscribeOptions } from "./transcribe";
import { downloadEngine } from "./engine-install";

export type { TranscribeOptions };
export { downloadEngine as downloadModel };

export async function transcribe(audioPath: string, options: TranscribeOptions = {}): Promise<string> {
  if (!existsSync(audioPath)) {
    throw new Error(`File not found: ${audioPath}`);
  }
  return internalTranscribe(audioPath, { ...options, silent: true });
}
```

- [ ] **Step 3: Update `src/status.ts`** to show engine status instead of separate CoreML/ONNX

- [ ] **Step 4: Commit**

---

### Task 8: Update `package.json` and clean up tests

**Files:**
- Modify: `package.json`
- Update/delete test files

- [ ] **Step 1: Update `package.json`**

Remove dependencies:
- `onnxruntime-node`

Bump version to `1.0.0`.

- [ ] **Step 2: Clean up tests**

Delete tests for removed modules. Update remaining tests for new imports.

- [ ] **Step 3: Run tests**

```bash
bun test tests/unit/
bunx tsc --noEmit
```

- [ ] **Step 4: Commit**

---

### Task 9: Update smoke test and CI

**Files:**
- Modify: `scripts/smoke-test.ts`
- Modify: `.github/workflows/ci.yml`
- Delete: `.github/workflows/build-coreml.yml` (replaced by `build-engine.yml`)

- [ ] **Step 1: Update smoke test** to use engine binary
- [ ] **Step 2: Update CI** to install engine binary
- [ ] **Step 3: Remove old CoreML build workflow**
- [ ] **Step 4: Run smoke test**
- [ ] **Step 5: Commit**

---

### Task 10: Final verification

- [ ] **Step 1:** `bun test tests/unit/`
- [ ] **Step 2:** `bunx tsc --noEmit`
- [ ] **Step 3:** `bun scripts/smoke-test.ts`
- [ ] **Step 4:** Verify `parakeet install` works
- [ ] **Step 5:** Verify `parakeet --verbose`, `--json`, `--lang` flags work
- [ ] **Step 6:** Commit any fixes
