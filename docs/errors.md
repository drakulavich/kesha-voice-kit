# Error codes

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
| `E_INPUT_NOT_FOUND` | input | no | The input audio path doesn't exist (or no stdin was piped). Over MCP, also a `kesha-audio://` resource whose file is gone (JSON-RPC error -32002, resource not found): synthesized files are deleted after 24 hours. | Check the path; pass a readable file. |
| `E_BAD_AUDIO` | input | no | The audio container/codec couldn't be decoded (or the file couldn't be opened for a reason other than "missing"), including a header no decoder can represent, such as a WAV declaring a sample rate of 0, and an empty (0-byte) file. A directory passed where an audio file is expected is `E_INVALID_ARG`, not this — the CLI rejects it as a bad argument before the engine ever opens it. | Re-export to wav/ogg/mp3; verify the file isn't truncated; check permissions. |
| `E_MODEL_MISSING` | model | no | A required model or voice isn't installed. | `kesha install` / `kesha install --tts`. |
| `E_MODEL_DOWNLOAD` | model | yes | A model download failed (network or mirror error), or `kesha install` could not download the engine binary or its release's `SHA256SUMS`: a network error, an HTTP error status, an empty response, or a body that broke off mid-read. | Retry; check connectivity and `KESHA_MODEL_MIRROR`. For the engine binary, check that the release exists (`--engine-version`). |
| `E_CACHE_CORRUPT` | model | no | A cached model file, a freshly downloaded engine binary, or a cached engine file in a read-only engine directory failed its SHA-256 check. [Details](#e_cache_corrupt). | `kesha install --no-cache` to re-fetch; the other cases are under [details](#e_cache_corrupt). |
| `E_MODEL_LOAD` | model | no | A model file exists but failed to load, including a truncated Kokoro voice file and an ASR decoder whose output does not match its vocabulary; the message names the file. | Reinstall the model the message names: `kesha install --no-cache` for the speech-recognition model, `kesha install --tts` for a TTS model or voice file; check disk space. |
| `E_UNSUPPORTED_PLATFORM` | platform | no | The feature isn't supported on this OS/arch (e.g. microphone recording off macOS), or `kesha install` found no published engine for it. | Use a supported platform (see the [platform matrix](product-positioning.md#platform-matrix)). |
| `E_SIDECAR_MISSING` | platform | no | A helper sidecar is missing or exited nonzero (e.g. `say-avspeech`). | Reinstall; ensure the sidecar sits beside the engine (macOS). |
| `E_NO_BACKEND` | platform | no | The binary was built without an ASR backend. | Use an official release build. |
| `E_MIC_UNAVAILABLE` | platform | no | `kesha record` could not use a microphone: macOS reports no default input device, or the default input device failed to open or start. Exits `1`. | Connect a microphone and select it in System Settings > Sound > Input; allow your terminal in System Settings > Privacy & Security > Microphone. |
| `E_TEXT_EMPTY` | tts | no | Synthesis text was empty. | Pass non-empty text. |
| `E_TEXT_TOO_LONG` | tts | no | Text exceeded the maximum length. | Split into shorter requests. |
| `E_VOICE_UNKNOWN` | tts | no | The voice id wasn't recognized, or a `macos-*` voice is not downloaded on this Mac. | `kesha say --list-voices`; for a `macos-*` voice, download it in System Settings > Accessibility > Spoken Content. |
| `E_SSML_INVALID` | tts | no | SSML was malformed (missing `<speak>` root, a second root or text after `</speak>`, an unclosed tag, DOCTYPE, or unsupported relative rate). | Fix the SSML; see [docs/tts.md](tts.md). |
| `E_SSML_UNSUPPORTED` | tts | no | SSML isn't supported for this engine/voice. | Use a plain-text request or a supported voice. |
| `E_SCRIPT_UNSUPPORTED` | tts | no | The text is mostly in a script the chosen voice's G2P can't phonemize (Latin for the FluidAudio Kokoro voices, Cyrillic for `ru-vosk-*`, Han or Latin for `zh-*`; the message names both), or it has nothing pronounceable, or one token the FluidAudio G2P rejects. | Transliterate the text into a script the voice handles (the message names it), or use a voice whose engine supports the script. See [#492](https://github.com/drakulavich/kesha-voice-kit/issues/492). |
| `E_TRANSCRIBE_FAILED` | transcribe | no | The ASR pipeline failed: the model ran and errored, every fixed window of a long file failed, or `--speakers` labeled too little of the transcript. | Re-run with `KESHA_DEBUG=1`, then file a bug with the `kesha support-bundle` archive (the engine's hint says so); for incomplete speaker labels, re-run without `--speakers` for a plain transcript. |
| `E_DIARIZE_TIMEOUT` | transcribe | yes | A diarization phase exceeded its budget, or `KESHA_DIARIZE_TIMEOUT_SECS` cut the run short. The message names the phase: model load, reading the audio, or processing chunks. | Model load: re-run once warm (`kesha install --diarize`), or `KESHA_DIARIZE_COMPUTE_UNITS=cpu-and-gpu`, or raise `KESHA_DIARIZE_LOAD_TIMEOUT_SECS` (default 300). Own cap: raise or unset `KESHA_DIARIZE_TIMEOUT_SECS`. Otherwise file a bug. |
| `E_ENGINE_SPAWN` | platform | no | The Engine binary is missing or failed to start (CLI-side). The message names the path the CLI looked at, and the hint names `KESHA_ENGINE_BIN`, `KESHA_CACHE_DIR` or `KESHA_HOME` when one of them chose that path. | `kesha install`; or set `KESHA_ENGINE_BIN`; or fix or unset the variable the hint names. |
| `E_ENGINE_PROTOCOL` | platform | no | The installed Engine speaks a protocol version this CLI does not (CLI-side). | `kesha install` for a stale Engine; `bun add -g @drakulavich/kesha-voice-kit@latest` for a stale CLI. |
| `E_INSTALL_RACE` | internal | yes | Another `kesha install` reached the same cache: it overwrote the engine during our run, or it still holds the cache and we gave up waiting. [Details](#e_install_race). | Re-run the install once no other one is in flight; give concurrent jobs private state via `KESHA_HOME`. |
| `E_INVALID_ARG` | input | no | A CLI flag, argument, or `KESHA_*` value was invalid, or a path given to kesha cannot be used. [All cases](#e_invalid_arg). | See `kesha --help`; for a `KESHA_*` path the message names the setting, the offending value, and what it needs to be. |
| `E_INTERRUPTED` | platform | no | The run was cancelled, not failed: a signal reached the CLI, or a Core API or MCP caller cancelled. Exits 130, 143 or 129 by signal, 130 for a programmatic abort. [Details](#e_interrupted). | Nothing to fix: the run was cancelled, not broken. Re-run it if the cancellation was not intended. |
| `E_INTERNAL` | internal | no | An unexpected or uncoded failure; also a `kesha say` that wrote no audio, a disk error while writing the engine or a support bundle, and a Stats database kesha cannot use. [Details](#e_internal). | Re-run with `KESHA_DEBUG=1`, then file a bug with the `kesha support-bundle` archive; the disk and Stats cases have their own fixes under [details](#e_internal). |

## Details by code

### `E_CACHE_CORRUPT`

- A cached model file failed SHA-256 verification: `kesha install --no-cache` re-fetches it; if `KESHA_MODEL_MIRROR` is set, check that the mirror serves the pinned file.
- A freshly downloaded engine binary did not match its pinned SHA-256: it is deleted, never installed. Re-run `kesha install`, and report it if the mismatch persists.
- A cached engine binary or sidecar in a read-only engine directory no longer matches its pin: it is left in place and not run. Make the directory writable and re-run `kesha install`.

### `E_INSTALL_RACE`

- Another install overwrote the engine during our run: the recorded version or the binary's own `--version` names something else.
- Another install still holds the cache and we gave up waiting for it. Nothing is written in this case.

Concurrent jobs can also get just a private cache via `KESHA_CACHE_DIR` / `KESHA_ENGINE_BIN`. To fail sooner than the 6 h ceiling, set `KESHA_INSTALL_LOCK_WAIT_SECS` (seconds, positive numbers only). A lock held by an install on another host or container is taken over only once it is 6 h old, so a shorter wait gives up on such a lock instead of taking it over ([concurrent installs](architecture.md#runtime-data-flow)). If the message names a lock no install owns, delete the `.lock` directory it names.

### `E_INVALID_ARG`

- an option the command does not declare (`unknown option --timestamp`, with the nearest real flag suggested);
- a directory or another non-regular file (a named pipe, `/dev/stdin` or `/dev/fd/*` whatever stdin holds, `<(...)`) passed where an audio file is expected, or `-` given for stdin;
- `--no-vad` on audio past the 24-minute single-pass ceiling (drop the flag; VAD or fixed windows take over);
- `kesha init` without a terminal on stdin and stdout and without `--yes` or `--plan`;
- a `kesha record --out` path that cannot be written (a directory, an unwritable location; the message carries the OS reason);
- a `kesha support-bundle --output` path that names a directory or an existing file, sits under a file, or is refused for permission or a read-only filesystem;
- a diagnostic log folder `kesha logs enable` or `kesha logs mode` cannot write its settings file into (permission denied, a read-only filesystem, a file in the way);
- an MCP audio folder `synthesize_speech` cannot create under `KESHA_HOME`;
- a `KESHA_CACHE_DIR` / `KESHA_ENGINE_BIN` path the engine cannot be written into: one the engine directory cannot be created under, an existing engine directory this user cannot write (a read-only Nix store install reaches this one), or one that refuses the engine binary mid-install (permission denied, a read-only filesystem).

### `E_INTERRUPTED`

- The CLI received `SIGINT`, `SIGTERM` or `SIGHUP` mid-run, a Core API caller aborted the `AbortSignal` it passed to `transcribe()`, or an MCP client cancelled the call or disconnected mid-call.
- The running engine was terminated and no queued file started.
- The message names the signal the CLI received (`interrupted (SIGINT)`), even when the engine ignored it and had to be force-killed.
- CLI-side only: the engine never emits it.

### `E_INTERNAL`

- An unexpected or uncoded failure. An uncoded engine failure carries the `KESHA_DEBUG=1` / `kesha support-bundle` hint itself.
- An engine that exited 0 from `kesha say` without writing any audio (an empty or missing `--out` file, or nothing on stdout); exits `1`.
- A disk error other than a permission or read-only one (a full disk, `ENOSPC`, or an I/O error) while `kesha install` writes the engine binary or `kesha support-bundle` writes its archive; the message names the engine directory or the archive path. For a full disk, free space on the volume the message names and re-run the command that failed (`kesha install` or `kesha support-bundle`).
- A [Stats](local-stats.md) database that `kesha stats` cannot open, read or write (locked by another kesha command, read-only, or on a full disk); the message names the file. Not SQLite or damaged: delete the file. Locked: retry when the other kesha command finishes. Any other failure: make the file and its folder readable and writable.

## Where codes come from

- **Engine codes** (everything except the four CLI-only codes below) are defined in the Rust
  engine and emitted on its stderr as an `error` event that the CLI renders as `error [CODE]: …`.
  List them with `kesha-engine describe` (the `errors` section, each with its `origin`).
  When the engine also writes a line that is not an event, the CLI reports `E_INTERNAL` quoting
  that line and appends the engine's own transcript, so stderr may show two coded lines; the
  `code` field (JSON output, `KeshaError.code` in the [Core API](api.md#errors)) names one.
- **`E_ENGINE_SPAWN`**, **`E_ENGINE_PROTOCOL`**, **`E_INSTALL_RACE`** and **`E_INTERRUPTED`** originate
  only in the TypeScript CLI — the failure to spawn the engine subprocess at all,
  an installed engine whose protocol version the CLI does not speak, an
  install that lost the cache to another one, whether by being overwritten before
  it could report success or by giving up waiting for the lock, and a run the
  CLI's own signal cut short, or a caller cancelled through its `AbortSignal` or MCP
  request cancellation. An engine that exits 130 or 143 because the CLI forwarded the
  signal is reported as `E_INTERRUPTED`, never as `E_INTERNAL`.
- The CLI also raises some engine codes itself, before or around the engine run; all render exactly like the engine's own:
  - `E_MODEL_MISSING` before spawning when `--speakers` needs a diarization or VAD model that `kesha install --diarize` / `--vad` has not placed, and from `kesha status --check` when the engine binary or the ASR model is not installed (plain `status` and `status --json` exit `0`);
  - `E_TEXT_EMPTY` and `E_TEXT_TOO_LONG` from `kesha say` before any engine runs;
  - `E_INTERNAL` when the engine's transcription JSON cannot be read, the engine writes a line that is not an event, or it exits non-zero without reporting an error event. When a signal killed the engine, the message names it (`kesha-engine transcribe was killed by SIGSEGV`, likewise for `record` and `install`).
- Each of these `E_INTERNAL` failures carries a hint to re-run with `KESHA_DEBUG=1` and file a bug with the `kesha support-bundle` archive; for an off-protocol line it first suggests `kesha install`, since an engine and CLI that do not match is the usual cause. Transcription still exits `1`.
- The audio language-ID warning names the signal too and suggests the same bug report instead of a reinstall.
- `describe` publishes `E_MODEL_MISSING`, `E_TEXT_EMPTY` and `E_TEXT_TOO_LONG` as `both` from engine v1.26.0 on (#1202).
- `kesha install` and the Core API `install()` raise `E_MODEL_DOWNLOAD` when the engine binary
  cannot be downloaded (a network error, an HTTP error status, an empty response, a body
  that breaks off mid-read) and `E_CACHE_CORRUPT` when it does not match its SHA-256; both
  exit `1`. A disk that refuses the binary is not a download failure: permission denied or a
  read-only filesystem is `E_INVALID_ARG` (exit `2`), a full disk or another disk error `E_INTERNAL` (exit `4`),
  and neither leaves a partial binary behind. The engine codes a model file the cache refuses the same way, after
  one request and with no retry: `E_INVALID_ARG` names the directory to make writable (and offers `KESHA_CACHE_DIR`
  where it would move the write), `E_INTERNAL` names the disk to free; `kesha install` exits `1` for both. `describe` publishes the
  two codes as `both` from engine v2.1.0 on (#1261).
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
| `1` | Operational error: something is not installed, could not be downloaded, or a device or helper is missing. [Details](#exit-1). |
| `2` | Invalid arguments, usage, or configuration refused before anything runs, and malformed SSML. [Details](#exit-2). |
| `4` | Unexpected/uncoded internal failure (`E_INTERNAL`), and the two refusals that mean the request cannot be served as written rather than that anything is missing: `E_SCRIPT_UNSUPPORTED` and `E_SSML_UNSUPPORTED`. [Details](#exit-4). |
| `5` | `kesha say` text exceeds the length limit. |
| `130` | Interrupted — Ctrl-C (`SIGINT`) reached the CLI mid-run and the engine subprocess was terminated, the interrupted files reporting `E_INTERRUPTED`; or a `kesha init` prompt was cancelled (nothing was installed). |
| `143` | Terminated — a `SIGTERM` reached the CLI mid-run (a cancelled CI job, a stopped container); the engine subprocess was terminated and the interrupted files report `E_INTERRUPTED`. |
| `129` | Hung up — the terminal closed (`SIGHUP`) mid-run; the engine subprocess was terminated exactly as for `SIGTERM` and the interrupted files report `E_INTERRUPTED`. Not on Windows, which has no terminal hangup. [Details](#exit-129). |

`130`, `143` and `129` mean the run was **cancelled**, not that it failed: a wrapper
that treats every non-zero status as a crash will misreport a cancellation, and
one that greps for `error [E_` can tell a cancellation by its `E_INTERRUPTED` code.

For fine-grained handling, match on the stable `error [CODE]` line — it is the reliable signal; the numeric exit status only distinguishes the broad categories above.

### Exit 1

- engine/model not installed, a download or install failed;
- a `macos-*` voice this Mac has not downloaded;
- a helper sidecar that is missing or failed;
- a microphone `kesha record` cannot use (`E_MIC_UNAVAILABLE`);
- an engine that exited 0 from `kesha say` without writing any audio (`E_INTERNAL`).

`kesha say` derives this from the code, so `E_MODEL_MISSING`, `E_MODEL_DOWNLOAD`, `E_CACHE_CORRUPT`, `E_MODEL_LOAD`, `E_SIDECAR_MISSING` and `E_VOICE_UNKNOWN` exit `1` whichever engine raised them.

### Exit 2

Refused by the CLI before doing anything:

- no input file, an unknown command, an option the command does not declare, mutually-exclusive flags, a bad `--format`, empty `say` text;
- a backend flag this platform's release does not ship, a transcribe flag the installed engine lacks;
- a directory where an audio file is expected;
- a `KESHA_ENGINE_BIN` or `KESHA_CACHE_DIR` that cannot hold the engine directory (a file in the path, a read-only store), or a pinned engine file in a read-only engine directory that cannot be read to verify it.

From the engine:

- a `say` or `record --out` path it cannot write (a directory, a missing parent, an unwritable location, a device such as `/dev/stdout`), which both commands answer with the same code and status;
- a `--rate` outside 0.5–2.0, a `--bitrate` outside 6000–510000 or an Opus `--sample-rate` other than 8000, 12000, 16000, 24000 or 48000;
- a `record` without `--out` or `--live`, a `record --max-seconds 0` or an `--auto-stop-*` value out of range;
- malformed SSML (`E_SSML_INVALID`).

Transcription exits `1` instead for an `E_INVALID_ARG` the engine raises at run time, such as `--no-vad` on audio past the 24-minute ceiling.

### Exit 4

Transcription exits `1` instead for every engine failure, an engine crash included. An engine that dies without reporting an error follows [the rule below](#how-say-record-and-install-pick-the-status). `kesha install` also exits `1` for the `E_INTERNAL` of a CLI build that lacks the pinned SHA-256 of an engine asset.

### Exit 129

The engine itself also exits 129 when the process that started it has exited, for example after a `SIGKILL` that leaves no chance to forward a signal: `kesha-engine record` abandons the recording, closes the microphone and removes the file; `transcribe` and `say` stop within about 250 ms, and `say --out` writes no file unless it was already writing when the parent died, which can leave it partly written. Not on Windows.

### How `say`, `record` and `install` pick the status


`kesha say` (including `--list-voices`), `kesha record` and `kesha install`
derive that status from one rule: an error the engine reported exits with the
engine's own status (`4` if it broke the protocol on a clean exit), and an error
the CLI raised before the spawn — a flag the installed build lacks, a missing
engine, a protocol mismatch, a backend this platform's release does not ship, an
engine directory the CLI cannot write — maps its code through the table above.
Two edges of that rule are worth knowing. A CLI-raised `E_UNSUPPORTED_PLATFORM`
(no engine is published for this host, or `--diarize` off darwin-arm64) is the
operational `1`: the remedy is another machine, not another command line. And
an engine that exits non-zero without reporting anything has no code of its own:
all three report it as `E_INTERNAL`, naming the signal when one killed the engine;
`say` exits with the engine's status (such as `139` for `SIGSEGV`), while `record` (#1167) and
`install` keep the operational `1`.

Transcription is a batch and keeps its own rule: the run exits `2` when the CLI
itself rejected an argument for any file — a directory positional, a flag the
installed engine lacks — and `1` for every runtime failure, including one the
engine reported, whatever status the engine exited with.

A stdout the reader closes mid-write (`kesha say | head -c 1000`) exits `0`
quietly; any other failed write to stdout prints `error [E_INTERNAL]: failed writing to stdout`
with the OS error and exits `1`. A stdout already closed at launch (`kesha say hello >&-`) is the
exception: the Bun runtime reopens fd 1 as `/dev/null` before kesha runs, so
the output is discarded and `say`, transcription and `kesha mcp` exit `0`.
Redirect to a file or a pipe instead of closing stdout.
