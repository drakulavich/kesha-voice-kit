# Security & CI Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Rust advisory/license gating (cargo-deny), JS vuln scanning (bun audit), and a push-to-main lean Rust gate — all non-blocking on first landing, promoted to required in a follow-up PR.

**Architecture:** One new `deny.toml` policy file; one new `security.yml` workflow (cargo-deny + bun audit jobs, PR + weekly-cron + dispatch triggers, cron upserts a findings issue); a `push:` trigger + lean ubuntu-only job added to the existing `rust-test.yml`.

**Tech Stack:** cargo-deny (EmbarkStudios action), `bun audit`, GitHub Actions, `gh` CLI for the cron issue upsert.

**Working directory:** `/Users/anton/Personal/worktrees/kesha-voice-kit/security-ci-gates` (branch `codex/security-ci-gates-20260525-094039`). All paths below are relative to it.

**Spec:** `docs/superpowers/specs/2026-05-25-security-ci-gates-design.md`

---

## File Structure

- Create `rust/deny.toml` — cargo-deny policy (advisories, licenses, bans, sources).
- Create `.github/workflows/security.yml` — cargo-deny + bun audit jobs.
- Create `.github/scripts/upsert-audit-issue.sh` — cron findings issue upsert (kept out of the workflow `run:` per the "no inline scripts > 3 lines" rule).
- Modify `.github/workflows/rust-test.yml` — add `push` trigger, guard existing jobs to `pull_request`, add `rust-push-gate` job.

---

## Task 1: cargo-deny policy + local triage

**Files:**
- Create: `rust/deny.toml`

- [ ] **Step 1: Install cargo-deny locally**

Run: `cargo install cargo-deny --locked`
Expected: `cargo-deny` on PATH (`cargo deny --version` prints a version).

- [ ] **Step 2: Write the initial strict policy**

Create `rust/deny.toml`:

```toml
# cargo-deny policy. Run `cd rust && cargo deny check` locally before pushing.
# See docs/superpowers/specs/2026-05-25-security-ci-gates-design.md.

[advisories]
# RUSTSEC advisory DB. Unfixable transitive CVEs go in `ignore` below, each
# with a one-line justification + RUSTSEC link. Keep this list short and
# revisit on every cargo update.
yanked = "deny"
ignore = []

[licenses]
# Permissive allow-list. Anything outside this set fails the check.
allow = [
  "MIT",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Unicode-DFS-2016",
  "Unicode-3.0",
  "Zlib",
  "MPL-2.0",
  "CC0-1.0",
]
confidence-threshold = 0.9
# Per-crate exceptions for known-good oddballs go here as they surface:
# exceptions = [{ name = "ring", allow = ["OpenSSL"] }]
exceptions = []

[bans]
multiple-versions = "warn"
wildcards = "deny"

[sources]
unknown-registry = "deny"
unknown-git = "deny"
allow-registry = ["https://github.com/rust-lang/crates.io-index"]
```

- [ ] **Step 3: Run the check and capture findings**

Run: `cd rust && cargo deny check 2>&1 | tee /tmp/deny-initial.txt`
Expected: likely FAILs on `advisories` (some RUSTSEC entries against transitive deps) and/or `licenses` (a license not yet in the allow-list). This is expected — the next step triages.

- [ ] **Step 4: Triage findings into the policy**

For each advisory that has no available fix (transitive, no patched version): add to `[advisories] ignore` as `"RUSTSEC-YYYY-NNNN", # <crate> — <why unfixable>, revisit <date>`.
For each license outside the allow-list: if permissive and acceptable, add the SPDX id to `[licenses] allow`; if it is a single crate needing a non-standard term, add a `[[licenses.exceptions]]` entry instead of widening the global allow-list.
Do NOT ignore an advisory that has an available fix — bump the dep instead (`cargo update -p <crate>`).

- [ ] **Step 5: Re-run until clean**

Run: `cd rust && cargo deny check`
Expected: `advisories ok`, `bans ok`, `licenses ok`, `sources ok` — exit 0.

- [ ] **Step 6: Commit**

```bash
git add rust/deny.toml rust/Cargo.lock
git commit -m "chore(security): add cargo-deny policy with triaged advisories/licenses"
```

