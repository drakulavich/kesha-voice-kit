# Mutation evidence — #1088 (`find | head` SIGPIPE race under pipefail)

Three guards in `.github/scripts/check-workflows.ts`, all pinned by `just mutate <file> <find>
<replace> <test…>`, which restores the mutated file in a `finally` and exits 0 only when the
mutation was **caught**. `git status --short` was clean after every row below.

| Guard | Asserts | Where it runs |
|---|---|---|
| `forbidFindPipedToHead` | No `run:` line in a workflow/action YAML pipes `find` into `head`, skipping genuine comment lines | `checkFile`, every `.github/workflows/**` and `.github/actions/**` file |
| `checkFlakeNix` | Same pattern, in `flake.nix`'s `postInstall` — plain text, not YAML, so it runs outside `checkFile` | `main()`, directly against `flake.nix` |
| `requireFlakeNixInWorkflowsFilter` | `ci.yml`'s `workflows` path filter still lists `flake.nix`, or `checkFlakeNix` never runs in CI | `checkFile`, `ci.yml` only |

Three guards because review round 2 found the first two were each real but incompletely wired:
`checkFlakeNix` existed and was correct, but nothing pinned its registration in `main()`: deleting
`...checkFlakeNix(FLAKE_NIX)` or renaming the `FLAKE_NIX` constant both left every test in this
file green, because none of the five direct `checkFlakeNix` tests drives the script through its
own entry point. Separately, `checkFlakeNix` firing at all in CI depends on `ci.yml`'s `workflows`
path filter naming `flake.nix` — with a `find|head` reintroduced, a PR touching only `flake.nix`
ran neither `unit-tests` nor `workflow-lint`, so the guard the ticket's own PR added never fired
on the class of change it exists to police.

Greptile's PR review then found a fourth gap in `forbidFindPipedToHead` itself: it matched each
physical line independently, so a shell command wrapped across two lines with a trailing `\` —
`find ... \` on one line, `| head -1)` on the next — matched neither line's regex and passed clean.
Fixed by joining backslash-continued physical lines into one logical line before matching, keeping
the first physical line's number for the error.

## Mutation proof

| # | File | Mutation | Test | Result |
|---|---|---|---|---|
| 1 | `.github/scripts/check-workflows.ts` | `forbidFindPipedToHead`'s `if (/^\s*#/.test(line)) return;` → `if (false) return;` — the comment-skip branch deleted | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 175 pass, 1 fail (`a commented-out find\|head line is not flagged`) |
| 2 | `.github/scripts/check-workflows.ts` | Same branch → `if (/#/.test(line)) return;` — neutralised to match a trailing comment anywhere on the line, not just a comment-only line | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 175 pass, 1 fail (`a trailing comment after a real find\|head command does not hide it`) |
| 3 | `.github/scripts/check-workflows.ts` | `main()`'s `...checkFlakeNix(FLAKE_NIX),` spread → deleted | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 175 pass, 1 fail (`check:workflows fails end-to-end when flake.nix reintroduces find\|head`) |
| 4 | `.github/scripts/check-workflows.ts` | `const FLAKE_NIX = "flake.nix";` → `"flake.nix.disabled"` — `checkFlakeNix`'s `existsSync` guard then fails open | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 172 pass, 4 fail (the end-to-end test plus three `requireFlakeNixInWorkflowsFilter` tests, which also reference the constant) |
| 5 | `.github/scripts/check-workflows.ts` | `checkFile`'s `...requireFlakeNixInWorkflowsFilter(path, document),` → deleted | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 175 pass, 1 fail (`the file gate actually runs it`) |
| 6 | `.github/scripts/check-workflows.ts` | `requireFlakeNixInWorkflowsFilter`'s `workflows.includes(FLAKE_NIX)` → `true` — the membership check itself neutralised | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 174 pass, 2 fail |
| 7 | `flake.nix` | `-print -quit` reverted to `\| head -1` | `bun run check:workflows` | **PINNED** — exit 1, `flake.nix:175: pipes find into head … (#1088)` |
| 8 | `.github/workflows/ci.yml` | `'flake.nix'` entry removed from the `workflows` path filter | `bun run check:workflows` | **PINNED** — exit 1, `` ci.yml: `workflows` filter must include `flake.nix` … (#1088) `` |
| 9 | `.github/scripts/check-workflows.ts` | `forbidFindPipedToHead`'s `const continued = /\\\s*$/.test(line);` → `const continued = false;` — line-joining disabled, restoring the per-line-only match | `bun test tests/unit/check-workflows.test.ts` | **PINNED** — 177 pass, 1 fail (`catches a backslash-continued pipeline split across two lines`) |

Rows 3–5 are the load-bearing ones for review round 2: each mirrors row 2 of `issue-1105.md`'s
table — a guard whose *definition* is correct and directly tested, but whose *registration* in
`main()` or `checkFile` had no test driving it. Rows 3 and 5 both use an
`the file gate actually runs it`-style probe — row 3 spawns the script as a subprocess
(`Bun.spawn(["bun", ...])` against a temp fixture directory, since `checkFlakeNix`'s registration
lives in `main()` rather than `checkFile`) rather than calling the guard directly, and fail
precisely when the registration line is gone or the constant no longer matches a real path.

Rows 7 and 8 reproduce the actual defect class end to end, independent of the unit-test suite:
row 7 is the SIGPIPE race #1088 opened on, still live in `flake.nix` until this PR; row 8 is
review round 2's second finding, that the guard existed but never ran on the change it was meant
to catch. Row 9 is Greptile's finding on round 2: the matcher itself was structure-insensitive to
line wrapping, not just unwired.
