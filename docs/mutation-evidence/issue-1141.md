# Mutation evidence — #1141 (`rust/build.rs` and `rust/tests/**` code-filter entries were not pinned)

`.github/workflows/ci.yml`'s `changes` job carries three Rust entries in its `code` filter. #1132
widened the first from `rust/src/models/**` to `rust/src/**` and pinned that widening through a
collector (`collectRustSources`) plus a rule (`requireRustSourcesInCodeFilter`). The other two —
`rust/build.rs` and `rust/tests/**` — landed in #1134, #1132's review fix pass, with a justifying
comment but no guard: deleting either left `bun run check:workflows` green and no test in the repo
mentioned the strings. Review round 1 on PR #1140 found this and ruled it out of that
PR's scope.

The gap matters because those entries are what routes a rename under `rust/tests/` or an edit to
`rust/build.rs` into the 🧪 CI `unit-tests` lane, where
`tests/unit/rust-cross-references.test.ts` runs. Its `resolveFile` accepts any `rust/…` path as a
reference target, so a stale pointer into `rust/build.rs` or `rust/tests/*.rs` is exactly what that
suite exists to catch — and without the filter entries it would never run on the change that broke
it.

| Guard | Asserts | Where it runs |
|---|---|---|
| `collectRustReferenceTargets` | Every `.rs` under `rust/`, from the crate root `main()` actually uses | `collectRuleSources`, called by `main()` with no arguments |
| `requireRustReferenceTargetsInCodeFilter` | Every one of those targets is covered by some path in ci.yml's `code` filter, and an empty target list fails rather than passing vacuously | `checkFile`, `ci.yml` only |

It is a sibling rule, not an extension of `requireRustSourcesInCodeFilter`, because the
justification differs. Every `.rs` reference in `src/**` points inside `rust/src/`, so no TS suite
reads `rust/build.rs`, `rust/tests/*.rs` or `rust/vendor/**` today; the existing rule's "is read by
a TS suite" wording would have been false. The new message says *legal cross-reference target*
instead.

The rule probes coverage with the shared `coveredBy` helper rather than matching the literal
strings `- 'rust/build.rs'` / `- 'rust/tests/**'`. A literal match (the shape
`requireFlakeNixInWorkflowsFilter` uses) would reject a legitimate broadening to `rust/**` as a
regression; the probe accepts it, still fails on deletion, and names the specific files a narrowing
strands. Row 3 below is the row that distinguishes the two shapes.

## Review round 1

Three findings changed the shape above, and one landed next door.

**The collector enumerates the tree instead of naming two roots.** `resolveFile` returns any
`rust/…` path unchanged, so the guarded set is every `.rs` under `rust/` — not just `build.rs` and
`tests/`. The first cut left `rust/vendor/vosk-tts/src/*.rs` (six tracked files) unguarded and
uncovered by ci.yml, and a future `rust/benches` or `rust/examples` would have reopened the exact
gap #1141 closed. The collector is now `collectRustSources("rust")`, and ci.yml's `code` filter
gains `rust/vendor/**` so the widened set is actually covered. That entry is the only change this
PR makes to ci.yml, and row 7 pins it.

**`coveredBy` read a dorny negation as coverage.** `["rust/tests/**", "!rust/tests/model_gate.rs"]`
reported `model_gate.rs` covered, while dorny would exclude it and the unit-tests lane would not
fire — the same silent skip the rule exists to prevent. A `!` entry that matches now means *not*
covered. Pre-existing helper, shared by all four filter rules; row 8 pins it.

**The filter-parsing preamble was a fourth verbatim copy.** `codeFilterOf(path, document)` now
returns either the `code` list or the error the caller returns verbatim, and the four rules share
it. The two duplicated per-rule test pairs collapse into one parameterised block asserting every
rule surfaces the shared parser's errors; row 9 pins that propagation.

## Mutation proof

Every row ran through `just mutate <file> <find> <replace> <test…>`, which restores the mutated
file in a `finally` and exits 0 only when the mutation was **caught**. `git status --short` was
clean after every row. Rows 1 and 2 use the `- '…'` form of the find string on purpose: the bare
text `rust/build.rs` occurs twice in ci.yml, once in the justifying comment above the entry.

