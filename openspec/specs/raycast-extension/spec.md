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

While recording, the extension SHALL show elapsed time, the default input device's
name (with its sample rate and channel count when the system reports them), and a
Signal meter that distinguishes **signal** from **listening**. When the meter cannot
start, the session SHALL continue recording and report the meter as unavailable
rather than failing. The verdict SHALL depend only on how loudly Maks is speaking,
never on how many channels his input device exposes.

#### Scenario: Maks watches the level while dictating

- GIVEN a Dictation session is recording and Maks is speaking
- WHEN the meter samples the microphone
- THEN the view shows a level that rises with his voice and a `Signal detected`
  status
- AND elapsed time keeps pace with the wall clock

#### Scenario: Maks dictates through a multi-channel audio interface

- GIVEN Maks records through an interface that exposes several inputs and his
  microphone is plugged into one of them
- WHEN he speaks at the same level that reads as **signal** on his built-in
  microphone
- THEN the meter reports **signal**
- AND the Idle auto-stop countdown resets, so recording continues while he talks

#### Scenario: The level meter fails to start

- GIVEN the meter helper cannot be started or exits without emitting a sample
- WHEN the Dictation session is recording
- THEN the view reports the meter as `Meter unavailable`
- AND recording continues normally and the transcript is still produced

#### Scenario: A meter sample carries no usable level

- GIVEN the meter emits a sample whose channel levels are missing or not numbers
- WHEN the Dictation session is recording
- THEN that sample reads as **listening** rather than as speech
- AND recording continues, with Idle auto-stop still able to fire

> *Technical Note — meter cadence `METER_INTERVAL_MS = 500`:
> `raycast/src/lib/dictation-config.ts` line 3; ticking in
> `startRecordingMonitor`, `raycast/src/lib/recording-monitor.ts` lines 20–54.
> Device name/rate/channels come from `system_profiler SPAudioDataType -json`
> (`resolveDefaultMicInfo` in the same file, lines 56–66, parsed by
> `parseDefaultMicInfo` in `raycast/src/lib/mic-info.ts` lines 5–21). Level
> source: an AVAudioEngine tap run via `/usr/bin/swift -e`,
> `raycast/src/lib/signal-meter.ts` lines 9–54, spawned and supervised at lines
> 111–150. The tap accumulates one rms per
> channel (line 39) and emits them as `channelRms`; `loudestChannelRms` (line
> 72) reduces that to the loudest, and `parseMeterLine` classifies it against
> `SPEECH_RMS_THRESHOLD = 0.01` (`dictation-config.ts` line 8) at line 89. The
> displayed percentage comes from peak, already a maximum across channels, via
> `percentFromPeak` (line 63). Unavailable fallback: lines 133–141. Distinct
> from `SILENCE_PEAK_THRESHOLD = 0.0001` (`dictation-config.ts` line 5), which
> is not a speech test and is used only by `raycast/src/lib/wav.ts` lines 71 and
> 87 to reject an all-silent recording. A device that carries Maks's voice on one
> input and digital silence on the rest classifies the same speech the same way a
> single-channel microphone does; otherwise Idle auto-stop would end a Dictation session
> while he is still talking, the failure this extension is least able to afford. A
> sample with no usable channel level reads as **listening** because absence of a
> measurement is not evidence of speech, and treating it as speech would disable Idle
> auto-stop for the whole session.*

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

### Requirement: Dictation uses live Transcription when the Engine advertises `record.live`

The extension SHALL run a single `kesha record --live` process, which transcribes the
microphone as it captures and prints the transcript when recording stops, whenever
the CLI's machine-readable status lists `record.live` among the Engine's features
**and** reports a CLI version that accepts `--live`. Otherwise it SHALL record a WAV
and transcribe that file in a second process. An unreadable, malformed, or absent
feature list SHALL count as the feature being absent, never as an Error.

#### Scenario: Apple Silicon with an Engine that advertises the feature

- GIVEN the probe reports `record.live` among the Engine's features, and a CLI
  version that accepts `--live`
