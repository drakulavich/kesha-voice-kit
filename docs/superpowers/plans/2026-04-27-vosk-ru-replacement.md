# Replace Piper-ru with vosk-tts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Russian Piper TTS engine with `vosk-tts-rs`, drop the espeak-ng system dep and the CharsiuG2P fallback in the same PR.

**Architecture:** Add a new `tts::vosk` module wrapping `vosk_tts::Synth`; replace `ResolvedVoice::Piper`/`EngineChoice::Piper` with `Vosk` equivalents; route `ru-vosk-m02` (default) through it. Delete `piper.rs`, `g2p_espeak.rs`, CharsiuG2P internals of `g2p.rs`, related manifests, and CI/docs scaffolding for them.

**Tech Stack:** Rust 1.78+, `vosk-tts-rs = 0.1.0` (ONNX Runtime via `ort 2.0.0-rc.12`), `bun` for the TS CLI, GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-04-27-vosk-ru-replacement-design.md`

**Branch:** `fix/piper-ru-espeak-passthrough` → rename to `fix/replace-piper-with-vosk-ru` at end (preserves PR #210 thread).

---

## Phase 0: Pre-flight

### Task 0.1: Verify spec model URLs are reachable

**Files:** none

- [ ] **Step 1: HEAD-check each manifest URL**

```bash
for f in model.onnx dictionary config.json bert/model.onnx bert/vocab.txt README.md; do
  printf "%-22s " "$f"
  curl -sIL "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main/$f" \
    | grep -i '^content-length' | tail -1
done
```

Expected: each prints a `Content-Length` matching the spec table (179 MB / 101 MB / 2.4 KB / 654 MB / 1.8 MB / 1.2 KB).

If anything is missing or 404s, STOP and re-mirror before continuing.

### Task 0.2: Rename feature branch

**Files:** none

- [ ] **Step 1: Rename branch + update tracking**

```bash
git checkout fix/piper-ru-espeak-passthrough
git branch -m fix/replace-piper-with-vosk-ru
git push origin -u fix/replace-piper-with-vosk-ru
git push origin --delete fix/piper-ru-espeak-passthrough
gh pr edit 210 --title "feat(tts): replace Piper-ru with vosk-tts (closes #210)"
```

Expected: PR #210 still open, head ref now `fix/replace-piper-with-vosk-ru`.

---

## Phase 1: Add vosk-tts engine (commit 1)

### Task 1.1: Spike vosk-tts-rs binary size delta

**Files:** `rust/Cargo.toml`

- [ ] **Step 1: cargo add vosk-tts-rs**

```bash
cd rust && cargo add vosk-tts-rs@0.1.0
```

- [ ] **Step 2: Build release with current default features and capture size**

```bash
cargo build --release --no-default-features --features onnx,tts 2>&1 | tail -5
ls -lh target/release/kesha-engine
```

Record the size in your scratch notes. Compare against `git stash && cargo build --release --no-default-features --features onnx,tts && ls -lh target/release/kesha-engine && git stash pop`.

- [ ] **Step 3: Decide vendor vs accept**

If delta ≤ 20 MB → accept, continue.
If delta 20-50 MB → still accept but file a follow-up issue: "feature-gate vosk-tts-rs server/cli modules upstream".
If delta ≥ 50 MB → STOP. Vendor `model.rs`+`synth.rs`+`g2p.rs` from `github.com/andreytkachenko/vosk-tts-rs` into `rust/vendor/vosk-tts/` and depend on the local path instead. Document in spec under risk #1.

- [ ] **Step 4: Commit Cargo.toml + Cargo.lock**

```bash
git add rust/Cargo.toml rust/Cargo.lock
git commit -m "chore(deps): add vosk-tts-rs =0.1.0 for Russian TTS"
```

### Task 1.2: Add `vosk_ru_manifest()` to `rust/src/models.rs`

**Files:**
- Modify: `rust/src/models.rs` (add new function next to `piper_ru_manifest`, do NOT delete piper yet)

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `rust/src/models.rs`:

```rust
#[test]
fn vosk_ru_manifest_has_expected_files() {
    let m = vosk_ru_manifest();
    assert_eq!(m.len(), 6);
    let names: std::collections::HashSet<&str> =
        m.iter().map(|f| f.relative_path).collect();
    for f in [
        "models/vosk-ru/model.onnx",
        "models/vosk-ru/dictionary",
        "models/vosk-ru/config.json",
        "models/vosk-ru/bert/model.onnx",
        "models/vosk-ru/bert/vocab.txt",
        "models/vosk-ru/README.md",
    ] {
        assert!(names.contains(f), "missing {f}");
    }
    for f in &m {
        assert!(f.sha256.len() == 64, "sha256 must be 64 hex chars");
        assert!(f.url.starts_with("https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main/"));
    }
}
```

- [ ] **Step 2: Run test to confirm failure**

```bash
cd rust && cargo test --no-default-features --features onnx,tts vosk_ru_manifest_has_expected_files
```

Expected: FAIL `cannot find function vosk_ru_manifest`.

- [ ] **Step 3: Add the function**

Insert above `pub fn g2p_onnx_manifest()` (around line 130):

```rust
pub fn vosk_ru_manifest() -> Vec<ModelFile> {
    let base = "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main";
    vec![
        ModelFile {
            url: format!("{base}/model.onnx"),
            relative_path: "models/vosk-ru/model.onnx",
            sha256: "0fa5a36b22a8bf7fe7179a3882c6371d2c01e5317019e717516f892d329c24b9",
        },
        ModelFile {
            url: format!("{base}/dictionary"),
            relative_path: "models/vosk-ru/dictionary",
            sha256: "2939e72c170bb41ac8e256828cca1c5fac4db1e36717f9f53fde843b00a220ba",
        },
        ModelFile {
            url: format!("{base}/config.json"),
            relative_path: "models/vosk-ru/config.json",
            sha256: "e155fb266a730e1858a2420442b465acf08a3236dffad7d1a507bf155b213d50",
        },
        ModelFile {
            url: format!("{base}/bert/model.onnx"),
            relative_path: "models/vosk-ru/bert/model.onnx",
            sha256: "2e2f1740eaae5e29c2b4844625cbb01ff644b2b5fb0560bd34374c35d8a092c1",
        },
        ModelFile {
            url: format!("{base}/bert/vocab.txt"),
            relative_path: "models/vosk-ru/bert/vocab.txt",
            sha256: "bbe5063cc3d7a314effd90e9c5099cf493b81f2b9552c155264e16eeab074237",
        },
        ModelFile {
            url: format!("{base}/README.md"),
            relative_path: "models/vosk-ru/README.md",
            sha256: "e9db06085c65064c6f8e5220a85070f14fdf47bb8018d0b5c07cc0218cbb5a41",
        },
    ]
}
```

NOTE: if `ModelFile::url` is `&'static str` rather than `String` the existing manifests use, look at `kokoro_manifest()` shape and match it (likely const concatenation via `concat!`). Do not change the type.

