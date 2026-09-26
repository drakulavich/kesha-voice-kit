#!/usr/bin/env bash
# A matrix row that silently drops a feature must fail here, not ship (v1.1.0 → v1.1.3; CLAUDE.md "BUILD-ENGINE FEATURE MATRIX").
set -euo pipefail

binary="${ENGINE_BINARY:?}"
chmod +x "$binary"
caps=$("./$binary" describe)
echo "$caps"
# Scoped to the feature array: the error taxonomy and gate table carry "tts" and "transcribe.diarize" whatever was compiled in.
feats() { echo "$caps" | grep -o '"features":\[[^]]*\]'; }
feats | grep -q '"tts"' || {
  echo "expected tts in describe features, got: $caps" >&2
  exit 1
}
if [ "${RUNNER_IMAGE:?}" = "macos-14" ]; then
  voices=$("./$binary" say --list-voices)
  echo "$voices" | grep -q '^macos-' || {
    echo "expected at least one macos-* voice, got:" >&2
    echo "$voices" >&2
    exit 1
  }
  echo "$voices" | grep -q '^en-am_michael' || {
    echo "expected FluidAudio Kokoro voice en-am_michael, got:" >&2
    echo "$voices" >&2
    exit 1
  }
  # #199: transcribe.diarize is gated on system_diarize; this is the last gate before a release ships without it.
  feats | grep -q '"transcribe\.diarize"' || {
    echo "expected transcribe.diarize in describe features, got: $caps" >&2
    exit 1
  }
  # `detect-text-lang` takes the text as argv; the Rust glue forwards it into the sidecar's stdin.
  lang_json=$("./$binary" detect-text-lang "Hello world from the smoke test")
  echo "$lang_json"
  echo "$lang_json" | grep -q '"code"' || {
    echo "expected detect-text-lang to emit JSON with a 'code' field, got: $lang_json" >&2
    exit 1
  }
fi