- WHEN Maks dictates and stops
- THEN one CLI process ran for the whole session, no WAV was written, and no
  separate Transcription phase was entered
- AND the transcript is on the clipboard as soon as the live session ends

#### Scenario: The first live session of the day warms up

- GIVEN a live Dictation session whose Engine has not compiled its streaming
  models yet
- WHEN the command opens
- THEN the view says it is preparing, no Signal meter runs, and the idle
  auto-stop is not counting
- AND it flips to Recording only once the Engine reports the microphone open,
  so the first words spoken are captured

#### Scenario: A live session fails before the microphone opens

- GIVEN a live session that exits with an Error before it reports listening
- WHEN the failure arrives
- THEN the view goes from preparing straight to the Error, with no Signal meter
  started, no idle countdown and no Recording toast

#### Scenario: An Engine advertising the feature to a CLI too old for the flag

- GIVEN the probe reports `record.live` but a CLI version older than the release
  that added `kesha record --live`
- WHEN Maks dictates
- THEN the session takes the record-then-transcribe path rather than spawning a
  flag the CLI would ignore

#### Scenario: An Intel Mac, or any Engine without the feature

- GIVEN the probe reports the Engine's features and `record.live` is not among
  them, as on the ONNX Engine an Intel Mac runs
- WHEN Maks dictates
- THEN the session records to a WAV and transcribes it in a second process,
  behaving exactly as it did before live Transcription existed

#### Scenario: A CLI too old to report an Engine feature list

- GIVEN the resolved CLI produces no machine-readable status output, so no
  feature list is available
- WHEN Maks dictates
- THEN the extension takes the record-then-transcribe path rather than failing
- AND no setup Error is shown on account of the missing feature list

#### Scenario: Maks watches the view while a live session records

- GIVEN a live Dictation session that is recording
- WHEN Maks speaks for a minute
- THEN no text appears in the view while he talks, because live Transcription removes
  the separate Transcription phase rather than adding a progressive one
- AND the transcript is shown once, when recording stops

> *Technical Note — the feature list is read by `probeEngineAvailability`
> (`raycast/src/lib/kesha-bin.ts`), which already ran `kesha status --json` for
> the setup probe and now returns `engine.capabilities.features` and
> `cliVersion`; a value that is not an array of strings degrades to an empty
> list. Both halves are weighed by `supportsLiveDictation` in the same file,
> against `RECORD_LIVE_FEATURE` — matching what `rust/src/capabilities.rs`
> advertises under the same `cfg` that compiles `cli::record::run_live` — and
> `RECORD_LIVE_MIN_CLI_VERSION = "1.28.0"`, the first CLI release containing
> `record --live` (`git tag --contains 50511a0`). A prerelease of the same
> triple counts, and an unparseable or absent version fails closed to the
> fallback. Live spawn:
> `startKeshaLiveRecorder` in `raycast/src/lib/process-tasks.ts`. Branch:
> `startDictationSession`'s `run()` in `raycast/src/lib/dictation-controller.ts`,
> over a `recordPhase` generic in the task it starts so the meter, the idle
> tracker and cancellation are shared by both paths; `liveRecordPhase` starts the
> live task first and awaits its `micOpen` before handing it over. `micOpen`
> resolves `listening` on the Engine's `Listening (` stderr line —
> `rust/src/record.rs` prints it right after `stream.play()`, with
> `StreamingAsrSession::start` ahead of that — and `ended` when the process
> finished first, so a failed spawn neither hangs the session nor drives it
> through a recording view; that branch awaits `task.done` so the Engine's own
> failure is what Maks sees. `kesha install`'s warmup covers `backend::create_backend`, not
> `init_streaming_asr`, so the first live session pays that cost. Both halves of the
> gate are required because the Engine and the CLI version independently: the Engine
> advertises what it can do, while the CLI has to accept the flag and ignores one it
> does not know, so an Engine newer than the CLI's pin would otherwise reach a CLI
> that exits 2 asking for `--out`, with the recording already lost. Failing toward the
> fallback costs nothing, since the fallback path works everywhere.*

