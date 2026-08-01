# Raycast Extension Specification

## Purpose

The Raycast extension gives Maks a one-hotkey dictation surface on top of the
CLI: he opens **Dictate to Clipboard**, speaks, and the transcript lands on his
clipboard without a terminal, a file to manage, or a round trip to a cloud
service. Everything stays local — the extension records from the default
microphone, hands the audio to the CLI, and deletes it.

The extension is a thin GUI shell, deliberately: it owns the recording
lifecycle, the live Signal meter, and error presentation, while every audio
decision (capture, Transcription, VAD, language) belongs to the CLI and the
Engine underneath it.

## Non-Goals

- The extension does not bundle, download, or update the CLI, the Engine, or any
  model. The Never-auto-download rule holds unchanged: missing pieces surface as
  an actionable error pointing at `bun add -g` or `kesha install`.
- It exposes no transcription options — no language, VAD, Output format,
  Diarization, or Segment controls. Those stay on the CLI.
- It does not offer TTS, file transcription, or batch work. One command, one
  microphone, one clipboard write.
- It does not implement microphone capture itself; recording is delegated to
  `kesha record`, so the WAV contract belongs to the audio-recording spec.
- It is macOS-only and makes no attempt to degrade gracefully elsewhere —
  Raycast itself is macOS-only.
- Device selection is not offered; the OS default input device is used, matching
  `kesha record`.
## Requirements
### Requirement: One view command, macOS-only

The extension SHALL publish exactly one command, **Dictate to Clipboard**, in
`view` mode, and SHALL declare macOS as its only supported platform so the
Raycast Store never offers it on an unsupported client.

#### Scenario: Maks launches dictation from Raycast

- GIVEN the extension is installed and the CLI is present
- WHEN Maks runs **Dictate to Clipboard**
- THEN a view opens showing `Preparing microphone...` while the Dictation
  session starts
- AND recording begins without any further confirmation

#### Scenario: Store hides the extension off macOS

- GIVEN a Raycast client on an unsupported platform
- WHEN the Store lists extensions
- THEN this extension is not offered, because its manifest declares macOS only

> *Technical Note — manifest: `raycast/package.json` — `platforms: ["macOS"]`,
> single `commands[]` entry `dictate-to-clipboard` with `"mode": "view"`.
> Command entry point: `raycast/src/dictate-to-clipboard.tsx` lines 34–59
> (session start in the effect at 39–55, the `Preparing microphone...` view at
> 57–59).*

### Requirement: The CLI is located by preference, then by a fixed probe list

The extension SHALL use the `kesha` binary named by the **Kesha Binary Path**
preference when it is set, and otherwise SHALL probe a fixed list of common
global install locations. When the resolved path is a script with a
`#!/usr/bin/env <interp>` shebang, the extension SHALL invoke it through an
interpreter it locates by absolute path, because Raycast's GUI environment does
not inherit the user's shell `PATH`.

#### Scenario: Maks installed the CLI with bun and set nothing

- GIVEN `kesha` is at `~/.bun/bin/kesha` and the preference is empty
- WHEN Maks starts a Dictation session
- THEN the extension finds the binary by probing and recording starts
- AND no `PATH` configuration was required of Maks

#### Scenario: The CLI cannot be found

- GIVEN no `kesha` exists at any probed location and the preference is empty
- WHEN Maks starts a Dictation session
- THEN the view shows `kesha CLI not found.` together with a hint naming the
  preference, the `bun add -g @drakulavich/kesha-voice-kit` install command, and
  every location that was probed
- AND no recording is started

> *Technical Note — probe order: `FALLBACK_CANDIDATES` in
> `raycast/src/lib/kesha-bin.ts` lines 9–15 (`~/.bun/bin`, `/opt/homebrew/bin`,
> `/usr/local/bin`, `~/.npm-global/bin`, `~/.local/bin`). Resolution:
> `resolveKeshaBin` lines 93–107; shebang/interpreter handling: `buildSpawn`
> lines 69–91 against `INTERPRETER_CANDIDATES` lines 17–24. Not-found text:
> `notFoundMessage` lines 126–132. Surfaced at
> `raycast/src/lib/dictation-controller.ts` lines 71–78.*

### Requirement: Max recording seconds defaults to 300 and must be 1–3600

