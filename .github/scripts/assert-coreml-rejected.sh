#!/usr/bin/env bash
# Only meaningful without KESHA_ENGINE_BIN, which makes performInstall skip the pre-flight.
set -euo pipefail

if kesha install --coreml 2> coreml-reject.log; then
  echo "FAIL: \`kesha install --coreml\` succeeded on Windows" >&2
  exit 1
fi
grep -qi onnx coreml-reject.log || {
  echo "FAIL: rejection did not name the ONNX backend" >&2
  cat coreml-reject.log >&2
  exit 1
}