### Requirement: A live session shows the preparing view until the Engine is listening

A live Dictation session SHALL keep showing the preparing view, with no Signal meter,
no idle countdown and no Stop action, until the Engine reports that it is listening.

#### Scenario: A warm Engine opens the microphone quickly

- GIVEN a live Dictation session whose streaming models are already compiled
- WHEN the Engine reports that it is listening
- THEN the view switches to Recording, the Signal meter starts, the idle countdown
  begins and **Stop and Transcribe** is offered

#### Scenario: Maks looks for Stop while the Engine warms up

- GIVEN a live Dictation session whose Engine is still compiling its streaming models
- WHEN Maks looks at the view before the Engine reports listening
- THEN it offers no **Stop and Transcribe** action and no idle countdown runs
- AND the view still reads `Preparing microphone...`

> *Technical Note — a live session prepares its streaming Transcription before it
> opens the input device, and a first run compiles models for the ANE in about 20 s.
> Claiming to record through that window would lose everything spoken in it and then
> blame macOS Microphone permission for the empty transcript. Sources:
> `liveRecordPhase` awaiting `micOpen` in `raycast/src/lib/dictation-controller.ts`;
> the preparing view in `raycast/src/dictate-to-clipboard.tsx`.*

### Requirement: Silent audio is rejected before Transcription with a permission hint

On the record-then-transcribe path the extension SHALL fail the Dictation session
when the recorded WAV contains no sample above the silence threshold, naming the two
plausible causes — macOS Microphone permission for Raycast, and the selected input
device — instead of spending time on a Transcription that would return nothing. On
the live path an empty transcript SHALL carry the same guidance, in a single message
naming the permission cause.

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

#### Scenario: A live session captures nothing

- GIVEN a live Dictation session whose transcript is empty
- WHEN the session ends
- THEN the view names macOS Microphone permission for Raycast and the selected
  input device, the same guidance the WAV silence check produces
- AND the clipboard is left untouched

> *Technical Note — check invoked at
> `raycast/src/lib/dictation-controller.ts` lines 129–133. Detection reads the
> `fmt `/`data` chunks and scans samples: `isSilentWav` in
> `raycast/src/lib/wav.ts` lines 12–30, covering IEEE-float 32-bit (the format
> `kesha record` writes) and 16-bit PCM, including `WAVE_FORMAT_EXTENSIBLE`
> payloads (lines 47–60). Threshold: `SILENCE_PEAK_THRESHOLD = 0.0001`.
> Unrecognised formats return "not silent" so the check can never block a valid
> recording (line 29). The live equivalent is `normalizeLiveTranscript` in
> `raycast/src/lib/dictation-controller.ts`, kept separate from
> `normalizeTranscribeResult` so the fallback's two distinct messages survive. The
> live path has no WAV to inspect, so an empty transcript is its equivalent signal, and
> nothing on that path can tell a silent capture apart from speech that produced no
> text.*

### Requirement: Transcription runs through the CLI and times out proportionally to the recording length

On the record-then-transcribe path the extension SHALL obtain the transcript by
running the CLI's default Transcription command on the recorded file and reading its
stdout, and SHALL abandon a Transcription that has not finished within a timeout
that scales with the recording's length (a fixed floor plus a per-second allowance),
so a recording made at the default `maxSeconds` cannot fail purely because of the
timeout.

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

#### Scenario: A long recording gets a proportional timeout

- GIVEN a recording captured over 120 seconds
- WHEN Transcription starts
- THEN the timeout is the floor plus 120 × the per-second allowance, not a
  fixed 60 seconds
- AND the visible Transcription timeout reflects that scaled value

#### Scenario: Transcription hangs

- GIVEN a Transcription that produces no result before its scaled timeout
- WHEN the timeout expires
- THEN the process is terminated and the view shows `kesha transcription timed
  out after N seconds.` for that recording's timeout