The extension SHALL default the **Max Recording Seconds** preference to 300 when
it is empty, SHALL reject values that are not positive integers within 1–3600
with a message stating the valid range, and SHALL pass the accepted value to
`kesha record` as its own cap. Rejection happens before the microphone is
touched.

#### Scenario: Maks leaves the preference empty

- GIVEN the preference is blank
- WHEN Maks starts a Dictation session
- THEN recording is capped at 300 seconds
- AND the remaining time is visible in the view while he speaks

#### Scenario: The preference holds a non-integer

- GIVEN the preference is set to `30.5`
- WHEN Maks starts a Dictation session
- THEN the view shows `Max recording seconds must be an integer between 1 and
  3600.`
- AND no microphone recording is started

> *Technical Note — constants `DEFAULT_MAX_SECONDS = 300`,
> `MAX_ALLOWED_SECONDS = 3600`: `raycast/src/lib/dictation-config.ts` lines 1–2.
> Validation: `parseMaxSeconds` lines 10–23, called first in the session at
> `raycast/src/lib/dictation-controller.ts` line 69. Forwarded as
> `--max-seconds`: `raycast/src/lib/process-tasks.ts` lines 83–94.*

### Requirement: Recording shows live elapsed time, input device, and Signal meter

While recording, the extension SHALL show elapsed time, the default input
device's name (with its sample rate and channel count when the system reports
them), and a Signal meter that distinguishes **signal** from **listening**. When
the meter cannot start, the session SHALL continue recording and report the
meter as unavailable rather than failing.

#### Scenario: Maks watches the level while dictating

- GIVEN a Dictation session is recording and Maks is speaking
- WHEN the meter samples the microphone
- THEN the view shows a level that rises with his voice and a `Signal detected`
  status
- AND elapsed time keeps pace with the wall clock

#### Scenario: The level meter fails to start

- GIVEN the meter helper cannot be started or exits without emitting a sample
- WHEN the Dictation session is recording
- THEN the view reports the meter as `Meter unavailable`
- AND recording continues normally and the transcript is still produced

> *Technical Note — meter cadence `METER_INTERVAL_MS = 500`:
> `raycast/src/lib/dictation-config.ts` line 4; ticking in
> `startRecordingMonitor`, `raycast/src/lib/recording-monitor.ts` lines 18–52.
> Device name/rate/channels come from `system_profiler SPAudioDataType -json`
> (`resolveDefaultMicInfo` lines 54–64, parsed by `parseDefaultMicInfo` in
> `raycast/src/lib/mic-info.ts` lines 5–21). Level source: an AVAudioEngine tap
> run via `/usr/bin/swift -e`, `raycast/src/lib/signal-meter.ts` lines 9–56 and
> 101–141; `signal`/`listening` classification against
> `SILENCE_PEAK_THRESHOLD = 0.0001` at lines 64–84. Unavailable fallback: lines
> 125–132.*

### Requirement: Idle auto-stop ends recording after 45 s of no speech

The extension SHALL treat a continuous **listening** stretch as idle: it SHALL
warn Maks in the view at 30 seconds and SHALL stop recording 15 seconds later,
so an abandoned session never runs to the full cap. Any detected signal SHALL
reset the idle countdown. Idle auto-stop fires at most once per Dictation
session.

#### Scenario: Maks walks away mid-session

- GIVEN a Dictation session has been recording silence for 30 seconds
- THEN the view reads `No speech detected — recording will stop soon.`
- WHEN a further 15 seconds of silence pass
- THEN recording stops on its own, a `Stopped after silence.` notice is shown,
  and the audio captured so far proceeds to Transcription

#### Scenario: Maks pauses to think and resumes

- GIVEN 20 seconds of silence have elapsed within a Dictation session
- WHEN Maks starts speaking again
- THEN the idle countdown resets and no warning is shown
- AND recording continues until he stops it or the cap is reached

> *Technical Note — `IDLE_WARN_MS = 30_000`, `IDLE_STOP_GRACE_MS = 15_000`:
> `raycast/src/lib/dictation-config.ts` lines 5–6. Countdown and one-shot latch:
> `createSilenceTracker` in `raycast/src/lib/dictation-controller.ts` lines
> 214–241 (reset on any non-`listening` state, line 226). Idle copy:
> `raycast/src/lib/recording-view.ts` lines 17–19.*

### Requirement: Silent audio is rejected before Transcription with a permission hint

