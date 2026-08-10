#!/usr/bin/env bash
# Point the model-gated Rust tests at a staged Kokoro + CharsiuG2P cache.
# Source it — it only exports. usage: source rust/ci/kokoro-env.sh <cache_dir>
#
# Both nextest lanes (rust-test.yml `test` via run-cargo-test.sh, and `coverage`)
# read this one copy: they used to carry the same conditions inline, so a fix to
# one silently left the other gating on something else (#741).

_kokoro_cache="${1:?usage: source kokoro-env.sh <cache_dir>}"

_kokoro_export() {
  export "$1=$2"
  if [[ -n "${GITHUB_ENV:-}" ]]; then
    echo "$1=$2" >>"$GITHUB_ENV"
  fi
}

if [[ -f "$_kokoro_cache/model.onnx" && -f "$_kokoro_cache/am_michael.bin" ]]; then
  _kokoro_export KOKORO_MODEL "$_kokoro_cache/model.onnx"
  _kokoro_export KOKORO_VOICE "$_kokoro_cache/am_michael.bin"
  echo "Running with real Kokoro models from $_kokoro_cache"
else
  echo "Kokoro cache empty — gated tests will skip"
fi

# Gate on the runtime layout `common::kokoro_cache_dir_or_skip` resolves against.
# This used to gate on the Vosk-RU bundle, which no test ever read — deleting
# that bundle would then have left KESHA_CACHE_DIR unset and skipped
# tts_multilang_audio silently, on a green run (#741).
if [[ -f "$_kokoro_cache/models/kokoro-82m/model.onnx" ]]; then
  _kokoro_export KESHA_CACHE_DIR "$_kokoro_cache"
  echo "KESHA_CACHE_DIR=$_kokoro_cache (cache-resolved gated tests enabled)"
fi

if [[ -f "$_kokoro_cache/models/g2p/byt5-tiny/encoder_model.onnx" ]]; then
  _kokoro_export CHARSIU_ONNX "$_kokoro_cache/models/g2p/byt5-tiny"
  echo "CHARSIU_ONNX=$_kokoro_cache/models/g2p/byt5-tiny (multilingual TTS gated tests enabled)"
fi

unset _kokoro_cache
