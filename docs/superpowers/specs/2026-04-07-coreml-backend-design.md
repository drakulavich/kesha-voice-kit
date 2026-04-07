# CoreML Backend Integration

Add CoreML as a high-performance transcription backend on macOS Apple Silicon, using a pre-built Swift helper binary that wraps FluidAudio. Falls back to the existing ONNX pipeline on other platforms.

## Architecture

```
parakeet <audio.wav>
    |
    +-- macOS arm64 + CoreML binary installed?
    |   YES -> spawn `parakeet-coreml <audio.wav>` subprocess
    |           -> read stdout (plain text transcript)
    |
    +-- NO  -> existing ONNX pipeline (requireModel -> preprocess -> encode -> decode)


parakeet install
    |
    +-- macOS arm64?
    |   YES -> download `parakeet-coreml` binary -> ~/.cache/parakeet/coreml/bin/
    |          (CoreML model files downloaded on first run by FluidAudio internally)
    |
    +-- other -> download ONNX model files -> ~/.cache/parakeet/v3/


parakeet install --onnx    (force ONNX on any platform)
parakeet install --coreml   (explicit CoreML, error if not macOS arm64)
```

## Swift Helper Binary (`parakeet-coreml`)

A minimal Swift executable depending on FluidAudio. Takes an audio file path, transcribes it, prints plain text to stdout.

### Interface contract

- **Input:** single audio file path as CLI argument
- **Stdout:** transcribed text (plain text)
- **Stderr:** model download progress on first run (FluidAudio handles this)
- **Exit code:** 0 success, 1 error (error message to stderr)

### Implementation

```swift
import FluidAudio

@main struct ParakeetCoreML {
    static func main() async throws {
        let path = CommandLine.arguments[1]
        let models = try await AsrModels.downloadAndLoad(version: .v3)
        let asr = AsrManager(config: .default)
        try await asr.initialize(models: models)
        let samples = try await AudioProcessor.loadAudioFile(path: path)
        let result = try await asr.transcribe(samples, source: .system)
        print(result.text)
        asr.cleanup()
    }
}
```

### Project structure in repo

```
swift/
+-- Package.swift           # depends on FluidAudio
+-- Sources/
    +-- ParakeetCoreML/
        +-- main.swift      # minimal transcription wrapper
```

## Install Flow

### Smart default (`parakeet install`)

On macOS arm64: downloads `parakeet-coreml` binary from the matching GitHub release.
On other platforms: downloads ONNX model files from HuggingFace.

### Override flags

- `--onnx` — force ONNX download on any platform
- `--coreml` — force CoreML, error if not macOS arm64
- `--no-cache` — re-download even if already present

### Platform detection

```typescript
function isMacArm64(): boolean {
    return process.platform === "darwin" && process.arch === "arm64";
}
```

### CoreML binary download

- Source: `https://github.com/drakulavich/parakeet-cli/releases/download/v{version}/parakeet-coreml-darwin-arm64`
- Destination: `~/.cache/parakeet/coreml/bin/parakeet-coreml`
- `chmod +x` after download

### Cache structure

```
~/.cache/parakeet/
+-- coreml/
|   +-- bin/
|       +-- parakeet-coreml          # Swift binary
+-- v3/                               # ONNX models (if installed)
    +-- encoder-model.onnx
    +-- encoder-model.onnx.data
    +-- decoder_joint-model.onnx
    +-- nemo128.onnx
    +-- vocab.txt
```

CoreML model files (`*.mlmodelc`) are managed by FluidAudio internally — downloaded on first invocation of `parakeet-coreml`.

## Runtime Backend Selection

### Detection

```typescript
function isCoreMLAvailable(): boolean {
    return isMacArm64() && existsSync(COREML_BIN_PATH);
}
```

### Transcription flow

1. If `isCoreMLAvailable()`: spawn `parakeet-coreml <audioPath>`, capture stdout, return as string. If process exits non-zero, throw with stderr.
2. If ONNX model is cached: use existing ONNX pipeline.
3. If neither: throw error directing user to run `bunx @drakulavich/parakeet-cli install`.

### Subprocess invocation

```typescript
const proc = Bun.spawn([COREML_BIN_PATH, audioPath], {
    stdout: "pipe",
    stderr: "pipe",
});
```

No audio conversion needed — FluidAudio handles format conversion internally.

### Error when no backend is installed

```
Error: No backend available

+----------------------------------------------------------+
| No transcription backend is installed.                   |
| Please run the following command to get started:         |
|                                                          |
|     bunx @drakulavich/parakeet-cli install               |
+----------------------------------------------------------+
```

## GitHub CI for Swift Binary Releases

### Workflow: `.github/workflows/build-coreml.yml`

- **Trigger:** on published GitHub releases
- **Runner:** `macos-15` (Apple Silicon, Xcode + Swift 6)
- **Steps:**
  1. Checkout repo
  2. `swift build -c release` in `swift/` directory
  3. Rename binary to `parakeet-coreml-darwin-arm64`
  4. Attach to the GitHub release via `gh release upload`

### Release flow

```
git tag v0.5.0 && git push --tags
  -> GitHub Release created
    -> CI builds parakeet-coreml-darwin-arm64
      -> Binary attached to release assets
```

### Version coupling

The Swift binary version is tied to the parakeet-cli release tag. `parakeet install` downloads the binary from the matching release version.

## Files to create or modify

### New files

- `swift/Package.swift` — Swift package manifest
- `swift/Sources/ParakeetCoreML/main.swift` — Swift helper binary
- `.github/workflows/build-coreml.yml` — CI workflow

### Modified files

- `src/models.ts` — add `isMacArm64()`, `isCoreMLAvailable()`, `downloadCoreML()`, update `requireModel` error to handle both backends
- `src/cli.ts` — update install command to handle `--coreml` / `--onnx` flags, smart default
- `src/transcribe.ts` — add CoreML subprocess path before ONNX fallback
- `src/lib.ts` — re-export any new public API if needed
- `package.json` — version bump

## Performance

- CoreML on M4 Pro: ~155x RTF (1 min audio in ~0.4s)
- ONNX (current): significantly slower
- Subprocess overhead is negligible relative to inference time
