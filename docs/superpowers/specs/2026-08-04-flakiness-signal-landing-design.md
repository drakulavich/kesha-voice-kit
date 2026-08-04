# Landing the Flakiness.io signal on kesha

Date: 2026-08-04

## Problem

A survey of `Laputa/kesha-voice-kit` on Flakiness.io found no flaky tests at all
— `flip>0%`, `fail>0%`, `s:flaked` and `s:regressed` all return zero on the
default branch and on PRs 690, 687, 686 and 682. That is a real result, but it
rests on data that cannot yet accumulate. Two collection defects cap how much
history the service ever holds, and both of them are ours.

### Environment identity forks on every macOS image bump

Flakiness.io keys an environment on `(category, name, path, os + version,
arch)`. The OS version carries a patch component, so a runner image bump mints a
brand-new environment whose history starts empty. Over ~90 days:

| runner | jobs | environments produced |
|---|---|---|
| `macos-latest` | `unit-tests`, `integration-tests`, `integration-tests-full` | **5** — 15.7.4, 15.7.5, 15.7.7, 26.4, 26.5.2 |
| `macos-14` (pinned) | `tts-e2e` | 1 — 14.8.7 |
| `ubuntu-latest` | — | 1 — 24.04 |
| `windows-latest` | — | 1 — 10.0.26100 |

macOS fragments even inside one major: 15.7.4, 15.7.5 and 15.7.7 are three
separate environments. Rare-flake detection needs hundreds of runs in one
bucket; these buckets reset every few weeks.

The same lane is also the noisy one. Day-over-day duration movement, over all
1413 default-branch records:

| OS | timed tests | moved >25% | median abs. trend |
|---|---|---|---|
| macos 26.5.2 | 142 | **79.6%** | **55%** |
| macos 14.8.7 | 6 | 66.7% | 29% |
| ubuntu 24.04 | 93 | 19.4% | 0% |
| win 10.0.26100 | 34 | 2.9% | 0% |

On macOS nearly all of `cli-contracts.test.ts` shifted −38%…−55% on the same
day, which is a whole-run slowdown rather than per-test instability.

### Rust never reaches main

```
flakiness list tests --env-category rust              -> 0
flakiness list tests --env-category bun               -> 1413
flakiness list tests --pr 690 --env-category rust     -> 1200
```

1200 Rust tests exist, but only in PR scope. `rust-push-gate`
(`rust-test.yml:317`) is the only Rust job that runs on push to main, and it
runs `cargo nextest run --features tts` without `--profile ci`. JUnit XML is
emitted only by that profile (`rust/.config/nextest.toml`), so there is nothing
to upload and no upload step. The job already runs on every push to main and has
no `needs: changes` gate, so it is a regular, cheap sampling point that is
simply not wired up.

Flakiness is measured against a stable branch: `flip_rate` counts pass/fail
transitions along a branch's history. In PR scope that history is one point,
which is why all four PRs report zero — not because Rust is clean, but because
there is nothing to compare against.

**Unverified**: `regressed` is defined as "passed on the target branch, fails
here". If Rust never lands on main there is no target-branch baseline, so a
failing Rust test in a PR probably cannot be classified `regressed`. That would
silently break the `--fql 's:regressed'` triage workflow for Rust. The mechanism
is consistent but unproven — confirming it needs a PR with a genuinely red Rust
test, and no recent PR has one.

## Goal

Accumulate long-lived history so rare flakes and duration degradation become
detectable. This is explicitly *not* about diagnosing a current failure.

## Approach

Two tracks, landed as two sequential PRs.

### Rejected alternatives

**Pin runners to fixed images.** The data refutes it: 15.7.4 → 15.7.5 → 15.7.7
is drift *within* one major. `macos-14` held a single identity because that
image is frozen and near EOL, not because pinning works. It is a fix with an
expiry date that also drags tests onto an obsolete macOS.

**Declare ubuntu+windows the trend baseline, macOS pass/fail only.** Free, and
those are the stable, quiet buckets. But kesha is macOS-first — CoreML,
AVSpeech and `system_kokoro` are darwin-only — so giving up macOS trends blinds
the most product-relevant lane. Retained as the fallback if PR 1's verification
fails.

## PR 1 — make the signal accumulate

### Normalize the reported macOS version

Split the single-shot `bunx @flakiness/junit-xml` call into three steps:
convert with `--disable-upload`, rewrite `report.json`, then `flakiness upload`.
Validated by a throwaway spike: the converter writes
`environments[].systemData.osVersion` as a plain editable field, and
`flakiness upload <path>` accepts the edited report.

Rule: for `osName == "macos"` only, truncate `osVersion` to **major.minor**
(`26.5.2` → `26.5`). Ubuntu (`24.04`) and Windows (`10.0.26100`) have not moved
in 90 days and are left untouched.

**Accepted trade-off.** major.minor merges the dead 15.7.x line (three
environments into one) but not the live one: `26.4` and `26.5` stay separate,
and macOS ships minors roughly monthly, so the current line keeps forking at
about that cadence. Truncating to major would hold all of macOS 26 in one bucket
for the OS lifecycle. major.minor was chosen deliberately with this understood;
it is a compromise, not an oversight. If monthly buckets prove too short for
rare-flake detection, moving to major-only is a one-line change to the script.