(`Cargo.lock` is staged in case Step 4 required a `cargo update -p` to take a fix.)

---

## Task 2: security.yml — cargo-deny job

**Files:**
- Create: `.github/workflows/security.yml`

- [ ] **Step 1: Resolve the cargo-deny-action pin**

Run: `gh api repos/EmbarkStudios/cargo-deny-action/releases/latest --jq '"\(.tag_name) \(.target_commitish)"'`
Then resolve the tag to a commit SHA: `gh api repos/EmbarkStudios/cargo-deny-action/git/refs/tags/<tag> --jq '.object.sha'`
Record the SHA — used as `uses: EmbarkStudios/cargo-deny-action@<sha> # <tag>`.

- [ ] **Step 2: Write the workflow with the cargo-deny job**

Create `.github/workflows/security.yml` (replace `<SHA>`/`<TAG>` with Step 1 values):

```yaml
name: "🛡️ Security Audit"

on:
  pull_request:
    paths:
      - "rust/Cargo.toml"
      - "rust/Cargo.lock"
      - "rust/deny.toml"
      - "package.json"
      - "bun.lock"
      - ".github/workflows/security.yml"
  schedule:
    # Weekly advisory-DB re-check against unchanged deps (RUSTSEC/npm
    # advisories update independently of our code). Offset from the
    # monthly cargo-dependency-maintenance cron so they don't collide.
    - cron: "23 6 * * 1"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  cargo-deny:
    runs-on: ubuntu-latest
    # NON-BLOCKING on first landing. Remove this line in the promotion PR
    # once the initial findings are triaged into rust/deny.toml.
    continue-on-error: true
    steps:
      - uses: actions/checkout@v6
      - uses: EmbarkStudios/cargo-deny-action@<SHA> # <TAG>
        with:
          manifest-path: rust/Cargo.toml
          command: check advisories licenses bans sources
```

- [ ] **Step 3: Validate workflow syntax**

Run: `bun run check:workflows`
Expected: silent success, exit 0.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/security.yml
git commit -m "ci(security): add cargo-deny job (non-blocking)"
```

---

## Task 3: security.yml — bun audit job

**Files:**
- Modify: `.github/workflows/security.yml`

- [ ] **Step 1: Add the bun-audit job**

Append under `jobs:` in `.github/workflows/security.yml`:

```yaml
  bun-audit:
    runs-on: ubuntu-latest
    # NON-BLOCKING on first landing (see cargo-deny note above).
    continue-on-error: true
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.13"
      - name: Install deps (frozen lockfile)
        run: bun install --frozen-lockfile
      - name: Audit JS dependencies
        run: bun audit --audit-level=high
```

- [ ] **Step 2: Verify locally what CI will run**

Run: `cd /Users/anton/Personal/worktrees/kesha-voice-kit/security-ci-gates && bun install --frozen-lockfile && bun audit --audit-level=high`
Expected: exits 0 with "no vulnerabilities" across the 5 runtime deps (if a high-sev advisory exists, note it — the job is non-blocking so it won't gate, but record it for the promotion PR triage).

- [ ] **Step 3: Validate + commit**

Run: `bun run check:workflows`
Expected: exit 0.

```bash
git add .github/workflows/security.yml
git commit -m "ci(security): add bun audit job (non-blocking)"
```

---

## Task 4: cron findings issue upsert

**Files:**
- Create: `.github/scripts/upsert-audit-issue.sh`
- Modify: `.github/workflows/security.yml`

- [ ] **Step 1: Write the upsert script**

Create `.github/scripts/upsert-audit-issue.sh`:

```bash
#!/usr/bin/env bash
# Upsert a single "Security audit findings" issue when the weekly cron
# detects advisory/license problems. Reuses one issue (by exact title +
# label) instead of opening a new one each week. Mirrors the upsert
# pattern in cargo-dependency-maintenance.yml.
#
# Usage: upsert-audit-issue.sh <body-file>
#   Env: GH_TOKEN, REPO (owner/name)
set -euo pipefail

body_file="$1"
title="Security audit findings (weekly)"
label="security"

existing="$(
  gh issue list -R "$REPO" --state open --label "$label" \
    --search "in:title \"$title\"" --json number --jq '.[0].number // empty'
)"

