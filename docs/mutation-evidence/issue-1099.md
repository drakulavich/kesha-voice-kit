# Mutation evidence — #1099 (silero-vad manifest URL pinned to an immutable commit)

## The guard

`tests/unit/check-model-plan-sizes.test.ts`, inside `describe("parseManifestUrls", …)`:

```ts
test("the silero-vad manifest URL pins a 40-hex commit, not the movable v6.2.1 tag", () => {
  const vad = realManifestEntries().find(
    (entry) => entry.relPath === "models/silero-vad/silero_vad.onnx",
  );
  const ref = vad?.url.split("/raw/")[1]?.split("/")[0] ?? "";
  expect(/^[0-9a-f]{40}$/.test(ref)).toBe(true);
});
```

One assertion, scoped to the single `VAD_FILES` entry in `rust/src/models.rs`, read through
`parseManifestEntries` the same way `no Hugging Face manifest URL resolves through a mutable
ref` (same describe block) reads every other manifest entry. Runs in the `unit-tests` job of
the `🧪 CI` workflow whenever `ci.yml`'s `code` path filter matches — not on every PR
unconditionally, since `unit-tests` is gated `if: needs.changes.outputs.code == 'true'`. For
this diff specifically that filter always matches: `rust/src/models.rs` is one of its listed
paths, so an edit to it always triggers the job.

No matching Rust-side test exists or was added, and here the reach comparison runs the other
way from what an earlier draft of this file claimed: `VAD_FILES` carries no `#[cfg(...)]`
gate, so a Rust test would see the same one entry, but the TS `code` filter also matches
`tests/**` and `model-plan.json` changes that touch neither `rust/src/models.rs` nor anything
the Rust gate's own path filter watches — a test-only edit to this very file, for instance,
re-runs the TS assertion without ever triggering a Rust nextest run. The TS test's trigger set
is a superset of what a hypothetical Rust duplicate would add, not merely equal to it, so the
duplicate would still add no reach the TS test doesn't already have. (Contrast the
Hugging-Face guards, which keep both a Rust and a TS version because the TS one's reach
genuinely exceeds the Rust one in a different way — it sees `system_kokoro`-gated manifests no
CI lane ever compiles as tests.)

## Observed red before the fix

Captured before `rust/src/models.rs`'s `VAD_FILES` URL was touched, against the tag-pinned
source (`raw/v6.2.1/…`):

```
$ bun test tests/unit/check-model-plan-sizes.test.ts -t "silero-vad manifest URL"
bun test v1.3.13 (bf2e2cec)

tests/unit/check-model-plan-sizes.test.ts:
153 |   test("the silero-vad manifest URL pins a 40-hex commit, not the movable v6.2.1 tag", () => {
154 |     const vad = realManifestEntries().find(
155 |       (entry) => entry.relPath === "models/silero-vad/silero_vad.onnx",
156 |     );
157 |     const ref = vad?.url.split("/raw/")[1]?.split("/")[0] ?? "";
158 |     expect(/^[0-9a-f]{40}$/.test(ref)).toBe(true);
                                             ^
error: expect(received).toBe(expected)

Expected: true
Received: false

      at <anonymous> (tests/unit/check-model-plan-sizes.test.ts:158:40)
(fail) parseManifestUrls > the silero-vad manifest URL pins a 40-hex commit, not the movable v6.2.1 tag [8.12ms]

 0 pass
 22 filtered out
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [52.00ms]
```

