# TTS audio samples

Drop the four sample files here before pushing to gh-pages:

| Filename | Voice | Settings | Source text |
|---|---|---|---|
| `en-kokoro-medium.mp3` | `en-am_michael` (Kokoro-82M) | default rate | "Kesha turns voice into text in a single command — no Python, no ffmpeg." |
| `en-kokoro-xfast.mp3` | `en-am_michael` (Kokoro-82M) | `<prosody rate="x-fast">` | same text |
| `ru-vosk-medium.mp3` | `ru-vosk-m02` (Vosk-TTS) | default rate | «Кеша превращает голос в текст одной командой — без Python, без ffmpeg.» |
| `ru-vosk-slow.mp3` | `ru-vosk-m02` (Vosk-TTS) | `<prosody rate="slow">` | same text |

## Generation commands

```bash
# 1. English, normal speed
kesha say --voice en-am_michael \
  "Kesha turns voice into text in a single command — no Python, no ffmpeg." \
  --format mp3 --out en-kokoro-medium.mp3

# 2. English, x-fast prosody
kesha say --voice en-am_michael --ssml \
  '<speak><prosody rate="x-fast">Kesha turns voice into text in a single command — no Python, no ffmpeg.</prosody></speak>' \
  --format mp3 --out en-kokoro-xfast.mp3

# 3. Russian, normal speed
kesha say --voice ru-vosk-m02 \
  "Кеша превращает голос в текст одной командой — без Python, без ffmpeg." \
  --format mp3 --out ru-vosk-medium.mp3

# 4. Russian, slow prosody
kesha say --voice ru-vosk-m02 --ssml \
  '<speak><prosody rate="slow">Кеша превращает голос в текст одной командой — без Python, без ffmpeg.</prosody></speak>' \
  --format mp3 --out ru-vosk-slow.mp3
```

## Notes

- Keep each file ≤ 200 KB if possible (the page bundles them with the site).
- `mp3` is preferred for the widest browser support. If you'd rather ship `ogg`
  Opus, update the `data-src` attributes in `index.html` to match.
- Until the files exist, each player on the live site shows a "sample not yet
  uploaded" placeholder bar (the page does a HEAD probe on load).
