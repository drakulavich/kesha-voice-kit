#!/usr/bin/env bash
set -euo pipefail

python3 -m venv /tmp/mini-venv && /tmp/mini-venv/bin/pip -q install 'onnx==1.22.0' numpy
# Separated so the failure names itself: a toolchain that could not run is not drift.
/tmp/mini-venv/bin/python .github/scripts/generate-mini-models.py tests/fixtures/mini-models/kokoro \
  || { echo "::error::the generator could not run — toolchain problem, not drift"; exit 1; }
git diff --exit-code -- tests/fixtures/mini-models/kokoro \
  || { echo "::error::the generator produced different bytes than the committed fixture"; exit 1; }
