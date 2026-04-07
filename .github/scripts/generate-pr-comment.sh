#!/bin/bash
# Generate a PR comment from JUnit test result artifacts.
# Usage: generate-pr-comment.sh <results-dir> <output-file>

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
for xml in "$RESULTS_DIR"/test-results-*/unit-*.xml; do
  [ -f "$xml" ] || continue
  name=$(basename "$xml" .xml | sed 's/unit-//')
  python3 "$SCRIPT_DIR/junit-to-markdown.py" --summary "$name" "$xml" >> "$OUTPUT"
done

echo "" >> "$OUTPUT"

# Integration tests — full table
for xml in "$RESULTS_DIR"/test-results-*/integration.xml; do
  [ -f "$xml" ] || continue
  python3 "$SCRIPT_DIR/junit-to-markdown.py" "Integration Tests" "$xml" >> "$OUTPUT"
done
