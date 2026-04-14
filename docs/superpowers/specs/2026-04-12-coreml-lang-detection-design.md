# CoreML Language Detection Integration

**Date**: 2026-04-12
**Status**: Approved
**Extends**: `2026-04-09-lang-detection-design.md`
**Scope**: Swift binary, ONNX lang-id pipeline, CLI output, model distribution

## Problem

Current language detection uses `tinyld` on transcript text only. This has two limitations:
1. No pre-transcription language detection from audio — users can't know the spoken language before transcription runs
2. `tinyld` trigram analysis is less accurate than Apple's `NLLanguageRecognizer` on macOS

## Constraints

- Parakeet TDT 0.6B v3 has no language conditioning — detection is informational only, cannot route models
- Must be backward-compatible: `tinyld` stays as the baseline on all platforms
- CoreML enhancements are additive on macOS, not required
- No Python dependency for end users — models ship pre-converted

## Solution

Two new language detection capabilities layered on top of the existing `tinyld` baseline:

### 1. Pre-transcription audio language detection (lazy)

**Model**: [speechbrain/lang-id-voxlingua107-ecapa](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa) — ECAPA-TDNN architecture, 107 languages, ~20MB

**When it runs**: Only when `--lang`, `--verbose`, or `--json` flags are present. Zero overhead in the default case.

**Dual backend** (matches existing transcription architecture):
- **CoreML on macOS arm64**: New subcommand `parakeet-coreml detect-lang <audio-path>`, runs ECAPA-TDNN `.mlpackage` on ANE
- **ONNX cross-platform**: `onnxruntime-node` loads `lang-id-ecapa.onnx`, new `src/lang-id.ts` module

**Pipeline**:
1. Extract first ~10 seconds of audio (reuse existing ffmpeg conversion to 16kHz mono PCM)
2. Compute mel filterbank features for ECAPA-TDNN input
3. Run inference → `{ language: "ru", confidence: 0.94 }`

### 2. Post-transcription text language detection (enhanced)

**On macOS**: `NLLanguageRecognizer` via new subcommand `parakeet-coreml detect-text-lang <text>`. Higher accuracy than `tinyld`. Result takes priority when available.

**On all platforms**: `tinyld` continues to run as baseline (existing behavior preserved).

**Runs**: Always, on every transcription. `NLLanguageRecognizer` on text is effectively free.

## Model Conversion & Distribution

**One-time conversion** (done by maintainer):
1. PyTorch → ONNX via `torch.onnx.export`
2. PyTorch → CoreML via `coremltools` (targeting `compute_units=ALL` for ANE)

**Hosting**: New HuggingFace repo `drakulavich/parakeet-lang-id-ecapa` with:
- `lang-id-ecapa.onnx` (~20MB)
- `lang-id-ecapa.mlpackage` (~20MB)

**Download**: `parakeet install` downloads lang-id models alongside transcription models into:
- `~/.cache/parakeet/onnx/` (ONNX model)
- `~/.cache/parakeet/coreml/` (CoreML model)

## CLI Output

### Default mode (no flags) — unchanged
```
Привет мир как дела
```

### With `--lang ru` (mismatch warning)
```
warning: expected language "ru" but detected "uk"
Привіт світ як справи
```
Existing behavior preserved. Audio lang-id adds a second check: if audio language disagrees with `--lang` at confidence >0.8, warn before transcription.

### With `--verbose`
```
Audio language: ru (confidence: 0.94)
Text language:  ru (confidence: 0.98)
Duration: 3.2s | RTF: 0.006x
---
Привет мир как дела
```

### With `--json`
```json
[
  {
    "file": "audio.ogg",
    "text": "Привет мир как дела",
    "lang": "ru",
    "audioLanguage": { "code": "ru", "confidence": 0.94 },
    "textLanguage": { "code": "ru", "confidence": 0.98 },
    "duration": 3.2,
    "rtf": 0.006
  }
]
```
The `lang` field remains for backward compatibility (populated by `tinyld` or `NLLanguageRecognizer`). `audioLanguage` and `textLanguage` are new additive fields.

## Architecture

```
Audio Input
│
├─ [lazy: --lang/--verbose/--json only]
│  Pre-transcription Lang-ID (ECAPA-TDNN, ~10s sample)
│  ├─ CoreML backend (macOS arm64): parakeet-coreml detect-lang
│  └─ ONNX backend (cross-platform): onnxruntime-node
│  → { audioLanguage, confidence }
│
├─ Transcription (existing pipeline, unchanged)
│  ├─ CoreML backend: parakeet-coreml transcribe
│  └─ ONNX backend: encoder + decoder pipeline
│  → transcript text
│
└─ [always] Post-transcription Lang-ID
   ├─ tinyld (all platforms, baseline, existing behavior)
   ├─ NLLanguageRecognizer (macOS, enhanced, result used for lang field when available)
   └─ Priority: NLLanguageRecognizer > tinyld (on macOS); tinyld only (elsewhere)
   → { textLanguage, confidence }

Output assembly:
  default    → transcript only (unchanged)
  --lang     → warn on mismatch (audio and/or text vs expected)
  --verbose  → languages + transcript
  --json     → full structured output with lang + audioLanguage + textLanguage
```

## Backward Compatibility

- `tinyld` remains a required dependency on all platforms
- `tinyld` continues to populate the `lang` field in JSON output
- `NLLanguageRecognizer` is additive on macOS — its result takes priority but `tinyld` still runs
- Audio lang-id is purely additive — only triggers with explicit flags
- Existing `--lang` mismatch warning behavior unchanged
- No changes to the public API (`transcribe()` function from `./core`)

## Files Changed

| File | Change |
|---|---|
| `swift/Sources/ParakeetCoreML/main.swift` | Add `detect-lang` and `detect-text-lang` subcommands |
| `swift/Package.swift` | Add `NaturalLanguage` framework import |
| `src/lang-id.ts` | New: ONNX ECAPA-TDNN inference for audio lang-id |
| `src/cli.ts` | Lazy lang-id trigger logic, verbose/JSON output formatting |
| `src/transcribe.ts` | Integrate pre/post lang-id into pipeline |
| `src/coreml.ts` | Add helpers to invoke new Swift subcommands |
| `src/coreml-install.ts` | Download CoreML lang-id model |
| `src/onnx-install.ts` | Download ONNX lang-id model |
| `src/models.ts` | Re-export lang-id model download |
| `src/lib.ts` | Expose lang-id fields in `TranscribeResult` type |
| `src/__tests__/lang-id.test.ts` | New: unit tests for lang-id module |
| `src/__tests__/cli.test.ts` | Update: tests for new verbose/JSON fields |

## New Dependencies

- None for end users (models downloaded via `parakeet install`)
- `NaturalLanguage` framework (macOS system framework, no external dep)

## Out of Scope

- Language-conditioned transcription (not possible with Parakeet TDT architecture)
- Training or fine-tuning the ECAPA-TDNN model
- Streaming/real-time language detection
- Language detection in the public API (`transcribe()`) — CLI only for now
