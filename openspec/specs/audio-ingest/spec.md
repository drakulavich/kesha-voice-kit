# Audio Ingest Specification

## Purpose

Audio ingest is the Engine's front door: every audio path a user hands to
Transcription, Language detection (audio), or Diarization is opened, decoded,
mixed to mono, and resampled here before any model sees it. It is also where a
bad file is supposed to be rejected — cheaply, with a coded error, before a
Backend spends twenty-five seconds cold-loading on input that was never usable.

Ira cares that a corrupt file in a batch fails with a stable Error code instead
of a cryptic model failure. Maks cares that voice notes from any messenger just
work without installing anything else.

## Non-Goals

- Transcoding or exporting audio. Kesha reads audio; the only audio it writes is
  synthesized speech ([tts-synthesis](../tts-synthesis/spec.md)) and microphone
  captures ([audio-recording](../audio-recording/spec.md)).
- Requiring, detecting, or shelling out to any external media tool. `ffmpeg` is
  not a dependency and never becomes one.
- Splitting audio into utterances. VAD windowing and chunking are
  [transcription](../transcription/spec.md)'s concern and run on the samples
  this capability produces.
- Live microphone capture, which reaches the model through
  [audio-recording](../audio-recording/spec.md) rather than through a file
  decode.

## Requirements

### Requirement: Audio decoding needs no external media tool

The Engine SHALL decode every supported container in-process and SHALL NOT depend on `ffmpeg` or any other external media tool being installed. A container it cannot decode is an error, never a fallback to an external process.

#### Scenario: Maks transcribes a Telegram voice note on a clean machine

- GIVEN Maks has installed the CLI and run `kesha install`, and no `ffmpeg` is
  on the machine
- WHEN Maks runs `kesha voice.ogg` on an OGG/Opus voice note
- THEN the file is decoded and transcribed
- AND nothing reports a missing media tool

#### Scenario: A container the Engine cannot demux

- GIVEN a file in a container the Engine has no demuxer for
- WHEN Ira transcribes it
- THEN the Engine fails with a message naming the file
- AND no external process is spawned to try again
- AND the Error code is `E_BAD_AUDIO`, because an undecodable container is the
  user's input, not an Engine fault

> *Technical Note — `rust/src/audio.rs:19-24` registers symphonia's enabled
> codecs plus `symphonia_adapter_libopus::OpusDecoder`; `open_format`
> (`rust/src/audio.rs:50`) probes with symphonia's enabled formats. Supported
> containers/codecs are whatever those registries carry — MP3, WAV, FLAC, AAC,
> OGG/Vorbis, Opus, AIFF, and more. CLAUDE.md states the no-`ffmpeg` property
> as a project invariant.*

### Requirement: A file's extension is a hint, not the decision

The Engine SHALL determine a file's container by probing its contents, using the path extension only as a case-insensitive hint, so that an unusually-cased or misleading extension does not by itself decide whether a file can be read.

#### Scenario: Maks transcribes a file exported with an uppercase extension

- GIVEN a screen recorder wrote `Recording.M4A`
- WHEN Maks runs `kesha Recording.M4A`
- THEN it decodes exactly as `recording.m4a` would

#### Scenario: A file with no extension at all

- GIVEN an existing file named `voicenote` with no extension
- WHEN Maks runs `kesha voicenote`
- THEN the Engine probes the contents with no hint and decodes it if the
  container is supported

> *Technical Note — `build_hint` (`rust/src/audio.rs:36`) lowercases the
> extension before handing it to symphonia and returns an empty `Hint` when the
> path has no extension or a non-UTF-8 one. Routing a bare extensionless
> existing file to transcription instead of the unknown-command handler is
> specified in [cli-shell-integration](../cli-shell-integration/spec.md).*

### Requirement: Unusable input is rejected before a Backend is loaded

Every transcription entry point SHALL validate that the input is a supported container holding at least one audio track before loading a Backend, so an unusable file fails in milliseconds with a message about the file rather than after a model cold-load with a message about the model.

#### Scenario: Ira transcribes a video-only container

- GIVEN a `.webm` carrying only a video track
- WHEN Ira runs `kesha clip.webm`
- THEN the Engine fails with an error stating the file has no supported audio
  tracks
- AND it fails before any ASR model is loaded

#### Scenario: A readable, supported file

- GIVEN a WAV file with one audio track
- WHEN Ira transcribes it
- THEN validation passes without decoding any frames, and transcription proceeds

