# DX Improvements: Actionable Errors, Status Command, Download Progress

**Date:** 2026-04-09
**Inspired by:** Playwright's DX patterns

## Overview

Three improvements to parakeet-cli's developer/user experience:

1. **Actionable error messages** — every error tells users what failed, why, and how to fix it
2. **`parakeet status` command** — diagnostic view of installed components with actionable suggestions
3. **Download progress bar** — TTY-aware progress indicator for model downloads

## Feature 1: Actionable Error Messages

### Philosophy

CLI mode is strict (warns visibly, never silent). Programmatic API is lenient (returns empty string, no warnings logged). Every error follows a 3-part format:

```
Error: <what happened>
  <detail or file context>
  Fix: <actionable remediation>
```

### Changes

#### `src/transcribe.ts` — Short audio handling

Currently returns `""` silently when audio is < 1600 samples (0.1s). Change:

- **CLI path:** Log `log.warn("Audio too short (< 0.1s), skipping: {file}")` before returning `""`.
- **API path:** Return `""` silently (current behavior preserved).
- Add a `caller` context parameter (e.g., `{ silent?: boolean }`) to the internal transcribe function so CLI can opt into warnings.

#### `src/onnx-install.ts` — Download errors

Enrich existing error messages:

| Current | Improved |
|---------|----------|
| `failed to download {file}: HTTP {status}` | `Failed to download {file}: HTTP {status}\n  Fix: Check your network connection or try again with --no-cache` |
| `failed to fetch {file}: {error}` | `Failed to fetch {file}: {error}\n  Fix: Check your network connection and try again` |
| `empty response body for {file}` | `Download failed: empty response for {file}\n  Fix: Try again — the server may be temporarily unavailable` |

#### `src/coreml-install.ts` — Binary download failure

Current: `Failed to download CoreML binary (HTTP {status}). No release found with {name}.`

Improved:
```
Failed to download CoreML binary (HTTP {status})
  No release found matching {name}
  Fix: Check https://github.com/drakulavich/parakeet-cli/releases for available versions
       Or install the ONNX backend instead: parakeet install --onnx
```

#### `src/audio.ts` — ffmpeg conversion errors

Current: `failed to convert audio: {last stderr line}`

Improved:
```
Audio conversion failed: {last stderr line}
  File: {path}
  Fix: Ensure the file is a valid audio format. Run "ffmpeg -i {path}" to diagnose.
```

#### `src/transcribe.ts` — Silent CoreML-to-ONNX fallback

When CoreML detection/invocation fails and ONNX is used instead, add:
```
log.warn("CoreML backend unavailable, falling back to ONNX")
```

This only applies when the platform is macOS ARM64 (CoreML-eligible) but `isCoreMLAvailable()` returns false — i.e., the binary or model is missing, not when a transcription fails mid-run.

## Feature 2: `parakeet status` Command

### New subcommand

```
$ parakeet status
```

### Output format

```
Backend:  CoreML (macOS Apple Silicon)
  Binary:   ~/.cache/parakeet/coreml/bin/parakeet-coreml  ✓
  Model:    ~/.cache/parakeet/coreml/model/               ✓

ONNX:
  Models:   ~/.cache/parakeet/onnx/                       ✗ not installed

ffmpeg:     /opt/homebrew/bin/ffmpeg                       ✓
Runtime:    Bun 1.3.2                                     ✓
Platform:   macOS arm64

Run "parakeet install --onnx" to install the ONNX backend.
```

### Implementation

#### New file: `src/status.ts`

Exports `async function showStatus(): Promise<void>` that:

1. Probes CoreML state using existing `probeCoreMLState()` from `coreml-install.ts`
2. Checks ONNX model cache using existing `isModelCached()` from `onnx-install.ts`
3. Checks ffmpeg via `Bun.which("ffmpeg")`
4. Reports Bun version (`Bun.version`) and platform (`process.platform`, `process.arch`)
5. Collects missing components and prints actionable suggestions at the bottom

#### `src/cli.ts`

Add `status` as a subcommand alongside `install`.

#### Exports needed

- `src/onnx-install.ts` — export `isModelCached()` (or equivalent check function)
- `src/coreml-install.ts` — export `probeCoreMLState()` (or equivalent)

### Design decisions

- Uses `✓` / `✗` text markers, not color-only (accessible in monochrome terminals)
- Suggestions appear at the bottom, only for missing components
- No `--json` output in this iteration — plain text only
- Checks existence only, does not validate model file integrity (would require loading ONNX runtime)

## Feature 3: Download Progress Bar

### New file: `src/progress.ts`

~30 lines. Exports:

```typescript
function createProgressBar(label: string, totalBytes: number): {
  update(downloadedBytes: number): void;
  finish(): void;
}
```

### TTY behavior

When `process.stderr.isTTY` is true:

```
Downloading encoder-model.onnx  [████████░░░░░░░░] 48%  102MB/212MB
```

- Uses `process.stderr.write("\r" + line)` to overwrite in place
- Bar width: 20 characters fixed
- Shows percentage and MB downloaded / MB total
- `finish()` writes final 100% state with newline

### Non-TTY behavior (CI, piped output)

```
Downloading encoder-model.onnx (212MB)...
Downloaded encoder-model.onnx ✓
```

- Simple start/finish messages via `log.progress()` / `log.success()`
- No intermediate updates (avoids log spam)

### Integration

#### `src/onnx-install.ts`

Replace current `log.progress("Downloading {file}...")` + `Bun.write()` with:

1. Read `Content-Length` header from fetch response
2. Create progress bar with file name and total bytes
3. Stream response body in chunks, calling `update()` on each chunk
4. Call `finish()` when done

#### `src/coreml-install.ts`

Same pattern for `fetchCoreMLBinary()`. CoreML model download is delegated to the Swift subprocess — no progress bar there (it manages its own output).

### Edge cases

- **Missing `Content-Length`:** Fall back to indeterminate mode — show `Downloading {file}...` without percentage, then `✓` on completion
- **All output to stderr:** Progress bars never pollute stdout (transcription output)

## Files Changed

| File | Change |
|------|--------|
| `src/progress.ts` | **New** — progress bar utility |
| `src/status.ts` | **New** — status command logic |
| `src/cli.ts` | Add `status` subcommand, pass warning context to transcribe |
| `src/transcribe.ts` | Add short-audio warning, CoreML fallback warning, silent option |
| `src/onnx-install.ts` | Enriched error messages, progress bar integration, export `isModelCached` |
| `src/coreml-install.ts` | Enriched error messages, progress bar integration, export probe function |
| `src/audio.ts` | Enriched ffmpeg error format |
| `src/lib.ts` | Pass `{ silent: true }` to internal transcribe (preserves lenient API behavior) |

## Not in scope

- `--verbose` flag (future improvement)
- JSON output for `status` command (future)
- Model integrity validation in `status`
- Download size estimation before starting install