The extension SHALL fail the Dictation session when the recorded WAV contains no
sample above the silence threshold, naming the two plausible causes — macOS
Microphone permission for Raycast, and the selected input device — instead of
spending time on a Transcription that would return nothing.

#### Scenario: Raycast lacks Microphone permission

- GIVEN macOS has not granted Raycast microphone access, so the recording is
  digital silence
- WHEN the Dictation session finishes recording
- THEN the view shows `Recorded audio is silent. Check macOS Microphone
  permission for Raycast and the selected input device.`
- AND the CLI is never asked to transcribe

#### Scenario: Audible speech passes the check

- GIVEN the recording contains speech
- WHEN the Dictation session finishes recording
- THEN the silence check passes and Transcription starts immediately

> *Technical Note — check invoked at
> `raycast/src/lib/dictation-controller.ts` lines 129–133. Detection reads the
> `fmt `/`data` chunks and scans samples: `isSilentWav` in
> `raycast/src/lib/wav.ts` lines 12–30, covering IEEE-float 32-bit (the format
> `kesha record` writes) and 16-bit PCM, including `WAVE_FORMAT_EXTENSIBLE`
> payloads (lines 47–60). Threshold: `SILENCE_PEAK_THRESHOLD = 0.0001`.
> Unrecognised formats return "not silent" so the check can never block a valid
> recording (line 29).*

### Requirement: Transcription runs through the CLI and times out after 60 s

The extension SHALL obtain the transcript by running the CLI's default
Transcription command on the recorded file and reading its stdout. It SHALL
abandon a Transcription that has not finished within 60 seconds and report the
timeout. A non-zero Exit code SHALL be surfaced using the CLI's own stderr text
so the Engine's Error code and hint reach Maks unedited.

#### Scenario: Maks dictates a short note

- GIVEN a recording with speech and an installed Engine and models
- WHEN Transcription completes successfully
- THEN the transcript is taken from the CLI's stdout, trimmed, and shown
- AND the elapsed Transcription time was visible while it ran

#### Scenario: Models are missing

- GIVEN Maks has never run `kesha install`, so the CLI exits non-zero with an
  `E_MODEL_MISSING` Error code and an install hint
- WHEN the Dictation session reaches Transcription
- THEN the view shows the CLI's own stderr message, hint included
- AND the extension does not attempt any download of its own

#### Scenario: Transcription hangs

- GIVEN a Transcription that produces no result for 60 seconds
- WHEN the timeout expires
- THEN the process is terminated and the view shows `kesha transcription timed
  out after 60 seconds.`

> *Technical Note — `TRANSCRIBE_TIMEOUT_MS = 60_000`:
> `raycast/src/lib/dictation-config.ts` lines 7–8. Spawn, capture, timeout and
> force-kill: `startKeshaTranscriber` in `raycast/src/lib/process-tasks.ts`
> lines 112–168 (SIGTERM at the timeout, SIGKILL 3 s later, lines 136–145).
> stderr is preferred over a synthetic message on non-zero exit, lines 156–160.
> Buffers are tail-capped — 16 MiB stdout, 8 000 characters of stderr — by
> `capTail` lines 23–25.*

### Requirement: A successful transcript is copied to the clipboard; an empty one is an error

On success the extension SHALL copy the trimmed transcript to the clipboard,
confirm that it did, and show the text with a copy action for a second copy. A
transcript that is empty after trimming SHALL be surfaced as a failed Dictation
session rather than silently copying an empty string.

#### Scenario: Transcript reaches the clipboard

- GIVEN Transcription returned text
- WHEN the Dictation session completes
- THEN the trimmed transcript is on the clipboard, a `Copied transcript`
  confirmation is shown, and the view displays the text
- AND Maks can paste immediately without touching the view

#### Scenario: Nothing intelligible was said

- GIVEN Transcription succeeded but returned only whitespace
- WHEN the Dictation session completes
- THEN the view shows `No transcript returned.`
- AND the clipboard is left untouched

> *Technical Note — the empty case is rejected by `normalizeTranscribeResult`
> (`raycast/src/lib/dictation-controller.ts` lines 253–262), which trims stdout
> and throws before the session sees a result; that is why the user-visible text
> is `No transcript returned.` and not the friendlier
> `No speech was detected in the recording.` at lines 158–160, which is
> unreachable for exactly that reason (see Open Issues). Trim, copy and success
> state: lines 157–169. Clipboard write is Raycast's own `Clipboard.copy`,
> injected at
> `raycast/src/dictate-to-clipboard.tsx` lines 43–46; the result view's copy
> action is at lines 115–118.*

