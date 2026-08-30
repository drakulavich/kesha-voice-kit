# Voice Activity Detection (VAD)

For meetings, lectures, and podcasts, enable Silero VAD so Parakeet only sees the speech bits. Segment boundaries land at natural speech starts/ends instead of arbitrary cuts, and long silences are skipped entirely.

```bash
kesha install --vad                   # one-time, ~2.3MB
kesha lecture.m4a                     # auto-on when audio ≥ 120s and VAD installed
kesha --vad short-clip.ogg            # force VAD on any input
kesha --no-vad short-clip.ogg         # force full-file ASR for short/medium inputs
```

Auto-triggers at 120 s so voice messages (< 30 s of near-pure speech) stay on the fast path. Parakeet full-file ASR is bounded by decoded duration and backend memory, not by compressed file size. The upstream full-attention guidance is about 24 minutes for one pass; Kesha treats longer `--no-vad` runs as unsafe and fails early with a recovery hint.

If VAD is not installed, very long Auto-mode audio uses fixed 10-minute ASR windows with 5 seconds of overlap and stitched absolute offsets. That fallback is safer than one full-file pass, but VAD boundaries are still better for meetings and silence-heavy recordings.

Defaults: threshold 0.5, min-speech 250 ms, min-silence 100 ms, 30 ms edge padding. See issues [#128](https://github.com/drakulavich/kesha-voice-kit/issues/128) (base), [#187](https://github.com/drakulavich/kesha-voice-kit/issues/187) (auto-trigger), and [#404](https://github.com/drakulavich/kesha-voice-kit/issues/404) (long-audio contract).

Silero's decoder LSTM rejects more than one frame per `Session::run` call (a wider window reshapes to 5-D and hard-errors), so batching the call itself is not possible without moving segment boundaries — [#712](https://github.com/drakulavich/kesha-voice-kit/issues/712)'s trade this repo already refused. [#990](https://github.com/drakulavich/kesha-voice-kit/issues/990) instead pinned `intra_threads(1)` on the VAD session: bit-identical output to the untuned default across the full benchmark corpus plus a ~278 s synthetic composite (default 124.6 µs/frame vs. tuned 105.5 µs/frame, ~15% faster), so segment boundaries never moved.

## Live end-of-utterance

`record --live` stays manual by default. Opt in when dictating to stop after a spoken utterance and its trailing pause:

```bash
kesha install --vad
kesha record --live --auto-stop
kesha record --live --auto-stop --auto-stop-silence-ms 800 --auto-stop-threshold 0.4
```

The live detector uses the installed Silero model and never downloads it. It waits for 1,000 ms of silence by default, after at least 250 ms of detected speech; use `--auto-stop-min-speech-ms` to tune that false-start guard. A missing VAD model fails with `kesha install --vad` rather than starting a recording without endpointing.
