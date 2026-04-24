# Voice Activity Detection (VAD)

For meetings, lectures, and podcasts, enable Silero VAD so Parakeet only sees the speech bits. Segment boundaries land at natural speech starts/ends instead of arbitrary cuts, and long silences are skipped entirely.

```bash
kesha install --vad                   # one-time, ~2.3MB
kesha lecture.m4a                     # auto-on when audio ≥ 120s and VAD installed
kesha --vad short-clip.ogg            # force VAD on any input
kesha --no-vad meeting.m4a            # force VAD off even on long audio
```

Auto-triggers at 120 s so voice messages (< 30 s of near-pure speech) stay on the fast path. If you have long audio without VAD installed, Kesha prints a one-time stderr hint. Defaults: threshold 0.5, min-speech 250 ms, min-silence 100 ms, 30 ms edge padding. See issues [#128](https://github.com/drakulavich/kesha-voice-kit/issues/128) (base) and [#187](https://github.com/drakulavich/kesha-voice-kit/issues/187) (auto-trigger).
