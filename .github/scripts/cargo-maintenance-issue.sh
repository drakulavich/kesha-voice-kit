#!/usr/bin/env bash
# Env: GH_TOKEN, REPO (owner/name), REQUESTED_MONTH (YYYY-MM or empty), RUNNER_TEMP; run from the repo root.
set -euo pipefail

if [[ -n "$REQUESTED_MONTH" ]]; then
  if [[ ! "$REQUESTED_MONTH" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]]; then
    echo "::error::month must use YYYY-MM format, got '$REQUESTED_MONTH'"
    exit 1
  fi
  month="$REQUESTED_MONTH"
else
  month="$(date -u +'%Y-%m')"
fi

title="Cargo dependency maintenance - ${month}"

existing="$(
  gh issue list \
    -R "$REPO" \
    --state all \
    --search "\"$title\" in:title" \
    --json number,title \
    --jq "map(select(.title == \"$title\")) | first | .number // \"\""
)"

if [[ -n "$existing" ]]; then
  echo "Cargo maintenance issue already exists: #$existing"
  exit 0
fi

outdated="$RUNNER_TEMP/cargo-outdated.txt"
outdated_err="$RUNNER_TEMP/cargo-outdated.err"
if (cd rust && cargo outdated --root-deps-only) >"$outdated" 2>"$outdated_err"; then
  cat "$outdated_err" >&2
  outdated_status="\`cargo outdated --root-deps-only\` on \`main\`:"
else
  # A failed report must not cost the month its checklist; the issue says it failed instead.
  echo "::warning::cargo outdated failed; the issue carries its output"
  cat "$outdated_err" >>"$outdated"
  outdated_status="\`cargo outdated --root-deps-only\` **failed** on \`main\`; its output:"
fi

body="$RUNNER_TEMP/cargo-maintenance.md"
cat >"$body" <<'EOF'
Monthly Rust dependency upkeep checklist.

Dependabot Cargo updates are intentionally disabled in this repo because its runner has repeatedly failed against the crates.io sparse index. This issue keeps the replacement process explicit and visible.

## Checklist

- [ ] Create a branch from current `main`
- [ ] Run `cd rust && cargo update`
- [ ] Review `rust/Cargo.lock` for major, security-sensitive, or native dependency changes
- [ ] Review the outdated direct dependencies below; `cargo update` never crosses a semver-major bump
- [ ] Run `cd rust && cargo fmt -- --check`
- [ ] Run `cd rust && cargo clippy --all-targets -- -D warnings`
- [ ] Run `cd rust && cargo nextest run --features tts`
- [ ] If backend or platform crates changed, also run `cd rust && cargo check --features coreml --no-default-features`
- [ ] Open a PR titled `chore(deps): refresh Rust dependencies`
- [ ] Link this issue from the PR and note any risky transitive changes

If `cargo update` produces no diff and nothing below is outdated, close this issue with a short note.

## Outdated direct dependencies

EOF
{
  printf '%s\n\n```text\n' "$outdated_status"
  cat "$outdated"
  printf '```\n'
} >>"$body"

labels=(--label dependencies)
if gh label list -R "$REPO" --search rust --json name --jq '.[].name' | grep -Fxq rust; then
  labels+=(--label rust)
else
  echo "::warning::Label 'rust' does not exist; creating the checklist with only 'dependencies'."
fi

gh issue create \
  -R "$REPO" \
  --title "$title" \
  --body-file "$body" \
  "${labels[@]}"