- [ ] **Step 4: Run test, confirm pass**

```bash
cargo test --no-default-features --features onnx,tts vosk_ru_manifest_has_expected_files
```

Expected: PASS.

- [ ] **Step 5: Add a vosk cache helper**

Below `is_g2p_cached`, add:

```rust
pub fn vosk_ru_model_dir() -> String {
    format!("{}/models/vosk-ru", crate::cache::cache_dir())
}

pub fn is_vosk_ru_cached(cache_dir: &str) -> bool {
    let base = std::path::Path::new(cache_dir);
    base.join("model.onnx").exists()
        && base.join("dictionary").exists()
        && base.join("bert/model.onnx").exists()
}
```

(Match the existing helper conventions for kokoro/piper — patterns are visible at the top of `models.rs`.)

- [ ] **Step 6: Wire into `manifest_for_features()`**

Find the existing line `manifest.extend(piper_ru_manifest());` and add directly below:

```rust
manifest.extend(vosk_ru_manifest());
```

(Piper still installs alongside until Phase 2 deletes it — installs are additive during the transition.)

- [ ] **Step 7: cargo test passes**

```bash
cargo test --no-default-features --features onnx,tts models::
```

Expected: PASS (including the existing `manifest_for_features_includes_*` tests).

- [ ] **Step 8: Commit**

```bash
git add rust/src/models.rs
git commit -m "feat(tts): add vosk-tts-ru-0.9-multi manifest"
```

### Task 1.3: Create `rust/src/tts/vosk.rs`

**Files:**
- Create: `rust/src/tts/vosk.rs`

- [ ] **Step 1: Write the failing test**

Create `rust/src/tts/vosk.rs` with the test first:

```rust
//! Thin wrapper around `vosk_tts::Synth` for Russian synthesis.
//!
//! Vosk-TTS handles text normalization, BERT-prosody, and G2P internally;
//! callers pass plain Russian text and a numeric speaker_id (0..=4 for the
//! 5 voices in vosk-model-tts-ru-0.9-multi).

use anyhow::{Context, Result};
use std::path::Path;

pub const SAMPLE_RATE: u32 = 22_050;
pub const SPEAKER_COUNT: u32 = 5;

pub struct Vosk {
    inner: vosk_tts::Synth,
}

impl Vosk {
    /// Load all model artifacts from `model_dir`. Expects:
    /// `model.onnx`, `dictionary`, `config.json`, `bert/model.onnx`, `bert/vocab.txt`.
    pub fn load(model_dir: &Path) -> Result<Self> {
        let inner = vosk_tts::Synth::new(model_dir)
            .with_context(|| format!("loading vosk model from {}", model_dir.display()))?;
        Ok(Self { inner })
    }

    /// Synthesize `text` with the given speaker id, returning interleaved f32 mono samples.
    /// `rate` is reserved for future use (vosk-tts-rs 0.1.0 has no rate parameter); pass 1.0.
    pub fn infer(&mut self, text: &str, speaker_id: u32, _rate: f32) -> Result<Vec<f32>> {
        if speaker_id >= SPEAKER_COUNT {
            anyhow::bail!("vosk speaker_id must be 0..{} (got {speaker_id})", SPEAKER_COUNT);
        }
        let pcm = self
            .inner
            .synth(text, speaker_id)
            .with_context(|| format!("vosk synth failed for {speaker_id}"))?;
        Ok(pcm)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_out_of_range_speaker() {
        let dir = std::path::Path::new(&crate::models::vosk_ru_model_dir()).to_path_buf();
        if !crate::models::is_vosk_ru_cached(dir.to_str().unwrap()) {
            eprintln!("vosk model not cached — skipping speaker_id range test");
            return;
        }
        let mut v = Vosk::load(&dir).unwrap();
        let err = v.infer("привет", SPEAKER_COUNT, 1.0).unwrap_err();
        assert!(err.to_string().contains("speaker_id"), "msg: {err}");
    }
}
```

- [ ] **Step 2: Verify the test compiles AND that vosk-tts-rs API matches**

```bash
cd rust && cargo build --no-default-features --features onnx,tts 2>&1 | tail -20
```

If compilation errors mention a different API (e.g. `Synth::new` signature differs, `synth` returns something other than `Vec<f32>`, no `vosk_tts::Synth` at all), STOP and read the actual crate API:

```bash
cargo doc --package vosk-tts-rs --no-deps --open
# or:
find ~/.cargo/registry/src -name '*.rs' -path '*vosk-tts-rs*' | xargs grep -l 'pub struct\|pub fn'
```

Adapt the wrapper to the real API. Goal: `Vosk::load(&Path)` and `Vosk::infer(text, speaker_id, rate) -> Vec<f32>`.