### Requirement: Maks can stop recording or cancel Transcription at any point

The extension SHALL offer an explicit stop action while recording and an
explicit cancel action while transcribing, and SHALL also treat closing the
command as a cancel. Stopping mid-recording SHALL still transcribe what was
captured; cancelling a Transcription SHALL abandon it.

#### Scenario: Maks stops as soon as he finishes the sentence

- GIVEN a Dictation session is recording
- WHEN Maks triggers **Stop and Transcribe**
- THEN recording stops, the view shows `Stopping recording...`, and the audio
  captured so far is transcribed

#### Scenario: Maks closes the command while transcribing

- GIVEN a Dictation session is transcribing
- WHEN Maks dismisses the Raycast window
- THEN the Transcription is abandoned, no clipboard write happens, and no
  further view update is attempted

> *Technical Note — session handles: `stopRecording`, `cancelTranscription` and
> `cancel` in `raycast/src/lib/dictation-controller.ts` lines 42–62; the
> `cancelled` latch suppresses late state writes at lines 110, 127, 155 and 171.
> Actions and unmount cleanup: `raycast/src/dictate-to-clipboard.tsx` lines
> 51–54, 68–73 and 91–97.*

### Requirement: No orphaned recorder or transcriber processes survive a session

Every child process the extension starts SHALL be terminated when its Dictation
session ends, by any route — normal completion, stop, cancel, error, or the
command closing. Termination SHALL escalate: a cooperative stop first, then
SIGTERM, then SIGKILL, targeting the whole process group so an interpreter
wrapper cannot leave the CLI behind.

#### Scenario: A stopped recorder exits promptly

- GIVEN a Dictation session is recording
- WHEN Maks stops it
- THEN the recorder is asked to stop cooperatively, is sent SIGTERM if it is
  still alive 1.5 s later, and SIGKILL 5 s after the stop
- AND no `kesha record` process remains once the session ends

#### Scenario: A wedged transcriber is force-killed

- GIVEN a Transcription that ignores SIGTERM
- WHEN cancellation or the timeout fires
- THEN SIGKILL follows 3 s later and the process group is gone

> *Technical Note — escalation ladders: `stopProcessWithWatchdog`
> (stdin EOF → SIGTERM at 1500 ms → SIGKILL at 5000 ms) and
> `terminateProcessWithWatchdog` (SIGTERM now → SIGKILL at 3000 ms) in
> `raycast/src/lib/process-tasks.ts` lines 39–74. The Signal meter helper has
> its own shorter ladder — SIGTERM, then SIGKILL after 1 s —
> `raycast/src/lib/signal-meter.ts` lines 134–139. Group targeting:
> `killProcessGroup` lines 27–37, paired with `detached: true` at spawn
> (`raycast/src/lib/process-tasks.ts` lines 93 and 124,
> `raycast/src/lib/signal-meter.ts` line 111). Session-scoped teardown
> regardless of outcome: `raycast/src/lib/dictation-controller.ts` lines
> 177–185.*

### Requirement: Recorded audio is written to a private temp directory and deleted

The extension SHALL record into a per-session temporary directory it creates,
and SHALL delete that directory when the Dictation session ends, on every path
including failure and cancellation. Audio SHALL never be written to a
user-visible location and SHALL never leave the machine.

#### Scenario: Nothing is left behind after a normal session

- GIVEN a Dictation session that completes and copies a transcript
- WHEN the session ends
- THEN its temporary directory and the WAV inside it no longer exist

#### Scenario: Nothing is left behind after a failure

- GIVEN a Dictation session that fails — silent audio, a CLI error, or a
  cancellation
- WHEN the session ends
- THEN the temporary directory is still removed
- AND no partial recording remains on disk

> *Technical Note — creation and path: `createTempDir` in
> `raycast/src/lib/dictation-controller.ts` (`createDefaultDictationDeps`:
> `mkdtemp` under the OS temp dir, prefix `raycast-kesha-dictate-`); the WAV
> path is `join(tempDir, "dictation.wav")` inside `run()`. Removal in the
> session's `finally` via `cleanupTempDir`
> (`rm(dir, { recursive: true, force: true })`).*