`ref` evaluates to `"v6.2.1"` — a 6-character tag, not 40 hex — so the regex is `false` and
`expect(false).toBe(true)` fails. Turned green by pinning the URL's `/raw/` segment to
`7e30209a3e901f9842f81b225f3e93d8199902b1` (the tag's resolved commit, verified below), with
no other line in the test file changed.

## Verifying the resolved commit before pinning

Per "VERIFY THIRD-PARTY MODEL FORMATS WITH A SPIKE," run in a throwaway `/tmp/` directory,
deleted after:

```
$ git ls-remote https://github.com/snakers4/silero-vad.git refs/tags/v6.2.1
7e30209a3e901f9842f81b225f3e93d8199902b1  refs/tags/v6.2.1
```

One line, no `^{}` peel entry — a lightweight tag, so that hash is the commit itself.

```
$ curl -sSL https://github.com/snakers4/silero-vad/raw/7e30209a3e901f9842f81b225f3e93d8199902b1/src/silero_vad/data/silero_vad.onnx | shasum -a 256
1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3  (2327524 bytes)
```

Matches the pin already in `rust/src/models.rs` (`sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3"`)
and the size already recorded in `model-plan.json` (`"vad": [{ "relPath":
"models/silero-vad/silero_vad.onnx", "sizeBytes": 2327524 }]`) exactly — re-verified at the
target revision, not assumed, and neither value needed to change.

## Mutation proof

Every row: `just mutate rust/src/models.rs <find> <replace> bun test
tests/unit/check-model-plan-sizes.test.ts -t "silero-vad manifest URL"`, restored in a
`finally` regardless of outcome; every restore was confirmed with a clean `git status
--short` afterward.

| # | Mutation | What it removes | Occurrences | Result |
|---|---|---|---|---|
| 1 (delete) | Revert the pinned URL's ref segment from the commit back to `v6.2.1` | The property "resolves through a 40-hex commit" is fully absent, reproducing the real pre-fix red above | 1 | **PINNED** — `ref` is `"v6.2.1"` |
| 2 (present, not satisfying) | Same 40 characters, same length, uppercased (`7E30209A3E901F9842F81B225F3E93D8199902B1`) | The shape of a commit SHA, wrong case — the regex is lowercase-only | 1 | **PINNED** |
| 3 (present, not satisfying) | Drop the `raw/` path segment entirely, so `.split("/raw/")[1]` is `undefined` and `ref` falls back to `""` | The empty-segment edge case #1096 review round 2 found missing from the Hugging-Face guard's first draft | 1 | **PINNED** — fails on the empty-string fallback, not a crash |
| 4 (present, not satisfying — **survives**) | Same 40 characters, same length, all zeroes (`0000…0000`) — a lowercase-hex string that is not a real commit | Nothing: the regex only checks shape, so a lowercase 40-hex string that names no actual commit is indistinguishable from one that does | 1 | **NOT PINNED** — `just mutate` exits 1; the mutated URL 404s at install time but the assertion passes |
| control | None — the real, correctly-pinned commit SHA, untouched | — | — | **passes** (`1 pass / 0 fail`) |

Row 3 is not a second assertion — it is the same regex-match assertion exercised through the
parser's failure path (`?? ""`), which is the residual the Hugging-Face guard's own history
(`docs/mutation-evidence/issue-1093.md`, rows 4/7/9) flags as worth checking explicitly
rather than trusting the optional-chaining fallback not to throw or to silently pass.

Rows 1 and 3 are the two ways the actual defect class in #1099 could resurface — the tag
moved back, or a future edit to the URL's structure slips past the `/raw/` marker the
assertion depends on. Row 2 is not a defect this ticket names, but the same shape-vs-content
distinction the sibling Hugging-Face guard's mutation table already tests for its own regex,
so it was run here rather than assumed to hold by symmetry.

**Row 4 is a stated boundary, not a bug to fix.** The assertion proves the ref is
lowercase-40-hex-shaped; it does not and cannot prove the ref names a commit that exists,
because that would require a network call from an offline, deterministic unit-test lane. This
is not a gap unique to this guard: the sibling Hugging-Face predicate accepted at #1096
(`assert_pins_immutable_revision`, and its TS twin) carries the identical residual — a
`/resolve/<40 hex that resolves to nothing>/` URL passes both of them too. A commit-existence
check was considered and rejected for the reason above; the honest claim for this guard is
"pins a lowercase-40-hex ref," not "pins a commit that is verified to exist" — the latter is
established once, by hand, at pin time (§"Verifying the resolved commit before pinning"
above), not on every CI run.
