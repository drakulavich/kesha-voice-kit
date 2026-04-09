# Language Detection and `--lang` Flag

**Date**: 2026-04-09
**Status**: Approved
**Scope**: `src/cli.ts`, `src/__tests__/cli.test.ts`, `package.json`

## Problem

The CLI outputs no language information. Users can't know which language was detected, and can't validate that the model transcribed in the expected language.

## Constraints

Language forcing is not possible with Parakeet TDT 0.6B v3 — it's a pure transducer model with no prompt conditioning input. Language detection is implicit in the encoder. Neither the ONNX nor CoreML backend exposes which language was detected.

## Solution

Use `tinyld` (lightweight language detection library, ~50KB, pure JS, zero deps) to detect the language of the transcript text post-transcription.

### `--lang` flag

```bash
parakeet --lang ru audio.ogg
```

If the detected language doesn't match `--lang`, emit a warning to stderr:
```
warning: expected language "ru" but detected "en"
```

The transcript is still output regardless — `--lang` is a validation hint, not a filter. The value is an ISO 639-1 two-letter code (e.g. `en`, `ru`, `fr`).

### JSON output with language

```json
[
  {
    "file": "audio.ogg",
    "text": "Transcript here.",
    "lang": "ru"
  }
]
```

`lang` is always present in JSON output — an ISO 639-1 code from tinyld. In text mode, language is not shown unless `--lang` mismatch triggers the warning.

### Architecture

No changes to the transcription pipeline. Language detection is purely post-processing on the output text.

```
transcribe(file) → text
  → tinyld.detect(text) → lang code
  → if --lang provided and doesn't match → warn to stderr
  → output text (+ lang in JSON mode)
```

**Files changed:**

| File | Change |
|---|---|
| `package.json` | Add `tinyld` dependency |
| `src/cli.ts` | Add `--lang` flag, detect language on result, warn on mismatch, add `lang` to `TranscribeResult` and JSON output |
| `src/__tests__/cli.test.ts` | Tests for language detection, `--lang` mismatch warning, JSON `lang` field |

### New Dependency

- `tinyld` — ~50KB, pure JS, zero deps, detects language from text via trigram frequency analysis

## Out of Scope

- No changes to `src/lib.ts`, `src/transcribe.ts`, or any other pipeline files
- No language forcing in the model (not possible with this architecture)
- No `--lang` flag in the public API (`transcribe()` function)