### Requirement: Not-found guidance works for users without bun
When the kesha CLI cannot be resolved, the extension's guidance SHALL present a Homebrew-first install path, mention the bun alternative, include the mandatory `kesha install` follow-up step, and demote the probed-paths listing to a secondary troubleshooting line.

#### Scenario: Store user without the CLI
- **WHEN** the extension cannot find the kesha binary
- **THEN** the error view shows numbered setup steps (install CLI, run `kesha install`) understandable without prior knowledge of bun

### Requirement: Error views are actionable
Every error state SHALL render an ActionPanel with at least: copy the error text, open extension preferences, and open the setup guide.

#### Scenario: any error state
- **WHEN** the extension shows an error Detail
- **THEN** the user can copy the error, open preferences, or open the setup guide without leaving Raycast

### Requirement: Setup problems surface before recording

Before entering the recording state, the extension SHALL probe the resolved CLI (version/engine availability) and, on failure, render a dedicated finish-setup view naming the exact remaining command instead of starting a recording that cannot succeed.

The probe SHALL decide Engine availability from the CLI's machine-readable status
output rather than by matching human-readable prose, so that rewording the CLI's
status text cannot break a published extension.

Engine availability SHALL mean present AND reporting readable capabilities. An
Engine binary that exists but cannot report its capabilities is unusable, and the
probe SHALL treat it as unavailable rather than starting a Dictation session that
will fail during Transcription. The finish-setup view SHALL distinguish this case
from a never-installed Engine in both its message and its hint, because the
remedy differs: a plain `kesha install` takes the cached-engine path and only
re-trusts an existing binary, so repairing one requires `kesha install
--no-cache`. On a read-only engine directory (a Nix-store install) that flag is
deliberately a no-op, and the probe cannot tell the two topologies apart, so the
hint SHALL name both routes rather than promising a repair that would silently
skip.

When the resolved CLI is older than the machine-readable output and therefore
does not produce it, the probe SHALL fall back to the previous prose marker
rather than reporting a broken install — the extension is distributed through the Raycast Store and cannot
assume the CLI on a given machine matches it.

The prose fallback SHALL be taken only when the output is not machine-readable at
all. Output that is machine-readable but does not satisfy the contract SHALL be
treated as unavailable, never passed to the prose fallback: a structured response
missing the presence field would otherwise also fail the prose match and be
reported as a healthy Engine. Failing closed here costs Maks a dismissible setup
view; failing open costs him a Dictation session. The prose match SHALL be
anchored to the Engine binary line rather than to the whole output, so an
unrelated line rendered with the same missing-marker cannot be misread as the
Engine being absent.

A probe that cannot run at all SHALL continue to fail open, letting the CLI's own
guards report the real problem with a better message than the probe could.

#### Scenario: CLI present but engine not installed

- **WHEN** Maks starts dictation with the CLI installed but `kesha install` never run
- **THEN** a finish-setup view names `kesha install` before any recording toast appears

#### Scenario: Engine present, structured probe succeeds

- **GIVEN** the resolved CLI produces machine-readable status output and the Engine is installed
- **WHEN** Maks starts a Dictation session
- **THEN** the probe reports the Engine as available without inspecting any human-readable text
- **AND** recording starts without a finish-setup view

#### Scenario: Engine present but unusable

- **GIVEN** the Engine binary exists but cannot report its capabilities (corrupt or incompatible)
- **WHEN** Maks starts a Dictation session
- **THEN** the probe reports the Engine as unavailable despite it being present
- **AND** the finish-setup view names repairing the install, distinct from the never-installed wording
- **AND** no recording starts

#### Scenario: Older CLI without machine-readable status

- **GIVEN** the resolved CLI predates the machine-readable status output
- **WHEN** Maks starts a Dictation session with no Engine installed
- **THEN** the probe falls back to the prose marker and still renders the finish-setup view
- **AND** an installed Engine on that same older CLI still starts recording normally

#### Scenario: Structured output that breaks the contract

- **GIVEN** the resolved CLI emits machine-readable output without the presence field
- **WHEN** Maks starts a Dictation session
- **THEN** the probe reports the Engine as unavailable rather than falling back to the prose match
- **AND** no recording starts

#### Scenario: Probe cannot run

- **WHEN** the resolved CLI cannot be spawned or exits unexpectedly during the probe
- **THEN** the probe fails open and the Dictation session proceeds
- **AND** any real problem is reported by the CLI's own error path

