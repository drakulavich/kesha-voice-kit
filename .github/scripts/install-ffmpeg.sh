#!/usr/bin/env bash
set -euo pipefail

case "${FFMPEG_PROVIDER:?}" in
  apt) sudo apt-get update -qq && sudo apt-get install -y ffmpeg ;;
  brew) which ffmpeg || brew install ffmpeg ;;
  skip) exit 0 ;;
  *) echo "Unsupported ffmpeg provider: $FFMPEG_PROVIDER" >&2; exit 1 ;;
esac
