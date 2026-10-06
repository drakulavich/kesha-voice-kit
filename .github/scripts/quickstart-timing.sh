#!/usr/bin/env bash
# README Quick Start from a clean runner, timed per step into the job summary (#1411).
set -euo pipefail

start=$(date +%s)
bun add -g kesha
kesha --version
installed=$(date +%s)
kesha install
models=$(date +%s)
kesha tests/fixtures/benchmark-en/01-check-email.ogg | tee transcript.txt
grep -q "[[:alpha:]]" transcript.txt
done=$(date +%s)

{
  echo "### Quick Start on ${RUNNER_LABEL}"
  echo
  echo "| Step | Seconds |"
  echo "|---|---|"
  echo "| \`bun add -g\` | $((installed - start)) |"
  echo "| \`kesha install\` | $((models - installed)) |"
  echo "| first \`kesha audio.ogg\` | $((done - models)) |"
  echo "| total to first transcript | $((done - start)) |"
} >> "$GITHUB_STEP_SUMMARY"
