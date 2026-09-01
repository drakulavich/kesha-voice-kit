# Mutation evidence — #1145 (`rust-test.yml`'s own `rust/build.rs` code-filter entry was not pinned)

`.github/workflows/rust-test.yml`'s `changes` job carries a curated eight-entry `coreml` filter,
and `rust/build.rs` is one of them. Nothing read that filter: before this ticket the only rule in
`check-workflows.ts` that touched `rust-test.yml` at all was
`requireRustTestCancelsSupersededRuns` (#1105, concurrency). Deleting the entry left
`bun run check:workflows` green.

#1141/#1144 closed the same reach-gap class one workflow over, for `ci.yml`'s `code` filter, and
[`issue-1141.md`](issue-1141.md) closes by naming this entry as deliberately out of its scope.

## The stranded lane is `coreml-regression`, not all of 🧪 Rust Tests

The ticket text says deleting the entry "lets future `rust/build.rs` changes skip the 🧪 Rust Tests
lane". It does not, and the rule's message says so precisely instead. `rust-test.yml`'s `rust`
filter opens with the wildcard `rust/**`, which still matches `rust/build.rs`, so `lint-ubuntu`,
`test` and `coverage` all still fire. What is actually stranded is `coreml-regression` — the only
job gated on `needs.changes.outputs.coreml`, and the only lane that *links and runs* the `coreml`
feature. The per-PR `macos-14` lane stops at `cargo check --features coreml` and rides the `rust`
filter.

That is exactly the surface CLAUDE.md's COREML BUILD TRIPLE condition 3 describes: `rust/build.rs`
emits `-Wl,-rpath,/usr/lib/swift` under `cfg(any(coreml, system_kokoro, system_diarize))`. An edit
breaking that emit is a link-time failure, and without the filter entry no lane that links `coreml`
would run on it. If a future edit narrows the `rust` filter off `rust/**`, the ticket's wider claim
becomes true and this message should widen with it.

## Only `rust/build.rs` is pinned, not the other seven entries

`rust/build.rs` is the one entry in that list whose presence follows from a written repo invariant
rather than from curation. The rest — `rust/src/backend/fluidaudio.rs`, `rust/src/fluid_stdout.rs`,
`rust/src/transcribe/diarize.rs`, `rust/Cargo.toml`, `rust/Cargo.lock`, the benchmark fixture and
the workflow itself — are a judgment call about what constitutes the CoreML regression surface,
recorded in the comments above the list. Pinning them would freeze that judgment and red every
legitimate re-curation. There is no derivable set behind the
`coreml` filter the way `collectRustSources` backs the #950/#1132 rules, so this is a
named-constant membership rule, not a collector-driven one — and with a compile-time constant as
its target it needs no `length === 0` vacuous-pass branch, unlike its three collector-driven
siblings.

Coverage is probed with the shared `coveredBy` helper rather than matched literally, for
`issue-1141.md`'s reason: a literal `.includes()` would reject a legitimate broadening of the
filter to `rust/**` as a regression. Row 4 below is the mutation that distinguishes the two shapes;
the `a narrowing that misses the build script is caught` case covers the other direction, a
`rust/src/**` narrowing that neither shape may let through.

| Guard | Asserts | Where it runs |
|---|---|---|
| `namedFilterOf(path, document, name)` | The named list from a `changes` job's inline paths-filter, or the caller's verbatim error | Five rules across `ci.yml` and `rust-test.yml` |
| `requireBuildScriptInCoremlFilter` | Some path in `rust-test.yml`'s `coreml` filter covers `rust/build.rs` | `checkFile`, `rust-test.yml` only |

`codeFilterOf` became `namedFilterOf` rather than gaining a sibling: #1144's round-1 P3 noted the
parser preamble was four verbatim copies, and it was actually five —
`requireFlakeNixInWorkflowsFilter` kept a private copy because it reads `workflows`, not `code`,
with two error strings byte-identical to the shared parser's. Generalising over the filter name
folds that fifth copy in and serves the new rule at the same time. Keeping `codeFilterOf` as a
wrapper would have been the "exists for later" surface CLAUDE.md's NO SPECULATIVE FIELDS rule
targets.

## Mutation proof

Every row ran through `just mutate <file> <find> <replace> <test…>`, which restores the mutated
file in a `finally` and exits 0 only when the mutation was **caught**. `git status --short` was
clean after every row. `rust/build.rs` occurs exactly once in `rust-test.yml` and carries no
adjacent comment naming it, so the bare `- 'rust/build.rs'` form is unambiguous — unlike
`issue-1141.md` rows 1–2, where `ci.yml` carried the string twice.

| # | File | Mutation | Test | Result |
|---|---|---|---|---|
| 1 | `.github/workflows/rust-test.yml` | `- 'rust/build.rs'` entry deleted from the `coreml` filter | `bun run check:workflows` | **PINNED** — exit 1, 1 check failed: `` rust-test.yml: no path in the `coreml` filter matches rust/build.rs … (#1145) `` |
| 2 | `.github/workflows/rust-test.yml` | `- 'rust/build.rs'` → `- 'rust/build.rs.bak'` — a typo rather than a deletion | `bun run check:workflows` | **PINNED** — exit 1, 1 check failed |
| 3 | `.github/scripts/check-workflows.ts` | rule body short-circuited to `return [];` | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 247 pass, 5 fail (the four negative cases plus `the file gate actually runs it`) |
| 4 | `.github/scripts/check-workflows.ts` | `coveredBy(filter.entries, RUST_BUILD_SCRIPT)` → `filter.entries.includes(RUST_BUILD_SCRIPT)` | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 251 pass, 1 fail (`a broader rust wildcard satisfies the rule`) |
| 5 | `.github/scripts/check-workflows.ts` | `if (!path.endsWith("rust-test.yml")) return [];` deleted | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 251 pass, 1 fail (`ignores every other workflow`) |
| 6 | `.github/scripts/check-workflows.ts` | `checkFile`'s `...requireBuildScriptInCoremlFilter(path, document),` spread deleted | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 251 pass, 1 fail (`the file gate actually runs it`) |
| 7 | `.github/scripts/check-workflows.ts` | `namedFilterOf`'s `?.[name]` → `?.code` — the generalisation reverted | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 241 pass, 11 fail |
| 8 | `.github/scripts/check-workflows.ts` | the missing-list message's `${name}` → `code` | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 248 pass, 4 fail (`names the list it was asked for, not code` plus the three cases asserting a non-`code` list by name) |
| 9 | `.github/scripts/check-workflows.ts` | the missing-list branch → `return { entries: [] }` — the shared parser fails open | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 243 pass, 9 fail (all five rows of the parameterised block plus four direct cases) |
| 10 | `.github/scripts/check-workflows.ts` | `requireFlakeNixInWorkflowsFilter`'s `namedFilterOf(…, "workflows")` → `"code"` | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 246 pass, 6 fail |

Rows 1 and 2 reproduce the defect end to end, independent of the unit suite: both were **green**
before this PR. Row 6 is the registration row `issue-1088.md` rows 3–5, `issue-1105.md` row 2 and
`issue-1141.md` row 4 exist to cover — a rule that is correct and directly tested but never wired
into `checkFile`. Rows 7–10 are the generalisation's own rows: row 7 is the revert, row 10 is the
caller passing the wrong list name, and both would otherwise be silent because every caller but the
new one asks for `code`.

## Deliberately out of scope

- The other seven entries in the `coreml` filter, and the `rust` filter's own entries. Both lists
  are unpinned by the same argument as above.
- `.github/workflows/rust-test.yml` is not edited by this PR. The entry already exists and is
  already correct; the ticket adds the guard, not the entry.
- **An adjacent gap of the same class, found while mapping and not fixed here:** `ci.yml`'s `code`
  filter does not list `.github/workflows/rust-test.yml`, yet `tests/unit/lane-exclusive-tests.test.ts`
  parses that file's nextest `-E` expression. A `rust-test.yml`-only edit therefore skips
  `unit-tests` and never runs that suite. It does not block this ticket — the new rule runs in
  `workflow-lint`, which *is* gated on `.github/workflows/**` — and the fix widens which jobs run
  on every workflow PR, so it is left for its own ticket.