- [ ] **Step 3: Add `pub mod vosk;` to `rust/src/tts/mod.rs`**

Find the line `pub mod piper;` (line 8) and add directly below:

```rust
pub mod vosk;
```

- [ ] **Step 4: cargo build succeeds**

```bash
cargo build --no-default-features --features onnx,tts 2>&1 | tail -5
```

Expected: `Finished release [optimized] target(s)`.

- [ ] **Step 5: Commit**

```bash
git add rust/src/tts/vosk.rs rust/src/tts/mod.rs
git commit -m "feat(tts): add vosk engine wrapper"
```

### Task 1.4: Add `ResolvedVoice::Vosk` + `resolve_vosk_ru` (without removing Piper)

**Files:**
- Modify: `rust/src/tts/voices.rs`

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `voices.rs`:

```rust
fn populate_vosk_ru(cache: &Path) {
    let dir = cache.join("models/vosk-ru");
    std::fs::create_dir_all(dir.join("bert")).unwrap();
    std::fs::write(dir.join("model.onnx"), b"dummy").unwrap();
    std::fs::write(dir.join("dictionary"), b"dummy").unwrap();
    std::fs::write(dir.join("config.json"), b"{}").unwrap();
    std::fs::write(dir.join("bert/model.onnx"), b"dummy").unwrap();
    std::fs::write(dir.join("bert/vocab.txt"), b"v").unwrap();
}

#[test]
fn resolve_vosk_ru_default_voice() {
    let tmp = tempfile::tempdir().unwrap();
    populate_vosk_ru(tmp.path());
    let r = resolve_voice(tmp.path(), "ru-vosk-m02").unwrap();
    match r {
        ResolvedVoice::Vosk { model_dir, speaker_id } => {
            assert!(model_dir.ends_with("models/vosk-ru"));
            assert_eq!(speaker_id, 4);
        }
        other => panic!("expected Vosk, got {other:?}"),
    }
}

#[test]
fn resolve_vosk_ru_all_speaker_ids() {
    let tmp = tempfile::tempdir().unwrap();
    populate_vosk_ru(tmp.path());
    for (id, n) in [("f01", 0u32), ("f02", 1), ("f03", 2), ("m01", 3), ("m02", 4)] {
        let voice = format!("ru-vosk-{id}");
        match resolve_voice(tmp.path(), &voice).unwrap() {
            ResolvedVoice::Vosk { speaker_id, .. } => assert_eq!(speaker_id, n, "{voice}"),
            other => panic!("{voice}: expected Vosk, got {other:?}"),
        }
    }
}

#[test]
fn resolve_vosk_ru_unknown_speaker_errors() {
    let tmp = tempfile::tempdir().unwrap();
    populate_vosk_ru(tmp.path());
    let err = resolve_voice(tmp.path(), "ru-vosk-zzz").unwrap_err().to_string();
    assert!(err.contains("vosk"), "msg: {err}");
}
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
cd rust && cargo test --no-default-features --features onnx,tts resolve_vosk
```

Expected: 3 FAILs (no `ResolvedVoice::Vosk`, no `resolve_vosk_ru`).

- [ ] **Step 3: Add `Vosk` variant + resolver**

In `rust/src/tts/voices.rs`:

3a. Add a new variant to `ResolvedVoice` (insert directly above `AVSpeech`):

```rust
    /// Vosk-TTS multi-speaker Russian (replaces Piper-ru).
    Vosk {
        model_dir: std::path::PathBuf,
        speaker_id: u32,
    },
```

3b. Update `ResolvedVoice::espeak_lang` to handle `Vosk` (it has none — Vosk does its own G2P):

```rust
    pub fn espeak_lang(&self) -> &'static str {
        match self {
            Self::Kokoro { espeak_lang, .. } | Self::Piper { espeak_lang, .. } => espeak_lang,
            Self::Vosk { .. } => "",
            #[cfg(all(feature = "system_tts", target_os = "macos"))]
            Self::AVSpeech { .. } => "",
        }
    }
```

3c. Replace the `"ru" =>` arm in `resolve_voice`:

```rust
        "ru" => {
            // ru-vosk-* is the new path; keep ru-ruslan working until Phase 2 deletes Piper.
            if let Some(rest) = name.strip_prefix("vosk-") {
                resolve_vosk_ru(cache_dir, voice_id, rest)
            } else {
                resolve_piper_ru(cache_dir, voice_id, name)
            }
        }
```

3d. Add `resolve_vosk_ru`:

```rust
fn resolve_vosk_ru(cache_dir: &Path, voice_id: &str, suffix: &str) -> anyhow::Result<ResolvedVoice> {
    let speaker_id: u32 = match suffix {
        "f01" => 0,
        "f02" => 1,
        "f03" => 2,
        "m01" => 3,
        "m02" => 4,
        other => anyhow::bail!(
            "unknown vosk voice 'ru-vosk-{other}'. valid: ru-vosk-f01, ru-vosk-f02, ru-vosk-f03, ru-vosk-m01, ru-vosk-m02"
        ),
    };
    let model_dir = cache_dir.join("models/vosk-ru");
    if !model_dir.join("model.onnx").exists() || !model_dir.join("bert/model.onnx").exists() {
        anyhow::bail!("voice '{voice_id}' not installed. run: kesha install --tts");
    }
    Ok(ResolvedVoice::Vosk { model_dir, speaker_id })
}
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
cargo test --no-default-features --features onnx,tts resolve_vosk
cargo test --no-default-features --features onnx,tts resolve_  # confirm no regressions in piper/kokoro tests
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add rust/src/tts/voices.rs
git commit -m "feat(tts): resolve ru-vosk-* voice ids → Vosk"
```

### Task 1.5: Add `EngineChoice::Vosk` + `say_with_vosk` + SSML segment path

