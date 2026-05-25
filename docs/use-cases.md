# KESHA Use Cases

Ready-to-use CLI commands and shell snippets for transcription, speech synthesis, language detection — all local, all offline.

To get set up, see the [install guide](https://github.com/drakulavich/kesha-voice-kit#install).

## Table of Contents

- [Tips for Best Results](#tips-for-best-results)
- [Voice Message Transcription](#voice-message-transcription)
- [Sending Voice Replies](#sending-voice-replies)
- [Language Detection Pipeline](#language-detection-pipeline)
- [Batch Meeting Transcription](#batch-meeting-transcription)
- [macOS System Voices for Alerts](#macos-system-voices-for-alerts)
- [Offline Privacy-First Workflows](#offline-privacy-first-workflows)
- [AI Agent Integration](#ai-agent-integration)
- [Content Creation & Voiceovers](#content-creation--voiceovers)
- [Ready to Automate? Install as an OpenClaw Plugin](#ready-to-automate-install-as-an-openclaw-plugin)

## Tips for Best Results

- **Keep voice messages short.** For transcripts under 3 minutes, KESHA uses a fast path with no silence detection overhead. Longer audio works — just expect a few extra seconds of VAD preprocessing.
- **Use `--json` for automation.** Structured output with language detection, confidence scores, and optional timestamps is what scripts and agents need. Plain text is for humans.
- **Match TTS voice language to text.** `kesha say` auto-routes English → Kokoro and Russian → Vosk-TTS. For any other language, use macOS system voices (`--voice macos-de-DE "Guten Tag"`).
- **Combine with other tools.** Pipe KESHA transcripts into `jq`, `grep`, your CRM, or an AI agent for multi-step workflows.
- **License awareness.** KESHA is MIT — ship it, embed it, automate it. No API keys, no per-minute billing, no cloud egress costs.

## Voice Message Transcription

Transcribe Telegram/WhatsApp/Signal voice notes to text — private, offline, no file leaves the machine.

**Quick transcription (plain text):**

```bash
kesha voice.ogg
# → "Привет, как дела?"
```

**Structured output for scripts and agents:**

```bash
kesha --json voice.ogg
# → [{"file":"voice.ogg","text":"Привет, как дела?","lang":"ru","audioLanguage":{"code":"ru","confidence":0.98},"textLanguage":{"code":"ru","confidence":0.99}}]
```

**Batch transcribe a folder of voice notes:**

```bash
mkdir -p transcripts
for f in voice-notes/*.ogg; do
  kesha --json "$f" > "transcripts/$(basename "$f" .ogg).json"
done
# → transcripts/voice-1.json, voice-2.json, ...
```

💡 **Tips:**

- All formats work: `.ogg`, `.opus`, `.mp3`, `.m4a`, `.wav`, `.flac`, `.webm` — decoded via symphonia, no ffmpeg required.
- For Telegram integration, configure OpenClaw's `tools.media.audio.models` to route voice messages through KESHA — transcript appears in-chat before the agent replies.

## Sending Voice Replies

Synthesize speech locally and send as a native voice note in any messenger.

**English voice note for Telegram:**

```bash
kesha say --format ogg-opus --out reply.ogg "Hey, I'll be there in 10 minutes"
# → reply.ogg (24 kHz @ 32 kbps mono — Telegram native format)
```

**Russian voice reply:**

```bash
kesha say --voice ru-vosk-m02 --format ogg-opus --out reply.ogg "Скоро буду"
# → reply.ogg (ru-vosk-m02 — женский голос, оптимальный для русской речи)
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
- Default voice for English is Kokoro-82M (FluidAudio CoreML on Apple Silicon, ONNX elsewhere). Russian uses Vosk-TTS with 5 speaker options (`ru-vosk-m02` through `m06`).
- All TTS models run locally — zero latency from network calls, zero privacy risk from cloud uploads.

## Language Detection Pipeline

Identify the language of an audio file *before* deciding what to do with it.

**Detect language with confidence scores:**

```bash
kesha --json --verbose audio.mp3 | jq '.[0] | {lang, audioConfidence: .audioLanguage.confidence, textConfidence: .textLanguage.confidence}'
# → {"lang":"de","audioConfidence":0.97,"textConfidence":0.96}
```

**Branch on detected language in a script:**

```bash
lang=$(kesha --json "$FILE" | jq -r '.[0].lang')
case "$lang" in
  ru) echo "Russian — process with Vosk-TTS" ;;
  en) echo "English — process with Kokoro" ;;
  de|fr|es) echo "EU language — use macOS system voice" ;;
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
- 25 European languages supported for STT. Use `--lang` to sanity-check expectations in CI/testing pipelines.

## Batch Meeting Transcription

Transcribe meeting recordings with speaker labels and timestamps.

**Full meeting transcript with speaker diarization (macOS Apple Silicon):**

```bash
kesha install --diarize                                     # one-time, ~245 MB
kesha --json --vad --speakers meeting.m4a > meeting.json
jq '.[0].segments[] | "[\(.speaker)] \(.start)-\(.end): \(.text)"' meeting.json
# → [0] 0.0-2.3: Good morning everyone
# → [1] 2.5-5.1: Let's start with Q3 results
```

**Simpler: transcript with timestamps, no speakers:**

```bash
kesha --json --timestamps meeting.m4a > meeting.json
jq '.[0].segments[] | "\(.start | tostring | .[0:5])s: \(.text)"' meeting.json
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
  kesha --json --vad --speakers "$f" > "transcripts/$(basename "$f" .m4a).json"
done
# → transcripts/standup.json, transcripts/retro.json, ...
```

💡 **Tips:**

- Speaker diarization is macOS arm64 only (preview feature). Cluster IDs are stable within a single file — speakers are labeled `0`, `1`, `2`, etc. No persistent voice profiles across files.
- VAD (Voice Activity Detection) install: `kesha install --vad`. Automatically enabled for long audio; skip for short voice messages on the fast path.
- Combine with `--timestamps` for chapter markers in podcasts or YouTube transcripts.

## macOS System Voices for Alerts

Generate spoken alerts and notifications using ~180 macOS system voices — zero model downloads, zero install time.

**List all available macOS voices:**

```bash
kesha say --list-voices | grep macos-
# → macos-en-US:Samantha, macos-de-DE:Anna, macos-fr-FR:Thomas, ...
```

**English alert with a specific voice:**

```bash
kesha say --voice macos-en-US:Fiona --format ogg-opus --out alert.ogg "Build failed — check CI logs"
```

**Multi-language notification script:**

```bash
alert() {
  lang="$1"; shift
  case "$lang" in
    en) voice="macos-en-US:Samantha" ;;
    de) voice="macos-de-DE:Anna" ;;
    fr) voice="macos-fr-FR:Thomas" ;;
    ru) voice="macos-ru-RU:Milena" ;;
    *)  voice="macos-en-US:Samantha" ;;
  esac
  kesha say --voice "$voice" --format ogg-opus --out /tmp/alert.ogg "$*"
}
alert de "Der Build ist fehlgeschlagen"
alert fr "La compilation a échoué"
```

💡 **Tips:**

- macOS system voices require zero setup — no `kesha install --tts`, no model cache. Available on any modern macOS.
- Quality is OS voice quality, not neural TTS. For neural-quality synthesis, use Kokoro (English) or Vosk-TTS (Russian) which are also offline.
- Great for CI/CD notifications, timer alerts, or accessibility announcements in developer tooling.

## Offline Privacy-First Workflows

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
- Model files are plain `.ort` (ONNX) for STT and `.onnx`/`.bin` for TTS — no proprietary formats, no license servers, no phone-home.
- The whole model set lives under `~/.cache/kesha` (override with `KESHA_CACHE_DIR`); copy that directory for USB transfers and air-gapped deployments — kesha never phones home.

## AI Agent Integration

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

**Hermes Agent — command-provider mode:**

```bash
# Configure in Hermes agent config:
hermes stt set --provider local --command "kesha --json {{file}}"
hermes tts set --provider local --command "kesha say --format ogg-opus --out {{out}} '{{text}}'"
```

**Claude Code / any MCP client — voice processing skill:**

```bash
# Create ~/.claude/skills/transcribe.md:
# "When asked to transcribe a file, run: kesha --json <file>"
# "When asked to speak, run: kesha say --format ogg-opus --out reply.ogg '<text>'"
```

💡 **Tips:**

- The OpenClaw integration is the primary agent path — voice messages arrive in Telegram/WhatsApp, KESHA transcribes them locally, the agent sees the text, and can reply with TTS.
- `echoTranscript: true` shows the transcript in-chat before the agent responds — useful for debugging and trust.
- For JSON output with timestamps in agent mode, use: `kesha --json --timestamps {{MediaPath}}` with a higher timeout.

## Content Creation & Voiceovers

Generate voiceovers, narration, and audio assets — all offline, all scriptable.

**Podcast intro in English (neural quality):**

```bash
kesha say --voice en-kokoro-af_heart --format ogg-opus --out intro.ogg "Welcome to the show. Today we're talking about local AI."
```

**Russian narration with emphasis:**

```bash
kesha say --voice ru-vosk-m02 --format ogg-opus --out narration.ogg "<prosody rate='medium'>Добро пожаловать в мир локального <emphasis>син+теза</emphasis> речи</prosody>"
```

**Slow down for accessibility:**

```bash
kesha say --voice en-kokoro-af --rate 0.75 --format ogg-opus --out accessible.ogg "Here is the information, spoken slowly and clearly."
```

**Generate a YouTube chapter voiceover from a script:**

```bash
cat chapters.txt
# 0:00 Introduction
# 2:30 Installing KESHA
# 5:15 Transcribing voice messages

while IFS=' ' read -r time text; do
  kesha say --voice en-kokoro-af_heart --format ogg-opus --out "chapter-${time}.ogg" "$text"
done < chapters.txt
```

💡 **Tips:**

- Kokoro-82M provides neural-quality English TTS with multiple voice options (`en-kokoro-af_heart`, `en-kokoro-af_bella`, etc.). Run `kesha say --list-voices` to hear them all.
- Russian Vosk-TTS supports SSML emphasis: `<emphasis>сл+ово</emphasis>` shifts stress to the vowel marked `+`.
- `<prosody rate="…">` controls speed: `x-slow`, `slow`, `medium`, `fast`, `x-fast`, or absolute `120%`. Composes multiplicatively with `--rate`.
- All synthesis is local — batch-generate 100 voiceover clips without rate limits or API costs.

## Ready to Automate? Install as an OpenClaw Plugin

If you've found workflows you use regularly, you can skip the copy/paste entirely. KESHA ships as a first-class OpenClaw plugin that makes voice processing a native part of your agent's toolchain.

```bash
bun add -g @drakulavich/kesha-voice-kit
kesha install
openclaw plugins install @drakulavich/kesha-voice-kit
```

Once installed, ask your agent naturally: "transcribe this voice message", "reply with voice", "what language is this audio?" — KESHA handles the rest.

For more advanced workflows, see:

- [TTS reference](tts.md) — all TTS engines, voices, SSML support, abbreviations
- [OpenClaw integration](openclaw.md) — full agent configuration
- [Nix install](nix-install.md) — reproducible, declarative setup
- [Homebrew tap](homebrew.md) — macOS-native package management
- [Hermes Agent](hermes.md) — command-provider mode for voice assistants
- [VAD guide](vad.md) — voice activity detection for long audio
