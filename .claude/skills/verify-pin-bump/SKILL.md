---
name: verify-pin-bump
description: Use when a model SHA-256 mismatch surfaces (download_verified errors, manifest_tests failures, fresh download produces a different hash than rust/src/models.rs pins). Walks through the safe bump procedure — verify the upstream weights deliberately, then update the pin. Refuses to suggest commenting out verification.
---

# verify-pin-bump

Use this skill when you see ANY of:

- `download_verified` error: `expected sha256 ABC, got DEF`
- `cargo test models::manifest_tests` failure
- A user reporting `kesha install` is failing post-update
- A `KESHA_MODEL_MIRROR` swap has produced a hash mismatch (could be legitimate mirror staleness — or an attack)
- Upstream HuggingFace repo shows the model was re-uploaded

## Why this skill exists

CLAUDE.md "MODEL HASHES ARE PINNED" rule:

> Every entry in `rust/src/models.rs` (ASR, lang-id, TTS) carries a pinned SHA-256. `download_verified` refuses to cache a file whose hash doesn't match. This makes `KESHA_MODEL_MIRROR` safe (a compromised mirror can't silently swap weights) and turns an upstream HuggingFace republish into a deliberate decision rather than a silent swap.

The pin exists *because* of incident #174 — a previous regression where verification was disabled "to get it working". Bumping the pin without confirming the new weights are intentional re-introduces that risk.

## Hard NO

- ❌ Do **NOT** comment out `download_verified` to "make it work".
- ❌ Do **NOT** silently update the SHA without checking what changed upstream.
- ❌ Do **NOT** use `KESHA_MODEL_MIRROR=` to bypass — the mirror produces the same hash check.

## Procedure

### Step 1: Identify which pin failed

The error message names the file. Find its `ModelFile` entry in `rust/src/models.rs`:

```bash
grep -n "sha256:" rust/src/models.rs | head -40
# locate the entry whose URL or rel_path matches the failing download
```

### Step 2: Re-download cleanly

Wipe the existing cache for that file (it may be a partial / corrupted download), then re-download:

```bash
rm -f ~/.cache/kesha/models/<subdir>/<file>
KESHA_CACHE_DIR=/tmp/pin-bump ./rust/target/release/kesha-engine install --tts
# or, for a single file, curl directly from the URL in models.rs:
curl -fsSL "<url-from-models.rs>" -o /tmp/pin-bump-file
```

### Step 3: Compute the actual hash

```bash
shasum -a 256 ~/.cache/kesha/models/<subdir>/<file>
# or
shasum -a 256 /tmp/pin-bump-file
```

Compare to:
- The pin in `rust/src/models.rs`
- The HuggingFace UI's reported SHA (open the file URL, click "Copy SHA")

### Step 4: Decide intentional vs incident

Three possible scenarios:

**A. Upstream legitimately re-published.** Verify by checking the HF repo's commit history:

```bash
# the URL in models.rs already points at /resolve/main/<file> — get the latest commit:
curl -sIL "<url>" | grep -i 'x-repo-commit:'
# then inspect the commit:
gh api "repos/<owner>/<repo>/commits/<sha>" --jq '.commit.message'
```

If the commit message says "fix tokenizer" / "re-export with new ONNX opset" / etc — it's a deliberate upstream update. Proceed to Step 5.

**B. Mirror is stale / our HF mirror diverged.** If we maintain the mirror (e.g. `drakulavich/vosk-tts-ru-0.9-multi`), the pin is the source of truth. Re-mirror from upstream and verify SHAs match what we pinned, OR bump the pin if we're moving to a new model version.

**C. Compromised mirror / supply-chain attack.** If the new hash doesn't match either the upstream OR our mirror's expected content — **STOP**. Do NOT update the pin. Investigate. This is the threat model the pin protects against.

### Step 5: Update the pin (only after Step 4 confirms intentional)

Edit `rust/src/models.rs`:

```rust
ModelFile {
    rel_path: "models/<subdir>/<file>",
    url: "https://huggingface.co/.../resolve/main/<file>",
    sha256: "<NEW HASH>",  // bumped <reason> per <upstream commit / mirror version>
},
```

If the bump represents a model version change (not just a re-export), also:
- Update the URL/rel_path if needed (e.g. `<old-version>-multi` → `<new-version>-multi`)
- Bump any related model dir constant
- Update `docs/tts.md` install size table if size changed materially

### Step 6: Verify shape invariants

```bash
cd rust && cargo test models::manifest_tests
```

This catches: hash not 64 hex chars, URL malformed, rel_path duplicate, manifest count off.

### Step 7: Run a clean install end-to-end

```bash
rm -rf /tmp/pin-bump-cache
KESHA_CACHE_DIR=/tmp/pin-bump-cache ./rust/target/release/kesha-engine install --tts
```

Expected: completes with no `expected sha256` errors.

### Step 8: Smoke that the new artifact still works

For TTS bumps:

```bash
KESHA_CACHE_DIR=/tmp/pin-bump-cache ./rust/target/release/kesha-engine say --voice <voice-id> "Привет, мир." > /tmp/pin-bump.wav
afplay /tmp/pin-bump.wav  # listen — does it sound right?
```

For ASR bumps:

```bash
KESHA_CACHE_DIR=/tmp/pin-bump-cache ./rust/target/release/kesha-engine transcribe <fixture.ogg>
# compare to the previous transcript — material drift means quality may have changed
```

For lang-id bumps: run the `lang_id_smoke` test.

### Step 9: Commit

```bash
git add rust/src/models.rs
git commit -m "chore(models): bump <model> SHA pin for <reason>

Upstream commit: <hf-commit-sha>
Old: <old-hash>
New: <new-hash>

Verified intentional re-export; smoke test passes for <voice/lang>.
"
```

### Step 10 (if release-relevant): release-engine

If this bump should ship, invoke `/release-engine vX.Y.Z` for the engine release.

## Output

At the end, print:

```
✅ Pin bumped for <file>
   Old: <old-hash[:16]>...
   New: <new-hash[:16]>...
   Reason: <intentional upstream / our re-mirror / model version change>
   Smoke: <pass/fail>
   Commit: <sha>
```

## Anti-patterns to refuse

If asked to bypass verification, refuse and explain:

> The SHA pin is what makes `KESHA_MODEL_MIRROR` safe and what makes silent upstream swaps impossible. Removing or bypassing verification re-introduces the regression #174 fixed. Run the verify-pin-bump procedure instead — if the new hash represents an intentional upstream change, the pin will be updated *deliberately* (one commit, with the upstream commit referenced) rather than silently.
