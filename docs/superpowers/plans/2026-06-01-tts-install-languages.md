# Language-scoped TTS Install — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `kesha install --tts <langs>` and `kesha init` download only the TTS models the requested languages need (Playwright-style), instead of always pulling the full ~990 MB.

**Architecture:** Three layers. The Rust engine owns the language↔engine↔platform registry and exposes it via `--capabilities-json` (single source of truth). The engine `install --tts` accepts language codes and builds a per-language download manifest. The TS CLI parses positional language codes, validates them against capabilities before forwarding, and drives a `@clack/prompts` multi-select in `kesha init`.

**Tech Stack:** Rust (clap, anyhow, serde), Bun + TypeScript (citty), `@clack/prompts`.

**Spec:** `docs/superpowers/specs/2026-06-01-tts-install-languages-design.md`
**Issue:** [#517](https://github.com/drakulavich/kesha-voice-kit/issues/517) — PR must say `Closes #517`.

**Key facts the implementer must keep straight:**
- Availability differs by build. **ONNX build** (Linux/Windows/macOS-without-`system_kokoro`): `en es fr it pt ru`. **`system_kokoro` build** (darwin-arm64): `en es fr hi it ja pt zh ru`. `hi ja zh` are darwin-arm64-only.
- On the ONNX path the Kokoro graph (`model.onnx`, ~326 MB) is shared by `en es fr it pt`. CharsiuG2P (3 files, ~30 MB) is needed only for `es fr it pt` (not `en`). Vosk RU is ~937 MB.
- On the `system_kokoro` path `kokoro_manifest()` is empty; per-language voices are staged into FluidAudio's ANE cache by `stage_ane_kokoro_voices`.
- `macos-*` AVSpeech is **never installed** — it is ambient on macOS and excluded from `install --tts` entirely.
- Re-runs are **additive**: `download_verified` already short-circuits cached, hash-matching files, so no pruning logic is needed.
- The `<lang>:<engine>` override syntax is **deferred** — model the data as `{ code, engines[] }` but do not build the override parser (every list is length 1 today). Adding a second engine to a list later must NOT require unused code now (clippy `-D warnings` forbids dead code).

**Verification commands (run as indicated per task):**
- TS: `bun test` and `bunx tsc --noEmit`
- Rust: `cd rust && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo nextest run --features tts`
- Backend/capabilities changed: also `cd rust && cargo check --features coreml --no-default-features`

---

## File Structure

**Rust (`rust/src/`):**
- `models.rs` — add `tts_languages()` (cfg-gated registry), `validate_tts_langs()`, refactor `kokoro_manifest()` into addressable consts + `kokoro_manifest_for(langs)`, partition `ANE_KOKORO_VOICES` by language + `ane_voices_for(langs)`, change `download_tts(no_cache)` → `download_tts(langs, no_cache)` and `stage_ane_kokoro_voices(no_cache)` → `stage_ane_kokoro_voices(langs, no_cache)`.
- `capabilities.rs` — add structured `tts` field (`TtsCapabilities { languages: Vec<TtsLanguage> }`), bump `protocol_version` 2→3.
- `cli/install.rs` — `run` takes `tts_langs: Vec<String>`; validate + forward to `download_tts`.
- `main.rs` — `Install.tts` from `bool` → `Vec<String>` (`num_args(0..)`); dispatch.

**TypeScript (`src/`):**
- `engine.ts` — extend `EngineCapabilities` with `tts?: { languages: { code: string; engines: string[] }[] }`.
- `cli/install.ts` — parse positional langs, validate against capabilities, forward.
- `engine-install.ts` — `InstallOptions.tts: boolean` → `ttsLangs?: string[]`; build engine args; gate Kokoro warm-up on a Kokoro language being present.
- `cli/init.ts` — `@clack/prompts` multi-select; thread `string[]` through `InitSelection`.
- `install-plan.ts` — per-language pack groups; `renderInstallPlan` takes the lang list.

**Tests:** alongside each (`rust/src/*.rs` `#[cfg(test)]` modules; `tests/unit/*.test.ts`, `src/__tests__/*.test.ts`).

**Docs:** `CLAUDE.md` (TTS section), `docs/tts.md`, `docs/languages.md`.

---

## Task 0: Add the `@clack/prompts` dependency

**Files:**
- Modify: `package.json` (dependencies)

- [ ] **Step 1: Add the dependency**

Run:
```bash
bun add @clack/prompts
```
Expected: `package.json` gains `"@clack/prompts": "^<version>"` under `dependencies`; `bun.lock` updates.

- [ ] **Step 2: Verify it imports under Bun**

Run:
```bash
bun -e "import { multiselect, isCancel } from '@clack/prompts'; console.log(typeof multiselect, typeof isCancel)"
```
Expected: `function function`

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "build: add @clack/prompts for init language multi-select (#517)"
```

---

## Task 1: Rust — TTS language registry + capabilities field

**Files:**
- Modify: `rust/src/models.rs` (add `tts_languages`)
- Modify: `rust/src/capabilities.rs` (add structured `tts`, bump protocol)
- Test: `rust/src/models.rs` `#[cfg(all(test, feature = "tts"))] mod tts_tests`, `rust/src/capabilities.rs` tests

- [ ] **Step 1: Write the failing test for `tts_languages()`**

Add to `rust/src/models.rs` inside `mod tts_tests`:
```rust
    #[test]
    fn tts_languages_includes_en_and_ru_everywhere() {
        let langs = tts_languages();
        assert!(langs.contains(&"en"), "en missing: {langs:?}");
        assert!(langs.contains(&"ru"), "ru missing: {langs:?}");
        // es/fr/it/pt are available on every TTS build.
        for l in ["es", "fr", "it", "pt"] {
            assert!(langs.contains(&l), "{l} missing: {langs:?}");
        }
    }

    #[test]
    fn tts_languages_gates_ane_only_langs() {
        let langs = tts_languages();
        let ane_only = ["hi", "ja", "zh"];
        #[cfg(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64"))]
        for l in ane_only {
            assert!(langs.contains(&l), "{l} should be present on system_kokoro build");
        }
        #[cfg(not(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64")))]
        for l in ane_only {
            assert!(!langs.contains(&l), "{l} must NOT be present on the ONNX build");
        }
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd rust && cargo nextest run --features tts tts_languages`
Expected: FAIL — `cannot find function tts_languages`

- [ ] **Step 3: Implement `tts_languages()`**

Add to `rust/src/models.rs` (near `kokoro_manifest`, under `#[cfg(feature = "tts")]`):
```rust
/// TTS languages installable on THIS build, in maintainer-curated order.
/// Source of truth for `kesha-engine install --tts <lang>` validation and the
/// `tts.languages` capabilities rows. `es/fr/it/pt` exist on both the ONNX
/// (CharsiuG2P) and darwin ANE builds; `hi/ja/zh` exist only on the ANE build.
/// `macos-*` AVSpeech is NOT listed — it needs no install.
#[cfg(feature = "tts")]
pub fn tts_languages() -> Vec<&'static str> {
    #[cfg(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64"))]
    {
        vec!["en", "es", "fr", "hi", "it", "ja", "pt", "zh", "ru"]
    }
    #[cfg(not(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64")))]
    {
        vec!["en", "es", "fr", "it", "pt", "ru"]
    }
}
```

- [ ] **Step 4: Run to verify the models test passes**

Run: `cd rust && cargo nextest run --features tts tts_languages`
Expected: PASS (both tests)

- [ ] **Step 5: Write the failing capabilities test**

Add to `rust/src/capabilities.rs` (create a `#[cfg(test)] mod tests` if absent):
```rust
#[cfg(all(test, feature = "tts"))]
mod tts_caps_tests {
    use super::*;

    #[test]
    fn capabilities_expose_tts_languages() {
        let caps = get_capabilities();
        let tts = caps.tts.expect("tts field present on a tts build");
        let codes: Vec<&str> = tts.languages.iter().map(|l| l.code).collect();
        assert!(codes.contains(&"en"));
        assert!(codes.contains(&"ru"));
        // every language advertises at least one downloadable engine
        for lang in &tts.languages {
            assert!(!lang.engines.is_empty(), "{} has no engines", lang.code);
        }
    }

    #[test]
    fn protocol_version_is_3() {
        assert_eq!(get_capabilities().protocol_version, 3);
    }
}
```

- [ ] **Step 6: Run to verify it fails**

Run: `cd rust && cargo nextest run --features tts capabilities_expose_tts_languages`
Expected: FAIL — no field `tts` on `Capabilities`

- [ ] **Step 7: Implement the capabilities field**

In `rust/src/capabilities.rs`, add the types and populate them. The engine for each language is its default downloadable engine (`engines[0]`); the list shape anticipates future multi-engine languages without building override syntax now:
```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsLanguage {
    pub code: &'static str,
    /// Downloadable engines for this language, default first. One entry today.
    pub engines: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsCapabilities {
    pub languages: Vec<TtsLanguage>,
}
```
Add to `Capabilities`:
```rust
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tts: Option<TtsCapabilities>,
```
Change `protocol_version: 2` → `protocol_version: 3`. In `get_capabilities()`, after the `features` block, build the field:
```rust
    #[cfg(feature = "tts")]
    let tts = Some(TtsCapabilities {
        languages: crate::models::tts_languages()
            .into_iter()
            .map(|code| TtsLanguage {
                code,
                engines: vec![if code == "ru" { "vosk" } else { "kokoro" }],
            })
            .collect(),
    });
    #[cfg(not(feature = "tts"))]
    let tts = None;
```
and include `tts` in the returned `Capabilities { ... }`.

- [ ] **Step 8: Run all capabilities + models tts tests**

Run: `cd rust && cargo nextest run --features tts capabilities tts_languages`
Expected: PASS

- [ ] **Step 9: Verify the non-tts build still compiles (tts is Optional)**

Run: `cd rust && cargo check --no-default-features --features onnx`
Expected: compiles (the `#[cfg(not(feature="tts"))] let tts = None;` arm covers it)

- [ ] **Step 10: fmt + clippy + commit**

```bash
cd rust && cargo fmt && cargo clippy --all-targets --features tts -- -D warnings
cd .. && git add rust/src/models.rs rust/src/capabilities.rs
git commit -m "feat(engine): expose installable TTS languages via capabilities (proto v3) (#517)"
```
Expected: clippy clean.

---

## Task 2: Rust — language-aware ONNX Kokoro manifest

**Files:**
- Modify: `rust/src/models.rs` (refactor `kokoro_manifest`, add `kokoro_manifest_for`)
- Test: `rust/src/models.rs` `mod tts_tests`

This task only touches the **ONNX path** (`not(all(system_kokoro, macos, aarch64))`). The darwin ANE path is Task 3.

- [ ] **Step 1: Write the failing test**

Add to `mod tts_tests` (guard for the ONNX path, since the helper is cfg'd there):
```rust
    #[cfg(not(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64")))]
    #[test]
    fn kokoro_manifest_for_selects_per_language() {
        let ends = |m: &[ModelFile], suffix: &str| m.iter().any(|f| f.rel_path.ends_with(suffix));

        // en: graph + am_michael, NO g2p
        let en = kokoro_manifest_for(&["en"]);
        assert!(ends(&en, "model.onnx"));
        assert!(ends(&en, "am_michael.bin"));
        assert!(!en.iter().any(|f| f.rel_path.contains("g2p")), "en must not pull g2p");

        // es: graph + em_alex + g2p, NO am_michael
        let es = kokoro_manifest_for(&["es"]);
        assert!(ends(&es, "model.onnx"));
        assert!(ends(&es, "em_alex.bin"));
        assert!(es.iter().any(|f| f.rel_path.contains("g2p")), "es needs g2p");
        assert!(!ends(&es, "am_michael.bin"));

        // en + es: graph once, both voices, g2p present
        let both = kokoro_manifest_for(&["en", "es"]);
        assert_eq!(both.iter().filter(|f| f.rel_path.ends_with("model.onnx")).count(), 1);
        assert!(ends(&both, "am_michael.bin") && ends(&both, "em_alex.bin"));

        // ru only: no kokoro graph at all
        assert!(kokoro_manifest_for(&["ru"]).is_empty());
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd rust && cargo nextest run --features tts kokoro_manifest_for`
Expected: FAIL — `cannot find function kokoro_manifest_for`

- [ ] **Step 3: Refactor `kokoro_manifest` into addressable consts + add `kokoro_manifest_for`**

In `rust/src/models.rs`, under the existing `#[cfg(not(all(system_kokoro, macos, aarch64)))]` ONNX region, replace the inline literals of `kokoro_manifest()` with named consts and a lang-keyed voice table. Keep `kokoro_manifest()` returning the full set (its existing test depends on it). Use the EXACT urls/sha256 already in the file — copy them verbatim, do not invent hashes.

```rust
#[cfg(not(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64")))]
const KOKORO_GRAPH: ModelFile = ModelFile {
    rel_path: "models/kokoro-82m/model.onnx",
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    sha256: "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
};

#[cfg(not(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64")))]
const KOKORO_EN_VOICE: ModelFile = ModelFile {
    rel_path: "models/kokoro-82m/voices/am_michael.bin",
    url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_michael.bin",
    sha256: "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1",
};

// CharsiuG2P byt5-tiny (CC-BY 4.0, #185) — shared by es/fr/it/pt only.
#[cfg(not(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64")))]
const G2P_CHARSIU_FILES: &[ModelFile] = &[
    ModelFile {
        rel_path: "models/g2p/byt5-tiny/encoder_model.onnx",
        url: "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/main/encoder_model.onnx",
        sha256: "1ac7aca11845527873f9e0e870fbe1e3c3ac2cb009d8852230332d10541aab04",
    },
    ModelFile {
        rel_path: "models/g2p/byt5-tiny/decoder_model.onnx",
        url: "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/main/decoder_model.onnx",
        sha256: "de32477aae14e254d4a7dee4b2c324fb39f93a0dc254181c5bfdd8fc67492919",
    },
    ModelFile {
        rel_path: "models/g2p/byt5-tiny/decoder_with_past_model.onnx",
        url: "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/main/decoder_with_past_model.onnx",
        sha256: "fae30b9f3a8d935be01b32af851bae6d54f330813167073e84caf6d0a1890fcb",
    },
];

// es/fr/it/pt → that language's Kokoro voice pack (ONNX path).
#[cfg(not(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64")))]
fn multilang_voice(lang: &str) -> Option<ModelFile> {
    let (rel, url, sha) = match lang {
        "es" => ("models/kokoro-82m/voices/em_alex.bin",
                 "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/em_alex.bin",
                 "27809e9eafdcbcfff90a3016c697568676531de2a2c39cee29c96c7bd6b83e95"),
        "fr" => ("models/kokoro-82m/voices/ff_siwis.bin",
                 "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/ff_siwis.bin",
                 "a35f5675ad08948e326ae75fd0ea16ba5d0042e4f76b5f3d1df77d0a48c54861"),
        "it" => ("models/kokoro-82m/voices/im_nicola.bin",
                 "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/im_nicola.bin",
                 "bc578e510d52a96d6940d46f12e96d7b3df00905dbea075113226d100e6e1ab0"),
        "pt" => ("models/kokoro-82m/voices/pm_alex.bin",
                 "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/pm_alex.bin",
                 "0175c753f59c54e7fd5a995bedef0c5ff2fb67e0043dd3dcb2ae74ec2acbeb2a"),
        _ => return None,
    };
    Some(ModelFile { rel_path: rel, url, sha256: sha })
}

/// ONNX-path Kokoro files needed for `langs`. Graph included if any kokoro
/// language is selected; G2P included only if a multilingual language is
/// selected; per-language voices added individually. Empty if no kokoro lang.
#[cfg(not(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64")))]
fn kokoro_manifest_for(langs: &[&str]) -> Vec<ModelFile> {
    const KOKORO_LANGS: [&str; 5] = ["en", "es", "fr", "it", "pt"];
    const MULTILANG: [&str; 4] = ["es", "fr", "it", "pt"];
    let mut out = Vec::new();
    if langs.iter().any(|l| KOKORO_LANGS.contains(l)) {
        out.push(KOKORO_GRAPH.clone());
    }
    if langs.contains(&"en") {
        out.push(KOKORO_EN_VOICE.clone());
    }
    if langs.iter().any(|l| MULTILANG.contains(l)) {
        out.extend(G2P_CHARSIU_FILES.iter().cloned());
    }
    for l in langs {
        if let Some(v) = multilang_voice(l) {
            out.push(v);
        }
    }
    out
}
```
Then rewrite `kokoro_manifest()`'s non-empty arm to reuse the consts so there is ONE copy of each literal:
```rust
    #[allow(unreachable_code)]
    {
        let mut v = vec![KOKORO_GRAPH.clone(), KOKORO_EN_VOICE.clone()];
        v.extend(G2P_CHARSIU_FILES.iter().cloned());
        for l in ["es", "fr", "it", "pt"] {
            v.push(multilang_voice(l).expect("multilang voice"));
        }
        v
    }
```

- [ ] **Step 4: Run the new + existing manifest tests**

Run: `cd rust && cargo nextest run --features tts kokoro_manifest`
Expected: PASS (`kokoro_manifest_for_selects_per_language` and `kokoro_manifest_has_expected_files`)

- [ ] **Step 5: fmt + clippy + commit**

```bash
cd rust && cargo fmt && cargo clippy --all-targets --features tts -- -D warnings
cd .. && git add rust/src/models.rs
git commit -m "refactor(engine): addressable Kokoro manifest + kokoro_manifest_for(langs) (#517)"
```

---

## Task 3: Rust — language-aware ANE voice staging (darwin path)

**Files:**
- Modify: `rust/src/models.rs` (partition `ANE_KOKORO_VOICES`, add `ane_voices_for`, change `stage_ane_kokoro_voices` signature)
- Test: `rust/src/models.rs` `mod tts_tests`

This task only touches the **`system_kokoro` darwin-arm64 path**. Its tests are cfg-gated and only run on that build (CI runs them via the `cargo check --features coreml` job and on macos-14). Implement carefully even though local non-darwin runs skip them.

- [ ] **Step 1: Write the failing test (darwin-gated)**

Add to `mod tts_tests`:
```rust
    #[cfg(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64"))]
    #[test]
    fn ane_voices_for_filters_by_language_prefix() {
        let names = |langs: &[&str]| {
            ane_voices_for(langs)
                .iter()
                .map(|f| f.rel_path.to_string())
                .collect::<Vec<_>>()
        };
        // en → only a*/b* voices (am_*, bm_*); never es/it/etc
        let en = names(&["en"]);
        assert!(en.iter().any(|n| n.starts_with("am_")));
        assert!(en.iter().all(|n| n.starts_with("am_") || n.starts_with("af_") || n.starts_with("bm_")));
        // es → only e* voices
        let es = names(&["es"]);
        assert!(!es.is_empty() && es.iter().all(|n| n.starts_with("e")));
        // af_heart never staged
        assert!(!names(&["en"]).iter().any(|n| n == "af_heart.bin"));
    }
```

- [ ] **Step 2: Run to verify it fails (on a darwin-arm64 machine / CI)**

Run: `cd rust && cargo nextest run --features tts,system_kokoro ane_voices_for` (darwin-arm64 only)
Expected: FAIL — `cannot find function ane_voices_for`

- [ ] **Step 3: Add `ane_voices_for` and rewire `stage_ane_kokoro_voices`**

The flat `ANE_KOKORO_VOICES` const stays as the catalogue. Add a prefix→language classifier and filter. Add near `ANE_KOKORO_VOICES`:
```rust
#[cfg(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64"))]
fn ane_voice_lang(rel_path: &str) -> Option<&'static str> {
    // Kokoro voice files are `<x><gender>_name.bin`; first char picks language.
    match rel_path.chars().next() {
        Some('a') | Some('b') => Some("en"),
        Some('e') => Some("es"),
        Some('f') => Some("fr"),
        Some('h') => Some("hi"),
        Some('i') => Some("it"),
        Some('j') => Some("ja"),
        Some('p') => Some("pt"),
        Some('z') => Some("zh"),
        _ => None,
    }
}

#[cfg(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64"))]
fn ane_voices_for(langs: &[&str]) -> Vec<&'static ModelFile> {
    ANE_KOKORO_VOICES
        .iter()
        .filter(|f| ane_voice_lang(f.rel_path).is_some_and(|l| langs.contains(&l)))
        .collect()
}
```
Change the staging fn signature and body:
```rust
#[cfg(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64"))]
pub fn stage_ane_kokoro_voices(langs: &[&str], no_cache: bool) -> Result<()> {
    let manifest = ane_voices_for(langs);
    if manifest.is_empty() {
        return Ok(());
    }
    let ane_dir = fluidaudio_ane_kokoro_dir();
    fs::create_dir_all(&ane_dir)
        .with_context(|| format!("create FluidAudio ANE dir {}", ane_dir.display()))?;
    parallel_download(&ane_dir, &manifest, no_cache)
}
```

- [ ] **Step 4: Run the test (darwin-arm64 / CI)**

Run: `cd rust && cargo nextest run --features tts,system_kokoro ane_voices_for`
Expected: PASS. (On non-darwin dev machines this test is cfg'd out — that's expected; CI's macos-14 job covers it.)

- [ ] **Step 5: fmt + clippy + commit**

```bash
cd rust && cargo fmt && cargo clippy --all-targets --features tts -- -D warnings
cd .. && git add rust/src/models.rs
git commit -m "refactor(engine): stage only requested languages' ANE Kokoro voices (#517)"
```

---

## Task 4: Rust — `download_tts(langs)` + validation

**Files:**
- Modify: `rust/src/models.rs` (`download_tts` signature + `validate_tts_langs`)
- Test: `rust/src/models.rs` `mod tts_tests`

- [ ] **Step 1: Write the failing validation test**

Add to `mod tts_tests`:
```rust
    #[test]
    fn validate_tts_langs_accepts_known_rejects_unknown() {
        assert!(validate_tts_langs(&["en"]).is_ok());
        let err = validate_tts_langs(&["en", "klingon"]).unwrap_err().to_string();
        assert!(err.contains("klingon"), "err names the bad code: {err}");
        // a known-but-unavailable-on-this-build code is rejected too
        #[cfg(not(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64")))]
        {
            let err = validate_tts_langs(&["ja"]).unwrap_err().to_string();
            assert!(err.contains("ja"), "ja unavailable on ONNX build: {err}");
        }
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd rust && cargo nextest run --features tts validate_tts_langs`
Expected: FAIL — `cannot find function validate_tts_langs`

- [ ] **Step 3: Implement validation**

Add to `rust/src/models.rs`:
```rust
/// Validate requested TTS language codes against what THIS build supports.
/// Hard error (download nothing) naming the offending code and the supported set.
#[cfg(feature = "tts")]
pub fn validate_tts_langs(langs: &[&str]) -> Result<()> {
    let supported = tts_languages();
    for l in langs {
        if !supported.contains(l) {
            coded_bail!(
                ErrorCode::VoiceUnknown,
                "TTS language '{l}' is not available on this build (supported: {})",
                supported.join(", ")
            );
        }
    }
    Ok(())
}
```
(`ErrorCode::VoiceUnknown` and `coded_bail!` are already imported in this module — confirm the `use` at the top; if `coded_bail!`/`ErrorCode` are not in scope here, add `use crate::errors::ErrorCode;` and `use crate::coded_bail;` matching how `download_verified` references them.)

- [ ] **Step 4: Write the failing `download_tts(langs)` shape test**

`download_tts` hits the network, so test only the no-op early-return shape (empty langs downloads nothing and returns Ok):
```rust
    #[test]
    fn download_tts_empty_langs_is_noop() {
        // No languages selected → nothing to download, Ok.
        assert!(download_tts(&[], false).is_ok());
    }
```

- [ ] **Step 5: Run to verify it fails (signature mismatch)**

Run: `cd rust && cargo nextest run --features tts download_tts_empty`
Expected: FAIL — `download_tts` takes 1 argument / type mismatch.

- [ ] **Step 6: Change `download_tts` to take languages**

Replace the existing `download_tts`:
```rust
#[cfg(feature = "tts")]
pub fn download_tts(langs: &[&str], no_cache: bool) -> Result<()> {
    if langs.is_empty() {
        return Ok(());
    }
    let cache = cache_dir();

    // ONNX path: assemble the per-language Kokoro/G2P manifest + Vosk for ru.
    #[cfg(not(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64")))]
    {
        let mut manifest = kokoro_manifest_for(langs);
        if langs.contains(&"ru") {
            manifest.extend(vosk_ru_manifest());
        }
        let refs: Vec<&ModelFile> = manifest.iter().collect();
        parallel_download(&cache, &refs, no_cache)?;
    }

    // system_kokoro (darwin-arm64): Vosk for ru via the normal cache, Kokoro
    // langs staged into FluidAudio's ANE cache (graph auto-downloads on synth).
    #[cfg(all(feature = "system_kokoro", target_os = "macos", target_arch = "aarch64"))]
    {
        if langs.contains(&"ru") {
            let manifest = vosk_ru_manifest();
            let refs: Vec<&ModelFile> = manifest.iter().collect();
            parallel_download(&cache, &refs, no_cache)?;
        }
        stage_ane_kokoro_voices(langs, no_cache)?;
    }

    Ok(())
}
```

- [ ] **Step 7: Run the tts tests**

Run: `cd rust && cargo nextest run --features tts download_tts_empty validate_tts_langs`
Expected: PASS

- [ ] **Step 8: fmt + clippy (callers still broken — that's Task 5)**

Run: `cd rust && cargo fmt` then `cargo clippy --features tts -- -D warnings 2>&1 | head`
Expected: the only remaining error is `cli/install.rs` calling `download_tts(no_cache)` with the old signature. That is fixed in Task 5 — do NOT commit until it compiles. Proceed directly to Task 5 in the same working tree.

---

## Task 5: Rust — wire `install` CLI + `main.rs`

**Files:**
- Modify: `rust/src/cli/install.rs` (`run` signature, validate + forward)
- Modify: `rust/src/main.rs` (`Install.tts` arg + dispatch)
- Test: `rust/src/cli/install.rs` (small unit test on a pure helper if added) — primary coverage is Task 1/4 + the TS layer.

- [ ] **Step 1: Change `cli::install::run` to take language codes**

In `rust/src/cli/install.rs`, change the `tts: bool` parameter to `tts_langs: Vec<String>` and replace the TTS block:
```rust
pub fn run(
    no_cache: bool,
    #[cfg(feature = "tts")] tts_langs: Vec<String>,
    vad: bool,
    #[cfg(feature = "system_diarize")] diarize: bool,
    no_warmup: bool,
) -> Result<()> {
    models::init_mirror_logging();
    models::install(no_cache)?;
    #[cfg(feature = "tts")]
    if !tts_langs.is_empty() {
        let refs: Vec<&str> = tts_langs.iter().map(String::as_str).collect();
        models::validate_tts_langs(&refs)?;
        models::download_tts(&refs, no_cache)?;
        eprintln!("TTS models installed ({}).", tts_langs.join(", "));
    }
    // ... (vad / diarize / warm-up blocks unchanged) ...
```
Leave the ASR/diarize warm-up blocks exactly as they are.

- [ ] **Step 2: Change the `Install` subcommand in `main.rs`**

Replace the `tts: bool` arg:
```rust
        /// Install TTS models for these languages (space-separated, e.g.
        /// `--tts en ru`). Bare `--tts` installs English only. Codes are
        /// validated against this build's supported set.
        #[cfg(feature = "tts")]
        #[arg(long, num_args = 0.., value_name = "LANG", default_missing_value = "en")]
        tts: Vec<String>,
```
And in the dispatch arm, forward `tts` to the renamed parameter:
```rust
        Some(Commands::Install {
            no_cache,
            #[cfg(feature = "tts")]
            tts,
            vad,
            #[cfg(feature = "system_diarize")]
            diarize,
            no_warmup,
        }) => cli::install::run(
            no_cache,
            #[cfg(feature = "tts")]
            tts,
            vad,
            #[cfg(feature = "system_diarize")]
            diarize,
            no_warmup,
        )?,
```

Note on clap semantics: `num_args = 0..` + `default_missing_value = "en"` means bare `--tts` yields `vec!["en"]`, `--tts en ru` yields `vec!["en","ru"]`, and omitting `--tts` yields `vec![]`. Verify this in Step 4.

- [ ] **Step 3: Build the engine**

Run: `cd rust && cargo build --features tts`
Expected: compiles.

- [ ] **Step 4: Manually verify clap parsing of the new arg**

Run:
```bash
cd rust
./target/debug/kesha-engine install --tts --plan 2>/dev/null || true   # if --plan unsupported, skip
./target/debug/kesha-engine install --help | grep -A3 -- '--tts'
```
Then confirm validation rejects a bad code without downloading the engine models (point at an empty temp cache so `install` is cheap, and expect the bad-code error before any large download — interrupt if it starts fetching ASR):
```bash
KESHA_CACHE_DIR=$(mktemp -d) ./target/debug/kesha-engine install --tts klingon 2>&1 | grep -i klingon
```
Expected: an error line naming `klingon`. (ASR install runs first; if that is too slow locally, trust the Task 4 `validate_tts_langs` unit test and the TS-layer pre-validation in Task 7 instead.)

- [ ] **Step 5: Run the full rust suite + clippy**

Run: `cd rust && cargo fmt && cargo clippy --all-targets --features tts -- -D warnings && cargo nextest run --features tts`
Expected: clippy clean, tests PASS.

- [ ] **Step 6: Verify the coreml/system_kokoro build compiles**

Run: `cd rust && cargo check --features coreml --no-default-features`
Expected: compiles. (This exercises the `system_kokoro` cfg arms in `download_tts` and `stage_ane_kokoro_voices`.)

- [ ] **Step 7: Commit (Rust engine now fully language-aware)**

```bash
cd .. && git add rust/src/models.rs rust/src/cli/install.rs rust/src/main.rs
git commit -m "feat(engine): kesha-engine install --tts <langs> with validation (#517)"
```

---

## Task 6: TS — mirror the capabilities `tts` field

**Files:**
- Modify: `src/engine.ts` (`EngineCapabilities`)
- Test: `src/__tests__/engine.test.ts` (create if needed) or `tests/unit/engine.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that parses a capabilities JSON with the new field. In `tests/unit/engine.test.ts` (new file if absent):
```typescript
import { describe, expect, test } from "bun:test";
import type { EngineCapabilities } from "../../src/engine";

describe("EngineCapabilities tts field", () => {
  test("typed tts.languages round-trips from JSON", () => {
    const json = `{"protocolVersion":3,"backend":"onnx","features":["tts"],"tts":{"languages":[{"code":"en","engines":["kokoro"]},{"code":"ru","engines":["vosk"]}]}}`;
    const caps = JSON.parse(json) as EngineCapabilities;
    expect(caps.tts?.languages.map((l) => l.code)).toEqual(["en", "ru"]);
    expect(caps.tts?.languages[0].engines).toEqual(["kokoro"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bunx tsc --noEmit`
Expected: FAIL — `Property 'tts' does not exist on type 'EngineCapabilities'`.

- [ ] **Step 3: Extend the interface**

In `src/engine.ts`, update:
```typescript
export interface TtsLanguageCapability {
  code: string;
  engines: string[];
}

export interface EngineCapabilities {
  protocolVersion: number;
  backend: string;
  features: string[];
  tts?: { languages: TtsLanguageCapability[] };
}
```

- [ ] **Step 4: Verify**

Run: `bunx tsc --noEmit && bun test tests/unit/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/engine.ts tests/unit/engine.test.ts
git commit -m "feat(cli): type the capabilities tts.languages field (#517)"
```

---

## Task 7: TS — `install` positional language parsing + validation

**Files:**
- Modify: `src/cli/install.ts` (arg shape, parse positionals, validate, forward)
- Modify: `src/engine-install.ts` (consumed in Task 8 — declare the new option here only if needed; otherwise keep Task 8 separate)
- Test: `tests/unit/install.test.ts` (new)

Add a pure, exported helper so parsing/validation is unit-testable without spawning the engine.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/install.test.ts`:
```typescript
import { describe, expect, test } from "bun:test";
import { resolveTtsLangs } from "../../src/cli/install";

const caps = ["en", "es", "fr", "it", "pt", "ru"];

describe("resolveTtsLangs", () => {
  test("bare --tts defaults to en", () => {
    expect(resolveTtsLangs({ tts: true, positionals: [] }, caps)).toEqual(["en"]);
  });
  test("explicit languages pass through", () => {
    expect(resolveTtsLangs({ tts: true, positionals: ["en", "ru"] }, caps)).toEqual(["en", "ru"]);
  });
  test("no --tts means no tts even with positionals -> error", () => {
    expect(() => resolveTtsLangs({ tts: false, positionals: ["en"] }, caps)).toThrow(/require .*--tts/i);
  });
  test("unsupported language is a hard error naming the code and supported set", () => {
    expect(() => resolveTtsLangs({ tts: true, positionals: ["ja"] }, caps)).toThrow(/ja/);
  });
  test("tts disabled and no positionals -> empty", () => {
    expect(resolveTtsLangs({ tts: false, positionals: [] }, caps)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/install.test.ts`
Expected: FAIL — `resolveTtsLangs` is not exported.

- [ ] **Step 3: Implement `resolveTtsLangs`**

Add to `src/cli/install.ts`:
```typescript
export interface TtsArgInput {
  /** Whether --tts was passed. */
  tts: boolean;
  /** Positional args after the install command (candidate language codes). */
  positionals: string[];
}

/**
 * Resolve the requested TTS language list. Bare `--tts` defaults to English.
 * Positionals without `--tts` are an error. Unsupported codes (per the engine's
 * advertised capabilities) are a hard error so nothing downloads.
 */
export function resolveTtsLangs(input: TtsArgInput, supported: string[]): string[] {
  if (!input.tts) {
    if (input.positionals.length > 0) {
      throw new Error(
        `Language codes (${input.positionals.join(", ")}) require the --tts flag, ` +
          `e.g. \`kesha install --tts ${input.positionals.join(" ")}\`.`,
      );
    }
    return [];
  }
  const langs = input.positionals.length > 0 ? input.positionals : ["en"];
  const bad = langs.filter((l) => !supported.includes(l));
  if (bad.length > 0) {
    throw new Error(
      `Unsupported TTS language(s): ${bad.join(", ")}. ` +
        `Supported on this platform: ${supported.join(", ")}.`,
    );
  }
  return langs;
}
```

- [ ] **Step 4: Wire it into the `install` command**

In `src/cli/install.ts`, the citty command currently declares `tts` as a boolean. Keep `tts: { type: "boolean" }`; citty exposes positionals as `args._`. In `run`, after the engine is present, fetch capabilities and resolve:
```typescript
  async run({ args, rawArgs }: { args: InstallCommandArgs; rawArgs: string[] }) {
    const backend = resolveBackendFlag(args.coreml, args.onnx);
    const positionals = (args._ ?? []).map(String);
    // Engine must exist to read capabilities; performInstall downloads it first
    // when missing, then validates TTS langs before the TTS model step.
    await performInstall(
      resolveNoCacheFlag(args, rawArgs),
      backend,
      { tts: args.tts === true, positionals },
      args.vad,
      args.diarize,
      args.plan,
    );
  },
```
Update `performInstall` to accept the TTS input, fetch capabilities, resolve+validate, and pass `ttsLangs` down (the engine-install change is Task 8). For this task, thread the resolved `string[]` into the existing `downloadEngine` call site; capabilities fetch:
```typescript
import { getEngineCapabilities } from "../engine";
// inside performInstall, after the engine binary is guaranteed present:
const caps = await getEngineCapabilities();
const supported = caps?.tts?.languages.map((l) => l.code) ?? ["en", "ru"];
const ttsLangs = resolveTtsLangs(ttsInput, supported);
```
(Keep the `["en","ru"]` fallback minimal — it only applies if the capability probe fails on an older engine; the engine re-validates authoritatively.)

- [ ] **Step 5: Run the unit test**

Run: `bun test tests/unit/install.test.ts && bunx tsc --noEmit`
Expected: PASS / no type errors. (Some `performInstall` call sites in `init.ts` will not yet compile against the new signature — Task 9 fixes them. If `tsc` fails ONLY on `init.ts`, proceed to Tasks 8–9 before committing; otherwise fix here.)

- [ ] **Step 6: Commit once `tsc` is clean across the tree (after Task 8/9 if needed)**

```bash
git add src/cli/install.ts tests/unit/install.test.ts
git commit -m "feat(cli): parse + validate positional --tts languages (#517)"
```

---

## Task 8: TS — `engine-install.ts` forwards language list

**Files:**
- Modify: `src/engine-install.ts` (`InstallOptions`, args, warm-up gating)
- Test: `src/__tests__/engine-install.test.ts` (extend)

- [ ] **Step 1: Write the failing test for arg construction**

Add an exported pure helper for the engine install args and test it. In `src/engine-install.ts` add:
```typescript
/** Build the `kesha-engine install` argv from options. Exported for testing. */
export function buildEngineInstallArgs(opts: {
  noCache: boolean;
  ttsLangs?: string[];
  vad?: boolean;
  diarize?: boolean;
}): string[] {
  return [
    "install",
    ...(opts.noCache ? ["--no-cache"] : []),
    ...(opts.ttsLangs && opts.ttsLangs.length > 0 ? ["--tts", ...opts.ttsLangs] : []),
    ...(opts.vad ? ["--vad"] : []),
    ...(opts.diarize ? ["--diarize"] : []),
  ];
}
```
Test in `src/__tests__/engine-install.test.ts`:
```typescript
import { buildEngineInstallArgs } from "../engine-install";
// ...
test("tts languages become positional args after --tts", () => {
  expect(buildEngineInstallArgs({ noCache: false, ttsLangs: ["en", "ru"] }))
    .toEqual(["install", "--tts", "en", "ru"]);
});
test("no tts langs omits --tts", () => {
  expect(buildEngineInstallArgs({ noCache: true, ttsLangs: [] }))
    .toEqual(["install", "--no-cache"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test src/__tests__/engine-install.test.ts`
Expected: FAIL — `buildEngineInstallArgs` not exported (after adding the test before the impl, or import error).

- [ ] **Step 3: Implement — change `InstallOptions` and use the helper**

In `src/engine-install.ts`:
```typescript
export interface InstallOptions {
  /** TTS languages to install (empty/undefined = no TTS). */
  ttsLangs?: string[];
  vad?: boolean;
  diarize?: boolean;
}
```
Replace the inline `installArgs` construction in `downloadEngine` with:
```typescript
  const installArgs = buildEngineInstallArgs({
    noCache,
    ttsLangs: options.ttsLangs,
    vad: options.vad,
    diarize: options.diarize,
  });
```
Gate the Kokoro warm-up on a Kokoro language being requested (en/es/fr/hi/it/ja/pt — i.e. any non-`ru`):
```typescript
  const wantsKokoro = (options.ttsLangs ?? []).some((l) => l !== "ru");
  if (wantsKokoro) {
    await warmDarwinKokoro(binPath);
  }
```
(Previously gated on `options.tts`; Vosk-only installs no longer trigger the Kokoro warm-up.)

- [ ] **Step 4: Update `performInstall` (install.ts) to pass `ttsLangs`**

In `src/cli/install.ts`, change the `downloadEngine` call inside `performInstall`:
```typescript
    await downloadEngine(noCache, backend, { ttsLangs, vad, diarize });
```
and update the `--plan` branch to pass langs to `renderInstallPlan` (Task 10 changes the signature; for now pass `{ ttsLangs, ... }`).

- [ ] **Step 5: Run tests + types**

Run: `bun test src/__tests__/engine-install.test.ts && bunx tsc --noEmit`
Expected: PASS (init.ts may still be pending Task 9 — see note in Task 7 Step 6).

- [ ] **Step 6: Commit (after init compiles — Task 9)**

```bash
git add src/engine-install.ts src/__tests__/engine-install.test.ts src/cli/install.ts
git commit -m "feat(cli): forward --tts language list to the engine; gate Kokoro warm-up (#517)"
```

---

## Task 9: TS — `init` multi-select language picker

**Files:**
- Modify: `src/cli/init.ts` (`InitSelection`, prompt, args, suggestions)
- Test: `tests/unit/init.test.ts` (update)

`InitSelection.tts: boolean` becomes `ttsLangs: string[]`. `initInstallArgs` emits `--tts <langs>`. The interactive selection uses `@clack/prompts` `multiselect`; the non-TTY path keeps printing suggested commands.

- [ ] **Step 1: Update the failing tests first**

In `tests/unit/init.test.ts`, update the expectations to the new shape:
```typescript
  test("defaults to base install only", () => {
    const selection = resolveInitSelection(initArgs(), undefined);
    expect(selection).toEqual({
      noCache: false,
      backend: undefined,
      ttsLangs: [],
      vad: false,
      diarize: false,
    });
    expect(initInstallArgs(selection)).toEqual(["kesha", "install"]);
  });

  test("preselected feature flags map to install flags", () => {
    const selection = resolveInitSelection(
      initArgs({ "no-cache": true, tts: true, vad: true, diarize: true }),
      "coreml",
    );
    expect(initInstallArgs(selection)).toEqual([
      "kesha", "install", "--no-cache", "--coreml", "--tts", "en", "--vad", "--diarize",
    ]);
  });
```
Add:
```typescript
  test("tts languages render as positional args", () => {
    const args = initInstallArgs({
      noCache: false, backend: undefined, ttsLangs: ["en", "ru"], vad: false, diarize: false,
    });
    expect(args).toEqual(["kesha", "install", "--tts", "en", "ru"]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/init.test.ts`
Expected: FAIL — shape mismatch (`tts` vs `ttsLangs`).

- [ ] **Step 3: Update `InitSelection`, `resolveInitSelection`, `initInstallArgs`**

In `src/cli/init.ts`:
```typescript
export interface InitSelection {
  noCache: boolean;
  backend?: string;
  ttsLangs: string[];
  vad: boolean;
  diarize: boolean;
}
```
`resolveInitSelection` maps the preselect `args.tts` boolean to `["en"]` (the default) when set:
```typescript
    ttsLangs: args.tts ? ["en"] : [],
```
`initInstallArgs`:
```typescript
export function initInstallArgs(selection: InitSelection): string[] {
  return [
    "kesha",
    "install",
    selection.noCache ? "--no-cache" : "",
    selection.backend === "coreml" ? "--coreml" : "",
    selection.backend === "onnx" ? "--onnx" : "",
    ...(selection.ttsLangs.length > 0 ? ["--tts", ...selection.ttsLangs] : []),
    selection.vad ? "--vad" : "",
    selection.diarize ? "--diarize" : "",
  ].filter(Boolean);
}
```
Update `initSuggestionCommands`, `omitUnsupportedDiarize`, and `printPlan`/`performInstall` call sites to use `ttsLangs` instead of `tts`. In the variants list in `initSuggestionCommands`, replace `tts: false`/`tts: true` with `ttsLangs: []`/`ttsLangs: ["en"]`.

- [ ] **Step 4: Replace the interactive TTS prompt with `@clack/prompts` multiselect**

In `promptInitSelection`, replace the `askYesNo(... "Install text-to-speech ...")` call. Fetch the supported languages from capabilities (fall back to `["en","ru"]` if unavailable), then:
```typescript
import { multiselect, isCancel } from "@clack/prompts";
import { getEngineCapabilities } from "../engine";

const TTS_LANG_LABELS: Record<string, string> = {
  en: "English (Kokoro)",
  es: "Spanish (Kokoro)",
  fr: "French (Kokoro)",
  hi: "Hindi (Kokoro ANE)",
  it: "Italian (Kokoro)",
  ja: "Japanese (Kokoro ANE)",
  pt: "Portuguese (Kokoro)",
  zh: "Chinese (Kokoro ANE)",
  ru: "Russian (Vosk-TTS)",
};

async function promptTtsLangs(preselect: string[]): Promise<string[]> {
  const caps = await getEngineCapabilities();
  const supported = caps?.tts?.languages.map((l) => l.code) ?? ["en", "ru"];
  const selected = await multiselect({
    message: "Select TTS languages to install (space to toggle, enter to confirm; none = skip TTS):",
    options: supported.map((code) => ({
      value: code,
      label: TTS_LANG_LABELS[code] ?? code,
    })),
    initialValues: preselect.filter((l) => supported.includes(l)),
    required: false,
  });
  if (isCancel(selected)) return [];
  return selected as string[];
}
```
Call it in `promptInitSelection`:
```typescript
  const ttsLangs = await promptTtsLangs(args.tts ? ["en"] : []);
```
and return `ttsLangs` in the `InitSelection`. Keep the VAD/diarize `askYesNo` prompts unchanged.

Note: `getEngineCapabilities` requires the engine to be installed. `init` runs before install in the cold case; if capabilities is null, the `["en","ru"]` fallback keeps the picker usable, and the engine re-validates at download time.

- [ ] **Step 5: Update `performInstall` calls in `init.ts`**

`init.ts` calls `performInstall(...)` in the `--yes` and confirmed-interactive branches. Update them to the new `performInstall` signature from Task 7/8 (passing `{ tts: prompted.ttsLangs.length > 0, positionals: prompted.ttsLangs }` or, simpler, give `performInstall` a path that accepts an already-resolved `ttsLangs` — choose ONE: extend `performInstall` to accept resolved `ttsLangs: string[]` directly and have the `install` command call `resolveTtsLangs` before it). Recommended: `performInstall(noCache, backend, ttsLangs, vad, diarize, plan)` taking the resolved list; `install`'s `run` resolves via `resolveTtsLangs`, `init` passes `prompted.ttsLangs` directly. Update Task 7 Step 4/Task 8 Step 4 call shapes to match this resolved-list signature.

- [ ] **Step 6: Run init tests + full TS suite + types**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS, no type errors across the tree.

- [ ] **Step 7: Commit the TS install/init/engine-install set together**

```bash
git add src/cli/init.ts src/cli/install.ts src/engine-install.ts tests/unit/init.test.ts tests/unit/install.test.ts src/__tests__/engine-install.test.ts
git commit -m "feat(cli): init multi-select TTS languages via @clack/prompts (#517)"
```

---

## Task 10: TS — per-language install plan

**Files:**
- Modify: `src/install-plan.ts` (`InstallPlanOptions`, per-language groups, command line)
- Test: `tests/unit/install-plan.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

In `tests/unit/install-plan.test.ts`:
```typescript
test("plan with --tts en omits Vosk RU", async () => {
  const out = await renderInstallPlan({ ttsLangs: ["en"] });
  expect(out).toContain("Kokoro");
  expect(out).not.toContain("Vosk RU");
  expect(out).toContain("--tts en");
});
test("plan with --tts ru omits Kokoro graph component", async () => {
  const out = await renderInstallPlan({ ttsLangs: ["ru"] });
  expect(out).toContain("Vosk RU");
  expect(out).toContain("--tts ru");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/install-plan.test.ts`
Expected: FAIL — `ttsLangs` not on `InstallPlanOptions` / Vosk still present for en.

- [ ] **Step 3: Make the plan language-aware**

In `src/install-plan.ts`:
```typescript
export interface InstallPlanOptions {
  noCache?: boolean;
  backend?: string;
  ttsLangs?: string[];
  vad?: boolean;
  diarize?: boolean;
}
```
Replace the `if (options.tts) { ... }` block with per-language logic. Define which languages map to which packs and add components conditionally:
```typescript
  const ttsLangs = options.ttsLangs ?? [];
  const wantsKokoro = ttsLangs.some((l) => ["en", "es", "fr", "it", "pt"].includes(l));
  const wantsG2p = ttsLangs.some((l) => ["es", "fr", "it", "pt"].includes(l));
  const wantsRu = ttsLangs.includes("ru");

  if (ttsLangs.length > 0) {
    if (isDarwinArm64()) {
      // ANE path: graph auto-downloads (warm-up note); Vosk only if ru.
      if (wantsKokoro) {
        warmups.push({
          name: "TTS Kokoro (ANE)",
          note: `${FLUID_KOKORO_CACHE_NOTE} (${fluidKokoroCachePath()})`,
        });
      }
      if (wantsRu) {
        components.push(bundleComponent(cacheRoot, "TTS Vosk RU", "model cache", VOSK_RU_FILES, noCache, "Russian ru-vosk-* voices"));
      }
    } else {
      if (wantsKokoro) {
        components.push(bundleComponent(cacheRoot, "TTS Kokoro graph + voices", "model cache", kokoroPlanFiles(ttsLangs), noCache, `voices for ${ttsLangs.filter((l) => l !== "ru").join(", ")}`));
      }
      if (wantsG2p) {
        components.push(bundleComponent(cacheRoot, "G2P CharsiuG2P byt5-tiny", "model cache", G2P_CHARSIU_FILES, noCache, "multilingual G2P for es/fr/it/pt (CC-BY 4.0)"));
      }
      if (wantsRu) {
        components.push(bundleComponent(cacheRoot, "TTS Vosk RU", "model cache", VOSK_RU_FILES, noCache, "Russian ru-vosk-* voices"));
      }
    }
  }
```
Add a helper that selects the graph + per-language voice plan files (split `KOKORO_FILES` into the graph and named voices):
```typescript
const KOKORO_GRAPH_FILE: PlanFile = { relPath: "models/kokoro-82m/model.onnx", sizeBytes: 325_532_387 };
const KOKORO_VOICE_FILES: Record<string, PlanFile> = {
  en: { relPath: "models/kokoro-82m/voices/am_michael.bin", sizeBytes: 522_240 },
  es: { relPath: "models/kokoro-82m/voices/em_alex.bin", sizeBytes: 522_240 },
  fr: { relPath: "models/kokoro-82m/voices/ff_siwis.bin", sizeBytes: 522_240 },
  it: { relPath: "models/kokoro-82m/voices/im_nicola.bin", sizeBytes: 522_240 },
  pt: { relPath: "models/kokoro-82m/voices/pm_alex.bin", sizeBytes: 522_240 },
};
function kokoroPlanFiles(langs: string[]): PlanFile[] {
  const files: PlanFile[] = [KOKORO_GRAPH_FILE];
  for (const l of langs) {
    const v = KOKORO_VOICE_FILES[l];
    if (v) files.push(v);
  }
  return files;
}
```
Update the final `command` array builder to emit `--tts <langs>`:
```typescript
  const command = [
    "kesha",
    "install",
    options.noCache ? "--no-cache" : "",
    options.backend === "coreml" ? "--coreml" : "",
    options.backend === "onnx" ? "--onnx" : "",
    ...(ttsLangs.length > 0 ? ["--tts", ...ttsLangs] : []),
    options.vad ? "--vad" : "",
    options.diarize ? "--diarize" : "",
  ].filter(Boolean);
```
Keep the old `KOKORO_FILES` const only if still referenced; otherwise remove it to avoid an unused-variable lint. Update the `--tts && isDarwinArm64()` warm-up note line to check `ttsLangs.length > 0 && wantsKokoro`.

- [ ] **Step 4: Run the plan tests + full suite**

Run: `bun test tests/unit/install-plan.test.ts && bun test && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/install-plan.ts tests/unit/install-plan.test.ts
git commit -m "feat(cli): per-language install plan for --tts <langs> (#517)"
```

---

## Task 11: Docs + end-to-end verification

**Files:**
- Modify: `CLAUDE.md` (TTS section), `docs/tts.md`, `docs/languages.md`

- [ ] **Step 1: Update the docs**

- `CLAUDE.md` TTS section: change "`kesha install --tts` (~990 MB)" guidance to describe language scoping: bare `--tts` = English (~326 MB); `--tts en ru` etc.; note `es/fr/it/pt` on all builds, `hi/ja/zh` darwin-arm64-only, `ru` ~937 MB.
- `docs/tts.md` and `docs/languages.md`: document `kesha install --tts <langs>`, the default (English-only), the platform availability matrix, and that `kesha init` offers a multi-select. Keep all install/upgrade examples in **bun** form (never npm).

- [ ] **Step 2: Full verification sweep**

Run:
```bash
bun test && bunx tsc --noEmit
cd rust && cargo fmt --check && cargo clippy --all-targets --features tts -- -D warnings && cargo nextest run --features tts && cargo check --features coreml --no-default-features
cd ..
```
Expected: all green.

- [ ] **Step 3: Manual smoke (engine built in Task 5)**

Run (English-only install into a temp cache; confirm NO Vosk files appear):
```bash
CACHE=$(mktemp -d)
KESHA_CACHE_DIR="$CACHE" rust/target/debug/kesha-engine install --tts en --no-warmup 2>&1 | tail -5
test ! -d "$CACHE/models/vosk-ru" && echo "OK: no vosk-ru for --tts en"
ls "$CACHE/models/kokoro-82m/voices/" 2>/dev/null
```
Expected: `OK: no vosk-ru for --tts en`; `am_michael.bin` present, no `em_alex.bin`/etc.

- [ ] **Step 4: audio-quality-check gate (rust/src/tts changed)**

Dispatch the `audio-quality-check` agent against a fixed Russian + English corpus to confirm `kesha say` still produces sane audio for `en-am_michael` and `ru-vosk-m02` after the TTS download refactor.

- [ ] **Step 5: Commit docs**

```bash
git add CLAUDE.md docs/tts.md docs/languages.md
git commit -m "docs: document language-scoped TTS install (#517)"
```

- [ ] **Step 6: Push + open PR**

```bash
git push -u origin feat/tts-install-languages
gh pr create --base main --head feat/tts-install-languages \
  --title "Language-scoped TTS install: \`kesha install --tts <langs>\` + init multi-select" \
  --body "Closes #517

Implements the spec at docs/superpowers/specs/2026-06-01-tts-install-languages-design.md.
- \`kesha install --tts en ru\` (Playwright-style positionals); bare \`--tts\` = English only.
- Unsupported-on-platform language → hard error, nothing downloaded.
- \`kesha init\` multi-select via @clack/prompts.
- AVSpeech excluded from install; additive re-runs.
- Engine capabilities (proto v3) advertise installable TTS languages; TS validates against them."
```
Then follow the CLAUDE.md gate: wait for CI + Greptile, address P1/P2, re-push, merge only after both cover the latest head SHA. Remove the `WIP` label when the PR merges.

---

## Self-Review

**Spec coverage:**
- Positional syntax → Task 5 (engine clap `num_args`), Task 7 (TS parsing). ✓
- Bare `--tts` = English → Task 5 (`default_missing_value = "en"`), Task 7 (`["en"]`), Task 9 (init preselect). ✓
- Hard error on unsupported lang → Task 4 (`validate_tts_langs`), Task 7 (`resolveTtsLangs`). ✓
- init multi-select → Task 9. ✓
- Additive re-runs → inherent (`download_verified` short-circuit); no task needed; noted. ✓
- AVSpeech excluded → `tts_languages()` omits `macos`; documented Task 11. ✓
- Many-to-many data model, override deferred → Task 1 (`engines: Vec`), no override parser built. ✓
- Capabilities source of truth, proto bump → Task 1, Task 6. ✓
- ONNX es/fr/it/pt + G2P dependency → Task 2, Task 10. ✓
- darwin hi/ja/zh + ANE per-language staging → Task 1, Task 3. ✓
- Plan rendering per language → Task 10. ✓

**Placeholder scan:** No "TBD"/"handle edge cases" — every code step shows code. The one judgment call (final `performInstall` signature) is resolved explicitly in Task 9 Step 5 (resolved-list signature) and referenced back to Tasks 7/8.

**Type consistency:** `InitSelection.ttsLangs: string[]` (Tasks 9), `InstallOptions.ttsLangs?: string[]` (Task 8), `InstallPlanOptions.ttsLangs?: string[]` (Task 10), `EngineCapabilities.tts?.languages[].code/engines` (Task 6) — consistent. Rust `download_tts(&[&str], bool)` / `stage_ane_kokoro_voices(&[&str], bool)` / `validate_tts_langs(&[&str])` / `tts_languages() -> Vec<&'static str>` — consistent across Tasks 1–5.
