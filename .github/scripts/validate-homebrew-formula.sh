#!/usr/bin/env bash
set -euo pipefail

brew tap-new local/tap
brew trust local/tap
cp tap/Formula/kesha-voice-kit.rb "$(brew --repository local/tap)/Formula/kesha-voice-kit.rb"
brew install --build-from-source local/tap/kesha-voice-kit
brew audit --strict --formula local/tap/kesha-voice-kit
brew test local/tap/kesha-voice-kit