> *Technical Note — `ensure_audio_track` (`rust/src/audio.rs:321`) calls
> `open_format` and discards the reader: container headers only, never a frame
> decode and never an `n_frames` scan, so it stays cheap on the Xing-less CBR
> MP3 worst case. Its doc comment records the failure it was added for —
> FluidAudio's "Swift bridge error: Transcription failed" landing ~25 s into
> the ASR cold-load on a file already known to be unusable.*

### Requirement: A missing input is distinguished from an unreadable one

The Engine SHALL report a path that does not exist with the `E_INPUT_NOT_FOUND` Error code, and a path that exists but is otherwise unreadable — it cannot be **opened**, carries no container the Engine can demux, holds no supported audio track, declares no sample rate, uses a codec the Engine cannot decode, or raises a hard **decode** fault — with `E_BAD_AUDIO`, so a caller can tell a typo from an unreadable file without parsing prose, and never sees `E_INTERNAL` for input the Engine simply cannot read.

#### Scenario: Ira mistypes a filename in a batch

- GIVEN `a.ogg` exists and `b.ogg` does not
- WHEN Ira runs `kesha a.ogg b.ogg`
- THEN the `b.ogg` failure carries `E_INPUT_NOT_FOUND`
- AND `a.ogg` is still transcribed, per
  [transcription](../transcription/spec.md)

#### Scenario: A file exists but cannot be opened

- GIVEN a file that exists but is permission-denied or otherwise unopenable
- WHEN Ira transcribes it
- THEN the failure carries `E_BAD_AUDIO`

#### Scenario: The container is supported but the codec is not

- GIVEN a container the Engine can demux carrying a codec it has no decoder for
- WHEN Ira transcribes it
- THEN the failure carries `E_BAD_AUDIO`, because the audio inside is unusable —
  the user's input, not an Engine fault

> *Technical Note — `open_format` (`rust/src/audio.rs:51-63`) maps
> `io::ErrorKind::NotFound` to `ErrorCode::InputNotFound` and every other open
> failure to `ErrorCode::BadAudio`. The remaining ingest failures are tagged
> `ErrorCode::BadAudio` via `CodedContext::coded`: unsupported format (`:78`),
> no supported audio tracks (`:85`), unknown sample rate (`:101`), unsupported
> codec (`:108`), and hard decode faults (`:119`, `:137`). No ingest failure
> falls through to `code_of`'s `ErrorCode::Internal` default
> (`rust/src/errors.rs:193-197`). `E_BAD_AUDIO` is in the taxonomy printed by
> `--error-codes-json` and mirrored TS-side in `src/error-codes.ts`; its
> category is `Input` (`rust/src/errors.rs:266-267`). Only the unsupported-format
> branch has a real-input regression test (`rust/tests/audio_format.rs`); the
> other three take the identical change but need a demuxable-yet-unusable
> container no tiny deterministic fixture can synthesise.*

### Requirement: Recoverable decode faults are skipped, unrecoverable ones stop the read

The Engine SHALL continue past packet-level decode faults and end the read cleanly when the stream ends or a reset is required, so a locally damaged file still yields the audio around the damage instead of failing outright. A fault that is neither SHALL surface as `E_BAD_AUDIO`.

#### Scenario: Maks transcribes a voice note with a damaged packet

- GIVEN a file with one undecodable packet in the middle
- WHEN Maks transcribes it
- THEN the damaged packet is skipped and the rest of the audio is transcribed

#### Scenario: The container declares no sample rate

- GIVEN a track whose codec parameters carry no sample rate
- WHEN Ira transcribes it
- THEN the Engine fails with an error naming the file rather than guessing a
  rate

> *Technical Note — `decode_packets` (`rust/src/audio.rs:96`): `IoError` and
> `ResetRequired` from `next_packet` break the loop; `IoError` and `DecodeError`
> from `decoder.decode` `continue`; anything else is returned as
> `ErrorCode::BadAudio`. A missing `codec_params.sample_rate` errors at
> `rust/src/audio.rs:99-101`. Packets belonging to other tracks are skipped.*

### Requirement: Models receive mono audio at one fixed sample rate

The Engine SHALL present decoded audio to every model as single-channel samples at 16 kHz, mixing multi-channel input by averaging its channels and resampling through the same filter shape used by live capture, so a stereo 48 kHz recording and a mono 16 kHz one reach the model the same way.

