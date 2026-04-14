# CoreML Language Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add pre-transcription audio language detection (ECAPA-TDNN via CoreML/ONNX) and post-transcription text language detection (NLLanguageRecognizer on macOS) while keeping `tinyld` as the baseline on all platforms.

**Architecture:** Lazy audio lang-id (only with `--lang`/`--verbose`/`--json`) using SpeechBrain ECAPA-TDNN model in both CoreML and ONNX backends. Always-on text lang-id via `NLLanguageRecognizer` on macOS (priority over `tinyld`), with `tinyld` remaining as baseline everywhere. Models pre-converted and hosted on HuggingFace.

**Tech Stack:** TypeScript (Bun), Swift (NaturalLanguage framework), onnxruntime-node, CoreML

**Spec:** `docs/superpowers/specs/2026-04-12-coreml-lang-detection-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/lang-id.ts` | New: ONNX ECAPA-TDNN audio lang-id inference |
| `src/lang-id-install.ts` | New: Download lang-id models (ONNX + CoreML) from HuggingFace |
| `src/cli.ts` | Modify: Add `--verbose` flag, lazy lang-id trigger, updated output formatting |
| `src/transcribe.ts` | Modify: Integrate pre/post lang-id into pipeline |
| `src/coreml.ts` | Modify: Add helpers to invoke `detect-lang` and `detect-text-lang` subcommands |
| `src/coreml-install.ts` | Modify: Download CoreML lang-id model during `parakeet install` |
| `src/onnx-install.ts` | Modify: Download ONNX lang-id model during `parakeet install` |
| `src/lib.ts` | Modify: Expose `LangDetectResult` type, update `TranscribeOptions` |
| `swift/Sources/ParakeetCoreML/main.swift` | Modify: Add `detect-lang` and `detect-text-lang` subcommands |
| `swift/Package.swift` | No change needed — `NaturalLanguage` is a system framework, imported directly |
| `tests/unit/lang-id.test.ts` | New: Unit tests for ONNX lang-id module |
| `tests/unit/lang-id-install.test.ts` | New: Unit tests for lang-id model download |
| `tests/unit/cli.test.ts` | Modify: Tests for `--verbose`, new JSON fields, lang-id integration |
| `tests/unit/coreml.test.ts` | Modify: Tests for new CoreML subcommand helpers |

---

### Task 1: Model Conversion Script (One-Time Tooling)

**Files:**
- Create: `scripts/convert-lang-id-model.py`

This is a one-time script you run locally to convert the SpeechBrain model. Not shipped to users.

- [ ] **Step 1: Create the conversion script**

```python
#!/usr/bin/env python3
"""Convert speechbrain/lang-id-voxlingua107-ecapa to ONNX and CoreML."""

import torch
import coremltools as ct
from speechbrain.inference.classifiers import EncoderClassifier

# Load the SpeechBrain model
classifier = EncoderClassifier.from_hparams(
    source="speechbrain/lang-id-voxlingua107-ecapa",
    savedir="tmp/lang-id-model",
)

# The model expects: waveform [batch, time] at 16kHz
# Output: language probabilities [batch, num_languages]

# Extract the encoder model for export
model = classifier.mods["embedding_model"]
model.eval()

# Create dummy input: 10 seconds of 16kHz audio
dummy_input = torch.randn(1, 160000)

# The full pipeline: compute_features -> embedding_model -> classifier
# We need to export the full inference chain

class LangIdWrapper(torch.nn.Module):
    def __init__(self, classifier):
        super().__init__()
        self.classifier = classifier

    def forward(self, wavs):
        wavs = wavs.to(next(self.classifier.mods.parameters()).device)
        feats = self.classifier.mods.compute_features(wavs)
        feats = self.classifier.mods.mean_var_norm(feats, torch.ones(1))
        embeddings = self.classifier.mods.embedding_model(feats)
        outputs = self.classifier.mods.classifier(embeddings)
        return outputs.squeeze(1)

wrapper = LangIdWrapper(classifier)
wrapper.eval()

# Export to ONNX
print("Exporting to ONNX...")
torch.onnx.export(
    wrapper,
    dummy_input,
    "lang-id-ecapa.onnx",
    input_names=["waveform"],
    output_names=["language_probs"],
    dynamic_axes={
        "waveform": {0: "batch", 1: "time"},
        "language_probs": {0: "batch"},
    },
    opset_version=17,
)
print("ONNX export complete: lang-id-ecapa.onnx")

# Export to CoreML
print("Exporting to CoreML...")
traced = torch.jit.trace(wrapper, dummy_input)
mlmodel = ct.convert(
    traced,
    inputs=[ct.TensorType(name="waveform", shape=ct.Shape((1, ct.RangeDim(16000, 480000))))],
    compute_units=ct.ComputeUnit.ALL,
    minimum_deployment_target=ct.target.macOS14,
)
mlmodel.save("lang-id-ecapa.mlpackage")
print("CoreML export complete: lang-id-ecapa.mlpackage")
```

