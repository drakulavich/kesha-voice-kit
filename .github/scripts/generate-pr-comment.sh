#!/bin/bash
# Generate a PR comment from JUnit test result artifacts.
# Usage: generate-pr-comment.sh <results-dir> <output-file>
# results-dir: directory containing test-results-* subdirectories
# output-file: path to write the markdown comment

set -euo pipefail

RESULTS_DIR="${1:?Usage: generate-pr-comment.sh <results-dir> <output-file>}"
OUTPUT="${2:?Usage: generate-pr-comment.sh <results-dir> <output-file>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

cat > "$OUTPUT" << 'EOF'
## Test Results

| Platform | Status | Tests | Time |
|----------|--------|-------|------|
EOF

# Unit tests — summary row per platform
for dir in "$RESULTS_DIR"/test-results-ubuntu-* "$RESULTS_DIR"/test-results-windows-* "$RESULTS_DIR"/test-results-macos-*; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir" | sed 's/test-results-//')
  xml="$dir/junit.xml"
  if [ -f "$xml" ]; then
    python3 "$SCRIPT_DIR/junit-to-markdown.py" --summary "$name" "$xml" >> "$OUTPUT"
  fi
done

echo "" >> "$OUTPUT"

# Integration tests — full table
if [ -f "$RESULTS_DIR/test-results-integration/junit.xml" ]; then
  python3 "$SCRIPT_DIR/junit-to-markdown.py" "Integration Tests" "$RESULTS_DIR/test-results-integration/junit.xml" >> "$OUTPUT"
fi
