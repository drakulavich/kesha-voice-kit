# Mutation evidence — #1105 item 3 (`nix-build` redding `main` from inside the CI aggregator)

One guard, `forbidNixBuildInCiAggregator` in `.github/scripts/check-workflows.ts`. It asserts
that `jobs.ci.needs` in `ci.yml` does not contain `nix-build` — a job gated on
`github.event_name == 'push'` cannot report on a pull request, yet a failed **or cancelled**
run reds the required `🧪 CI` check on `main` (`ci.yml:984`), which is what happened at
`394e013a`.

| Guard | File | Test | Where it runs | Reach |
|---|---|---|---|---|
| TS | `.github/scripts/check-workflows.ts` | `forbidNixBuildInCiAggregator > passes on the real ci.yml` (+3 siblings) | `🧪 CI` → `unit-tests` (every PR, plain `bun test` over `tests/unit/`), and `bun run check:workflows` inside `just preflight` | The one instance. It pins `nix-build` returning to the aggregator; it does **not** catch the nix job returning under a different name, nor any other push-only job being added. |

That reach limit is deliberate, not an oversight — see the doc comment on the function and the
PR body. A general "no push-only job in the aggregator" matcher's own failure mode is an
over-fire, and `check:workflows` runs inside `preflight`, so over-firing would block every push
until someone deleted the guard.

## Mutation proof

Both rows: `just mutate <file> <find> <replace> <test…>`, which restores the file in a `finally`
and exits 0 only when the mutation was **caught**. `git status --short` was clean after each.

Two rows rather than one because there are two ways to lose this guard — breaking what it
matches, and unwiring it from `checkFile` so it never runs at all. The second is the one every
directly-called test survives.

| # | File | Mutation | Test | Result |
|---|---|---|---|---|
| 1 | `.github/scripts/check-workflows.ts` | `"nix-build"` → `"nix-buildx"` — the job-name comparison matches nothing | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 142 pass, 2 fail |
| 2 | `.github/scripts/check-workflows.ts` | `"...forbidNixBuildInCiAggregator(path, document),"` → `""` — the guard is deleted from `checkFile`'s list while its definition and every direct test stay intact | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 143 pass, 1 fail, and the single failure is `forbidNixBuildInCiAggregator > the file gate actually runs it` |

Row 2 is the load-bearing one. Without `test("the file gate actually runs it")` — which asserts
through `checkFile(path, [], [], undefined)` rather than calling the guard directly — deleting
the registration line leaves every other test green while `bun run check:workflows` silently
stops checking. That test exists because of this mutation, not the other way round.

**Why that test filters on `"nix-build"` and not on `#1105`.** Three of the four existing
`the file gate actually runs it` tests (`check-workflows.test.ts:638`, `:858`, `:897`) already
filter on `#1105`, and `requireJobTimeouts` — which cites `#1105` — has no path guard and
interpolates the job name into its message (`check-workflows.ts:499-501`). A fourth `#1105`
filter would have counted unrelated errors. For the same reason the probe's jobs carry **no
`steps:` array**: `check-workflows.ts:497` skips jobs without one, which keeps
`requireJobTimeouts` (and `requirePipefailShell`, `requireBashOnWindowsRunSteps`,
`requireDepsBeforeBunTest`, `requireReusableCallPermissions` — the rest of the checks that
interpolate a job name) silent, so `toHaveLength(1)` counts only this guard's error. The probe
also uses `on: push` rather than `on: pull_request`, which keeps
`requireConcurrencyOnPullRequestWorkflows` quiet.

## The flake fix has no mutation row, deliberately

`flake.nix`'s `fetchurl` override is the other half of this PR and it is **not** in the table
above. A check asserting that `flake.nix` contains a `--user-agent` string would pin the
implementation rather than a contract a user can observe — the class retired by the #161 audit
in #163.

Its guard is the `❄️ Nix Build` job itself: remove the override and the next run goes red on
the same crates.io 403. That is slow, but it is a real guard rather than a restatement of the
diff, and it fired correctly on this PR — red on the 403 before the override, green after, on
both `ubuntu-latest` and `macos-14` (run
[`33198751156`](https://github.com/drakulavich/kesha-voice-kit/actions/runs/33198751156):
0 occurrences of `error: 403`, 244 successful `crates.io` fetches, smoke `kesha-engine 1.24.11`).
