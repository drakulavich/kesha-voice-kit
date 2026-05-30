# Error Codes

Every user-facing failure prints a stable code on stderr:

```
error [E_MODEL_MISSING]: voice 'ru-vosk-m02' not installed. run: kesha install --tts
```

The code is stable across releases — quote it in bug reports. Engine codes are
introspectable via `kesha-engine --error-codes-json`. Codes are recorded
(leak-free) in [Stats](#) and [diagnostic logs](diagnostic-logs.md); the human
message may contain a path and is sanitized before storage, but the code never
needs sanitizing.

| Code | Category | Retryable | When it fires | How to fix |
|------|----------|-----------|---------------|------------|
| `E_INPUT_NOT_FOUND` | input | no | The input audio path doesn't exist (or no stdin was piped). | Check the path; pass a readable file. |
| `E_BAD_AUDIO` | input | no | The audio container/codec couldn't be decoded (or the file couldn't be opened for a reason other than "missing"). | Re-export to wav/ogg/mp3; verify the file isn't truncated; check permissions. |
| `E_MODEL_MISSING` | model | no | A required model or voice isn't installed. | `kesha install` / `kesha install --tts`. |
| `E_MODEL_DOWNLOAD` | model | yes | A model download failed (network or mirror error). | Retry; check connectivity and `KESHA_MODEL_MIRROR`. |
| `E_CACHE_CORRUPT` | model | no | A cached model file failed SHA-256 verification. | `kesha install --no-cache` to re-fetch. |
| `E_MODEL_LOAD` | model | no | A model file exists but failed to load. | Reinstall the model; check disk space. |
| `E_UNSUPPORTED_PLATFORM` | platform | no | The feature isn't supported on this OS/arch (e.g. microphone recording off macOS). | Use a supported platform (see the README platform matrix). |
| `E_SIDECAR_MISSING` | platform | no | A helper sidecar is missing or exited nonzero (e.g. `say-avspeech`). | Reinstall; ensure the sidecar sits beside the engine (macOS). |
| `E_NO_BACKEND` | platform | no | The binary was built without an ASR backend. | Use an official release build. |
| `E_TEXT_EMPTY` | tts | no | Synthesis text was empty. | Pass non-empty text. |
| `E_TEXT_TOO_LONG` | tts | no | Text exceeded the maximum length. | Split into shorter requests. |
| `E_VOICE_UNKNOWN` | tts | no | The voice id wasn't recognized. | `kesha say --list-voices`. |
| `E_SSML_INVALID` | tts | no | SSML was malformed (missing `<speak>` root, DOCTYPE, or unsupported relative rate). | Fix the SSML; see [docs/tts.md](tts.md). |
| `E_SSML_UNSUPPORTED` | tts | no | SSML isn't supported for this engine/voice. | Use a plain-text request or a supported voice. |
| `E_TRANSCRIBE_FAILED` | transcribe | no | The ASR pipeline failed. | Re-run; file a bug with a support bundle. |
| `E_DIARIZE_TIMEOUT` | transcribe | yes | Speaker diarization timed out (cold compile or long audio). | Re-run once warm; shorten the audio. |
| `E_ENGINE_SPAWN` | internal | no | The CLI couldn't spawn the engine subprocess. | `kesha install`; check the engine binary path (`KESHA_ENGINE_BIN`). |
| `E_INVALID_ARG` | input | no | A CLI flag or argument was invalid. | See `kesha --help`. |
| `E_INTERNAL` | internal | no | An unexpected or uncoded failure. | File a bug with `kesha support-bundle`. |

## Where codes come from

- **Engine codes** (everything except `E_ENGINE_SPAWN`) are defined in the Rust
  engine and emitted on its stderr as `error [CODE]: …`. List them with
  `kesha-engine --error-codes-json`.
- **`E_ENGINE_SPAWN`** originates only in the TypeScript CLI, for the failure to
  spawn the engine subprocess at all.
- **`E_INVALID_ARG`** and **`E_INPUT_NOT_FOUND`** are emitted by *both* the
  engine and the TypeScript CLI: the CLI validates arguments and checks input
  existence up front, and the engine emits the same codes when a bad argument or
  a missing file reaches it directly (e.g. `kesha-engine say` with conflicting
  `--model` / `--voice-file`, or a malformed `--format`).

## Stability

Codes are part of the public contract. A code's meaning will not change; new
codes may be added. The human-readable message after the code is **not**
contractual and may be reworded — match on the code, not the message.