**Files:**
- Modify: `rust/src/tts/mod.rs`

- [ ] **Step 1: Add `Vosk` to `EngineChoice`**

Insert directly above `AVSpeech` (around line 41):

```rust
    /// Vosk-TTS Russian: model dir + speaker id (G2P happens inside vosk).
    Vosk {
        model_dir: &'a Path,
        speaker_id: u32,
        /// Reserved for future rate scaling; vosk-tts-rs 0.1.0 ignores it.
        speed: f32,
    },
```

- [ ] **Step 2: Add `Vosk` to `engine_label`**

Update the match in `say()`:

```rust
    let engine_label: &str = match &opts.engine {
        EngineChoice::Kokoro { .. } => "kokoro",
        EngineChoice::Piper { .. } => "piper",
        EngineChoice::Vosk { .. } => "vosk",
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        EngineChoice::AVSpeech { .. } => "avspeech",
    };
```

- [ ] **Step 3: Skip G2P for Vosk in `say()`**

Vosk handles its own G2P. Insert directly after the AVSpeech early-return block, BEFORE `if opts.ssml`:

```rust
    // Vosk-tts owns its own G2P + text normalisation; bypass our espeak/misaki path.
    if let EngineChoice::Vosk { model_dir, speaker_id, speed } = &opts.engine {
        if opts.ssml {
            return synth_segments_vosk(opts.text, model_dir, *speaker_id, *speed);
        }
        return say_with_vosk(opts.text, model_dir, *speaker_id, *speed);
    }
```

(The existing `g2p::text_to_ipa` call stays — only Kokoro/Piper reach it now.)

- [ ] **Step 4: Add `Vosk` arm to inner `match opts.engine` and `say_ssml` match**

Make both matches exhaustive over `Vosk` with `unreachable!("handled by early return above")`, mirroring how `AVSpeech` is treated:

```rust
        EngineChoice::Vosk { .. } => unreachable!("handled by early return above"),
```

- [ ] **Step 5: Add `say_with_vosk`**

Insert next to `say_with_piper`:

```rust
fn say_with_vosk(text: &str, model_dir: &Path, speaker_id: u32, speed: f32) -> Result<Vec<u8>, TtsError> {
    let mut v = vosk::Vosk::load(model_dir)
        .map_err(|e| TtsError::SynthesisFailed(format!("vosk load: {e}")))?;
    let audio = v
        .infer(text, speaker_id, speed)
        .map_err(|e| TtsError::SynthesisFailed(format!("vosk infer: {e}")))?;
    wav::encode_wav(&audio, vosk::SAMPLE_RATE)
        .map_err(|e| TtsError::SynthesisFailed(format!("wav: {e}")))
}
```

- [ ] **Step 6: Add `synth_segments_vosk`**

```rust
fn synth_segments_vosk(text: &str, model_dir: &Path, speaker_id: u32, speed: f32) -> Result<Vec<u8>, TtsError> {
    let segments = ssml::parse(text)
        .map_err(|e| TtsError::SynthesisFailed(format!("ssml: {e}")))?;
    if segments.is_empty() {
        return Err(TtsError::SynthesisFailed("SSML had no speakable content".into()));
    }
    let mut v = vosk::Vosk::load(model_dir)
        .map_err(|e| TtsError::SynthesisFailed(format!("vosk load: {e}")))?;
    let mut out: Vec<f32> = Vec::new();
    for seg in segments {
        match seg {
            ssml::Segment::Text(t) | ssml::Segment::Ipa(t) => {
                // For Vosk, IPA passthrough degrades to plain text — we can't reach
                // its internal G2P with raw phonemes. Best effort: synthesize as text.
                let audio = v.infer(&t, speaker_id, speed)
                    .map_err(|e| TtsError::SynthesisFailed(format!("vosk infer: {e}")))?;
                out.extend(audio);
            }
            ssml::Segment::Break(dur) => {
                let samples = ((dur.as_secs_f64() * vosk::SAMPLE_RATE as f64).round()) as usize;
                out.extend(std::iter::repeat_n(0.0_f32, samples));
            }
        }
    }
    if out.is_empty() {
        return Err(TtsError::SynthesisFailed("no audio produced from SSML input".into()));
    }
    wav::encode_wav(&out, vosk::SAMPLE_RATE)
        .map_err(|e| TtsError::SynthesisFailed(format!("wav: {e}")))
}
```

- [ ] **Step 7: cargo build + clippy**

```bash
cd rust && cargo build --no-default-features --features onnx,tts 2>&1 | tail -5
cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add rust/src/tts/mod.rs
git commit -m "feat(tts): wire Vosk into say()/say_ssml dispatch"
```

### Task 1.6: Wire `EngineChoice::Vosk` into `main.rs` synthesis path

**Files:**
- Modify: `rust/src/main.rs` (find where `ResolvedVoice::Piper` is converted to `EngineChoice::Piper`)

- [ ] **Step 1: Locate the call site**

```bash
cd rust && grep -n "ResolvedVoice::Piper\|EngineChoice::Piper" src/main.rs
```

- [ ] **Step 2: Add a `ResolvedVoice::Vosk` arm**

Mirror the Piper arm. Pseudocode:

```rust
        voices::ResolvedVoice::Vosk { model_dir, speaker_id } => tts::EngineChoice::Vosk {
            model_dir,
            speaker_id,
            speed: rate,
        },
```

(Replace `rate` with whatever variable name the surrounding match uses — likely `args.rate.unwrap_or(1.0)`.)

- [ ] **Step 3: Add `list_vosk_ru_voices`**

Locate `list_piper_ru_voices` and add a sibling:

```rust
fn list_vosk_ru_voices() -> Vec<String> {
    vec![
        "ru-vosk-f01".into(),  // Tiflocomp Irina (female)
        "ru-vosk-f02".into(),  // Natasha-from-Sova (female)
        "ru-vosk-f03".into(),  // Artificial (female)
        "ru-vosk-m01".into(),  // Artificial (male)
        "ru-vosk-m02".into(),  // Artificial (male) — default
    ]
}
```

Then call it from wherever `list_piper_ru_voices()` is appended to the `--list-voices` output (same loop). Both lists co-exist for now.

- [ ] **Step 4: cargo build + run a smoke list-voices**

```bash
cargo build --release --no-default-features --features onnx,tts
./target/release/kesha-engine say --list-voices 2>&1 | grep -E '^(ru-|en-am)'
```

Expected: contains `ru-vosk-f01..m02` AND `ru-ruslan` (Piper still listed; cleanup in Phase 2).

- [ ] **Step 5: End-to-end smoke (model must already be downloaded into KESHA_CACHE_DIR)**

```bash
KESHA_CACHE_DIR=~/.cache/kesha ./target/release/kesha-engine say \
    --voice ru-vosk-m02 "Привет, мир. Это тест." > /tmp/vosk-test.wav
ls -la /tmp/vosk-test.wav
```

Expected: WAV ≥ 50 KB.

If the model isn't cached yet, run `./target/release/kesha-engine install --tts` first (now downloads vosk too thanks to Task 1.2 step 6).

- [ ] **Step 6: Commit**

```bash
git add rust/src/main.rs
git commit -m "feat(tts): wire ResolvedVoice::Vosk through main.rs"
```

---

## Phase 2: Delete Piper engine (commit 2)

### Task 2.1: Remove Piper from `rust/src/tts/mod.rs`

**Files:**
- Modify: `rust/src/tts/mod.rs`

- [ ] **Step 1: Delete `pub mod piper;`**

- [ ] **Step 2: Delete `EngineChoice::Piper` variant** (the entire block lines ~44-50)

- [ ] **Step 3: Delete the `EngineChoice::Piper` arm** in `say()` (around line 121-125), the `engine_label` match, and the `say_ssml` match.

- [ ] **Step 4: Delete `say_with_piper`, `synth_segments_piper`, `synth_ipa_piper`** (entire functions, ~lines 224-329).

- [ ] **Step 5: cargo build**

```bash
cd rust && cargo build --no-default-features --features onnx,tts 2>&1 | tail -10
```

Expected errors: anything in `main.rs` that still references `ResolvedVoice::Piper` or `EngineChoice::Piper`. Continue to Task 2.2 — do not commit yet.

### Task 2.2: Remove Piper from `voices.rs`

**Files:**
- Modify: `rust/src/tts/voices.rs`

- [ ] **Step 1: Delete `ResolvedVoice::Piper` variant**, the `Piper { espeak_lang, .. }` arm of `espeak_lang()`, and `resolve_piper_ru`.

- [ ] **Step 2: Simplify the `"ru"` arm of `resolve_voice`**

```rust
        "ru" => {
            let suffix = name.strip_prefix("vosk-").unwrap_or(name);
            resolve_vosk_ru(cache_dir, voice_id, suffix)
        }
```

(`ru-ruslan` now errors with the helpful "valid: ru-vosk-f01..m02" message.)

- [ ] **Step 3: Delete the Piper-related tests** in `mod tests`: `populate_piper_ru`, `resolve_installed_piper_voice` (entire test functions).

### Task 2.3: Remove Piper from `main.rs`

**Files:**
- Modify: `rust/src/main.rs`

- [ ] **Step 1: Delete the `ResolvedVoice::Piper` arm** in the engine dispatch.
- [ ] **Step 2: Delete `list_piper_ru_voices`** and its caller.

### Task 2.4: Remove `piper_ru_manifest()`

**Files:**
- Modify: `rust/src/models.rs`

- [ ] **Step 1: Delete `pub fn piper_ru_manifest()`** and its `manifest.extend(piper_ru_manifest());` caller in `manifest_for_features()`.
- [ ] **Step 2: Delete the `piper_ru_manifest_has_expected_files` test** in `mod tests`.

### Task 2.5: Delete `rust/src/tts/piper.rs`

```bash
git rm rust/src/tts/piper.rs
```

### Task 2.6: Confirm clean build + commit

- [ ] **Step 1: Build + clippy + test**

```bash
cd rust
cargo build --release --no-default-features --features onnx,tts 2>&1 | tail -5
cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings 2>&1 | tail -10
cargo test --no-default-features --features onnx,tts 2>&1 | tail -20
```

Expected: all clean and green. If any test still references `ResolvedVoice::Piper` or `Piper::`, delete those tests/cases.

- [ ] **Step 2: Smoke that ru-ruslan now errors**

```bash
KESHA_CACHE_DIR=~/.cache/kesha ./target/release/kesha-engine say \
    --voice ru-ruslan "тест" 2>&1 | head -3
```

Expected: an error mentioning `ru-vosk-*`.

- [ ] **Step 3: Commit**

```bash
git add -A rust/
git commit -m "refactor(tts): remove Piper engine"
```

---

## Phase 3: Delete CharsiuG2P + espeak (commit 3)

### Task 3.1: Strip CharsiuG2P internals from `g2p.rs`

**Files:**
- Modify: `rust/src/tts/g2p.rs`

- [ ] **Step 1: Identify what to remove**

```bash
cd rust && grep -n 'G2pSessions\|charsiu_lang\|text_to_ipa_charsiu\|g2p_word\|tokenize\|detokenize\|use ort\|use ndarray' src/tts/g2p.rs
```

- [ ] **Step 2: Reduce `text_to_ipa` to misaki-only**

Replace the function body with:

