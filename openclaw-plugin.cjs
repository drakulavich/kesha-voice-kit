// Kesha Voice Kit — OpenClaw plugin entry.
//
// Declares the locally-installed `kesha` CLI as an audio media-understanding
// provider so it is discoverable in `openclaw plugins inspect`
// (Shape: plain-capability) — Parakeet TDT via CoreML on Apple Silicon, ONNX
// elsewhere, 25 languages, no cloud.
//
// This registration is declaration-only and does NOT transcribe. OpenClaw only
// routes audio to a media-understanding provider once model auth resolves for it
// (an API key), which a local, keyless CLI cannot satisfy on any sane config, so
// this provider is never selected to run. Real transcription is wired by the
// user through the documented `type: "cli"` entry in tools.media.audio.models,
// which runs `kesha {{MediaPath}}` directly and reads its stdout — see
// docs/openclaw.md and docs/runbooks/openclaw-plugin.md.
//
// The same `kesha` CLI also produces messenger-ready voice notes via
// `kesha say "..." --format ogg-opus --out reply.ogg` (Telegram / Discord ingest
// OGG/Opus directly — no transcoding needed). Not wired into OpenClaw's
// media-understanding capability here; invoke it from a hook or agent tool when
// you want Kesha to speak.
//
// Prerequisite: the `kesha` binary must be on PATH. Install it with:
//   bun add -g @drakulavich/kesha-voice-kit
//   kesha install            # ASR models
//   kesha install --tts      # TTS models (Kokoro + Vosk-TTS), only if you use `kesha say`
//
// Editing note: OpenClaw's `dangerous-exec` scanner is a naive per-file regex
// that also reads comments. Do not name the forbidden Node runtime module or a
// bare command-running call anywhere in this file — see
// docs/runbooks/openclaw-plugin.md.

const MODEL_ID = "parakeet-tdt-0.6b-v3";

module.exports = {
  id: "kesha-voice-kit",
  name: "Kesha Voice Kit",
  register(api) {
    api.registerMediaUnderstandingProvider({
      id: "kesha-voice-kit",
      capabilities: ["audio"],
      defaultModels: { audio: MODEL_ID },
      autoPriority: { audio: 50 },
    });
  },
};
