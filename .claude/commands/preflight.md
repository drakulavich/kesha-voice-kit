---
description: Run the full pre-push verification gate (bun + rust) per CLAUDE.md's VERIFY BEFORE PUSHING rules.
argument-hint: "[--all] (force the rust gate even if no rust changed)"
allowed-tools: Bash(bun test:*), Bash(bunx tsc:*), Bash(make:*), Bash(cd rust && cargo fmt:*), Bash(cd rust && cargo clippy:*), Bash(cd rust && cargo nextest:*), Bash(cd rust && cargo check:*), Bash(git status:*), Bash(git diff:*)
---

Run this repo's mandatory pre-push verification gate and report pass/fail with the actual command output. Do **not** claim success on any failure — surface the failing output verbatim and stop.

## Steps

1. Determine what changed: `git diff --name-only origin/main...HEAD` (and `git status --porcelain` for uncommitted work). Note whether anything under `rust/**` changed, and specifically whether `rust/src/backend/**` changed.

2. **Always run the TypeScript/CLI gate:**
   ```bash
   bun test && bunx tsc --noEmit
   ```

3. **If `rust/**` changed (or `$ARGUMENTS` contains `--all`), run the Rust gate** — use the exact flags; `--all-targets` and `nextest` are mandatory (plain `cargo test` is NOT acceptable in this repo):
   ```bash
   cd rust && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo nextest run --features tts
   ```
   (`make rust-test` wraps the nextest call if you prefer.)

4. **If `rust/src/backend/**` changed, also run the CoreML build check:**
   ```bash
   cd rust && cargo check --features coreml --no-default-features
   ```

5. Report a concise PASS/FAIL summary per gate. If `cargo fmt` made changes, mention the whitespace diff to commit. If clippy fails only because CI rustc is newer, point at `gh run view <id> --log-failed`.

Reference: CLAUDE.md "VERIFY BEFORE PUSHING".