#### Scenario: Maks transcribes a stereo 48 kHz recording

- GIVEN a two-channel 48 kHz WAV
- WHEN Maks transcribes it
- THEN the model receives one channel of 16 kHz samples, roughly one sixteen-
  thousandth of the original duration in samples per second
- AND the transcript is produced normally

#### Scenario: Input is already mono at the target rate

- GIVEN a mono 16 kHz WAV
- WHEN Ira transcribes it
- THEN the samples pass through unchanged, with no resampling applied

> *Technical Note — `TARGET_SAMPLE_RATE` is `16000`
> (`rust/src/audio.rs:17`). `mix_to_mono` (`:159`) averages interleaved frames
> and returns mono input untouched; `resample_mono` (`:189`) short-circuits when
> the rates match and otherwise runs `sinc_resampler` (`:173`) — a 128-tap
> Blackman-Harris windowed sinc with cubic interpolation, `FixedAsync::Input`,
> chunk size 1024 — the same construction the live capture path uses.
> `load_audio` (`:263`) is decode → mix → resample. Unit tests at
> `rust/src/audio.rs:329-378` cover the mono pass-through, the averaging, and
> output length within ±16 frames for 8 k/22.05 k/44.1 k/48 kHz.*

### Requirement: Duration is probed cheaply and measured only when required

The Engine SHALL answer duration from container metadata without decoding, and SHALL report the duration as unknown when the container declares no frame count. A full decode pass to count frames SHALL be used only where the duration is required, never for an advisory routing decision.

#### Scenario: Long audio auto-engages VAD

- GIVEN a two-hour MP3 whose container declares its frame count
- WHEN Ira transcribes it
- THEN the duration is known without decoding, and VAD engages per
  [transcription](../transcription/spec.md)

#### Scenario: A streaming OGG that declares no frame count

- GIVEN an OGG/Opus file with no frame count in the container
- WHEN the Engine probes its duration
- THEN the duration is reported as unknown rather than triggering a full decode
  to find out

#### Scenario: A container that decodes to nothing

- GIVEN a truncated or metadata-only container
- WHEN a caller requires the measured duration
- THEN the Engine fails with a message saying no audio frames were decoded and
  suggesting a re-export or transcribing without timestamps

> *Technical Note — `probe_duration_seconds` (`rust/src/audio.rs:280`) divides
> `codec_params.n_frames` by the sample rate and returns `Ok(None)` when either
> is absent; its doc comment forbids falling back to a decode-and-measure.
> `measure_duration_seconds` (`:294`) streams the file retaining no samples and
> errors when it counts zero frames.*

### Requirement: Language detection sees a bounded prefix of the audio

Audio Language detection SHALL be answered from a bounded leading prefix of the decoded audio, so the amount of audio the detector reads does not grow with the length of the recording. This bounds what the model sees, not what the decoder does — the decode itself is not bounded (see Open Issues).

#### Scenario: Maks detects the language of a long meeting recording

- GIVEN a 90-minute recording
- WHEN language detection runs on it
- THEN only the leading seconds are used, per
  [language-detection](../language-detection/spec.md)

#### Scenario: The file is shorter than the bound

- GIVEN a 4-second voice note
- WHEN language detection runs on it
- THEN all of the available audio is used and detection still returns a code and
  confidence

> *Technical Note — `load_audio_truncated` (`rust/src/audio.rs:269`) decodes via
> `load_audio` and keeps the first `max_seconds * TARGET_SAMPLE_RATE` samples.
> The window used for detection (first 10 s, ECAPA-TDNN VoxLingua107) is
> specified in [language-detection](../language-detection/spec.md).*

## Open Issues

- `load_audio_truncated` decodes the entire file and then discards the tail, so
  the bounded-prefix guarantee is about what the model sees, not about decode
  cost. On a 90-minute file, language detection still pays a full decode.
- `load_audio` materialises every decoded sample in memory before mixing and
  resampling, so peak memory scales with duration. Nothing caps it, and no
  requirement above states a supported maximum input length.
- `mix_to_mono` treats a zero-channel track as mono and returns the interleaved
  buffer unchanged (`rust/src/audio.rs:159-167`, covered by a unit test that
  asserts it does not panic). That is a defensive path, not a specified
  behaviour — what a zero-channel container *should* produce is undecided.
- The set of supported containers is inherited from symphonia's enabled feature
  set plus the Opus adapter. No test pins that list, so a dependency bump could
  silently add or drop a container.
