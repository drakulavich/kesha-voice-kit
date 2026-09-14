# Error Codes

Every user-facing failure prints a stable code on stderr:

```
error [E_MODEL_MISSING]: voice 'ru-vosk-m02' not installed. run: kesha install --tts
```

The code is stable across releases — quote it in bug reports. Engine codes are
introspectable via `kesha-engine describe` (the `errors` section). Codes are recorded
(leak-free) in [Stats](local-stats.md) and [diagnostic logs](diagnostic-logs.md);
the human message may contain a path and is sanitized before storage, but the
code never needs sanitizing.

| Code | Category | Retryable | When it fires | How to fix |
|------|----------|-----------|---------------|------------|
| `E_INPUT_NOT_FOUND` | input | no | The input audio path doesn't exist (or no stdin was piped). | Check the path; pass a readable file. |
| `E_BAD_AUDIO` | input | no | The audio container/codec couldn't be decoded (or the file couldn't be opened for a reason other than "missing"), including a header no decoder can represent, such as a WAV declaring a sample rate of 0. A directory passed where an audio file is expected is `E_INVALID_ARG`, not this — the CLI rejects it as a bad argument before the engine ever opens it. | Re-export to wav/ogg/mp3; verify the file isn't truncated; check permissions. |
| `E_MODEL_MISSING` | model | no | A required model or voice isn't installed. | `kesha install` / `kesha install --tts`. |
| `E_MODEL_DOWNLOAD` | model | yes | A model download failed (network or mirror error). | Retry; check connectivity and `KESHA_MODEL_MIRROR`. |
| `E_CACHE_CORRUPT` | model | no | A cached model file failed SHA-256 verification. | `kesha install --no-cache` to re-fetch. |
| `E_MODEL_LOAD` | model | no | A model file exists but failed to load. | Reinstall the model; check disk space. |
| `E_UNSUPPORTED_PLATFORM` | platform | no | The feature isn't supported on this OS/arch (e.g. microphone recording off macOS), or `kesha install` found no published engine for it. | Use a supported platform (see the [platform matrix](product-positioning.md#platform-matrix)). |
| `E_SIDECAR_MISSING` | platform | no | A helper sidecar is missing or exited nonzero (e.g. `say-avspeech`). | Reinstall; ensure the sidecar sits beside the engine (macOS). |
| `E_NO_BACKEND` | platform | no | The binary was built without an ASR backend. | Use an official release build. |
| `E_TEXT_EMPTY` | tts | no | Synthesis text was empty. | Pass non-empty text. |
| `E_TEXT_TOO_LONG` | tts | no | Text exceeded the maximum length. | Split into shorter requests. |
| `E_VOICE_UNKNOWN` | tts | no | The voice id wasn't recognized, or a `macos-*` voice is not downloaded on this Mac. | `kesha say --list-voices`; for a `macos-*` voice, download it in System Settings > Accessibility > Spoken Content. |
| `E_SSML_INVALID` | tts | no | SSML was malformed (missing `<speak>` root, DOCTYPE, or unsupported relative rate). | Fix the SSML; see [docs/tts.md](tts.md). |
| `E_SSML_UNSUPPORTED` | tts | no | SSML isn't supported for this engine/voice. | Use a plain-text request or a supported voice. |
| `E_SCRIPT_UNSUPPORTED` | tts | no | The text is mostly in a script the chosen voice's G2P can't phonemize (Latin for the FluidAudio Kokoro voices, Cyrillic for `ru-vosk-*`, Han or Latin for `zh-*`; the message names both), or it has nothing pronounceable, or one token the FluidAudio G2P rejects. | Transliterate the text into a script the voice handles (the message names it), or use a voice whose engine supports the script. See [#492](https://github.com/drakulavich/kesha-voice-kit/issues/492). |
| `E_TRANSCRIBE_FAILED` | transcribe | no | The ASR pipeline failed. | Re-run; file a bug with a support bundle. |
| `E_DIARIZE_TIMEOUT` | transcribe | yes | A diarization phase exceeded its budget, or `KESHA_DIARIZE_TIMEOUT_SECS` cut the run short. The message names the phase: model load, reading the audio, or processing chunks. | Model load: re-run once warm (`kesha install --diarize`), or `KESHA_DIARIZE_COMPUTE_UNITS=cpu-and-gpu`, or raise `KESHA_DIARIZE_LOAD_TIMEOUT_SECS` (default 300). Own cap: raise or unset `KESHA_DIARIZE_TIMEOUT_SECS`. Otherwise file a bug. |
| `E_ENGINE_SPAWN` | platform | no | The Engine binary is missing or failed to start (CLI-side). | `kesha install`; or set `KESHA_ENGINE_BIN`. |
| `E_ENGINE_PROTOCOL` | platform | no | The installed Engine speaks a protocol version this CLI does not (CLI-side). | `kesha install` for a stale Engine; `bun add -g @drakulavich/kesha-voice-kit@latest` for a stale CLI. |
| `E_INSTALL_RACE` | internal | yes | Another `kesha install` reached the same cache: either it overwrote the engine during our run (the recorded version or the binary's own `--version` names something else), or it still holds the cache and we gave up waiting for it. Nothing is written in the waiting case. | Re-run the install once no other one is in flight; give concurrent jobs private state via `KESHA_HOME` (or just a private cache via `KESHA_CACHE_DIR` / `KESHA_ENGINE_BIN`). A wait that must fail sooner than the 6 h ceiling: `KESHA_INSTALL_LOCK_WAIT_SECS`, in seconds, positive numbers only — and lowering it costs the one-retry takeover ([concurrent installs](architecture.md#runtime-data-flow)). If the message names a lock no install owns, delete the `.lock` directory it names. |
| `E_INVALID_ARG` | input | no | A CLI flag, argument, or `KESHA_*` value was invalid — including an option the command does not declare (`unknown option --timestamp`, with the nearest real flag suggested), a directory passed where an audio file is expected, `--no-vad` on audio past the 24-minute single-pass ceiling (drop the flag; VAD or fixed windows take over), a `kesha record --out` path that cannot be written (a directory, an unwritable location; the message carries the OS reason), and a `KESHA_CACHE_DIR` / `KESHA_ENGINE_BIN` path the engine cannot be written into: one the engine directory cannot be created under, or an existing engine directory this user cannot write (a read-only Nix store install reaches the second). | See `kesha --help`; for a `KESHA_*` path the message names the setting, the offending value, and what it needs to be. |
| `E_INTERRUPTED` | platform | no | The run was cancelled, not failed: the CLI received `SIGINT`, `SIGTERM` or `SIGHUP` mid-run, a Core API caller aborted the `AbortSignal` it passed to `transcribe()`, or an MCP client cancelled the call or disconnected mid-call. The running engine was terminated and no queued file started; the message names the signal the CLI received — `interrupted (SIGINT)` — even when the engine ignored it and had to be force-killed. Exits 130, 143 or 129 by signal, 130 for a programmatic abort. CLI-side only — the engine never emits it. | Nothing to fix: the run was cancelled, not broken. Re-run it if the cancellation was not intended. |
| `E_INTERNAL` | internal | no | An unexpected or uncoded failure. | File a bug with `kesha support-bundle`. |

## Where codes come from

- **Engine codes** (everything except `E_ENGINE_SPAWN`, `E_ENGINE_PROTOCOL`, `E_INSTALL_RACE` and `E_INTERRUPTED`) are defined in the Rust
  engine and emitted on its stderr as an `error` event that the CLI renders as `error [CODE]: …`.
  List them with `kesha-engine describe` (the `errors` section, each with its `origin`).
  When the engine also writes a line that is not an event, the CLI reports `E_INTERNAL` quoting
  that line and appends the engine's own transcript, so stderr may show two coded lines; the
  `code` field (JSON output, `SayError.code`) names one.
- **`E_ENGINE_SPAWN`**, **`E_ENGINE_PROTOCOL`**, **`E_INSTALL_RACE`** and **`E_INTERRUPTED`** originate
  only in the TypeScript CLI — the failure to spawn the engine subprocess at all,
  an installed engine whose protocol version the CLI does not speak, an
  install that lost the cache to another one, whether by being overwritten before
  it could report success or by giving up waiting for the lock, and a run the
  CLI's own signal cut short, or a caller cancelled through its `AbortSignal` or MCP
  request cancellation. An engine that exits 130 or 143 because the CLI forwarded the
  signal is reported as `E_INTERRUPTED`, never as `E_INTERNAL`.
- The CLI also raises `E_MODEL_MISSING` before spawning when `--speakers` needs a diarization
  or VAD model that `kesha install --diarize` / `--vad` has not placed, `E_TEXT_EMPTY` and
  `E_TEXT_TOO_LONG` from `kesha say` before any engine runs, and `E_INTERNAL` when the
  engine's transcription JSON cannot be read or the engine exits non-zero without reporting an
  error event; all render exactly like the engine's own. `describe` still lists those three
  as engine-only (#1202).
- **`E_INVALID_ARG`** and **`E_INPUT_NOT_FOUND`** are emitted by *both* the
  engine and the TypeScript CLI: the CLI validates arguments, checks input
  existence up front and refuses a cache path it cannot write the engine into,
  and the engine emits the same codes when a bad argument or
  a missing file reaches it directly (e.g. `kesha-engine say` with conflicting
  `--model` / `--voice-file`, or a malformed `--format`).
- **`E_UNSUPPORTED_PLATFORM`** is likewise emitted by both: the engine when a
  build lacks what a request needs, and the CLI from the `kesha install --diarize`
  pre-check, which refuses off darwin-arm64 before any engine exists.

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
| `1` | Operational error — engine/model not installed, a download or install failed, an unknown command, a `macos-*` voice this Mac has not downloaded, or a helper sidecar that is missing or failed. `kesha say` derives this from the code, so `E_MODEL_MISSING`, `E_MODEL_DOWNLOAD`, `E_CACHE_CORRUPT`, `E_MODEL_LOAD`, `E_SIDECAR_MISSING` and `E_VOICE_UNKNOWN` exit `1` whichever engine raised them. |
| `2` | Invalid arguments, usage, or configuration the CLI refuses before doing anything — no input file, an option the command does not declare, mutually-exclusive flags, a bad `--format`, empty `say` text, a backend flag this platform's release does not ship, a directory where an audio file is expected, a transcribe flag the installed engine lacks, a `KESHA_ENGINE_BIN` or `KESHA_CACHE_DIR` that cannot hold the engine directory (a file in the path, a read-only store). From the engine: a `say` or `record --out` path it cannot write (a directory, a missing parent, an unwritable location, a device such as `/dev/stdout`), which both commands answer with the same code and status, a `--rate` outside 0.5–2.0, a `--bitrate` outside 6000–510000, and malformed SSML (`E_SSML_INVALID`). |
| `4` | Unexpected/uncoded internal failure (`E_INTERNAL`), and the two refusals that mean the request cannot be served as written rather than that anything is missing: `E_SCRIPT_UNSUPPORTED` and `E_SSML_UNSUPPORTED`. |
| `5` | `kesha say` text exceeds the length limit. |
| `130` | Interrupted — Ctrl-C (`SIGINT`) reached the CLI mid-run and the engine subprocess was terminated, the interrupted files reporting `E_INTERRUPTED`; or a `kesha init` prompt was cancelled (nothing was installed). |
| `143` | Terminated — a `SIGTERM` reached the CLI mid-run (a cancelled CI job, a stopped container); the engine subprocess was terminated and the interrupted files report `E_INTERRUPTED`. |
| `129` | Hung up — the terminal closed (`SIGHUP`) mid-run; the engine subprocess was terminated exactly as for `SIGTERM` and the interrupted files report `E_INTERRUPTED`. Not on Windows, which has no terminal hangup. The engine itself also exits 129 from `kesha-engine record` when the process that started the capture has exited: the recording is abandoned, the microphone closed and the file removed. |

`130`, `143` and `129` mean the run was **cancelled**, not that it failed: a wrapper
that treats every non-zero status as a crash will misreport a cancellation, and
one that greps for `error [E_` can tell a cancellation by its `E_INTERRUPTED` code.

`kesha say` and other engine-backed commands may also exit with the **engine's
own** non-zero status when the engine itself fails. For fine-grained handling,
match on the stable `error [CODE]` line — it is the reliable signal; the numeric
exit status only distinguishes the broad categories above.

`kesha say` (including `--list-voices`), `kesha record` and `kesha install`
derive that status from one rule: an error the engine reported exits with the
engine's own status (`4` if it broke the protocol on a clean exit), and an error
the CLI raised before the spawn — a flag the installed build lacks, a missing
engine, a protocol mismatch, a backend this platform's release does not ship, an
engine directory the CLI cannot write — maps its code through the table above.
Two edges of that rule are worth knowing. A CLI-raised `E_UNSUPPORTED_PLATFORM`
(no engine is published for this host, or `--diarize` off darwin-arm64) is the
operational `1`: the remedy is another machine, not another command line. And
an engine that exits non-zero without reporting anything has no code to relay:
`say` reports it as `E_INTERNAL` with the engine's status, while `record`
(pinned by #1167) and `install` keep the operational `1`.

Transcription is a batch and keeps its own rule: the run exits `2` when the CLI
itself rejected an argument for any file — a directory positional, a flag the
installed engine lacks — and `1` for every runtime failure, including one the
engine reported, whatever status the engine exited with.