> *Technical Note — sources: `raycast/src/lib/kesha-bin.ts::probeEngineAvailability`,
> which spawns `kesha status --json` and branches on stdout kind:
> `parseStatusObject` accepts only a JSON object, `readStructuredStatus` requires
> `engine.installed` to be a boolean and treats a null `engine.capabilities` as
> unusable, and `proseSaysEngineMissing` matches the legacy marker on the Binary
> line. The verdict reaches the setup view through `EnginePreflightResult.reason`
> (`"missing"` / `"unusable"`), which `dictation-controller.ts` maps to distinct
> messages. `raycast/` is mirrored into `raycast/extensions`, so a change here
> needs a follow-up upstream sync.*

### Requirement: Missing microphone input is reported early
When the signal meter delivers no sample within a short window (~8 s) of recording start, the extension SHALL surface microphone-permission guidance as a non-blocking warning while recording continues — a meter failure alone MUST NOT abort a session that may still be capturing audio. An unavailable meter MUST NOT disarm the silence auto-stop, so a session without input ends at the idle stop instead of the maximum duration.

#### Scenario: mic permission denied
- **WHEN** macOS denies microphone access and the meter reports unavailable
- **THEN** within ~8 s the user sees guidance to grant Raycast microphone access, recording continues, and the session ends at the silence auto-stop with the silent-recording error instead of running to the max duration

## Open Issues

- Recording is capped by `--max-seconds` but Transcription is capped at a fixed
  60 s, and the two are unrelated: a 300 s recording of dense speech can exceed
  the Transcription timeout on a cold Engine and fail after the audio is already
  captured. The timeout is not user-configurable.
- The Signal meter runs a Swift snippet through `/usr/bin/swift`, which requires
  Xcode or the Command Line Tools. On a machine without them the meter reports
  itself unavailable — correct behaviour, but the message does not say why, so
  Maks cannot tell it apart from a permission problem.
- Idle auto-stop is driven entirely by the Signal meter: the silence timer
  advances on **listening** and **unavailable** alike, so a session whose meter
  never starts still stops at the idle deadline rather than running to
  `--max-seconds` — but it stops on meter silence, not on audio silence, so a
  monologue recorded while the meter is dead is cut at 45 s. That coupling is
  not obvious from the requirement text.
- The friendlier empty-transcript message `No speech was detected in the
  recording.` (`raycast/src/lib/dictation-controller.ts` lines 158–160) is
  unreachable: `normalizeTranscribeResult` (lines 253–262) already trims and
  throws `No transcript returned.` for the same input, so that is what Maks
  actually sees. Either the outer guard should go or `normalizeTranscribeResult`
  should carry the friendlier wording — changing it means diverging from the
  version currently in the Raycast Store, so it is recorded here rather than
  fixed in the sync.
- Microphone permission is observed only indirectly, as digital silence. The
  extension cannot distinguish "permission denied" from "the wrong input device
  is selected" or "the mic is muted in hardware", so the error names all of
  them.
- `raycast/CHANGELOG.md` and the Store listing are versioned separately from the
  CLI: nothing in CI fails when a CLI change alters behaviour this spec
  describes. Keeping them in step is manual today.
- The extension is published from `raycast/` in this repo by copying into
  `raycast/extensions`; the divergence that produced PR
  raycast/extensions#29681 (review fixes landing upstream only) has no automated
  guard.
- The fallback path means the prose marker `"not installed"` in `kesha status`
  stays a load-bearing string for as long as older CLIs are in the wild. There is
  no agreed point at which the fallback can be dropped, and nothing fails loudly
  if the marker is reworded while the fallback is still relied upon.
- The prose fallback cannot detect a present-but-unusable Engine: an older CLI's
  human output says "probe failed" on a line the marker match does not read, so on
  those CLIs a corrupt Engine still reaches recording and fails during
  Transcription. This matches today's behaviour and is not a regression, but it
  means the broken-Engine guarantee holds only on the structured path.
- "Readable capabilities" is a weaker guarantee than "Dictation will succeed": it
  says the Engine can describe itself, not that ASR models are present.
  `getEngineCapabilities` (`src/engine.ts:367`) casts parsed JSON without
  validating its shape, so a well-formed-but-wrong object counts as readable and
  can still fail later. Closing that gap is a separate concern from this change.
