# Programmatic API

Kesha exports a small TypeScript API from `@drakulavich/kesha-voice-kit/core` for
use inside a Bun program (the engine still runs as a local subprocess).

```typescript
import { install, transcribe, say, capabilities, KeshaError } from "@drakulavich/kesha-voice-kit/core";

await install({ tts: ["en"] });                         // engine + ASR models + English TTS
const { text, lang } = await transcribe("audio.ogg");   // a TranscribeResult
const wav = await say({ text: "Hello" });               // audio bytes
const { features } = await capabilities();              // the engine's describe document
```

| Export | What it does |
|--------|--------------|
| `transcribe(path, opts?)` | Resolves to a `TranscribeResult`: `file`, `text`, `lang`, `sttTimeMs`, `textLanguage` when detected, and `segments` only with `opts.timestamps` or `opts.speakers`. |
| `say(opts)` | Resolves to the audio bytes, or to an empty array when `opts.out` names a file. |
| `install(opts?)` | The one call that downloads. With no options it does what `kesha install` does; each option is one of its flags (below). |
| `capabilities()` | Resolves to a copy of the installed engine's describe document (`EngineDescription`): `backend`, `profile`, `features`, per-command flags, TTS languages. |
| `toToon(results, errors?)` | Encodes a `TranscribeResult[]` exactly as `kesha --toon` prints it. |
| `hasErrorRecords(output)` | Type guard for the `{ results, errors }` form of `TranscribeJsonOutput`. |
| `KeshaError` | The only rejection type (below). |

The exported types are `TranscribeResult`, `TranscribeOptions`, `TranscribeErrorRecord`,
`TranscribeJsonOutput`, `TranscriptionSegment`, `WordTiming`, `SayOptions`,
`InstallOptions`, `EngineDescription` and `VadMode`; all of them are typed in
[`src/lib.ts`](../src/lib.ts).

`transcribe`'s `lang` and `textLanguage` come from the CLI-side `tinyld` detector
(`textLanguage.source` is `"tinyld"`). The API does not run the engine's audio
language ID or the macOS text detector, so `audioLanguage` is absent and, on macOS,
`lang` can differ from what `kesha --json` reports for the same file.

## `install(opts)`

| Option | `kesha install` flag |
|--------|----------------------|
| `tts: ["en", "ru"]` | `--tts en ru` (empty or absent: no TTS) |
| `vad: true` | `--vad` |
| `diarize: true` | `--diarize` (darwin-arm64 only) |
| `noCache: true` | `--no-cache` |
| `backend: "coreml" \| "onnx"` | `--coreml` / `--onnx` |
| `engineVersion: "1.26.0"` | `--engine-version 1.26.0` |

`install()` makes the refusals `kesha install` makes before anything downloads, with
the same codes: a malformed `engineVersion`, a TTS language the platform cannot serve
or a backend it does not ship is `E_INVALID_ARG`; `diarize` off darwin-arm64 is
`E_UNSUPPORTED_PLATFORM`. Same no-auto-download contract as the CLI: `transcribe`,
`say` and `capabilities` never install anything, and reject with `E_ENGINE_SPAWN` when
the engine is missing.

## Errors

Every promise from `./core` rejects with a `KeshaError`:

- `code` — a stable [error code](errors.md); match on it, not on the message.
- `hint` — the remedy the CLI would print, when one is known.
- `exitCode` and `stderr` — set whenever an engine subprocess ran or a pre-flight
  assigned an exit code (`say` with empty text: `E_TEXT_EMPTY`, exit code 2).

A failure nothing coded (a network error inside `install()`, for instance) rejects as
`E_INTERNAL` carrying the original message.

```typescript
try {
  await transcribe("note.ogg");
} catch (err) {
  if (err instanceof KeshaError && err.code === "E_ENGINE_SPAWN") console.error(err.hint);
  else throw err;
}
```

## Migrating to 2.0.0

2.0.0 removes every name below. Each has one replacement:

| Removed (1.x) | Use instead (2.0.0) |
|---------------|---------------------|
| `const text = await transcribe(p, o)` | `const { text } = await transcribe(p, o)` |
| `transcribeWithTimestamps(p, o)` | `transcribe(p, { ...o, timestamps: true })` |
| `transcribeWithSegments(p, o)` | `transcribe(p, { ...o, timestamps: true })` |
| `downloadModel()` | `install()` |
| `downloadModel(noCache, backend)` | `install({ noCache, backend })` |
| `downloadModel(noCache, backend, { ttsLangs, vad, diarize })` | `install({ noCache, backend, tts: ttsLangs, vad, diarize })` |
| `downloadEngine(...)` | `install(...)`, as for `downloadModel` |
| `downloadCoreML(...)` | `install(...)`, as for `downloadModel` |
| `downloadTts()` | `install({ tts: ["en"] })` |
| `downloadTts(noCache, langs)` | `install({ noCache, tts: langs })` |
| `SayError` | `KeshaError`: `code`, `exitCode` and `stderr` are unchanged, so `err instanceof SayError` becomes `err instanceof KeshaError` |
| type `TranscriptionOutput` | type `TranscribeResult` (its `text` and `segments`) |

The 1.x `transcribe` returned the text of the plain transcription path; 2.0.0 returns
the same text in `.text`. Segments are still requested with `timestamps: true`.
