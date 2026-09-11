---
description: Run the full pre-push verification gate (bun + rust) per CLAUDE.md's VERIFY BEFORE PUSHING rules.
argument-hint: "[--all] (run every gate even if no rust changed)"
allowed-tools: Bash(just:*)
---

Run `just preflight` — or `just ALL=1 preflight` when `$ARGUMENTS` contains `--all` — and report a concise PASS/FAIL summary with the actual command output. Do **not** claim success on any failure: surface the failing output verbatim and stop.

The recipe owns which gates run and with which flags; do not reconstruct the commands here or reach past it to raw `cargo`. It prints one line per passing gate and the failing gate's log verbatim, so relay what it printed — re-running a gate loudly to see more only reprints what it already gave you.

- If `cargo fmt` reformatted anything, mention the whitespace diff to commit.
- If clippy fails only because CI's rustc is newer, point at `gh run view <id> --log-failed`.

Reference: the `preflight` recipe in `justfile`, CLAUDE.md "VERIFY BEFORE PUSHING".