if [[ -n "$existing" ]]; then
  gh issue edit "$existing" -R "$REPO" --body-file "$body_file"
  gh issue comment "$existing" -R "$REPO" \
    --body "Re-checked $(date -u +%Y-%m-%d): findings updated above."
else
  gh label create "$label" -R "$REPO" --color B60205 \
    --description "Automated security-audit findings" 2>/dev/null || true
  gh issue create -R "$REPO" --title "$title" --label "$label" --body-file "$body_file"
fi
```

- [ ] **Step 2: Make it executable + add a scheduled step to cargo-deny job**

Run: `chmod +x .github/scripts/upsert-audit-issue.sh`

In `.github/workflows/security.yml`, give the `cargo-deny` job `issues: write` only on schedule and add a post-check capture step. Replace the `cargo-deny` job with:

```yaml
  cargo-deny:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      # Only the scheduled run needs to upsert the findings issue.
      issues: write
    continue-on-error: true
    steps:
      - uses: actions/checkout@v6
      - id: deny
        uses: EmbarkStudios/cargo-deny-action@<SHA> # <TAG>
        with:
          manifest-path: rust/Cargo.toml
          command: check advisories licenses bans sources
          # Capture output even on failure so the cron step can report it.
        continue-on-error: true
      - name: Report findings (scheduled only)
        if: github.event_name == 'schedule' && steps.deny.outcome == 'failure'
        env:
          GH_TOKEN: ${{ github.token }}
          REPO: ${{ github.repository }}
        run: |
          {
            echo "## cargo-deny findings ($(date -u +%Y-%m-%d))"
            echo
            echo "The weekly advisory re-check failed. Run \`cd rust && cargo deny check\` locally and triage into \`rust/deny.toml\`."
            echo
            echo "Workflow run: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"
          } > /tmp/audit-body.md
          bash .github/scripts/upsert-audit-issue.sh /tmp/audit-body.md
      - name: Fail job if deny failed on PR
        # On PR/dispatch keep the original (non-blocking) outcome visible:
        # surface the failure as the job's own result so the CI summary
        # shows red-but-non-required. On schedule we already reported via
        # the issue, so don't double-signal.
        if: github.event_name != 'schedule' && steps.deny.outcome == 'failure'
        run: |
          echo "::warning::cargo-deny reported findings (non-blocking until promotion PR)"
          exit 1
```

Note: the job-level `continue-on-error: true` means the `exit 1` marks the job red without blocking merge; the promotion PR (Task 6) removes the job-level `continue-on-error`. The inner `steps.deny ... continue-on-error: true` lets the report step run after a failing check.

- [ ] **Step 3: Validate + commit**

Run: `bun run check:workflows`
Expected: exit 0.

```bash
git add .github/workflows/security.yml .github/scripts/upsert-audit-issue.sh
git commit -m "ci(security): upsert findings issue on weekly cron"
```

---

## Task 5: push-to-main lean Rust gate

**Files:**
- Modify: `.github/workflows/rust-test.yml`

- [ ] **Step 1: Add the push trigger**

In `.github/workflows/rust-test.yml`, change the `on:` block (lines 3-10) to add a `push` trigger:

```yaml
on:
  pull_request:
    paths:
      - "rust/**"
      - ".github/workflows/rust-test.yml"
      - ".github/scripts/check-coverage.ts"
      - "package.json"
      - "bun.lock"
  push:
    branches: [main]
    paths:
      - "rust/**"
      - ".github/workflows/rust-test.yml"
```

- [ ] **Step 2: Guard the existing heavy jobs to pull_request**

Add `if: github.event_name == 'pull_request'` to each of the three existing jobs so they do NOT run on push. Add it as the first line under each job key:

- `lint-ubuntu:` → add `    if: github.event_name == 'pull_request'`
- `test:` → add `    if: github.event_name == 'pull_request'` (above its existing `permissions:` block)
- `coverage:` → add `    if: github.event_name == 'pull_request'` (above its existing `permissions:` block)

- [ ] **Step 3: Add the lean push-gate job**

Append under `jobs:` in `.github/workflows/rust-test.yml`:

```yaml
  rust-push-gate:
    # Lean post-merge gate: catches semantic merge conflicts (two PRs green
    # alone, broken together) fast and cheap. The 3-OS matrix already ran on
    # the PR; build-engine.yml is the cross-platform release gate. Ubuntu-only
    # on purpose.
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: rust
      - name: Install system audio deps (Opus)
        run: |
          sudo apt-get update -qq
          sudo apt-get install -y --no-install-recommends libopus-dev pkg-config
      - uses: taiki-e/install-action@v2
        with:
          tool: nextest
      - name: Check formatting
        run: cd rust && cargo fmt -- --check
      - name: Clippy
        run: bash rust/ci/run-clippy.sh Linux
      - name: Tests
        run: cd rust && cargo nextest run --features tts