### Consolidate the upload sites

The upload block is currently copy-pasted six times: `ci.yml:268` (unit, 3-OS
matrix), `:361` (integration), `:428` (integration-full), `:770` (tts-e2e),
`rust-test.yml:213` (matrix), `:295` (coverage/ubuntu). All six collapse into
one `.github/scripts/upload-flakiness.sh` invocation. The repo already forbids
inline CI scripts over three lines, and the normalization step pushes these
blocks past that bar regardless.

### Wire Rust into main

In `rust-push-gate`: add `--profile ci` to the nextest run, add setup-bun, and
add an upload step with `--category rust`. This gives main a per-push Rust
history on ubuntu — the most stable bucket of the four.

**Scope limit, stated deliberately.** `rust-push-gate` is ubuntu-only by design
("lean post-merge gate"; the 3-OS matrix already ran on the PR). So main gets
Rust history from ubuntu only, and Windows/macOS-specific Rust flakes stay
invisible on main. This is a first step, not full coverage.

### The trap that would make this silently no-op

Uploads authenticate over OIDC. Top-level permissions in `rust-test.yml` are
`contents: read`; `id-token: write` is granted per-job in `test` (:85) and
`coverage` (:221). `rust-push-gate` has no permissions block. Every upload step
carries `continue-on-error: true` — deliberately, so a Flakiness outage cannot
fail a test job (Greptile #301 P1). The consequence: a missing `id-token: write`
would drop the data without failing anything, and the job would look green.

So PR 1 must add `permissions: id-token: write` to `rust-push-gate`, and
verification is a required step, not an optional one.

### Verification

After PR 1 merges, both must hold:

1. `flakiness list tests --env-category rust` on the default branch returns
   non-zero (currently 0, against 1200 in PR scope).
2. `flakiness list tests --env-os "macos 26.5"` shows subsequent runs joining
   that environment instead of minting a new one.

Check 2 also tests the one real assumption in this PR: that the service derives
environment identity solely from the reported `systemData`, and not from some
additional fingerprint. If it does not merge, the normalization approach fails
and we fall back to ubuntu+windows as the trend baseline.

## PR 2 — act on what the data already shows

Separate from PR 1 on purpose. PR 1 changes *which data arrives*; PR 2 changes
*the code being measured*. Landing them together would make any trend shift
unattributable — normalization or code change. Sequencing them means PR 2's
effect is visible in an already-trustworthy signal. The two touch disjoint
files.

### Two Vosk tests cost two minutes each

```
tts::vosk::tests::synth_short_phrase_produces_audio   2m04s (win) / 1m36s (ubuntu) / 1m16s (macos)
tts::vosk::tests::rejects_out_of_range_speaker        2m04s (win) / 1m36s (ubuntu) / 1m16s (macos)
```

The next slowest Rust test is 24.8s, so these two are a 5× outlier; 55 Rust
tests exceed 1s. Both call `Vosk::load(&dir)` independently
(`rust/src/tts/vosk.rs:96` and `:113`), and nextest runs each test in its own
process, so no in-process fixture can be shared. Merging them into one test
would save roughly one to two minutes per platform per run.

**Prerequisite.** The durations are identical to the second across two
independent processes, which is too exact to be coincidence and suggests the
JUnit converter may be attributing suite-level time. Inspect the raw
`rust-junit-*` CI artifact before optimizing — if the figure is an artifact,
there is no saving to capture and this item is dropped.

### Raise the pid-poll ceiling

`abort terminates the spawned engine process tree` (`tests/unit/engine.test.ts:204`)
runs 31ms–1.0s on macOS, a stable 1.0s on ubuntu, and is skipped on Windows.

The stability on ubuntu is the informative part: it means 1.0s is genuine
process-teardown latency, not poll granularity, so polling faster would achieve
nothing. What is actionable is headroom — `waitForPidFile` allows 80 × 25ms = 2s
against an observed max of ~1s, only 2× margin. A loaded macOS runner could
breach it, and the failure would surface as `timed out waiting for pid file`
rather than a clean assertion failure.

Raise `PID_FILE_POLL_ATTEMPTS` (80) and `PID_EXIT_POLL_ATTEMPTS` (120) in
`tests/helpers/process.ts` to give at least 10× headroom over the observed ~1s
worst case, leaving the 25ms interval alone. The loops exit on the first
successful poll, so a higher ceiling costs nothing when the process exits
promptly — it only widens the margin before a slow runner turns into a failure.

## Out of scope

- Windows/macOS Rust coverage on main (needs a new job; `rust-push-gate` is
  ubuntu-only by design).
- The macOS whole-run duration noise (79.6% of tests moving >25%). It is a
  runner-load property, not a code defect. Fixed environment identity plus main
  history is what makes it measurable; acting on it is separate work.
- Proving the `regressed`-classification hypothesis. Requires a PR with a red
  Rust test.

## Success criteria

- Both PR 1 verification checks pass.
- macOS environment count stops growing on patch-level image bumps.
- Rust tests appear in default-branch queries, giving `flip_rate` and
  `fail_rate` a baseline to compute against.