- AND the recorded audio is kept, and the Error hint names its path and a
  `kesha "<path>"` command to transcribe it manually

#### Scenario: Maks cancels a long transcription

- GIVEN a Transcription running on an already-captured recording
- WHEN Maks cancels it, or the view is dismissed
- THEN the recording is kept rather than deleted, and — when a view is still
  shown — the Error names its path and the `kesha "<path>"` command

#### Scenario: A live session fails after minutes of progress output

- GIVEN a live Dictation session that printed its progress line every second for
  the whole session and then failed
- WHEN the Error is shown
- THEN it names the Engine's own Error, and the progress line takes the single
  line it would take in a terminal rather than one fragment per second

#### Scenario: A live session is interrupted before it finishes

- GIVEN a live Dictation session that has not yet stopped
- WHEN Maks dismisses the view
- THEN no transcript is produced and none is written to the clipboard, because
  `--live` prints its transcript once, at the end
- AND the extension names no recovery artifact of its own; the Engine's own
  recovery audio (#962) is the only copy and lives under its cache, not the
  extension's temp directory

> *Technical Note — the timeout is `transcribeTimeoutMs(recordingSeconds)`:
> `raycast/src/lib/dictation-config.ts` (`TRANSCRIBE_TIMEOUT_FLOOR_MS = 60_000`
> plus `TRANSCRIBE_TIMEOUT_PER_SECOND_MS = 2_000`, derivation in the file
> comment against BENCHMARK.md's ONNX-CPU real-time factors). Recording length
> is the recorder's wall-clock duration, captured in `recordPhase`. Spawn,
> capture, timeout and force-kill: `startKeshaTranscriber` in
> `raycast/src/lib/process-tasks.ts` (SIGTERM at the timeout, SIGKILL 3 s
> later). On any post-capture failure the temp WAV is preserved instead of
> cleaned up and its path is surfaced via `keptAudioHint`
> (`raycast/src/lib/dictation-controller.ts`). stderr is preferred over a
> synthetic message on non-zero exit. Buffers are tail-capped — 16 MiB stdout,
> 8 000 characters of stderr — by `capTail`. The scaled timeout and the kept
> recording belong to the record-then-transcribe path only: the live path has no
> separate Transcription window to outrun and no recording of its own to keep.*

### Requirement: A recording that yields no transcript is kept

The extension SHALL keep a captured recording on the record-then-transcribe path, and
name its path in the Error, whenever Transcription does not deliver a transcript,
whether it times out, fails for any other reason, or Maks cancels it. A kept
recording left by an earlier session SHALL be pruned once it is older than a week.

#### Scenario: The CLI fails on a captured recording

- GIVEN a captured recording and a CLI that exits non-zero during Transcription
- WHEN the Error is shown
- THEN the recording is still on disk and the Error hint names its path and a
  `kesha "<path>"` command to transcribe it manually

#### Scenario: A week-old kept recording is pruned

- GIVEN one recording kept eight days ago and another kept two days ago
- WHEN Maks starts a new Dictation session
- THEN the eight-day-old recording is deleted and the two-day-old one is left alone

> *Technical Note — sources: `keptAudioHint` and the keep-on-failure branch in
> `raycast/src/lib/dictation-controller.ts`; `pruneOldRecordings` runs at session
> start and removes `raycast-kesha-dictate-*` temp dirs older than
> `RECORDING_MAX_AGE_MS` (7 days).*

### Requirement: CLI stderr reaches Maks unedited

A non-zero Exit code SHALL be surfaced using the CLI's own stderr text so the
Engine's Error code and hint reach Maks unedited. For a live session the extension
SHALL render carriage returns in that text the way a terminal does, keeping only the
final state of each line and treating a carriage return that ends a CRLF line as part
of the line ending, and SHALL change nothing else.

#### Scenario: A multi-line Error keeps its shape

- GIVEN a live Dictation session that fails with a multi-line Error containing a
  blank line and an install hint
- WHEN the Error is shown
- THEN the blank line and the install hint appear exactly as the CLI wrote them

#### Scenario: CRLF line endings are not read as overwrites

- GIVEN a live session whose stderr ends each line with CRLF
- WHEN the Error is shown
- THEN every line keeps its full text

> *Technical Note — a live session's stderr also carries a progress line the Engine
> repaints once a second with a carriage return, and surfacing every fragment would
> bury the Error under thousands of characters (#947). Source:
> `renderCarriageReturns` in `raycast/src/lib/process-tasks.ts`.*

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
- THEN the view shows `No speech was detected in the recording.`
- AND the clipboard is left untouched

> *Technical Note — the empty case is rejected by `normalizeTranscribeResult`
> (`raycast/src/lib/dictation-controller.ts`), which trims stdout and throws
> before the session sees a result. It is the only empty-transcript guard on the
> path and so carries the user-facing wording; `deliverTranscript` used to repeat
> the check unreachably behind it, and that duplicate is gone (#943). Copy and
> success state: `deliverTranscript`, on the already-trimmed text. Clipboard
> write is Raycast's own `Clipboard.copy`, injected at
> `raycast/src/dictate-to-clipboard.tsx` lines 43–46; the result view's copy
> action is at lines 115–118.*

### Requirement: Maks can stop recording or cancel Transcription at any point

The extension SHALL offer an explicit stop action while recording and an
explicit cancel action while transcribing, and SHALL also treat closing the
command as a cancel. Stopping mid-recording SHALL still transcribe what was
captured; cancelling a Transcription SHALL abandon it.

The Cancel Transcription action belongs to the record-then-transcribe path,
which is the only one with a Transcription phase to cancel. On the live path
**Stop and Transcribe** is the single control.

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

#### Scenario: Maks closes the command as the transcript is being copied

- GIVEN a Dictation session whose clipboard write has already begun
- WHEN Maks dismisses the Raycast window
- THEN the transcript still reaches the clipboard, because a write handed to the
  OS cannot be recalled and the transcript is what the session exists to produce
- AND no success toast is shown and the view is not updated, so the dismissal is
  what Maks sees

> *Technical Note — session handles: `stopRecording`, `cancelTranscription` and
> `cancel` in `raycast/src/lib/dictation-controller.ts` lines 42–62; the
> `cancelled` latch suppresses late state writes at lines 110, 127, 155 and 171.
> Actions and unmount cleanup: `raycast/src/dictate-to-clipboard.tsx` lines
> 51–54, 68–73 and 91–97.*

### Requirement: No orphaned recorder or transcriber processes survive a session

Every child process the extension starts SHALL be terminated when its Dictation
session ends, by any route — normal completion, stop, cancel, error, or the command
closing — escalating from a cooperative stop to SIGTERM to SIGKILL against the whole
process group, so an interpreter wrapper cannot leave the CLI behind. On the live
path the escalation after **Stop and Transcribe** SHALL be slower, while a cancelled
live session SHALL release the input device immediately.

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

#### Scenario: A stopped live session is given time to finish its transcript

- GIVEN a live Dictation session
- WHEN Maks stops it
- THEN the cooperative stop goes out first and no signal follows for several
  seconds, so the streaming session can print its transcript
- AND SIGTERM and then SIGKILL still follow if it never exits

#### Scenario: A live session is dismissed rather than stopped

- GIVEN a live Dictation session
- WHEN Maks closes the command instead of stopping it
- THEN SIGTERM goes out at once, with SIGKILL 3 s behind it, and the microphone
  is free for the next app rather than held for the finish ladder

> *Technical Note — escalation ladders: `stopProcessWithWatchdog`
> (stdin EOF → SIGTERM at 1500 ms → SIGKILL at 5000 ms),
> `stopLiveProcessWithWatchdog` (stdin EOF → SIGTERM at `LIVE_STOP_GRACE_MS`
> 10 s → SIGKILL at `LIVE_FORCE_KILL_MS` 15 s, both in
> `raycast/src/lib/dictation-config.ts`) and `terminateProcessWithWatchdog`
> (SIGTERM now → SIGKILL at 3000 ms) in `raycast/src/lib/process-tasks.ts`. The
> live grace exists because the CLI's own SIGTERM handler SIGKILLs the Engine
> 1 s later (`FORCE_KILL_GRACE_MS` in `src/process-tree.ts`), which would leave a
> live session ~2.5 s in total under the fallback ladder. `startKeshaLiveRecorder`
> returns both ladders: `stop` for the finish, `abort` — the
> `terminateProcessWithWatchdog` one — for a dismissal, chosen by
> `DictationSession.cancel`. A live session that
> exits 130 or 143 after printing its transcript is a success, not a failure
> (#962). The Signal meter helper has
> its own shorter ladder — SIGTERM, then SIGKILL after 1 s —
> `raycast/src/lib/signal-meter.ts` lines 134–139. Group targeting:
> `killProcessGroup` lines 27–37, paired with `detached: true` at spawn
> (`raycast/src/lib/process-tasks.ts` lines 93 and 124,
> `raycast/src/lib/signal-meter.ts` line 111). Session-scoped teardown
> regardless of outcome: `raycast/src/lib/dictation-controller.ts` lines
> 177–185. The live path starts one child where the fallback starts two. Its
> slower ladder exists because a live session produces its transcript after the
> cooperative stop: signalling it on the fallback recorder's schedule would destroy the
> transcript the session exists to deliver. A cancelled live session discards its
> transcript, so holding the microphone for the finish ladder buys nothing.*

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
output rather than by matching human-readable prose. A probe that cannot run at all
SHALL continue to fail open.

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
- **AND** the setup view names a CLI/extension version mismatch, not a broken Engine
- **AND** no recording starts

#### Scenario: Machine-readable output that is not a status object

- **GIVEN** the resolved CLI emits valid JSON whose top-level value is an array or a scalar
- **WHEN** Maks starts a Dictation session
- **THEN** the probe treats it as a contract failure, not as an older CLI's output
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
> needs a follow-up upstream sync. Reading structured output means rewording the CLI's
> status text cannot break a published extension. A probe that cannot run fails open so
> the CLI's own guards report the real problem with a better message than the probe
> could.*

### Requirement: A present but unusable Engine is caught before recording

Engine availability SHALL mean present AND reporting readable capabilities, a
non-empty structured value rather than merely a non-null one. The probe SHALL treat a
present Engine without them as unavailable, and the finish-setup view SHALL word that
case apart from a never-installed Engine in both message and hint, the hint naming
both `kesha install --no-cache` and the repair route for a read-only engine
directory.

#### Scenario: A healthy Engine reports its capabilities

- GIVEN the Engine is installed and `kesha status --json` reports a non-empty
  `engine.capabilities`
- WHEN Maks starts a Dictation session
- THEN recording starts without a finish-setup view

#### Scenario: The Engine reports an empty capabilities object

- GIVEN `kesha status --json` reports `engine.installed: true` and
  `engine.capabilities: {}`
- WHEN Maks starts a Dictation session
- THEN the view reads `Kesha's engine is installed but not working.`
- AND the hint names `kesha install --no-cache` and repairing a read-only (Nix)
  install through its package manager
- AND no recording starts

> *Technical Note — an unusable Engine would otherwise fail during Transcription,
> after the recording is gone (#647). A plain `kesha install` takes the cached-engine
> path and only re-trusts an existing binary, so repair needs `--no-cache`; on a
> read-only engine directory (a Nix-store install) that flag is a no-op, and the probe
> cannot tell the two topologies apart, so the hint names both rather than promising a
> repair that would silently skip. Sources: `capabilitiesAreReadable`, `REPAIR_HINT`
> in `raycast/src/lib/kesha-bin.ts`; `preflightMessage` in
> `raycast/src/lib/dictation-controller.ts`.*

### Requirement: The prose fallback is reserved for output that is not machine-readable

When the CLI's status output is not machine-readable, the probe SHALL fall back to
the previous prose marker, matched on the Engine binary line only, and only when the
output is recognisably a status report; unrecognisable output SHALL fail open.
Machine-readable output that breaks the contract SHALL be treated as an unavailable
Engine, never passed to the prose fallback, and SHALL be reported as a version
mismatch between CLI and extension rather than a broken Engine.

#### Scenario: Another line of an older CLI's output carries the marker

- GIVEN an older CLI whose human status shows the Engine binary as installed and
  `not installed` on an unrelated line
- WHEN Maks starts a Dictation session
- THEN the probe reads only the Binary line, reports the Engine as available and
  recording starts

#### Scenario: The status object has the wrong presence type

- GIVEN the resolved CLI emits a JSON object whose `engine.installed` is the string
  `"yes"`
- WHEN Maks starts a Dictation session
- THEN the view reads `Kesha CLI and this extension are out of sync.`
- AND no recording starts

#### Scenario: Output that is neither JSON nor a status report

- GIVEN the resolved CLI prints text with no Binary line
- WHEN Maks starts a Dictation session
- THEN the probe fails open and the Dictation session proceeds

> *Technical Note — the prose fallback exists because the extension is distributed
> through the Raycast Store and cannot assume the CLI on a given machine matches it.
> Structured output missing the presence field would also fail the prose match and be
> reported as a healthy Engine, so it fails closed: that costs Maks a dismissible setup
> view, while failing open costs him a Dictation session. A contract failure is a
> version mismatch because re-downloading the Engine would not resolve it. The Binary
> line anchor keeps an unrelated line rendered with the same missing-marker from being
> misread as the Engine being absent. Sources: `classifyStatusStdout`,
> `readStructuredStatus`, `proseSaysEngineMissing` and `CONTRACT_HINT` in
> `raycast/src/lib/kesha-bin.ts`.*

### Requirement: Missing microphone input is reported early
When the signal meter delivers no sample within a short window (~8 s) of recording start, the extension SHALL surface microphone-permission guidance as a non-blocking warning while recording continues — a meter failure alone MUST NOT abort a session that may still be capturing audio. An unavailable meter MUST NOT disarm the silence auto-stop, so a session without input ends at the idle stop instead of the maximum duration.

#### Scenario: mic permission denied
- **WHEN** macOS denies microphone access and the meter reports unavailable
- **THEN** within ~8 s the user sees guidance to grant Raycast microphone access, recording continues, and the session ends at the silence auto-stop with the silent-recording error instead of running to the max duration

## Open Issues

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
  says the Engine can describe itself, not that ASR models are present. The CLI
  now validates the capabilities shape before reporting it, but the extension
  keeps its own check because it meets whatever CLI version is on the machine,
  including ones that predate that validation.
- The multi-channel guarantee on the Signal meter is verified by arithmetic and
  unit tests, not on hardware: no multi-channel input device was available. The
  single-channel path was measured on a real microphone (183 samples over 20 s,
  1/183 classified as speech in a quiet room, consistent with the 7/101 recorded
  in #648).
- "Loudest channel" is a heuristic for "the channel Maks is speaking into". On a
  device where a different input carries something louder than his voice — a line
  input fed by music, say — the meter follows that instead, and Idle auto-stop
  would not fire. This is the same direction of failure as a noisy room, which
  #670 accepted deliberately, but it is now reachable through a second route and
  nothing warns about it.
- `raycast/CHANGELOG.md` in this repository has no `[Silence auto-stop now
  works]` section at all: #670 backported the code from
  `raycast/extensions#29936` without the changelog entry, so neither the
  threshold fix nor the multi-channel one is recorded for Store users on this
  side of the mirror. The upstream copy carries both. Left unresolved rather than
  guessed at, because the two copies' changelogs are reconciled at mirror-sync
  time and the merge-date placeholder is upstream's convention.
