# KESHA use cases

Ready-to-use CLI commands and shell snippets for transcription, speech synthesis, language detection — all local, all offline.

To get set up, see the [install guide](https://github.com/drakulavich/kesha-voice-kit#quick-start).

## Table of contents

- [Tips for best results](#tips-for-best-results)
- [Voice message transcription](#voice-message-transcription)
- [Sending voice replies](#sending-voice-replies)
- [Language detection pipeline](#language-detection-pipeline)
- [Batch meeting transcription](#batch-meeting-transcription)
- [macOS system voices for alerts](#macos-system-voices-for-alerts)
- [Offline privacy-first workflows](#offline-privacy-first-workflows)
- [AI agent integration](#ai-agent-integration)
- [Content creation & voiceovers](#content-creation--voiceovers)
- [Ready to automate? Install as an OpenClaw plugin](#ready-to-automate-install-as-an-openclaw-plugin)

## Tips for best results

- **Keep voice messages short.** For audio under 2 minutes (120 s), KESHA uses a fast path with no silence detection overhead. Longer audio works — just expect a few extra seconds of VAD preprocessing.
- **Use `--json` for automation.** Structured output with language detection, confidence scores, and optional timestamps is what scripts and agents need. Plain text is for humans.
- **Match TTS voice language to text.** On macOS, `kesha say` routes supported languages from the text; on Linux/Windows pass `--lang <code>` or `--voice <id>`. For languages outside that set, use macOS system voices (`--voice macos-de-DE "Guten Tag"`).
- **Combine with other tools.** Pipe KESHA transcripts into `jq`, `grep`, your CRM, or an AI agent for multi-step workflows.

## Voice message transcription

Transcribe Telegram/WhatsApp/Signal voice notes to text — private, offline, no file leaves the machine.

**Quick transcription (plain text):**

```bash
kesha voice.ogg
# → "Привет, как дела?"
```

**Structured output for scripts and agents:**

```bash
kesha --json voice.ogg
# → [{"file":"voice.ogg","text":"Привет, как дела?","lang":"ru","audioLanguage":{"code":"ru","confidence":0.98},"textLanguage":{"code":"ru","confidence":0.99,"source":"engine"}}]
```

**Batch transcribe a folder of voice notes:**

```bash
kesha --json voice-notes/*.ogg > transcripts.json
# → one JSON array, one entry per file
```

One call for the whole folder is about twice as fast as one call per file, since the CLI starts once.

💡 **Tips:**

- Supported formats: `.ogg`, `.opus`, `.mp3`, `.m4a`, `.aac`, `.wav`, `.flac`, `.aiff`, `.webm` — decoded via symphonia, no ffmpeg required.
- For Telegram integration, configure OpenClaw's `tools.media.audio.models` to route voice messages through KESHA — transcript appears in-chat before the agent replies.

## Sending voice replies

Synthesize speech locally and send as a native voice note in any messenger.

**English voice note for Telegram:**

```bash
kesha say --format ogg-opus --out reply.ogg "Hey, I'll be there in 10 minutes"
# → reply.ogg (24 kHz @ 32 kbps mono — Telegram native format)
```

**Russian voice reply:**

```bash
kesha say --voice ru-vosk-m02 --format ogg-opus --out reply.ogg "Скоро буду"
# → reply.ogg (ru-vosk-m02 — male Russian voice)
```

**Batch generate multiple voice notes:**

```bash
messages=("Your table is ready" "Order confirmed" "We're on our way")
for msg in "${messages[@]}"; do
  name=$(echo "$msg" | tr ' ' '_' | head -c 20)
  kesha say --format ogg-opus --out "${name}.ogg" "$msg"
done
```

**Tune quality vs file size:**

```bash
# Smaller file for WhatsApp/3G (16 kbps)
kesha say --format ogg-opus --bitrate 16000 --out tiny.ogg "Short reply"

# Higher quality for podcast snippet (48 kbps, 48 kHz)
kesha say --format ogg-opus --bitrate 48000 --sample-rate 48000 --out hq.ogg "Good quality audio"
```

💡 **Tips:**

- `--format ogg-opus` emits directly to messenger-native format — no ffmpeg round-trip, no WAV conversion.
- Default voice for English is Kokoro-82M (FluidAudio CoreML on Apple Silicon, ONNX elsewhere). Russian Vosk-TTS provides `ru-vosk-f01`, `ru-vosk-f02`, `ru-vosk-f03`, `ru-vosk-m01`, and `ru-vosk-m02`.
- All TTS models run locally — zero latency from network calls, zero privacy risk from cloud uploads.

## Language detection pipeline

Identify the language of an audio file *before* deciding what to do with it.

**Detect language with confidence scores:**

```bash
kesha --json --verbose audio.mp3 | jq '.[0] | {lang, audioConfidence: .audioLanguage.confidence, textConfidence: .textLanguage.confidence, textSource: .textLanguage.source}'
# → {"lang":"de","audioConfidence":0.97,"textConfidence":0.96,"textSource":"engine"}
```

The same command on Linux or Windows, where the Engine has no text detection, falls back to `tinyld` — same shape, different detector and a score on `tinyld`'s scale:

```bash
kesha --json audio.mp3 | jq -c '.[0].textLanguage'
# → {"code":"de","confidence":0.76,"source":"tinyld"}
```

**Branch on detected language in a script:**

```bash
lang=$(kesha --json "$FILE" | jq -r '.[0].lang')
case "$lang" in
  ru) echo "Russian — process with Vosk-TTS" ;;
  en) echo "English — process with Kokoro" ;;
  es|fr|it|pt) echo "Romance language — process with Kokoro" ;;
  de) echo "German — use a macOS system voice" ;;
  *) echo "Unsupported — fall back to hosted ASR" ;;
esac
```

**Guard against wrong-language input:**

```bash
kesha --lang en voice.ogg
# Warns if detected language ≠ en, but still transcribes
```

💡 **Tips:**

- Audio-language detection (`audioLanguage`) analyzes acoustic features — works even on short clips. Text-language detection (`textLanguage`) kicks in after transcription and is more reliable for long audio.
- `textLanguage.source` names the detector: `"engine"` (macOS `NLLanguageRecognizer`) or `"tinyld"` (the CLI fallback used everywhere else). The two score on different scales, so branch on `source` before you compare a `confidence` against a threshold.
- 25 European languages supported for STT. Use `--lang` to sanity-check expectations in CI/testing pipelines.

## Batch meeting transcription

Transcribe meeting recordings with speaker labels and timestamps.

**Full meeting transcript with speaker diarization (macOS Apple Silicon):**

```bash
kesha install --diarize                                     # one-time, ~245 MB (installs VAD too)
kesha --json --speakers meeting.m4a > meeting.json           # --speakers engages VAD itself
jq -r '.[0].segments[] | "[\(.speaker)] \(.start)-\(.end): \(.text)"' meeting.json
# → [0] 0.0-2.3: Good morning everyone
# → [1] 2.5-5.1: Let's start with Q3 results
```

**Simpler: transcript with timestamps, no speakers:**

```bash
kesha --json --timestamps meeting.m4a > meeting.json
jq -r '.[0].segments[] | "\(.start | tostring | .[0:5])s: \(.text)"' meeting.json
```

**Skip silence in long recordings:**

```bash
kesha --vad lecture.m4a
# VAD preprocesses by stripping silence before ASR — faster for hour-long audio
```

**Batch process a folder of meeting recordings:**

```bash
mkdir -p transcripts
for f in meetings/*.m4a; do
  kesha --json --speakers "$f" > "transcripts/$(basename "$f" .m4a).json"
done
# → transcripts/standup.json, transcripts/retro.json, ...
```

💡 **Tips:**

- Speaker diarization is macOS arm64 only (preview feature). Cluster IDs are stable within a single file — speakers are labeled `0`, `1`, `2`, etc. No persistent voice profiles across files.
- VAD (Voice Activity Detection) install: `kesha install --vad`. Once installed, it turns on automatically for audio of 120 s or more; skip for short voice messages on the fast path.
- Combine with `--timestamps` for chapter markers in podcasts or YouTube transcripts.

## macOS system voices for alerts

Generate spoken alerts and notifications using ~180 macOS system voices — zero model downloads, zero install time.

**List all available macOS voices:**

```bash
kesha say --list-voices | grep macos-
# → macos-com.apple.voice.compact.en-US.Samantha, macos-com.apple.voice.compact.de-DE.Anna, ...
```

**English alert with a specific voice:**

```bash
kesha say --voice macos-com.apple.voice.compact.en-US.Samantha --format ogg-opus --out alert.ogg "Build failed — check CI logs"
```

**Multi-language notification script:**

```bash
alert() {
  lang="$1"; shift
  case "$lang" in
    en) voice="macos-en-US" ;;
    de) voice="macos-de-DE" ;;
    fr) voice="macos-fr-FR" ;;
    ru) voice="macos-ru-RU" ;;
    *)  voice="macos-en-US" ;;
  esac
  kesha say --voice "$voice" --format ogg-opus --out /tmp/alert.ogg "$*"
}
alert de "Der Build ist fehlgeschlagen"
alert fr "La compilation a échoué"
```

💡 **Tips:**

- macOS system voices need no `kesha install --tts` and no model download: plain `kesha install` places the AVSpeech sidecar they run through. darwin-arm64 only.
- A voice id is `macos-` plus a full Apple identifier from `--list-voices` or a language code (`macos-de-DE`), which picks a voice for that language; see [macOS system voices](tts.md#macos-system-voices).
- Quality is OS voice quality, not neural TTS. For neural-quality synthesis, use a Kokoro voice or Vosk-TTS (Russian), which are also offline.
- Great for CI/CD notifications, timer alerts, or accessibility announcements in developer tooling.

## Offline privacy-first workflows

Process voice data without any cloud upload — important for regulated industries, personal messaging, HIPAA environments, and internal communications.

**Complete voice pipeline without network access:**

```bash
# 1. Transcribe (no API calls)
kesha --json sensitive-recording.mp3 > transcript.json

# 2. Process transcript with a local LLM (ollama, llama.cpp)
jq -r '.[0].text' transcript.json | ollama run mistral "Summarize:"

# 3. Generate voice reply (no API calls)
kesha say --format ogg-opus --out response.ogg "Got it, processing now"

# 4. Clean up
rm transcript.json response.ogg
```

**Air-gapped machine setup:**

```bash
# On an internet-connected machine: install the CLI and fetch every model.
bun add -g @drakulavich/kesha-voice-kit
kesha install --tts          # populates ~/.cache/kesha (engine + ASR + TTS models)

# Copy the populated cache to the air-gapped machine (USB, rsync, etc.):
rsync -a ~/.cache/kesha/ /Volumes/USB/kesha-cache/

# On the air-gapped machine: install the same CLI version, then point kesha at
# the copied cache. kesha never auto-downloads, so once the cache is present it
# runs fully offline.
export KESHA_CACHE_DIR=/path/to/kesha-cache
kesha status                 # → engines ready, no network required
```

**CI/CD pipeline with zero external calls:**

```bash
# Test that speech synthesis matches expected output
kesha say --out test.wav "Hello world"
checksum=$(shasum -a 256 test.wav | cut -d' ' -f1)   # macOS; on Linux either shasum or sha256sum works

# Verify language detection accuracy in test suite
kesha --json test-samples/de_sample.ogg | jq -e '.[0].audioLanguage.code == "de"'
```

💡 **Tips:**

- KESHA is MIT-licensed — embed it in enterprise products, medical devices, or offline kiosks without royalties.
- STT models are ONNX files and TTS models are `.onnx` graphs with `.bin` voice packs; Apple Silicon runs CoreML bundles instead. No license servers, no phone-home.
- The whole model set lives under `~/.cache/kesha` (override with `KESHA_CACHE_DIR`); copy that directory for USB transfers and air-gapped deployments — kesha never phones home. To keep logs and Stats out of the home directory as well, set `KESHA_HOME` instead: one directory for everything Kesha writes (see [diagnostic-logs.md](diagnostic-logs.md#where-kesha-keeps-its-files)).
- On macOS, a legacy FluidAudio install (`~/Library/Application Support/FluidAudio`, `~/.cache/fluidaudio`) is still read even when `KESHA_CACHE_DIR` or `KESHA_HOME` points elsewhere, so copying the cache can miss the speech model. A complete legacy bundle is used where it is and `kesha install` does not fetch a second copy.
- For a self-contained macOS copy, run the install with `HOME` pointing at an empty directory too, `HOME=/path/to/empty KESHA_HOME=/path/to/fresh kesha install`, and copy `/path/to/fresh`.
- Kokoro G2P for macOS speech synthesis still lands in `$HOME/.cache/fluidaudio/Models/kokoro`, outside `KESHA_HOME`, so copy that too if you need `kesha say`; see [architecture.md](architecture.md#where-fluidaudios-models-live).

## AI agent integration

Use KESHA as a local voice backend for AI agents — transcription, TTS replies, and language detection all through a single CLI.

**OpenClaw — voice messages in any chat:**

```bash
openclaw config patch --stdin <<'CONFIG'
{
  tools: {
    media: {
      audio: {
        enabled: true,
        models: [{
          type: "cli",
          command: "kesha",
          args: ["{{MediaPath}}"],
          timeoutSeconds: 15
        }],
        echoTranscript: true,
        echoFormat: '🦜 "{transcript}"'
      }
    }
  }
}
CONFIG
```

**OpenClaw — voice replies (auto-routed by language):**

```bash
openclaw config patch --stdin <<'CONFIG'
{
  messages: {
    tts: {
      auto: "always",
      provider: "tts-local-cli",
      providers: {
        "tts-local-cli": {
          command: "kesha",
          args: ["say", "--format", "ogg-opus", "--out", "{{OutputPath}}", "{{Text}}"],
          outputFormat: "opus",
          timeoutMs: 120000
        }
      }
    }
  }
}
CONFIG
```

**Hermes Agent — command-provider mode** (full config in [hermes.md](hermes.md)):

```bash
# Speech-to-text, with stt.provider: local_command in ~/.hermes/config.yaml:
export HERMES_LOCAL_STT_COMMAND='sh -c '"'"'kesha "$1" > "$2/transcript.txt"'"'"' sh {input_path} {output_dir}'
# Text-to-speech: a command provider in ~/.hermes/config.yaml runs
#   kesha say --format ogg-opus --out {output_path} < {input_path}
```

**Claude Code / any MCP client — `kesha mcp`** (other clients in [mcp.md](mcp.md)):

```bash
claude mcp add kesha -- kesha mcp
# Other MCP clients: { "mcpServers": { "kesha": { "command": "kesha", "args": ["mcp"] } } }
```

💡 **Tips:**

- The OpenClaw integration is the primary agent path — voice messages arrive in Telegram/WhatsApp, KESHA transcribes them locally, the agent sees the text, and can reply with TTS.
- `echoTranscript: true` shows the transcript in-chat before the agent responds — useful for debugging and trust.
- For JSON output with timestamps in agent mode, use: `kesha --json --timestamps {{MediaPath}}` with a higher timeout.

## Content creation & voiceovers

Generate voiceovers, narration, and audio assets — all offline, all scriptable.

**Podcast intro in English (neural quality):**

```bash
kesha say --voice en-am_michael --format ogg-opus --out intro.ogg "Welcome to the show. Today we're talking about local AI."
```

**Russian narration with emphasis:**

```bash
kesha say --ssml --voice ru-vosk-m02 --format ogg-opus --out narration.ogg "<speak><prosody rate='medium'>Добро пожаловать в мир локального <emphasis>с+интеза</emphasis> речи</prosody></speak>"
```

**Slow down for accessibility:**

```bash
kesha say --voice en-am_michael --rate 0.75 --format ogg-opus --out accessible.ogg "Here is the information, spoken slowly and clearly."
```

**Generate a YouTube chapter voiceover from a script:**

```bash
cat chapters.txt
# 0:00 Introduction
# 2:30 Installing KESHA
# 5:15 Transcribing voice messages

while IFS=' ' read -r time text; do
  kesha say --voice en-am_michael --format ogg-opus --out "chapter-${time}.ogg" "$text"
done < chapters.txt
```

💡 **Tips:**

- Kokoro-82M provides neural-quality English TTS with multiple voice options (`en-am_michael`, `en-af_bella`, etc.). Run `kesha say --list-voices` to list them all.
- SSML needs `--ssml` and a `<speak>` root ([SSML](tts.md#ssml)). Russian Vosk-TTS supports SSML emphasis: `<emphasis>сл+ово</emphasis>` shifts stress to the vowel after `+`.
- `<prosody rate="…">` controls speed: `x-slow`, `slow`, `medium`, `fast`, `x-fast`, or absolute `120%`. Composes multiplicatively with `--rate`.
- All synthesis is local — batch-generate 100 voiceover clips without rate limits or API costs.

## Ready to automate? Install as an OpenClaw plugin

If you've found workflows you use regularly, you can skip the copy/paste entirely. KESHA ships as an OpenClaw plugin that makes voice processing a native part of your agent's toolchain.

```bash
bun add -g @drakulavich/kesha-voice-kit
kesha install
openclaw plugins install @drakulavich/kesha-voice-kit
```

Once installed, ask your agent naturally: "transcribe this voice message", "reply with voice", "what language is this audio?" — KESHA handles the rest.

For more advanced workflows, see:

- [TTS reference](tts.md) — all TTS engines, voices, SSML support, abbreviations
- [OpenClaw integration](openclaw.md) — full agent configuration
- [Nix](distribution.md#nix) — reproducible engine build from source
- [Homebrew tap](distribution.md#homebrew) — macOS-native package management
- [Hermes Agent](hermes.md) — command-provider mode for voice assistants
- [VAD guide](vad.md) — voice activity detection for long audio