| # | File | Mutation | Test | Result |
|---|---|---|---|---|
| 1 | `.github/workflows/ci.yml` | `- 'rust/build.rs'` entry deleted from the `code` filter | `bun run check:workflows` | **PINNED** — exit 1, 1 check failed: `` ci.yml: rust/build.rs is a legal rust/… cross-reference target … (#1141) `` |
| 2 | `.github/workflows/ci.yml` | `- 'rust/tests/**'` entry deleted from the `code` filter | `bun run check:workflows` | **PINNED** — exit 1, 21 checks failed, one per `.rs` under `rust/tests` |
| 3 | `.github/workflows/ci.yml` | `- 'rust/tests/**'` → `- 'rust/tests/common/**'` — a plausible narrowing rather than a deletion | `bun run check:workflows` | **PINNED** — exit 1, 20 checks failed; `rust/tests/common/mod.rs` is correctly absent, the other 20 are named |
| 4 | `.github/scripts/check-workflows.ts` | `checkFile`'s `...requireRustReferenceTargetsInCodeFilter(path, document, sources.referenceTargets),` spread → deleted | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 239 pass, 1 fail (`the file gate actually runs all three`) |
| 5 | `.github/scripts/check-workflows.ts` | `collectRustReferenceTargets(crateRoot = "rust")` → `crateRoot = "rust/src"` — the default `main()` uses, silently narrowed | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 238 pass, 2 fail (`the production default crate root is rust`, `collectRuleSources fills all three sets from their own roots`) |
| 6 | `.github/scripts/check-workflows.ts` | `if (referenceTargets.length === 0) {` → `if (false) {` — the vacuous-pass guard neutralised | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 239 pass, 1 fail (`an empty target list fails loudly instead of passing vacuously`) |
| 7 | `.github/workflows/ci.yml` | `- 'rust/vendor/**'` entry deleted — round 1's first finding | `bun run check:workflows` | **PINNED** — exit 1, 6 checks failed, one per `.rs` under `rust/vendor/vosk-tts/src` |
| 8 | `.github/scripts/check-workflows.ts` | `coveredBy`'s negation line deleted, restoring "a `!` entry counts as coverage" | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 239 pass, 1 fail (`a negation entry excluding a target is not coverage`) |
| 9 | `.github/scripts/check-workflows.ts` | `codeFilterOf`'s missing-`code` branch → `return { code: [] }` — the shared parser fails open | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 235 pass, 5 fail (all four rules' propagation cases plus `codeFilterOf` itself) |
| 10 | `tests/unit/rust-cross-references.test.ts` | `refs.filter(flagged)` → `refs.filter(() => false)` — round 1's P2, the neutralisation that used to survive at 16 pass / 0 fail | `bun test tests/unit/rust-cross-references.test.ts` | **PINNED** — 22 pass, 1 fail (`the report names the origin and label of every flagged reference and nothing else`) |
| 11 | `tests/unit/rust-cross-references.test.ts` | `isDangling` → `() => false` | `bun test tests/unit/rust-cross-references.test.ts` | **PINNED** — 20 pass, 3 fail |
| 12 | `tests/unit/rust-cross-references.test.ts` | `isMissingSymbol`'s body → `false` | `bun test tests/unit/rust-cross-references.test.ts` | **PINNED** — 22 pass, 1 fail (`a symbol the named file does not declare is missing`) |

Rows 1–3 and 7 reproduce the defect class end to end, independent of the unit suite: each was
green before this PR. Rows 4–6 are the registration-and-default rows that
`issue-1088.md` rows 3–5 and `issue-1105.md` row 2 exist to cover — a rule whose definition is
correct and directly tested, but whose wiring into `checkFile` or whose production default has
nothing driving it. Row 5 is #1132 round 3's specific lesson: there, every test passed an explicit
root, so the default the script actually runs with went unpinned.

Rows 10–12 close review round 1's P2, which is next door in
`tests/unit/rust-cross-references.test.ts`: the two suite-level reports asserted the real tree is
clean, and the real tree *is* clean, so neutralising either filter changed nothing anyone could
observe. Extracting `isDangling`, `isMissingSymbol` and `report`, then driving them from synthetic
references, makes the predicates and the filtering itself fail on mutation.

## Deliberately out of scope

`.github/workflows/rust-test.yml` lists `rust/build.rs` in its own paths filter too, and that entry
is also unpinned. It gates the 🧪 Rust Tests lane rather than the 🧪 CI `unit-tests` lane this
ticket names, for a different reason, so it is left alone.
