## MODIFIED Requirements

### Requirement: Recording shows live elapsed time, input device, and Signal meter

While recording, the extension SHALL show elapsed time, the default input
device's name (with its sample rate and channel count when the system reports
them), and a Signal meter that distinguishes **signal** from **listening**. When
the meter cannot start, the session SHALL continue recording and report the
meter as unavailable rather than failing.

The **signal** / **listening** verdict SHALL depend only on how loudly Maks is
speaking, never on how many channels his input device exposes. A device that
carries his voice on one input and digital silence on the rest SHALL classify
the same speech the same way a single-channel microphone does — otherwise Idle
auto-stop ends a Dictation session while he is still talking, which is the
failure this extension is least able to afford.

A meter sample that carries no usable channel level SHALL read as **listening**.
Absence of a measurement is not evidence of speech, and treating it as such
would disable Idle auto-stop for the whole session.

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
> source: an AVAudioEngine tap
> run via `/usr/bin/swift -e`, `raycast/src/lib/signal-meter.ts` lines 9–54,
> spawned and supervised at lines 111–150. The tap accumulates one rms per
> channel (line 39) and emits them as `channelRms`; `loudestChannelRms` (line
> 72) reduces that to the loudest, and `parseMeterLine` classifies it against
> `SPEECH_RMS_THRESHOLD = 0.01` (`dictation-config.ts` line 8) at line 89. The
> displayed percentage comes from peak, already a maximum across channels, via
> `percentFromPeak` (line 63). Unavailable fallback: lines 133–141. Distinct
> from `SILENCE_PEAK_THRESHOLD = 0.0001` (`dictation-config.ts` line 5), which
> is not a speech test and is used only by `raycast/src/lib/wav.ts` lines 71 and
> 87 to reject an all-silent recording.*

## Open Issues

- The multi-channel guarantee is verified by arithmetic and unit tests, not on
  hardware: no multi-channel input device was available. The single-channel path
  was measured on a real microphone (183 samples over 20 s, 1/183 classified as
  speech in a quiet room, consistent with the 7/101 recorded in #648).
- "Loudest channel" is a heuristic for "the channel Maks is speaking into". On a
  device where a different input carries something louder than his voice — a
  line input fed by music, say — the meter follows that instead, and Idle
  auto-stop would not fire. This is the same direction of failure as a noisy
  room, which #670 accepted deliberately, but it is now reachable through a
  second route and nothing warns about it.
- `raycast/CHANGELOG.md` in this repository has no `[Silence auto-stop now
  works]` section at all: #670 backported the code from
  `raycast/extensions#29936` without the changelog entry, so neither the
  threshold fix nor this one is recorded for Store users on this side of the
  mirror. The upstream copy does carry both. Left unresolved here rather than
  guessed at, because the two copies' changelogs are reconciled at mirror-sync
  time and the merge date placeholder is upstream's convention.