- [ ] **Step 2: Run the conversion locally**

```bash
pip install speechbrain coremltools torch onnx
python scripts/convert-lang-id-model.py
```

Expected: Two files produced — `lang-id-ecapa.onnx` (~20MB) and `lang-id-ecapa.mlpackage` (~20MB).

Note: The wrapper class and export parameters may need adjustment based on the actual SpeechBrain model internals. Verify the ONNX model works with `onnxruntime` and the CoreML model works with Swift before publishing.

- [ ] **Step 3: Verify the ONNX model**

```python
import onnxruntime as ort
import numpy as np

session = ort.InferenceSession("lang-id-ecapa.onnx")
dummy = np.random.randn(1, 160000).astype(np.float32)
result = session.run(None, {"waveform": dummy})
print(f"Output shape: {result[0].shape}")  # Should be [1, 107]
print(f"Sum of probs: {result[0].sum()}")  # Should be ~1.0 (softmax)
```

- [ ] **Step 4: Publish to HuggingFace**

```bash
# Create repo and upload
huggingface-cli repo create drakulavich/parakeet-lang-id-ecapa --type model
huggingface-cli upload drakulavich/parakeet-lang-id-ecapa lang-id-ecapa.onnx
huggingface-cli upload drakulavich/parakeet-lang-id-ecapa lang-id-ecapa.mlpackage
```

Also upload a `labels.json` mapping index → ISO 639-1 code (extracted from the SpeechBrain model's label encoder).

- [ ] **Step 5: Commit the conversion script**

```bash
git add scripts/convert-lang-id-model.py
git commit -m "chore: add lang-id model conversion script (ECAPA-TDNN → ONNX + CoreML)"
```

---

### Task 2: Lang-ID Model Download (`src/lang-id-install.ts`)

**Files:**
- Create: `src/lang-id-install.ts`
- Create: `tests/unit/lang-id-install.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/lang-id-install.test.ts
import { describe, test, expect } from "bun:test";
import {
  getLangIdOnnxDir,
  getLangIdCoreMLDir,
  LANG_ID_ONNX_FILES,
  LANG_ID_COREML_FILES,
  isLangIdOnnxCached,
  isLangIdCoreMLCached,
} from "../../src/lang-id-install";

describe("lang-id install paths", () => {
  test("ONNX dir is under ~/.cache/parakeet", () => {
    const dir = getLangIdOnnxDir();
    expect(dir).toContain(".cache/parakeet");
    expect(dir).toContain("lang-id");
  });

  test("CoreML dir is under ~/.cache/parakeet", () => {
    const dir = getLangIdCoreMLDir();
    expect(dir).toContain(".cache/parakeet");
    expect(dir).toContain("lang-id");
  });

  test("ONNX files list includes model and labels", () => {
    expect(LANG_ID_ONNX_FILES).toContain("lang-id-ecapa.onnx");
    expect(LANG_ID_ONNX_FILES).toContain("labels.json");
  });

  test("CoreML files list includes mlpackage marker and labels", () => {
    expect(LANG_ID_COREML_FILES).toContain("labels.json");
  });

  test("isLangIdOnnxCached returns false when files missing", () => {
    expect(isLangIdOnnxCached("/nonexistent/path")).toBe(false);
  });

  test("isLangIdCoreMLCached returns false when files missing", () => {
    expect(isLangIdCoreMLCached("/nonexistent/path")).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/lang-id-install.test.ts`
Expected: FAIL — module `../../src/lang-id-install` not found

- [ ] **Step 3: Implement `src/lang-id-install.ts`**

```typescript
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";
import { log } from "./log";
import { streamResponseToFile } from "./progress";

export const LANG_ID_HF_REPO = "drakulavich/parakeet-lang-id-ecapa";

export const LANG_ID_ONNX_FILES = [
  "lang-id-ecapa.onnx",
  "labels.json",
];

export const LANG_ID_COREML_FILES = [
  "labels.json",
];

export function getLangIdOnnxDir(): string {
  return join(homedir(), ".cache", "parakeet", "lang-id", "onnx");
}

export function getLangIdCoreMLDir(): string {
  return join(homedir(), ".cache", "parakeet", "lang-id", "coreml");
}

export function isLangIdOnnxCached(dir?: string): boolean {
  const resolvedDir = dir ?? getLangIdOnnxDir();
  return LANG_ID_ONNX_FILES.every((file) => existsSync(join(resolvedDir, file)));
}

export function isLangIdCoreMLCached(dir?: string): boolean {
  const resolvedDir = dir ?? getLangIdCoreMLDir();
  // mlpackage is a directory; check it exists plus labels
  return (
    existsSync(join(resolvedDir, "lang-id-ecapa.mlpackage")) &&
    LANG_ID_COREML_FILES.every((file) => existsSync(join(resolvedDir, file)))
  );
}

async function downloadFromHF(files: string[], destDir: string, noCache: boolean): Promise<void> {
  mkdirSync(destDir, { recursive: true });

  for (const file of files) {
    const dest = join(destDir, file);

    if (!noCache && existsSync(dest)) continue;

    const url = `https://huggingface.co/${LANG_ID_HF_REPO}/resolve/main/${file}`;

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

    const bytes = await streamResponseToFile(res, dest, `lang-id: ${file}`);

    if (bytes === 0) {
      throw new Error(
        `Downloaded 0 bytes for ${file}\n  Fix: Try again — the server may be temporarily unavailable`,
      );
    }
  }
}

