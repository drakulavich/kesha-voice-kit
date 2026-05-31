# Supported languages

Kesha does three language-aware things: **speech-to-text** (ASR), **text-to-speech**, and **audio language detection**. Coverage differs per task — see each section below.

> Flags are indicative regional markers, not a claim about dialect or country; languages aren't countries. Codes are ISO 639-1, the same ones `--lang` accepts.

## Speech-to-text (25)

NVIDIA Parakeet TDT 0.6B v3. Language is auto-detected; `--lang <code>` warns if the detected language differs.

| Language | Code | |
|----------|------|---|
| Bulgarian | `bg` | 🇧🇬 |
| Croatian | `hr` | 🇭🇷 |
| Czech | `cs` | 🇨🇿 |
| Danish | `da` | 🇩🇰 |
| Dutch | `nl` | 🇳🇱 |
| English | `en` | 🇬🇧 |
| Estonian | `et` | 🇪🇪 |
| Finnish | `fi` | 🇫🇮 |
| French | `fr` | 🇫🇷 |
| German | `de` | 🇩🇪 |
| Greek | `el` | 🇬🇷 |
| Hungarian | `hu` | 🇭🇺 |
| Italian | `it` | 🇮🇹 |
| Latvian | `lv` | 🇱🇻 |
| Lithuanian | `lt` | 🇱🇹 |
| Maltese | `mt` | 🇲🇹 |
| Polish | `pl` | 🇵🇱 |
| Portuguese | `pt` | 🇵🇹 |
| Romanian | `ro` | 🇷🇴 |
| Russian | `ru` | 🇷🇺 |
| Slovak | `sk` | 🇸🇰 |
| Slovenian | `sl` | 🇸🇮 |
| Spanish | `es` | 🇪🇸 |
| Swedish | `sv` | 🇸🇪 |
| Ukrainian | `uk` | 🇺🇦 |

## Text-to-speech

Voice auto-picks from the text's language; pass `--voice <id>` to choose. Run `kesha say --list-voices` to see what's installed. Full voice catalogue and SSML details: [tts.md](tts.md).

| Language | Code | | Engine (voice prefix) | Platform | Notes |
|----------|------|---|------------------------|----------|-------|
| English | `en` | 🇬🇧 | Kokoro (`en-*`) | all | default `en-am_michael` |
| Russian | `ru` | 🇷🇺 | Vosk-TTS (`ru-*`) | all | default `ru-vosk-m02`; macOS also offers `macos-*` Milena |
| Spanish | `es` | 🇪🇸 | Kokoro (`es-*`) | darwin-arm64 | FluidAudio CoreML |
| French | `fr` | 🇫🇷 | Kokoro (`fr-*`) | darwin-arm64 | female voice only (`fr-ff_siwis`) |
| Italian | `it` | 🇮🇹 | Kokoro (`it-*`) | darwin-arm64 | FluidAudio CoreML |
| Portuguese | `pt` | 🇧🇷 | Kokoro (`pt-*`) | darwin-arm64 | Brazilian (`pt-pm_alex`) |
| Hindi | `hi` | 🇮🇳 | Kokoro (`hi-*`) | darwin-arm64 | **romanized (Latin) input only** — native Devanagari is rejected with `E_SCRIPT_UNSUPPORTED` ([#492](https://github.com/drakulavich/kesha-voice-kit/issues/492)) |
| Japanese | `ja` | 🇯🇵 | Kokoro (`ja-*`) | darwin-arm64 | **romaji (Latin) input only** — native kana/kanji is rejected ([#492](https://github.com/drakulavich/kesha-voice-kit/issues/492)) |
| Chinese | `zh` | 🇨🇳 | Kokoro (`zh-*`) | darwin-arm64 | **pinyin (Latin) input only** — native Han is rejected ([#492](https://github.com/drakulavich/kesha-voice-kit/issues/492)) |
| *(system voices)* | — | 🍎 | AVSpeech (`macos-*`) | macOS | any of the 180+ voices already installed on your Mac; zero model download |

On Linux/Windows, text-to-speech covers English (Kokoro ONNX) and Russian (Vosk-TTS); the FluidAudio Kokoro multilingual voices above are darwin-arm64 only.

## Audio language detection (107)

SpeechBrain ECAPA-TDNN identifies the spoken language of audio across 107 languages — broader than the ASR set above. Full list: [speechbrain/lang-id-voxlingua107-ecapa](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa).

Text language detection (for TTS voice routing) uses Apple's `NLLanguageRecognizer` on macOS.