```

- [ ] **Step 4: Validate workflow syntax**

Run: `bun run check:workflows`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/rust-test.yml
git commit -m "ci(rust): add lean push-to-main gate, scope matrix to PRs"
```

---

## Task 6: actionlint, open PR 1, verify trigger behavior

**Files:** none (verification + PR)

- [ ] **Step 1: Run actionlint on all workflows**

Run: `actionlint .github/workflows/security.yml .github/workflows/rust-test.yml`
(If `actionlint` is not installed: `brew install actionlint` or `go install github.com/rhysd/actionlint/cmd/actionlint@latest`.)
Expected: no output, exit 0. Fix any reported issues and re-commit.

- [ ] **Step 2: Push and open PR 1**

```bash
git push -u origin codex/security-ci-gates-20260525-094039
gh pr create --base main --head codex/security-ci-gates-20260525-094039 \
  --title "ci(security): add cargo-deny + bun audit gates and push-to-main Rust gate" \
  --body "Implements the non-blocking phase of #461 per docs/superpowers/specs/2026-05-25-security-ci-gates-design.md. cargo-deny + bun audit land as continue-on-error; rust-push-gate is a real gate. Refs #461."
```

- [ ] **Step 3: Verify trigger behavior on the PR**

After CI starts, confirm with `gh pr checks <N>`:
- `cargo-deny` and `bun-audit` jobs appear, and are non-blocking (PR can be green even if they're red).
- `rust-push-gate` does NOT run on the PR event (it's `if: github.event_name == 'push'`).
- The full `test` matrix (macos/windows) + `coverage` + `lint-ubuntu` DO run (pull_request event).

- [ ] **Step 4: After merge, verify push-gate fires on main**

Run: `gh run list --workflow "🧪 Rust Tests" --branch main --limit 1`
Expected: a run triggered by `push` whose only Rust job is `rust-push-gate` (the matrix jobs are skipped on push).

- [ ] **Step 5: Dispatch the cron path once to test issue upsert**

Run: `gh workflow run "🛡️ Security Audit"` then, after it completes, if cargo-deny found nothing the issue step is skipped (expected on a clean tree). To exercise the upsert, temporarily set a bogus advisory ignore is NOT needed — instead confirm the logic by running `bash .github/scripts/upsert-audit-issue.sh <(echo "test")` locally against a scratch label, then delete the test issue. (Do not leave a test issue open.)

---

## Promotion PR (separate, after dashboards are clean)

Not part of this plan's commits — a one-line follow-up once the non-blocking jobs have run clean for a cycle:

- Remove `continue-on-error: true` from the `cargo-deny` and `bun-audit` jobs in `security.yml`.
- Open PR titled `ci(security): promote cargo-deny + bun audit to required gates`, Refs #461.
- Verify the gate now blocks via a throwaway scratch branch that adds a crate with a denied license (do not merge the scratch branch).

---

## Notes for the implementer

- **Bun-only rule:** never introduce `package-lock.json` or `npm install`. `bun audit` against `bun.lock` is the JS gate; published-package signatures are already covered by `npm-publish.yml --provenance`.
- **No inline scripts > 3 lines:** the cron upsert lives in `.github/scripts/upsert-audit-issue.sh`, not in the workflow `run:`.
- **Greptile is a merge gate:** treat P1/P2 findings as blockers; wait for the review on the latest head SHA before merging (CLAUDE.md).
- **Verify before pushing:** `bun run check:workflows` + `actionlint` must pass; `cd rust && cargo deny check` must be clean.
