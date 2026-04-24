# Air-gapped / corporate mirrors

Set `KESHA_MODEL_MIRROR` to redirect all HuggingFace model downloads to an internal mirror ([#121](https://github.com/drakulavich/kesha-voice-kit/issues/121)). The HF path hierarchy is preserved, so any HTTP-readable mirror populated with `wget --mirror` or `rsync` works:

```bash
export KESHA_MODEL_MIRROR=https://models.corp.internal/kesha
kesha install        # ASR + lang-id + TTS models fetch from your mirror
kesha status         # confirms the active Mirror URL
```

Unset / empty falls back to `huggingface.co` with no regression. The engine binary itself still comes from GitHub Releases — this env var only redirects model downloads.