export async function downloadLangIdOnnx(noCache = false, dir?: string): Promise<string> {
  const destDir = dir ?? getLangIdOnnxDir();

  if (!noCache && isLangIdOnnxCached(destDir)) {
    log.success("Lang-ID ONNX model already downloaded.");
    return destDir;
  }

  await downloadFromHF(LANG_ID_ONNX_FILES, destDir, noCache);
  log.success("Lang-ID ONNX model downloaded.");
  return destDir;
}

export async function downloadLangIdCoreML(noCache = false, dir?: string): Promise<string> {
  const destDir = dir ?? getLangIdCoreMLDir();

  if (!noCache && isLangIdCoreMLCached(destDir)) {
    log.success("Lang-ID CoreML model already downloaded.");
    return destDir;
  }

  // mlpackage is a directory — download as tar and extract, or download individual files
  // For simplicity, we download a tar.gz archive of the mlpackage
  const files = ["lang-id-ecapa.mlpackage.tar.gz", ...LANG_ID_COREML_FILES];
  await downloadFromHF(files, destDir, noCache);

  // Extract the mlpackage tar.gz
  const tarPath = join(destDir, "lang-id-ecapa.mlpackage.tar.gz");
  const proc = Bun.spawn(["tar", "xzf", tarPath, "-C", destDir], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error("Failed to extract lang-id CoreML model");
  }

  log.success("Lang-ID CoreML model downloaded.");
  return destDir;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/lang-id-install.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lang-id-install.ts tests/unit/lang-id-install.test.ts
git commit -m "feat: add lang-id model download module (ONNX + CoreML)"
```

---

### Task 3: ONNX Audio Lang-ID Inference (`src/lang-id.ts`)

**Files:**
- Create: `src/lang-id.ts`
- Create: `tests/unit/lang-id.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/unit/lang-id.test.ts
import { describe, test, expect } from "bun:test";
import {
  type LangDetectResult,
  pickTopLanguage,
} from "../../src/lang-id";

describe("lang-id", () => {
  test("pickTopLanguage returns highest probability language", () => {
    const probs = new Float32Array(107).fill(0);
    probs[42] = 0.95; // index 42 = some language
    const labels = Array.from({ length: 107 }, (_, i) => `lang${i}`);
    labels[42] = "ru";

    const result = pickTopLanguage(probs, labels);
    expect(result.code).toBe("ru");
    expect(result.confidence).toBeCloseTo(0.95, 2);
  });

  test("pickTopLanguage handles all-zero probabilities", () => {
    const probs = new Float32Array(107).fill(0);
    const labels = Array.from({ length: 107 }, (_, i) => `lang${i}`);

    const result = pickTopLanguage(probs, labels);
    expect(result.code).toBe("lang0");
    expect(result.confidence).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/lang-id.test.ts`
Expected: FAIL — module `../../src/lang-id` not found

- [ ] **Step 3: Implement `src/lang-id.ts`**

```typescript
import * as ort from "onnxruntime-node";
import { join } from "path";
import { ensureOrtBackend } from "./ort-backend-fix";
import { getLangIdOnnxDir, isLangIdOnnxCached } from "./lang-id-install";
import { convertToFloat32PCM } from "./audio";

export interface LangDetectResult {
  code: string;
  confidence: number;
}

let session: ort.InferenceSession | null = null;
let labels: string[] | null = null;

// Max 10 seconds of audio at 16kHz for lang-id
const MAX_LANG_ID_SAMPLES = 160000;

export function pickTopLanguage(probs: Float32Array, labelList: string[]): LangDetectResult {
  let maxIdx = 0;
  let maxVal = probs[0];
  for (let i = 1; i < probs.length; i++) {
    if (probs[i] > maxVal) {
      maxVal = probs[i];
      maxIdx = i;
    }
  }
  return { code: labelList[maxIdx], confidence: maxVal };
}

async function loadLabels(modelDir: string): Promise<string[]> {
  const labelsPath = join(modelDir, "labels.json");
  const data = await Bun.file(labelsPath).json();
  return data as string[];
}

async function initLangId(modelDir: string): Promise<void> {
  if (session && labels) return;
  ensureOrtBackend();
  session = await ort.InferenceSession.create(join(modelDir, "lang-id-ecapa.onnx"));
  labels = await loadLabels(modelDir);
}

export async function detectAudioLanguageOnnx(audioPath: string, modelDir?: string): Promise<LangDetectResult | null> {
  const dir = modelDir ?? getLangIdOnnxDir();

  if (!isLangIdOnnxCached(dir)) {
    return null;
  }

  await initLangId(dir);

  if (!session || !labels) {
    return null;
  }

  // Convert audio to PCM, take first 10s
  const pcm = await convertToFloat32PCM(audioPath);
  const samples = pcm.length > MAX_LANG_ID_SAMPLES
    ? pcm.slice(0, MAX_LANG_ID_SAMPLES)
    : pcm;

  const inputTensor = new ort.Tensor("float32", samples, [1, samples.length]);
  const results = await session.run({ waveform: inputTensor });
  const probs = results["language_probs"].data as Float32Array;

  return pickTopLanguage(probs, labels);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/lang-id.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lang-id.ts tests/unit/lang-id.test.ts
git commit -m "feat: add ONNX audio language detection module (ECAPA-TDNN)"
```

---

### Task 4: Swift Binary — `detect-lang` and `detect-text-lang` Subcommands

**Files:**
- Modify: `swift/Sources/ParakeetCoreML/main.swift`

- [ ] **Step 1: Add `detect-text-lang` subcommand to `main.swift`**

Add this before the `guard args.count >= 2` line (before line 97):

```swift
import NaturalLanguage

// Detect language of text using NLLanguageRecognizer
if args.count >= 3 && args[1] == "detect-text-lang" {
    let text = args[2]
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(text)

    guard let lang = recognizer.dominantLanguage else {
        let result: [String: Any] = ["code": "", "confidence": 0.0]
        let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        exit(0)
    }

    let hypotheses = recognizer.languageHypotheses(withMaximum: 1)
    let confidence = hypotheses[lang] ?? 0.0

    let result: [String: Any] = [
        "code": lang.rawValue,
        "confidence": confidence,
    ]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(0)
}
```

- [ ] **Step 2: Add `detect-lang` subcommand for audio lang-id via CoreML**

Add this after the `detect-text-lang` block:

```swift
// Detect spoken language from audio using CoreML ECAPA-TDNN model
if args.count >= 3 && args[1] == "detect-lang" {
    let audioPath = args[2]

    guard FileManager.default.fileExists(atPath: audioPath) else {
        writeToStderr("Error: file not found: \(audioPath)\n")
        exit(1)
    }

    do {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let modelDir = home
            .appendingPathComponent(".cache", isDirectory: true)
            .appendingPathComponent("parakeet", isDirectory: true)
            .appendingPathComponent("lang-id", isDirectory: true)
            .appendingPathComponent("coreml", isDirectory: true)
        let modelPath = modelDir.appendingPathComponent("lang-id-ecapa.mlpackage")

        guard FileManager.default.fileExists(atPath: modelPath.path) else {
            writeToStderr("Error: lang-id CoreML model not found. Run 'parakeet install' first.\n")
            exit(1)
        }

        // Load the CoreML model
        let config = MLModelConfiguration()
        config.computeUnits = .all
        let model = try MLModel(contentsOf: modelPath, configuration: config)

        // Load and resample audio to 16kHz mono, take first 10s
        let samples = try AudioConverter().resampleAudioFile(path: audioPath)
        let maxSamples = min(samples.count, 160000) // 10s at 16kHz
        let truncated = Array(samples.prefix(maxSamples))

        // Create MLMultiArray input
        let inputArray = try MLMultiArray(shape: [1, NSNumber(value: truncated.count)], dataType: .float32)
        for (i, sample) in truncated.enumerated() {
            inputArray[i] = NSNumber(value: sample)
        }

        // Run inference
        let inputFeature = try MLDictionaryFeatureProvider(
            dictionary: ["waveform": MLFeatureValue(multiArray: inputArray)]
        )
        let prediction = try model.prediction(from: inputFeature)
        guard let outputArray = prediction.featureValue(for: "language_probs")?.multiArrayValue else {
            throw NSError(domain: "ParakeetCoreML", code: 1, userInfo: [NSLocalizedDescriptionKey: "No output from lang-id model"])
        }

        // Load labels
        let labelsPath = modelDir.appendingPathComponent("labels.json")
        let labelsData = try Data(contentsOf: labelsPath)
        let labels = try JSONDecoder().decode([String].self, from: labelsData)

        // Find top prediction
        var maxIdx = 0
        var maxVal: Float = 0
        for i in 0..<outputArray.count {
            let val = outputArray[i].floatValue
            if val > maxVal {
                maxVal = val
                maxIdx = i
            }
        }

        let result: [String: Any] = [
            "code": maxIdx < labels.count ? labels[maxIdx] : "",
            "confidence": Double(maxVal),
        ]
        let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } catch {
        writeToStderr("Error: \(error.localizedDescription)\n")
        exit(1)
    }
    exit(0)
}
```

- [ ] **Step 3: Update the usage string**

Replace the existing usage line (line 98):

```swift
guard args.count >= 2 else {
    writeToStderr("Usage: parakeet-coreml [--capabilities-json] [--check-install] [--download-only] [detect-lang <audio>] [detect-text-lang <text>] <audio-file-path>\n")
    exit(1)
}
```

- [ ] **Step 4: Verify it compiles**

```bash
cd swift && swift build 2>&1 | tail -5
```

Expected: Build succeeded (or warnings only, no errors). Note: `import CoreML` is needed — add `import CoreML` at the top alongside `import FluidAudio` and `import Foundation`.

- [ ] **Step 5: Commit**

```bash
git add swift/Sources/ParakeetCoreML/main.swift
git commit -m "feat: add detect-lang and detect-text-lang subcommands to Swift binary"
```

---

### Task 5: CoreML Helpers in TypeScript (`src/coreml.ts`)

**Files:**
- Modify: `src/coreml.ts`
- Modify: `tests/unit/coreml.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/coreml.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import {
  shouldRetryCoreMLWithWav,
  parseLangDetectResult,
} from "../../src/coreml";

// ... existing tests ...

describe("coreml lang-id helpers", () => {
  test("parseLangDetectResult parses valid JSON", () => {
    const result = parseLangDetectResult('{"code":"ru","confidence":0.94}');
    expect(result).toEqual({ code: "ru", confidence: 0.94 });
  });

  test("parseLangDetectResult returns null for invalid JSON", () => {
    const result = parseLangDetectResult("not json");
    expect(result).toBeNull();
  });

  test("parseLangDetectResult returns null for empty string", () => {
    const result = parseLangDetectResult("");
    expect(result).toBeNull();
  });

  test("parseLangDetectResult returns null for missing code field", () => {
    const result = parseLangDetectResult('{"confidence":0.94}');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/coreml.test.ts`
Expected: FAIL — `parseLangDetectResult` is not exported

- [ ] **Step 3: Add lang-id helpers to `src/coreml.ts`**

Add at the end of the file:

```typescript
import type { LangDetectResult } from "./lang-id";

export function parseLangDetectResult(stdout: string): LangDetectResult | null {
  try {
    const parsed = JSON.parse(stdout.trim());
    if (typeof parsed.code !== "string" || typeof parsed.confidence !== "number") {
      return null;
    }
    return { code: parsed.code, confidence: parsed.confidence };
  } catch {
    return null;
  }
}

export async function detectAudioLanguageCoreML(audioPath: string): Promise<LangDetectResult | null> {
  if (!isCoreMLInstalled()) return null;

  const binPath = getCoreMLBinPath();
  const proc = Bun.spawn([binPath, "detect-lang", audioPath], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) return null;
  return parseLangDetectResult(stdout);
}

export async function detectTextLanguageCoreML(text: string): Promise<LangDetectResult | null> {
  if (!isCoreMLInstalled()) return null;

  const binPath = getCoreMLBinPath();
  const proc = Bun.spawn([binPath, "detect-text-lang", text], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, , exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) return null;
  return parseLangDetectResult(stdout);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/coreml.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/coreml.ts tests/unit/coreml.test.ts
git commit -m "feat: add CoreML lang-id helpers (detect-lang, detect-text-lang)"
```

---

### Task 6: Integrate Lang-ID into Install Flow

**Files:**
- Modify: `src/cli.ts` (install command)
- Modify: `src/onnx-install.ts` (re-export lang-id download)

- [ ] **Step 1: Update `performInstall` in `src/cli.ts`**

Add lang-id model download after the backend install. Replace the `performInstall` function:

```typescript
import { downloadLangIdOnnx, downloadLangIdCoreML } from "./lang-id-install";

async function performInstall(options: InstallOptions) {
  const { noCache } = options;
  try {
    const backend = resolveInstallBackend(options);
    if (backend === "coreml") {
      await downloadCoreML(noCache);
      await downloadLangIdCoreML(noCache);
    } else {
      await downloadModel(noCache);
      await downloadLangIdOnnx(noCache);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(message);
    process.exit(1);
  }
}
```

- [ ] **Step 2: Run existing tests to check nothing breaks**

Run: `bun test tests/unit/cli.test.ts`
Expected: PASS (all existing tests still pass)

- [ ] **Step 3: Commit**

```bash
git add src/cli.ts
git commit -m "feat: download lang-id models during parakeet install"
```

---

### Task 7: Update CLI — `--verbose` Flag and Enhanced Output

**Files:**
- Modify: `src/cli.ts`
- Modify: `tests/unit/cli.test.ts`

- [ ] **Step 1: Write the failing tests for new output formats**

Add to `tests/unit/cli.test.ts`:

```typescript
import {
  // ... existing imports ...
  formatVerboseOutput,
  type TranscribeResult,
} from "../../src/cli";

describe("verbose output formatting", () => {
  test("verbose output includes language info", () => {
    const results: TranscribeResult[] = [{
      file: "a.ogg",
      text: "Hello",
      lang: "en",
      audioLanguage: { code: "en", confidence: 0.94 },
      textLanguage: { code: "en", confidence: 0.98 },
    }];
    const output = formatVerboseOutput(results);
    expect(output).toContain("Audio language: en");
    expect(output).toContain("Text language:");
    expect(output).toContain("Hello");
  });

  test("verbose output omits audio language when not detected", () => {
    const results: TranscribeResult[] = [{
      file: "a.ogg",
      text: "Hello",
      lang: "en",
    }];
    const output = formatVerboseOutput(results);
    expect(output).not.toContain("Audio language:");
    expect(output).toContain("Text language: en");
    expect(output).toContain("Hello");
  });
});

describe("JSON output with lang-id fields", () => {
  test("JSON output includes audioLanguage and textLanguage when present", () => {
    const results: TranscribeResult[] = [{
      file: "a.ogg",
      text: "Hello",
      lang: "en",
      audioLanguage: { code: "en", confidence: 0.94 },
      textLanguage: { code: "en", confidence: 0.98 },
    }];
    const output = formatJsonOutput(results);
    const parsed = JSON.parse(output);
    expect(parsed[0].audioLanguage).toEqual({ code: "en", confidence: 0.94 });
    expect(parsed[0].textLanguage).toEqual({ code: "en", confidence: 0.98 });
    expect(parsed[0].lang).toBe("en");
  });

  test("JSON output omits audioLanguage when not detected", () => {
    const results: TranscribeResult[] = [{
      file: "a.ogg",
      text: "Hello",
      lang: "en",
    }];
    const output = formatJsonOutput(results);
    const parsed = JSON.parse(output);
    expect(parsed[0].audioLanguage).toBeUndefined();
    expect(parsed[0].lang).toBe("en");
  });
});

describe("CLI help", () => {
  // ... existing tests ...

  test("main help contains --verbose flag", async () => {
    const usage = await renderUsage(mainCommand);
    expect(usage).toContain("--verbose");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/cli.test.ts`
Expected: FAIL — `formatVerboseOutput` not exported, `TranscribeResult` missing new fields

- [ ] **Step 3: Update `TranscribeResult` type and add `--verbose` flag**

In `src/cli.ts`, update the type and add the flag:

```typescript
import type { LangDetectResult } from "./lang-id";

export type TranscribeResult = {
  file: string;
  text: string;
  lang: string;
  audioLanguage?: LangDetectResult;
  textLanguage?: LangDetectResult;
};
```

Add `--verbose` to `mainCommand.args`:

```typescript
verbose: {
  type: "boolean",
  description: "Show language detection details",
  default: false,
},
```

Update `MainCommandArgs`:

```typescript
interface MainCommandArgs {
  _: string[];
  json: boolean;
  verbose: boolean;
  lang?: string;
}
```

- [ ] **Step 4: Add `formatVerboseOutput` function**

```typescript
export function formatVerboseOutput(results: TranscribeResult[]): string {
  return results
    .map((r, i) => {
      const lines: string[] = [];
      if (results.length > 1) {
        if (i > 0) lines.push("");
        lines.push(`=== ${r.file} ===`);
      }
      if (r.audioLanguage) {
        lines.push(`Audio language: ${r.audioLanguage.code} (confidence: ${r.audioLanguage.confidence.toFixed(2)})`);
      }
      const textLang = r.textLanguage ?? (r.lang ? { code: r.lang, confidence: 0 } : null);
      if (textLang) {
        const confStr = textLang.confidence > 0 ? ` (confidence: ${textLang.confidence.toFixed(2)})` : "";
        lines.push(`Text language: ${textLang.code}${confStr}`);
      }
      lines.push("---");
      lines.push(r.text);
      return lines.join("\n");
    })
    .join("\n") + "\n";
}
```

- [ ] **Step 5: Update the `run` function to use `--verbose`**

Update the output section in `mainCommand.run`:

```typescript
if (args.json) {
  process.stdout.write(formatJsonOutput(results));
} else if (args.verbose) {
  process.stdout.write(formatVerboseOutput(results));
} else {
  process.stdout.write(formatTextOutput(results));
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/unit/cli.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts tests/unit/cli.test.ts
git commit -m "feat: add --verbose flag and enhanced lang-id output formatting"
```

---

### Task 8: Integrate Lang-ID into Transcription Pipeline

**Files:**
- Modify: `src/cli.ts` (the `run` function in `mainCommand`)
- Modify: `src/transcribe.ts` (no changes needed — lang-id is CLI-level, not in transcribe)

- [ ] **Step 1: Update the transcription loop in `mainCommand.run`**

The lang-id calls happen at the CLI level, wrapping the existing `transcribe()` call. Replace the `for (const file of files)` loop:

```typescript
import { detectAudioLanguageOnnx } from "./lang-id";
import { detectAudioLanguageCoreML, detectTextLanguageCoreML } from "./coreml";

// Inside mainCommand.run:
const wantsLangId = !!(args.lang || args.verbose || args.json);

for (const file of files) {
  try {
    // Pre-transcription audio lang-id (lazy)
    let audioLanguage: LangDetectResult | undefined;
    if (wantsLangId) {
      const audioResult = isMacArm64()
        ? await detectAudioLanguageCoreML(file)
        : await detectAudioLanguageOnnx(file);
      if (audioResult && audioResult.code) {
        audioLanguage = audioResult;
      }
    }

    // Audio lang-id mismatch warning (pre-transcription)
    if (audioLanguage && args.lang && audioLanguage.confidence > 0.8) {
      const mismatch = checkLanguageMismatch(args.lang, audioLanguage.code);
      if (mismatch) log.warn(`${file}: ${mismatch} (from audio)`);
    }

    // Transcribe
    const text = await transcribe(file);

    // Post-transcription text lang-id
    const tinyldLang = detectLanguage(text);
    let textLanguage: LangDetectResult | undefined;

    // Try NLLanguageRecognizer on macOS (takes priority)
    const coremlTextResult = await detectTextLanguageCoreML(text);
    if (coremlTextResult && coremlTextResult.code) {
      textLanguage = coremlTextResult;
    }

    // Use NLLanguageRecognizer result for lang field when available, else tinyld
    const lang = textLanguage?.code || tinyldLang;

    // Text lang-id mismatch warning (post-transcription, existing behavior)
    const mismatchWarning = checkLanguageMismatch(args.lang, lang);
    if (mismatchWarning) log.warn(`${file}: ${mismatchWarning}`);

    results.push({
      file,
      text,
      lang,
      audioLanguage,
      textLanguage: textLanguage ?? (tinyldLang ? { code: tinyldLang, confidence: 0 } : undefined),
    });
  } catch (err: unknown) {
    hasError = true;
    const message = err instanceof Error ? err.message : String(err);
    log.error(`${file}: ${message}`);
  }
}
```

- [ ] **Step 2: Run full test suite**

Run: `bun test`
Expected: PASS — all existing tests still pass, new tests pass

- [ ] **Step 3: Run type check**

Run: `bunx tsc --noEmit`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat: integrate audio + text lang-id into transcription pipeline"
```

---

### Task 9: Update `parakeet status` for Lang-ID Models

**Files:**
- Modify: `src/status.ts`
- Modify: `tests/unit/status.test.ts`

- [ ] **Step 1: Add lang-id model status to `showStatus`**

After the ONNX status section in `src/status.ts`, add:

```typescript
import { isLangIdOnnxCached, getLangIdOnnxDir, isLangIdCoreMLCached, getLangIdCoreMLDir } from "./lang-id-install";

// Inside showStatus, after the ONNX section:
const langIdOnnxDir = getLangIdOnnxDir();
const langIdOnnxInstalled = isLangIdOnnxCached();
log.info("Lang-ID:");
log.info(formatStatusLine("ONNX model", langIdOnnxInstalled ? langIdOnnxDir : null, langIdOnnxInstalled));

if (isMac) {
  const langIdCoreMLDir = getLangIdCoreMLDir();
  const langIdCoreMLInstalled = isLangIdCoreMLCached();
  log.info(formatStatusLine("CoreML model", langIdCoreMLInstalled ? langIdCoreMLDir : null, langIdCoreMLInstalled));
}
log.info("");
```

- [ ] **Step 2: Run status tests**

Run: `bun test tests/unit/status.test.ts`
Expected: PASS (may need minor test updates if status output is asserted)

- [ ] **Step 3: Commit**

```bash
git add src/status.ts tests/unit/status.test.ts
git commit -m "feat: show lang-id model status in parakeet status"
```

---

### Task 10: Final Integration Test and Type Check

**Files:**
- No new files

- [ ] **Step 1: Run full unit test suite**

Run: `bun test tests/unit/`
Expected: All PASS

- [ ] **Step 2: Run type check**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Run lint (if any)**

Run: `make lint`
Expected: PASS

- [ ] **Step 4: Manual smoke test (if backend installed)**

```bash
# Test default output (unchanged)
parakeet fixtures/hello-english.wav

# Test verbose output
parakeet --verbose fixtures/hello-english.wav

# Test JSON output
parakeet --json fixtures/hello-english.wav

# Test lang mismatch
parakeet --lang ru fixtures/hello-english.wav
```

- [ ] **Step 5: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address integration test findings"
```
