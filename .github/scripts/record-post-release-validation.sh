#!/usr/bin/env bash
set -euo pipefail

{
  printf '\n## Validation output\n\n```text\n'
  bun run check:versions
  bun run check:engine-targets
  git diff --check
  printf 'git diff --check: passed\n```\n'
} | tee -a post-release-pr.md
