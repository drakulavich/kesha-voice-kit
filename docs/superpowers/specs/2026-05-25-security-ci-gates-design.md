# Security & CI gates — design

Tracking issue: [#461](https://github.com/drakulavich/kesha-voice-kit/issues/461) (spun off from audits #344 item 14/15 and #345 item 11).

## Problem

Three gaps in the supply-chain / CI posture:

1. **No Rust advisory or license enforcement.** ~302 transitive cargo deps, zero scanning. A new RUSTSEC CVE or a copyleft-licensed transitive dep would land silently. Dependabot deliberately skips the cargo ecosystem (#165 — sparse-index curl bug on the Dependabot runner), so there is no automated Rust signal beyond the monthly manual `cargo-dependency-maintenance.yml` checklist.
2. **No JS advisory scanning.** 5 runtime deps, no `bun audit` / `npm audit` in CI.
3. **Push-to-main Rust coverage is weaker than PR coverage.** `rust-test.yml` runs only on `pull_request`. A semantic merge break — two PRs that pass independently but conflict when both land — is invisible until the next release-tag build.

## Non-goals

- `npm audit signatures` for installed deps. It requires an npm lockfile/install, which violates the bun-only runtime rule (CLAUDE.md). Published-package signature integrity is already covered by `npm-publish.yml --provenance` (GitHub OIDC attestation). Installed-dep vuln scanning is handled by `bun audit` instead.
- Replacing the monthly `cargo-dependency-maintenance.yml` signal. This design adds advisory *gating*; the monthly issue remains the manual `cargo update` driver.
- Re-enabling Dependabot for cargo. Out of scope until the upstream sparse-index bug is fixed.

## Design

### 1. cargo-deny (Rust supply chain)

`rust/deny.toml` encodes the policy (cargo-deny looks in the manifest dir):

- **advisories:** deny RUSTSEC vulnerabilities and unmaintained crates. Unfixable transitive CVEs go in `[advisories] ignore` with a one-line justification + RUSTSEC link per entry.
- **licenses:** allow-list of permissive licenses (MIT, Apache-2.0, Apache-2.0 WITH LLVM-exception, BSD-2/3-Clause, ISC, Unicode-DFS-2016, Zlib, MPL-2.0 if needed). Anything outside the allow-list fails. Per-crate `[[licenses.exceptions]]` for known-good oddballs.
- **bans:** `multiple-versions = "warn"` (duplicate-version hygiene without blocking), deny any genuinely banned crate if one surfaces.
- **sources:** `unknown-registry = "deny"`, `unknown-git = "deny"` — only crates.io.

Runner: `EmbarkStudios/cargo-deny-action@<pinned-sha>` in a new `.github/workflows/security.yml`.

### 2. bun audit (JS supply chain)

`bun audit --audit-level=high` against `bun.lock`, as a job in the same `security.yml`. Native to bun, no npm lockfile.

### 3. Push-to-main lean Rust gate

Add to `rust-test.yml`:

- `on.push` with `branches: [main]`, `paths: [rust/**, .github/workflows/rust-test.yml]`.
- New ubuntu-only job `rust-push-gate`, guarded `if: github.event_name == 'push'`: `cargo fmt --check` + `cargo clippy --all-targets -- -D warnings` + `cargo nextest run --features tts`.
- Existing matrix jobs stay guarded to `pull_request` so a single event never runs both the full matrix and the lean gate.

Rationale for ubuntu-only: the PR that produced the merged content already ran the full 3-OS matrix; the push gate exists to catch semantic merge conflicts fast and cheap, not to re-certify every platform. The release-tag `build-engine.yml` remains the cross-platform release gate.

### Workflow triggers

`security.yml` runs on:

- `pull_request` touching `rust/Cargo.toml`, `rust/Cargo.lock`, `rust/deny.toml`, `package.json`, or `bun.lock` — fast feedback when deps change.
- `schedule` (weekly cron) — re-checks the advisory DB against unchanged deps, since RUSTSEC/npm advisories update independently of the code. The scheduled run upserts a single labeled issue (same upsert pattern as `cargo-dependency-maintenance.yml`) rather than opening a new issue each week.
- `workflow_dispatch` for manual runs.

`permissions`: `contents: read` for PR/dispatch; the scheduled job additionally needs `issues: write` to upsert the findings issue.

## Rollout (two PRs)

The first cargo-deny run against all 302 deps will surface findings we cannot predict in advance (existing advisories, license edge cases). So:

- **PR 1:** add `security.yml` (cargo-deny + bun audit jobs both `continue-on-error: true`), `rust/deny.toml`, and the `rust-push-gate` job. Triage the initial findings into `deny.toml` (ignore-list + license allow-list, each with a comment) in the same PR so the run is clean.
- **PR 2:** remove `continue-on-error` from both audit jobs → required gates. `deny.toml` policy is strict from PR 1; only the CI blocking flips.

The push-gate job is a real gate from PR 1 (it runs the same checks already required on PRs, so no triage risk).

## Testing

- **deny.toml validity:** `cargo deny check` runs clean locally in the worktree before PR 1 opens (with the triaged ignore/allow lists).
- **Workflow shape:** `bun .github/scripts/check-workflows.ts` (existing lint) passes; `actionlint` clean.
- **Trigger correctness:** confirm on PR 1 that (a) the cargo-deny + bun-audit jobs appear and are non-blocking, (b) the push-gate job does NOT run on the PR event, and (c) after merge, the push-gate job runs on main and the full matrix does not.
- **Cron:** `workflow_dispatch` the scheduled path once to confirm the issue-upsert logic creates exactly one issue and updates (not duplicates) it on a second run.
- **Promotion:** PR 2 verified by an intentional throwaway commit that adds a crate with a denied license / known advisory on a scratch branch, confirming the gate now blocks. (Not merged.)

## Files touched

- `rust/deny.toml` (new)
- `.github/workflows/security.yml` (new)
- `.github/workflows/rust-test.yml` (add push trigger + `rust-push-gate` job)
- `.github/scripts/` — a small script if the cron issue-upsert logic exceeds 3 inline lines (per the repo "no inline scripts > 3 lines" rule).
