# Voice Activity Detection (VAD)

For meetings, lectures, and podcasts, enable Silero VAD so Parakeet only sees the speech bits. Segment boundaries land at natural speech starts/ends instead of arbitrary cuts, and long silences are skipped entirely.

```bash
kesha install --vad                   # one-time, ~2.3MB
kesha lecture.m4a                     # auto-on when audio ≥ 120s and VAD installed
kesha --vad short-clip.ogg            # force VAD on any input
kesha --no-vad short-clip.ogg         # force full-file ASR for short/medium inputs
```

Auto-triggers at 120 s so voice messages (< 30 s of near-pure speech) stay on the fast path. Parakeet full-file ASR is bounded by decoded duration and backend memory, not by compressed file size. The upstream full-attention guidance is about 24 minutes for one pass; Kesha treats longer `--no-vad` runs as unsafe and fails early with a recovery hint.

A shorter file can still come back empty from one full pass when a few words sit around a long pause, for example "Wait", 15 seconds of silence, "done" ([#1466](https://github.com/drakulavich/kesha-voice-kit/issues/1466)). In Auto mode Kesha then transcribes the file again through VAD and returns that result. Without VAD installed it keeps the empty transcript and prints a hint to run `kesha install --vad`. `--no-vad` keeps the single-pass result.

If VAD is not installed, Auto-mode audio of 24 minutes or more uses fixed 10-minute ASR windows with 5 seconds of overlap and stitched absolute offsets. That fallback is safer than one full-file pass, but VAD boundaries are still better for meetings and silence-heavy recordings.

Defaults: threshold 0.5, min-speech 250 ms, min-silence 100 ms, 30 ms edge padding. See issues [#128](https://github.com/drakulavich/kesha-voice-kit/issues/128) (base), [#187](https://github.com/drakulavich/kesha-voice-kit/issues/187) (auto-trigger), and [#404](https://github.com/drakulavich/kesha-voice-kit/issues/404) (long-audio contract).

Silero's decoder LSTM rejects more than one frame per `Session::run` call (a wider window reshapes to 5-D and hard-errors), so the call cannot be batched without moving segment boundaries ([#712](https://github.com/drakulavich/kesha-voice-kit/issues/712)). The VAD session runs with `intra_threads(1)` instead ([#990](https://github.com/drakulavich/kesha-voice-kit/issues/990)). Its output is bit-identical to the default thread setting across the full benchmark corpus (92.6 s) plus a ~185 s synthetic composite, so segment boundaries do not move, and it is roughly 5-20% faster depending on build profile and measurement order. `just vad-bench` runs 5 reps alternating which arm goes first, since a single fixed-order run measures a biased number. The exact-comparison assertions run on darwin and linux only, because f32 results can diverge across platforms on Windows.

## Live end-of-utterance

`record --live` ([darwin-arm64 only](stt.md#live-dictation-darwin-arm64)) stays manual by default. Opt in when dictating to stop after a spoken utterance and its trailing pause:

```bash
kesha install --vad
kesha record --live --auto-stop
kesha record --live --auto-stop --auto-stop-silence-ms 800 --auto-stop-threshold 0.4
```

The live detector uses the installed Silero model and never downloads it. It waits for 1,000 ms of silence by default, after at least 250 ms of detected speech; use `--auto-stop-min-speech-ms` to tune that false-start guard. A missing VAD model fails with `E_MODEL_MISSING`, naming the model directory and `kesha install --vad`, rather than starting a recording without endpointing.
