# Error Codes

Every user-facing failure prints a stable code on stderr:

```
error [E_MODEL_MISSING]: voice 'ru-vosk-m02' not installed. run: kesha install --tts
```

The code is stable across releases — quote it in bug reports. Engine codes are
introspectable via `kesha-engine --error-codes-json`. Codes are recorded
(leak-free) in [Stats](local-stats.md) and [diagnostic logs](diagnostic-logs.md);
the human message may contain a path and is sanitized before storage, but the
code never needs sanitizing.

| Code | Category | Retryable | When it fires | How to fix |
|------|----------|-----------|---------------|------------|
| `E_INPUT_NOT_FOUND` | input | no | The input audio path doesn't exist (or no stdin was piped). | Check the path; pass a readable file. |
| `E_BAD_AUDIO` | input | no | The audio container/codec couldn't be decoded (or the file couldn't be opened for a reason other than "missing"). A directory passed where an audio file is expected is `E_INVALID_ARG`, not this — the CLI rejects it as a bad argument before the engine ever opens it. | Re-export to wav/ogg/mp3; verify the file isn't truncated; check permissions. |
| `E_MODEL_MISSING` | model | no | A required model or voice isn't installed. | `kesha install` / `kesha install --tts`. |
| `E_MODEL_DOWNLOAD` | model | yes | A model download failed (network or mirror error). | Retry; check connectivity and `KESHA_MODEL_MIRROR`. |
| `E_CACHE_CORRUPT` | model | no | A cached model file failed SHA-256 verification. | `kesha install --no-cache` to re-fetch. |
| `E_MODEL_LOAD` | model | no | A model file exists but failed to load. | Reinstall the model; check disk space. |
| `E_UNSUPPORTED_PLATFORM` | platform | no | The feature isn't supported on this OS/arch (e.g. microphone recording off macOS). | Use a supported platform (see the [platform matrix](product-positioning.md#platform-matrix)). |
| `E_SIDECAR_MISSING` | platform | no | A helper sidecar is missing or exited nonzero (e.g. `say-avspeech`). | Reinstall; ensure the sidecar sits beside the engine (macOS). |
| `E_NO_BACKEND` | platform | no | The binary was built without an ASR backend. | Use an official release build. |
| `E_TEXT_EMPTY` | tts | no | Synthesis text was empty. | Pass non-empty text. |
| `E_TEXT_TOO_LONG` | tts | no | Text exceeded the maximum length. | Split into shorter requests. |
| `E_VOICE_UNKNOWN` | tts | no | The voice id wasn't recognized. | `kesha say --list-voices`. |
| `E_SSML_INVALID` | tts | no | SSML was malformed (missing `<speak>` root, DOCTYPE, or unsupported relative rate). | Fix the SSML; see [docs/tts.md](tts.md). |
| `E_SSML_UNSUPPORTED` | tts | no | SSML isn't supported for this engine/voice. | Use a plain-text request or a supported voice. |
| `E_SCRIPT_UNSUPPORTED` | tts | no | The text uses a script the chosen voice's G2P can't phonemize (e.g. Devanagari / kana-kanji / Han for the FluidAudio Kokoro `hi`/`ja`/`zh` voices, which only handle Latin input). | Romanize the text (transliterate to Latin), or use a voice whose engine supports the script. See [#492](https://github.com/drakulavich/kesha-voice-kit/issues/492). |
| `E_TRANSCRIBE_FAILED` | transcribe | no | The ASR pipeline failed. | Re-run; file a bug with a support bundle. |
| `E_DIARIZE_TIMEOUT` | transcribe | yes | A diarization phase exceeded its budget, or `KESHA_DIARIZE_TIMEOUT_SECS` cut the run short. The message names the phase: model load, reading the audio, or processing chunks. | Model load: re-run once warm (`kesha install --diarize`), or `KESHA_DIARIZE_COMPUTE_UNITS=cpu-and-gpu`, or raise `KESHA_DIARIZE_LOAD_TIMEOUT_SECS` (default 300). Own cap: raise or unset `KESHA_DIARIZE_TIMEOUT_SECS`. Otherwise file a bug. |
| `E_ENGINE_SPAWN` | platform | no | The Engine binary is missing or failed to start (CLI-side). | `kesha install`; or set `KESHA_ENGINE_BIN`. |
| `E_ENGINE_PROTOCOL` | platform | no | The installed Engine speaks a protocol version this CLI does not (CLI-side). | `kesha install` for a stale Engine; `bun add -g @drakulavich/kesha-voice-kit@latest` for a stale CLI. |
| `E_INSTALL_RACE` | internal | yes | Another `kesha install` reached the same cache: either it overwrote the engine during our run (the recorded version or the binary's own `--version` names something else), or it still holds the cache and we gave up waiting for it. Nothing is written in the waiting case. | Re-run the install once no other one is in flight; give concurrent jobs private caches via `KESHA_CACHE_DIR` / `KESHA_ENGINE_BIN`. A wait that must fail sooner than the 6 h ceiling: `KESHA_INSTALL_LOCK_WAIT_SECS`, in seconds, positive numbers only — and lowering it costs the one-retry takeover ([concurrent installs](architecture.md#runtime-data-flow)). If the message names a lock no install owns, delete the `.lock` directory it names. |
| `E_INVALID_ARG` | input | no | A CLI flag, argument, or `KESHA_*` value was invalid — including a directory passed where an audio file is expected, and a `KESHA_CACHE_DIR` / `KESHA_ENGINE_BIN` path the engine cannot be written into: one the engine directory cannot be created under, or an existing engine directory this user cannot write (a read-only Nix store install reaches the second). | See `kesha --help`; for a `KESHA_*` path the message names the setting, the offending value, and what it needs to be. |
| `E_INTERNAL` | internal | no | An unexpected or uncoded failure. | File a bug with `kesha support-bundle`. |

## Where codes come from

- **Engine codes** (everything except `E_ENGINE_SPAWN` and `E_INSTALL_RACE`) are defined in the Rust
  engine and emitted on its stderr as `error [CODE]: …`. List them with
  `kesha-engine --error-codes-json`.
- **`E_ENGINE_SPAWN`** and **`E_INSTALL_RACE`** originate only in the TypeScript
  CLI — the failure to spawn the engine subprocess at all, and an install that
  lost the cache to another one, whether by being overwritten before it could
  report success or by giving up waiting for the lock.
- **`E_INVALID_ARG`** and **`E_INPUT_NOT_FOUND`** are emitted by *both* the
  engine and the TypeScript CLI: the CLI validates arguments, checks input
  existence up front and refuses a cache path it cannot write the engine into,
  and the engine emits the same codes when a bad argument or
  a missing file reaches it directly (e.g. `kesha-engine say` with conflicting
  `--model` / `--voice-file`, or a malformed `--format`).

## Stability

Codes are part of the public contract. A code's meaning will not change; new
codes may be added. The human-readable message after the code is **not**
contractual and may be reworded — match on the code, not the message.

## Process exit codes

In addition to the stable `error [CODE]` line above, the process exits with a
status that lets scripts branch without parsing stderr:

| Exit code | Meaning |
|-----------|---------|
| `0` | Success. |
| `1` | Operational error — engine/model not installed, a download or install failed, an unknown command, or no input was given. |
| `2` | Invalid arguments or usage (mutually-exclusive flags, a bad `--format`, empty `say` text, …). |
| `4` | Unexpected/uncoded internal failure. |
| `5` | `kesha say` text exceeds the length limit. |
| `130` | Interrupted — Ctrl-C (`SIGINT`) reached the CLI mid-run; the engine subprocess was terminated. |
| `143` | Terminated — a `SIGTERM` reached the CLI mid-run (a cancelled CI job, a stopped container); the engine subprocess was terminated. |

`130` and `143` mean the run was **cancelled**, not that it failed: a wrapper
that treats every non-zero status as a crash will misreport a cancellation.

`kesha say` and other engine-backed commands may also exit with the **engine's
own** non-zero status when the engine itself fails. For fine-grained handling,
match on the stable `error [CODE]` line — it is the reliable signal; the numeric
exit status only distinguishes the broad categories above.
