# Parakeet-CLI Library Split + translate-voice Refactor

## Problem

parakeet-cli is CLI-only. Consumers (like translate-voice in openclaw-tools) must shell out via `execFileSync('parakeet')` instead of importing directly. translate-voice also has accumulated tech debt: misleading file names, dead code, hardcoded temp paths, silent error swallowing.

## Scope

Two independent sub-projects:

1. **parakeet-cli lib split** — add library export path, CLI becomes thin wrapper
2. **translate-voice refactor** — switch to library import, cleanup, tests

---

## Sub-project 1: parakeet-cli lib split

### Public API

New file `src/lib.ts`:

```typescript
export interface TranscribeOptions {
  beamWidth?: number;    // default 4
  noCache?: boolean;     // force re-download models
  modelDir?: string;     // custom model cache directory
}

export async function transcribe(
  audioPath: string,
  options?: TranscribeOptions
): Promise<string>
```

Single high-level method. Handles the full pipeline internally: audio conversion, model loading, mel-spectrogram, encoding, beam decoding, detokenization.

### Package exports

```json
{
  "exports": {
    ".": "./src/cli.ts",
    "./core": "./src/lib.ts"
  }
}
```

- `@drakulavich/parakeet-cli` — CLI entry (existing behavior)
- `@drakulavich/parakeet-cli/core` — library API

### CLI refactor

`src/cli.ts` becomes a thin wrapper that:
1. Parses args (`--version`, `--no-cache`, audio file path)
2. Calls `transcribe(audioPath, { noCache })` from `./lib.ts`
3. Writes result to stdout

### Internal changes

- `src/transcribe.ts` — add `beamWidth` and `modelDir` parameters to existing `transcribe()` function signature
- `src/models.ts` — accept optional `modelDir` to override default cache path; accept `noCache` flag
- `src/lib.ts` — validates audioPath exists, calls internal `transcribe()` with mapped options
- No structural changes to encoder, decoder, preprocess, tokenizer — they stay as-is

### Version bump

0.2.0 → 0.3.0 (new public API = minor version)

---

## Sub-project 2: translate-voice refactor

### 1. STT: library import

Replace shell-out with direct import:
- Rename `whisper.ts` → `stt.ts`
- Replace `execFileSync('parakeet', [audioPath])` with `import { transcribe } from '@drakulavich/parakeet-cli/core'`
- Add `@drakulavich/parakeet-cli` as workspace or npm dependency

### 2. Rename ollama.ts

- Rename `ollama.ts` → `translate.ts`
- Remove dead `unloadAll()` function
- Update all imports across the package

### 3. Fix temp file handling

- `index.ts` line 47: replace hardcoded `/tmp/translated_${target}.mp3` with `path.join(tmpdir(), \`translated_${target}_${randomBytes(4).toString('hex')}.mp3\`)` — matching `core.ts` pattern

### 4. TTS error logging

- `tts.ts`: add `console.error('Piper failed:', err)` before falling back to Edge TTS
- If both Piper and Edge fail: throw with details from both errors instead of generic message

### 5. Tests

- Unit test for `stt.ts` — mock the transcribe import, verify it's called with correct path
- Unit test for `translate.ts` — mock curl execution, verify Groq API payload structure
- Update existing test imports for renamed files

### 6. Update CLAUDE.md

Update the file map and rules:
```
src/
  index.ts           — CLI entry (commander)
  core.ts            — programmatic API
  stt.ts             — Parakeet STT (speech-to-text)
  translate.ts       — Groq LLM translation
  tts.ts             — Piper/Edge TTS (text-to-speech)
  languages.ts       — language detection/mapping
```
Document: requires `GROQ_API_KEY` env var for translation, `parakeet-cli` for STT (or as npm dependency).

---

## Non-Goals

- Exposing parakeet internals (encoder, decoder, tokenizer) as public API
- Changing the translation backend (Groq stays)
- Adding new TTS engines
- Changing parakeet's ONNX pipeline or model architecture
