# Docker

Linux x64 CLI image, published to GHCR. Engine and model downloads remain explicit (nothing is auto-downloaded).

```bash
docker run --rm \
  -v kesha-cache:/cache/kesha \
  -v "$PWD:/work" -w /work \
  ghcr.io/drakulavich/kesha-voice-kit:latest install

docker run --rm \
  -v kesha-cache:/cache/kesha \
  -v "$PWD:/work" -w /work \
  ghcr.io/drakulavich/kesha-voice-kit:latest audio.ogg
```

The image keeps model downloads and the engine cache under `/cache/kesha`.
Mount that path as a named volume so `kesha install`, TTS models, VAD, and future
runs reuse the same cache. `compose.yml` provides the same layout:

```bash
docker compose run --rm kesha install
docker compose run --rm kesha audio.ogg
```
