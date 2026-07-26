# Docker

Linux x64 (`amd64`) CLI image, published to GHCR — no `arm64` image is built.
Engine and model downloads remain explicit (nothing is auto-downloaded); the
image only ships the Bun CLI wrapper, so the first `install` still pulls
~2.5 GB (engine + speech-to-text models) into the cache volume. See
[What Linux Gets](linux-packages.md#what-linux-gets) for the full feature
rundown.

The container has no microphone access, so `kesha record` won't work inside
it — this is a file-in/file-out setup: mount existing audio under `/work` and
read the transcript from stdout or a redirected file.

```bash
docker run --rm \
  -v kesha-cache:/cache/kesha \
  -v "$PWD:/work" -w /work \
  ghcr.io/drakulavich/kesha-voice-kit:latest install

docker run --rm \
  -v kesha-cache:/cache/kesha \
  -v "$PWD:/work" -w /work \
  ghcr.io/drakulavich/kesha-voice-kit:latest audio.ogg

docker run --rm \
  -v kesha-cache:/cache/kesha \
  -v "$PWD:/work" -w /work \
  ghcr.io/drakulavich/kesha-voice-kit:latest install --tts   # English TTS, ~326 MB more
```

The image keeps model downloads and the engine cache under `/cache/kesha`.
Mount that path as a named volume so `kesha install`, TTS models, VAD, and future
runs reuse the same cache. `compose.yml` provides the same layout:

```bash
docker compose run --rm kesha install
docker compose run --rm kesha audio.ogg
```
