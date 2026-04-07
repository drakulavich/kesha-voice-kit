#!/bin/bash
# Run benchmark and update BENCHMARK.md between CI markers.
# Usage: update-benchmark.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

bash "$REPO_DIR/scripts/benchmark.sh" > /tmp/bench_results.txt

echo "============================================"
echo "  BENCHMARK RESULTS"
echo "============================================"
cat /tmp/bench_results.txt
echo "============================================"

python3 "$SCRIPT_DIR/update-benchmark-md.py" /tmp/bench_results.txt BENCHMARK.md