```rust
pub fn text_to_ipa(text: &str, lang: &str) -> Result<String> {
    let lower = lang.to_ascii_lowercase();
    if lower == "en" || lower == "en-us" || lower == "en-gb" {
        return misaki_text_to_ipa(text, &lower);
    }
    anyhow::bail!(
        "G2P for language '{lang}' is no longer supported in this build. \
         Russian uses Vosk-TTS internally; English uses misaki-rs. \
         Other languages were dropped with CharsiuG2P (#212 follow-up)."
    )
}
```

- [ ] **Step 3: Delete CharsiuG2P helper code**

Remove `G2pSessions`, `g2p_word`, `tokenize`, `detokenize`, `text_to_ipa_charsiu`, `charsiu_lang`, and any `use ort::` / `use ndarray::` imports left orphaned. Remove the `use super::g2p_espeak` line if present.

- [ ] **Step 4: Delete CharsiuG2P + espeak tests** in `mod tests`

### Task 3.2: Delete `rust/src/tts/g2p_espeak.rs`

```bash
git rm rust/src/tts/g2p_espeak.rs
```

### Task 3.3: Remove `pub mod g2p_espeak;` from `mod.rs`

**Files:**
- Modify: `rust/src/tts/mod.rs`

Delete `pub mod g2p_espeak;` (line 6).

### Task 3.4: Remove `g2p_onnx_manifest()` from `models.rs`

**Files:**
- Modify: `rust/src/models.rs`

- [ ] **Step 1: Delete `pub fn g2p_onnx_manifest()`** and its `manifest.extend(g2p_onnx_manifest());` caller.
- [ ] **Step 2: Delete `g2p_onnx_manifest_has_expected_files` test.**
- [ ] **Step 3: Delete `g2p_model_dir()` and `is_g2p_cached()`** if nothing references them anymore (check with grep first):

```bash
grep -rn 'g2p_model_dir\|is_g2p_cached' rust/ src/ scripts/
```

If only the helper itself + tests reference them, delete both helpers + their tests.

### Task 3.5: Update / shrink `rust/tests/g2p_parity.rs`

**Files:**
- Modify: `rust/tests/g2p_parity.rs`

CharsiuG2P is gone; non-English entries no longer have a backend. Two options:

**Option A (preferred): keep file, English-only.** Drop all non-`en-*` rows from `REFERENCE`, lower the `>= 40`/`>= 8` corpus shape assertions (e.g. `>= 14` entries, `>= 2` languages — covering en-us + en-gb), and update the doc comment to reflect "misaki-rs frozen reference".

**Option B: delete the file entirely.** Simpler. The misaki-rs crate has its own tests; we lose the cross-version drift signal but the model isn't downloaded any more.

Pick A unless misaki-rs already has equivalent coverage (check its README); document the choice in the commit message.

- [ ] **Step 1: Apply chosen option, run the test**

```bash
cd rust && cargo test --no-default-features --features tts --test g2p_parity 2>&1 | tail -10
```

Expected: PASS or `skipping` (gated on misaki cache).

### Task 3.6: Confirm + commit

- [ ] **Step 1: Build + clippy**

```bash
cd rust
cargo build --release --no-default-features --features onnx,tts 2>&1 | tail -5
cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings 2>&1 | tail -10
cargo test --no-default-features --features onnx,tts 2>&1 | tail -10
```

- [ ] **Step 2: Commit**

```bash
git add -A rust/
git commit -m "refactor(tts): remove CharsiuG2P and espeak-ng fallback"
```

---

## Phase 4: TS CLI changes (no separate commit — folded into commit 4 below)

### Task 4.1: Update `pickVoiceForLang`

**Files:**
- Modify: `src/cli/say.ts`

- [ ] **Step 1: Update tests first**

Edit `tests/unit/say.test.ts`. Replace the linux/win32 expectation:

```typescript
  it("falls back to ru-vosk-m02 for Russian on non-darwin (Vosk replaces Piper-ruslan)", () => {
    expect(pickVoiceForLang("ru", 0.95, "linux")).toBe("ru-vosk-m02");
    expect(pickVoiceForLang("ru", 0.95, "win32")).toBe("ru-vosk-m02");
  });
```

- [ ] **Step 2: Run tests**

```bash
bun test tests/unit/say.test.ts 2>&1 | tail -10
```

Expected: 2 FAILs.

- [ ] **Step 3: Update `pickVoiceForLang`**

In `src/cli/say.ts`, change the non-darwin Russian return from `"ru-ruslan"` to `"ru-vosk-m02"`. Update the comment to reflect that Vosk replaces Piper.

- [ ] **Step 4: Re-run**

```bash
bun test tests/unit/say.test.ts 2>&1 | tail -10
bunx tsc --noEmit
```

Expected: PASS.

### Task 4.2: Update `src/status.ts` directory paths

**Files:**
- Modify: `src/status.ts`

- [ ] **Step 1: Locate refs**

```bash
grep -n 'piper-ru\|charsiu\|byt5' src/status.ts src/cli/*.ts
```

- [ ] **Step 2: Replace `models/piper-ru` → `models/vosk-ru`** (and drop CharsiuG2P / byt5 entries entirely).

- [ ] **Step 3: Type check + tests**

```bash
bunx tsc --noEmit
bun test 2>&1 | tail -10
```

---

## Phase 5: CI (commit 4)

### Task 5.1: Drop espeak from `.github/workflows/ci.yml`

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Remove espeak install step**

Find `🗣️ Install espeak-ng` step in the `tts-e2e` job and delete it.

- [ ] **Step 2: Bump cache key v4 → v5**

