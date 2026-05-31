# Supported languages

Kesha does three language-aware things: **speech-to-text** (ASR), **text-to-speech**, and **audio language detection**. Coverage differs per task — see each section below.

> Flags are indicative regional markers, not a claim about dialect or country; languages aren't countries. Codes are ISO 639-1, the same ones `--lang` accepts.

## Speech-to-text (25)

NVIDIA Parakeet TDT 0.6B v3. Language is auto-detected; `--lang <code>` warns if the detected language differs.

| # | Language | Code | |
|---:|----------|------|---|
| 1 | Bulgarian | `bg` | 🇧🇬 |
| 2 | Croatian | `hr` | 🇭🇷 |
| 3 | Czech | `cs` | 🇨🇿 |
| 4 | Danish | `da` | 🇩🇰 |
| 5 | Dutch | `nl` | 🇳🇱 |
| 6 | English | `en` | 🇬🇧 |
| 7 | Estonian | `et` | 🇪🇪 |
| 8 | Finnish | `fi` | 🇫🇮 |
| 9 | French | `fr` | 🇫🇷 |
| 10 | German | `de` | 🇩🇪 |
| 11 | Greek | `el` | 🇬🇷 |
| 12 | Hungarian | `hu` | 🇭🇺 |
| 13 | Italian | `it` | 🇮🇹 |
| 14 | Latvian | `lv` | 🇱🇻 |
| 15 | Lithuanian | `lt` | 🇱🇹 |
| 16 | Maltese | `mt` | 🇲🇹 |
| 17 | Polish | `pl` | 🇵🇱 |
| 18 | Portuguese | `pt` | 🇵🇹 |
| 19 | Romanian | `ro` | 🇷🇴 |
| 20 | Russian | `ru` | 🇷🇺 |
| 21 | Slovak | `sk` | 🇸🇰 |
| 22 | Slovenian | `sl` | 🇸🇮 |
| 23 | Spanish | `es` | 🇪🇸 |
| 24 | Swedish | `sv` | 🇸🇪 |
| 25 | Ukrainian | `uk` | 🇺🇦 |

## Text-to-speech

Voice auto-picks from the text's language; pass `--voice <id>` to choose. Run `kesha say --list-voices` to see what's installed. Full voice catalogue and SSML details: [tts.md](tts.md).

| # | Language | Code | | Engine (voice prefix) | Platform | Notes |
|---:|----------|------|---|------------------------|----------|-------|
| 1 | English | `en` | 🇬🇧 | Kokoro (`en-*`) | all | default `en-am_michael` |
| 2 | Russian | `ru` | 🇷🇺 | Vosk-TTS (`ru-*`) | all | default `ru-vosk-m02`; macOS also offers `macos-*` Milena |
| 3 | Spanish | `es` | 🇪🇸 | Kokoro (`es-*`) | darwin-arm64 | FluidAudio CoreML |
| 4 | French | `fr` | 🇫🇷 | Kokoro (`fr-*`) | darwin-arm64 | female voice only (`fr-ff_siwis`) |
| 5 | Italian | `it` | 🇮🇹 | Kokoro (`it-*`) | darwin-arm64 | FluidAudio CoreML |
| 6 | Portuguese | `pt` | 🇧🇷 | Kokoro (`pt-*`) | darwin-arm64 | Brazilian (`pt-pm_alex`) |
| 7 | Hindi | `hi` | 🇮🇳 | Kokoro (`hi-*`) | darwin-arm64 | **romanized (Latin) input only** — native Devanagari is rejected with `E_SCRIPT_UNSUPPORTED` ([#492](https://github.com/drakulavich/kesha-voice-kit/issues/492)) |
| 8 | Japanese | `ja` | 🇯🇵 | Kokoro (`ja-*`) | darwin-arm64 | **romaji (Latin) input only** — native kana/kanji is rejected ([#492](https://github.com/drakulavich/kesha-voice-kit/issues/492)) |
| 9 | Chinese | `zh` | 🇨🇳 | Kokoro (`zh-*`) | darwin-arm64 | **pinyin (Latin) input only** — native Han is rejected ([#492](https://github.com/drakulavich/kesha-voice-kit/issues/492)) |
| — | *(system voices)* | — | 🍎 | AVSpeech (`macos-*`) | macOS | any of the 180+ voices already installed on your Mac; zero model download |

On Linux/Windows, text-to-speech covers English (Kokoro ONNX) and Russian (Vosk-TTS); the FluidAudio Kokoro multilingual voices above are darwin-arm64 only.

## Audio language detection (107)

SpeechBrain ECAPA-TDNN identifies the spoken language of audio across 107 languages — broader than the ASR set above. Full list: [speechbrain/lang-id-voxlingua107-ecapa](https://huggingface.co/speechbrain/lang-id-voxlingua107-ecapa).

Text language detection (for TTS voice routing) uses Apple's `NLLanguageRecognizer` on macOS.
