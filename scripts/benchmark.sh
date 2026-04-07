#!/bin/bash
# Benchmark: faster-whisper vs parakeet-cli (CoreML)
# Outputs CI section content to stdout.
# The workflow inserts this between CI-BENCHMARK-START/END markers in BENCHMARK.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FIXTURES_DIR="$REPO_DIR/fixtures/benchmark"
CLI="$REPO_DIR/src/cli.ts"

# Get system info
CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "Unknown")
RAM=$(system_profiler SPHardwareDataType 2>/dev/null | grep "Memory:" | awk '{print $2, $3}' || echo "Unknown")
VERSION=$(bun run "$CLI" --version 2>/dev/null || echo "unknown")

# Ensure parakeet backend is installed
bun run "$CLI" install 2>/dev/null

# Collect files
FILES=("$FIXTURES_DIR"/*.ogg)
TOTAL_FILES=${#FILES[@]}

if [[ $TOTAL_FILES -eq 0 || ! -f "${FILES[0]}" ]]; then
  echo "ERROR: No .ogg files found in $FIXTURES_DIR" >&2
  exit 1
fi

# Setup faster-whisper in a temporary venv
VENV_DIR=$(mktemp -d)
trap 'deactivate 2>/dev/null; rm -rf "$VENV_DIR"' EXIT

python3 -m venv "$VENV_DIR"
source "$VENV_DIR/bin/activate"
pip install -q faster-whisper 2>/dev/null

# Run faster-whisper benchmark
echo "Running faster-whisper benchmark ($TOTAL_FILES files)..." >&2
WHISPER_JSON=$(python3 -c "
import sys, time, json
from faster_whisper import WhisperModel
model = WhisperModel('medium', device='cpu', compute_type='int8')
results = []
for f in sys.argv[1:]:
    start = time.time()
    segments, info = model.transcribe(f, language='ru')
    text = ' '.join(s.text.strip() for s in segments)
    elapsed = time.time() - start
    results.append({'time': round(elapsed, 1), 'text': text})
print(json.dumps(results, ensure_ascii=False))
" "${FILES[@]}")

# Run parakeet benchmark
echo "Running parakeet benchmark ($TOTAL_FILES files)..." >&2
PARAKEET_JSON=$(python3 -c "
import subprocess, time, json, sys
cli = sys.argv[1]
results = []
for f in sys.argv[2:]:
    start = time.time()
    r = subprocess.run(['bun', 'run', cli, f],
                       capture_output=True, text=True)
    elapsed = time.time() - start
    results.append({'time': round(elapsed, 1), 'text': r.stdout.strip()})
print(json.dumps(results, ensure_ascii=False))
" "$CLI" "${FILES[@]}")

# Generate CI section markdown
DATE=$(date -u +%Y-%m-%d)

cat << HEADER

**Date:** $DATE
**Version:** v$VERSION
**Runner:** GitHub Actions macos-15 ($CHIP, $RAM RAM)

| # | faster-whisper | Parakeet (CoreML) | faster-whisper Transcript | Parakeet Transcript |
|---|---------|----------|--------------------|---------------------|
HEADER

python3 -c "
import json, sys

whisper = json.loads(sys.argv[1])
parakeet = json.loads(sys.argv[2])

whisper_total = 0
parakeet_total = 0

for i, (w, p) in enumerate(zip(whisper, parakeet)):
    whisper_total += w['time']
    parakeet_total += p['time']
    print(f'| {i+1} | {w[\"time\"]}s | {p[\"time\"]}s | {w[\"text\"]} | {p[\"text\"]} |')

speedup = round(whisper_total / parakeet_total, 1) if parakeet_total > 0 else 0
print(f'| **Total** | **{round(whisper_total, 1)}s** | **{round(parakeet_total, 1)}s** | | |')
print()
print(f'**Parakeet is ~{speedup}x faster** with CoreML on Apple Silicon.')
" "$WHISPER_JSON" "$PARAKEET_JSON"