Find `kokoro-spike-v4` and replace with `kokoro-spike-v5`. (Renaming the cache key forces a fresh cache; old Piper/CharsiuG2P artifacts won't be reused.)

### Task 5.2: Drop espeak from `.github/workflows/rust-test.yml`

**Files:**
- Modify: `.github/workflows/rust-test.yml`

- [ ] **Step 1: Remove the OS-specific espeak install steps** (Ubuntu apt, macOS brew, Windows chocolatey + dumpbin/lib import-lib synth).

- [ ] **Step 2: Bump cache key v4 → v5.**

### Task 5.3: Update `rust/ci/download-kokoro.sh`

**Files:**
- Modify: `rust/ci/download-kokoro.sh`

- [ ] **Step 1: Drop the Piper-ru block** (`ru_RU-ruslan-medium.onnx` + `.json` URLs).

- [ ] **Step 2: Drop the CharsiuG2P block** (3 ONNX files).

- [ ] **Step 3: Add Vosk-ru block**

```bash
# Vosk-tts Russian (replaces Piper-ru). 6 files, ~935 MB total.
mkdir -p "$CACHE_ROOT/models/vosk-ru/bert"
VOSK_BASE="https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main"
for f in model.onnx dictionary config.json README.md; do
    curl -fsSL "$VOSK_BASE/$f" -o "$CACHE_ROOT/models/vosk-ru/$f"
done
for f in model.onnx vocab.txt; do
    curl -fsSL "$VOSK_BASE/bert/$f" -o "$CACHE_ROOT/models/vosk-ru/bert/$f"
done
```

(Adapt to the existing script's variable names — `$CACHE_ROOT`, `$KESHA_CACHE_DIR`, etc.)

### Task 5.4: Update `rust/ci/run-cargo-test.sh`

**Files:**
- Modify: `rust/ci/run-cargo-test.sh`

- [ ] **Step 1: Drop `PIPER_MODEL` / `PIPER_CONFIG` exports** if present.

- [ ] **Step 2: Add `VOSK_MODEL_DIR=$KESHA_CACHE_DIR/models/vosk-ru` export** if vosk-gated tests need it. Otherwise no addition.

### Task 5.5: Commit CI changes

```bash
git add .github/workflows/ rust/ci/
git commit -m "chore(ci): drop espeak install + add vosk-ru download"
```

---

## Phase 6: Docs (commit 5)

For each file below, the steps are: (1) read + edit, (2) verify with a quick grep that no `espeak`/`piper`/`charsiu` ghost references remain, (3) include in the docs commit at the end.

### Task 6.1: `README.md`

- [ ] **Step 1: Update TTS section**

Replace the `Kokoro (EN) + Piper (RU) + macOS system voices, SSML preview` line with: `Kokoro (EN) + Vosk-TTS (RU) + macOS system voices, SSML preview`.

Replace any reference to `Piper RU` in the model table (line 92) with `Vosk-TTS Russian` and update the `Source` link to `[Vosk-TTS](https://github.com/alphacep/vosk-tts)`.

Restore the "no system deps" framing in the runtime list — espeak-ng is gone.

### Task 6.2: `docs/tts.md`

- [ ] **Step 1: Full refresh of engines table**

| Engine | Voices | Sample rate | G2P |
|---|---|---|---|
| Kokoro-82M | `en-am_michael`, `en-am_*`, `en-bm_*`, … | 24000 Hz | misaki-rs (embedded) |
| Vosk-TTS | `ru-vosk-f01`, `ru-vosk-f02`, `ru-vosk-f03`, `ru-vosk-m01`, `ru-vosk-m02` | 22050 Hz | internal (BERT + dictionary) |
| AVSpeechSynthesizer | `macos-*` (any system voice) | 22050 Hz | Apple system |

- [ ] **Step 2: Voice catalogue list**

Update the Russian section: list the 5 vosk voices with their human descriptions (Tiflocomp Irina (f01), Natasha-from-Sova (f02), Artificial-female (f03), Artificial-male (m01), **Artificial-male m02 (default)**).

- [ ] **Step 3: Remove all `espeak` / `Piper` / `CharsiuG2P` / `ByT5` mentions.**

- [ ] **Step 4: Update install size**: `~490 MB → ~1 GB` (Kokoro + Vosk).

### Task 6.3: `BENCHMARK.md`

- [ ] **Step 1: Replace G2P section** with: "Vosk-ru handles its own G2P internally; misaki-rs covers English. CharsiuG2P (ByT5-tiny ONNX) was removed in PR #213."

### Task 6.4: `CLAUDE.md` — refresh TTS architecture block

- [ ] **Step 1: Locate "## TTS" section**

- [ ] **Step 2: Update voice routing table**

Replace `ru-* → Piper VITS` with `ru-vosk-* → Vosk-TTS multi-speaker (5 voices, default ru-vosk-m02)`. Drop the line about "espeak-ng for Russian G2P".

- [ ] **Step 3: Update the G2P split paragraph**

> G2P split (post-#213): English → misaki-rs (no system deps); Russian → Vosk internal (no system deps); other languages → not supported until #212 lands.

- [ ] **Step 4: Drop "PR #210 espeak-ng install requirement" note** if present.

- [ ] **Step 5: Add an ONNX I/O block for Vosk** (matching the existing Kokoro/Piper blocks). Pull the actual input/output names + dtypes by running:

```bash
python3 -m venv /tmp/vosk-inspect-venv
/tmp/vosk-inspect-venv/bin/pip install --quiet onnx
/tmp/vosk-inspect-venv/bin/python3 -c "
import onnx
m = onnx.load('$HOME/.cache/kesha/models/vosk-ru/model.onnx')
for i in m.graph.input: print('IN ', i.name, i.type.tensor_type)
for o in m.graph.output: print('OUT', o.name, o.type.tensor_type)
"
rm -rf /tmp/vosk-inspect-venv
```

Paste the names/dtypes into the new block.

### Task 6.5: `raycast/README.md`

- [ ] **Step 1: Update G2P note**

> English uses misaki-rs (embedded lexicon); Russian uses Vosk-TTS (embedded G2P + ONNX). No system deps.

### Task 6.6: Commit docs

- [ ] **Step 1: Final grep — no ghost references**

```bash
git grep -i 'espeak\|piper\|charsiu\|byt5' -- README.md docs/ BENCHMARK.md CLAUDE.md raycast/README.md
```

Expected: only legitimate references (e.g., a CHANGELOG entry, a historical migration note).

- [ ] **Step 2: Commit**

```bash
git add README.md docs/ BENCHMARK.md CLAUDE.md raycast/README.md
git commit -m "docs: refresh TTS architecture for vosk-ru"
```

---

## Phase 7: End-to-end verification

### Task 7.1: Local verification

- [ ] **Step 1: Full Rust suite**

```bash
cd rust
cargo fmt --check
cargo clippy --all-targets --no-default-features --features onnx,tts -- -D warnings
cargo test --no-default-features --features onnx,tts
```

- [ ] **Step 2: Coreml feature still compiles**

```bash
cargo check --features coreml --no-default-features 2>&1 | tail -5
```

- [ ] **Step 3: TS suite**

```bash
cd .. && bun test
bunx tsc --noEmit
```

- [ ] **Step 4: Smoke each acceptance criterion from the spec**

```bash
# Build a fresh release engine
cd rust && cargo build --release --no-default-features --features onnx,tts && cd ..

# Acceptance: 5 voices synthesise
for v in f01 f02 f03 m01 m02; do
    KESHA_CACHE_DIR=~/.cache/kesha ./rust/target/release/kesha-engine say \
        --voice "ru-vosk-$v" "Привет мир." > "/tmp/vosk-$v.wav"
    ls -la "/tmp/vosk-$v.wav" | awk '{print $5, $NF}'
done

# Acceptance: question intonation + pause between sentences
KESHA_CACHE_DIR=~/.cache/kesha ./rust/target/release/kesha-engine say \
    --voice ru-vosk-m02 "Привет, как дела? Это тест." > /tmp/vosk-prosody.wav
afplay /tmp/vosk-prosody.wav  # listen by ear

# Acceptance: --list-voices includes vosk
./rust/target/release/kesha-engine say --list-voices | grep -E '^ru-'

# Acceptance: English unaffected
./rust/target/release/kesha-engine say \
    --voice en-am_michael "Hello, world. This is a test." > /tmp/en-test.wav
afplay /tmp/en-test.wav
```

Each must pass.

### Task 7.2: Push + watch CI

- [ ] **Step 1: Push**

```bash
git push origin fix/replace-piper-with-vosk-ru
```

- [ ] **Step 2: Watch CI**

```bash
gh pr checks 210 --watch
```

Expected: green on all 3 OSes.

- [ ] **Step 3: Address Greptile findings**

Per CLAUDE.md "GREPTILE PR REVIEW IS A GATE", treat P1/P2 as blockers. Fix and re-push.

### Task 7.3: PR description update

- [ ] **Step 1: Regenerate PR body**

```bash
gh pr edit 210 --body "$(cat <<'EOF'
## Summary

Replaces the Russian Piper TTS engine with `vosk-tts-rs`. Side-effect: drops the espeak-ng system dependency that #210 introduced and the CharsiuG2P fallback (no remaining users).

- New default Russian voice: `ru-vosk-m02` (male, per CLAUDE.md "DEFAULT TTS VOICES MUST BE MALE")
- darwin still routes to Milena (AVSpeech) for the zero-install path
- 5 Vosk voices selectable via `--voice ru-vosk-{f01,f02,f03,m01,m02}`
- Model: `drakulavich/vosk-tts-ru-0.9-multi` HF mirror, SHA-256 pinned
- Install size: ~490 MB → ~1 GB (Kokoro + Vosk)
- Brand promise restored: no system deps

Closes #210.

## Test plan

- [ ] `cargo test --release --no-default-features --features onnx,tts`
- [ ] `bun test && bunx tsc --noEmit`
- [ ] `cargo fmt --check && cargo clippy --all-targets -- -D warnings`
- [ ] All 5 vosk voices synthesise on Linux (audio rated intelligible by native speaker)
- [ ] `kesha say --voice ru-vosk-m02 "Привет, как дела? Это тест."` has audible question intonation + sentence pause
- [ ] CI green on macos-14, ubuntu-latest, windows-latest
- [ ] Greptile P1/P2 findings resolved
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** every `Files to modify` / `Files to delete` / `CI changes` / `Documentation` bullet from the spec maps to a task here. Risks are addressed inline (Task 1.1 step 3 handles risk #1 binary-size; Task 1.4 step 3 verifies risk #2 speaker_id mapping by testing all 5 ids; risk #3 disk size is documented in 6.2 step 4; risk #4 maturity addressed by exact-version pin in Task 1.1; risk #5 mirror divergence is the SHA-256 pin in Task 1.2).
- **Acceptance criteria:** all 11 acceptance bullets from the spec are exercised in Task 7.1–7.2.
- **Commits:** map 1:1 to the PR plan in the spec — Phase 1 = commit 1, Phase 2 = commit 2, Phase 3 = commit 3, Phase 5 = commit 4, Phase 6 = commit 5. Phase 4 (TS CLI) folds into the test+TS changes; if you want a 6th commit, separate it with `git commit src/cli/say.ts src/status.ts tests/unit/say.test.ts -m "feat(tts): route ru → vosk-m02 in CLI auto-routing"`.
- **Type consistency check:** `model_dir` (PathBuf in `ResolvedVoice::Vosk`, `&Path` in `EngineChoice::Vosk`, `&Path` in `Vosk::load`) — consistent. `speaker_id: u32` everywhere. `vosk::SAMPLE_RATE: u32 = 22_050` matches the spec acceptance criterion.
- **Open uncertainty (mark and proceed):** the exact `vosk-tts-rs 0.1.0` API (`Synth::new` signature, `synth` return type) is documented from the upstream README only — Task 1.3 step 2 explicitly verifies it and gives an adapt-or-stop instruction.
