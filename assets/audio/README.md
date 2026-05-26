# TTS audio samples

Samples for the "Hear it" section. Output format is **FLAC** (lossless,
patent-free, plays natively in Safari/iOS and every modern browser — this is
why kesha shipped `--format flac` in v1.20.0; OGG/Opus does not play in Safari
and MP3 was dropped over LGPL encoder licensing).

| Filename | Voice | Settings | Source text | Status |
|---|---|---|---|---|
| `en-kokoro-medium.flac` | `en-am_michael` (Kokoro-82M) | default rate | "Kesha turns voice into text in a single command — no Python, no ffmpeg." | ✅ committed |
| `en-kokoro-xfast.flac` | `en-am_michael` (Kokoro-82M) | x-fast (1.5×) | same text | ⛔ not committed — see note |
| `ru-vosk-medium.flac` | `ru-vosk-m02` (Vosk-TTS) | default rate | «Кеша превращает голос в текст одной командой — без Python, без ffmpeg.» | ✅ committed |
| `ru-vosk-slow.flac` | `ru-vosk-m02` (Vosk-TTS) | slow (0.75×) | same text | ✅ committed |

## Generation commands (actual)

Generated with the v1.20.0 engine. Rate is set with `--rate` (0.5–2.0), not SSML
`<prosody>` — `--rate` is reliable on both engines and avoids SSML quoting.

```bash
# 1. English, normal speed
kesha say --voice en-am_michael \
  "Kesha turns voice into text in a single command — no Python, no ffmpeg." \
  --out en-kokoro-medium.flac

# 2. Russian, normal speed
kesha say --voice ru-vosk-m02 \
  "Кеша превращает голос в текст одной командой — без Python, без ffmpeg." \
  --out ru-vosk-medium.flac

# 3. Russian, slow
kesha say --voice ru-vosk-m02 --rate 0.75 \
  "Кеша превращает голос в текст одной командой — без Python, без ffmpeg." \
  --out ru-vosk-slow.flac
```

`--out *.flac` infers the format, so `--format flac` is optional when `--out` ends in `.flac`.

## Note: `en-kokoro-xfast.flac` is not committed yet

The rate-shifted English sample **cannot be produced on Apple Silicon**: the
CoreML build runs Kokoro through FluidAudio, which silently ignores `--rate` and
rejects SSML (tracked in
[#475](https://github.com/drakulavich/kesha-voice-kit/issues/475)). Rate control
for Kokoro works only on the **Linux/ONNX** build. Until that sample is generated
there, the x-fast card on the site shows the "sample not yet uploaded"
placeholder (the player does a HEAD probe and degrades gracefully on a 404).

To generate it on a Linux/ONNX machine:

```bash
kesha say --voice en-am_michael --rate 1.5 \
  "Kesha turns voice into text in a single command — no Python, no ffmpeg." \
  --out en-kokoro-xfast.flac
```

## Notes

- Keep each file ≤ 200 KB if possible (the page bundles them with the site).
  Current sizes: EN medium ~149 KB, RU medium ~109 KB, RU slow ~143 KB.
- FLAC `data-src` attributes in `index.html` must match these filenames.
- Until a file exists, its player shows a "sample not yet uploaded" placeholder
  bar (the page does a HEAD probe on load).
