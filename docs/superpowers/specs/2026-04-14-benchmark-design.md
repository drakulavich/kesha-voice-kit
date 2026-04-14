# Benchmark: Three-Way Speech-to-Text Comparison

**Date**: 2026-04-14
**Status**: Approved
**Scope**: `scripts/benchmark.ts`, fixtures, Makefile, cleanup

## Problem

Current benchmark only compares faster-whisper vs Kesha. Users coming from OpenClaw use `openai-whisper` (base model) as default. No three-way comparison exists, and the benchmark script uses outdated install paths.

## Solution

Single benchmark script comparing three engines on Russian and English audio, run locally on macOS or Linux.

## Engines

| Engine | Package | Model | Notes |
|---|---|---|---|
| openai-whisper | `openai-whisper` (pip) | `base` | OpenClaw default, marked as such in report |
| faster-whisper | `faster-whisper` (pip) | `base`, int8 | Optimized Whisper fork |
| Kesha | `kesha` (installed binary) | Parakeet TDT 0.6B v3 | Our engine |

All engines auto-detect language — no `--language` flag passed.

Run order: openai-whisper → faster-whisper → Kesha (slowest first).

## Fixtures

- `fixtures/benchmark/*.ogg` — Russian voice messages (10 files, already exist)
- `fixtures/benchmark-en/*.ogg` — English clips (to be cut from LibriSpeech or Common Voice)

If `benchmark-en/` doesn't exist, script skips English — no error.

## Python venv

- Path: `~/.cache/kesha/benchmark-venv/`
- First run: creates venv, installs `openai-whisper` and `faster-whisper`
- Subsequent runs: checks packages exist, skips install
- Both Whisper variants loaded via inline Python subprocess (load model once, run all files)

## Output

### Markdown (stdout)

```markdown
## Benchmark: Speech-to-Text Engines

**Date:** 2026-04-14
**Platform:** Darwin arm64 (Apple M3 Pro, 18 GB RAM)
**Kesha backend:** onnx
**Whisper model:** base

### Russian (10 files)

| # | File | openai-whisper | faster-whisper | Kesha | Transcript (Kesha) |
|---|---|---|---|---|---|
| 1 | 01-ne-nuzhno.ogg | 12.3s | 4.1s | 1.9s | Не нужно слать... |
| **Total** | | **95.2s** | **32.1s** | **15.4s** | |

**Speedup:** Kesha is ~6.2x faster than openai-whisper, ~2.1x faster than faster-whisper

### English (5 files)

(same format)
```

### JSON (`benchmark-results.json`)

```json
{
  "date": "2026-04-14",
  "platform": { "os": "Darwin", "arch": "arm64", "chip": "Apple M3 Pro", "ram": "18 GB" },
  "keshaBackend": "onnx",
  "whisperModel": "base",
  "groups": [
    {
      "name": "Russian",
      "results": [
        {
          "file": "01-ne-nuzhno.ogg",
          "openaiWhisper": { "time": 12.3, "text": "..." },
          "fasterWhisper": { "time": 4.1, "text": "..." },
          "kesha": { "time": 1.9, "text": "..." }
        }
      ],
      "totals": { "openaiWhisper": 95.2, "fasterWhisper": 32.1, "kesha": 15.4 }
    }
  ]
}
```

## Script

**File:** `scripts/benchmark.ts` (full rewrite of existing)

**Run:**
```bash
make benchmark
# or
bun scripts/benchmark.ts
```

**Steps:**
1. Detect platform (os, arch, chip, ram, Kesha backend)
2. Ensure Python venv with both Whisper packages
3. Scan `fixtures/benchmark/*.ogg` and `fixtures/benchmark-en/*.ogg`
4. For each group (Russian, English):
   - Run openai-whisper on all files, collect time + text
   - Run faster-whisper on all files, collect time + text
   - Run Kesha on all files, collect time + text
5. Render markdown to stdout
6. Write JSON to `benchmark-results.json`

## Files Changed

### Delete
| File | Reason |
|---|---|
| `scripts/benchmark-coreml.ts` | Obsolete WhisperKit comparison |
| `src/benchmark-report.ts` | Report logic moves into benchmark script |
| `tests/unit/benchmark-report.test.ts` | Tests for deleted module |
| `.github/workflows/benchmark.yml` | Benchmark is local-only now |

### Create/Modify
| File | Change |
|---|---|
| `scripts/benchmark.ts` | Full rewrite — three-way comparison |
| `Makefile` | Replace `benchmark-coreml` with `benchmark` |
| `fixtures/benchmark-en/` | New: English audio files from LibriSpeech/Common Voice |

## Requirements

- Python 3 in PATH
- Kesha engine installed (`kesha install`)
- ~1GB disk for Whisper models (downloaded on first run)
- `fixtures/benchmark/*.ogg` exists

## Out of Scope

- CI automation (local-only for now)
- WhisperKit comparison (removed)
- Model size comparison (different model architectures)
