# Air-gapped / corporate mirrors

Set `KESHA_MODEL_MIRROR` to redirect model downloads from `huggingface.co` to an internal mirror ([#121](https://github.com/drakulavich/kesha-voice-kit/issues/121)). The HF path hierarchy (`/<owner>/<repo>/resolve/<ref>/<file>`) is preserved, so any HTTP-readable mirror populated with `wget --mirror` or `rsync` works:

```bash
export KESHA_MODEL_MIRROR=https://models.corp.internal/kesha
kesha install        # HuggingFace-hosted models fetch from your mirror
kesha status         # confirms the active Mirror URL
```

Unset / empty falls back to `huggingface.co`. Kesha checks each model file it downloads against its pinned SHA-256, so the mirror must serve the same bytes as upstream.

Only `huggingface.co` URLs are rewritten. These downloads keep their own hosts:

- the engine binary, from GitHub Releases;
- Silero VAD (`kesha install --vad`), from github.com;
- the Kokoro ONNX graph (`kesha install --tts` outside darwin-arm64), from a github.com release;
- on darwin-arm64, the CoreML speech-to-text model, which FluidAudio fetches during the install warm-up, outside Kesha's downloader.

For the github.com model files, pre-stage each one at its path under the cache directory (`~/.cache/kesha` or `KESHA_CACHE_DIR`): `models/silero-vad/silero_vad.onnx`, `models/kokoro-82m/model.onnx`. `kesha install` reuses a cached file whose SHA-256 matches its pin.
