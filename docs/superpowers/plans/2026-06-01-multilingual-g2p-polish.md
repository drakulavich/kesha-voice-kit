# Multilingual G2P Polish Implementation Plan (#511)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix Portuguese/French number connectors, stop word-acronyms from being letter-spelled in es/fr/it/pt, and add Castilian Spanish (θ) via `--lang es-ES` with a spike gate and Latin-American fallback.

**Architecture:** Three deterministic fixes live in `rust/src/tts/normalize/{numbers,acronyms}.rs` (pure functions, exhaustive unit tests, no upstream dependency). Castilian threads a BCP-47 region subtag from the existing `--lang` override through `say_loop`/`say`/`g2p`/`charsiu`, choosing a Castilian G2P tag if the spike (Phase 0) finds one upstream, else degrading to Latin-American with a one-time stderr note.

**Tech Stack:** Rust (`rust/src/tts/**`), `ort` (CharsiuG2P ONNX sessions), `cargo nextest`, a throwaway Python venv for the Phase-0 spike.

**Design doc:** `docs/superpowers/specs/2026-06-01-multilingual-g2p-polish-design.md`

**Working directory:** `.worktrees/mlang-g2p-polish` (branch `feat/mlang-g2p-polish`, off fresh `origin/main`).

**Independence:** Tasks 1–3 are independent of Phase 0 and of each other — they may be implemented and committed in any order. Tasks 4–6 depend on the Phase-0 decision.

**Verification (run before every push, per CLAUDE.md):**
```bash
cd rust && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo nextest run --features tts
```
Use `cargo nextest run`, never plain `cargo test`. If CI-only clippy flags `manual_is_multiple_of`, the repo prefers `x.is_multiple_of(n)` (#224).

---

## Phase 0: Castilian G2P spike (decision gate — blocks Tasks 4–6 only)

**Goal:** Determine whether klebster's CharsiuG2P ByT5-tiny export emits a Castilian θ via a dedicated language tag, or only generic `<spa>` (Latin-American seseo). Records the decision that Tasks 4–6 consume. **No production code in this phase.**

**Files:** none committed. Spike artifacts in `/tmp/castilian-spike/`, deleted after the finding is recorded here.

- [ ] **Step 1: Stage the ONNX export (reuse the existing cache if present)**

The three CharsiuG2P files are already pinned in `rust/src/models.rs` and cached at `~/.cache/kesha/models/g2p/byt5-tiny/` after any `kesha install --tts`. Confirm they exist; if not, the spike can pull them from the klebster HF repo `klebster/g2p_multilingual_byT5_tiny_onnx`.

```bash
ls -la ~/.cache/kesha/models/g2p/byt5-tiny/
# expect: encoder_model.onnx, decoder_model.onnx, decoder_with_past_model.onnx
```

- [ ] **Step 2: Create a throwaway venv and probe the tag vocabulary**

Per CLAUDE.md "PYTHON DEPENDENCIES GO IN A VENV":
```bash
python3 -m venv /tmp/castilian-spike-venv
/tmp/castilian-spike-venv/bin/pip install --quiet onnxruntime transformers
```

The CharsiuG2P training tags are documented in the upstream `charsiu/g2p` README and the ByT5 tokenizer is pure byte-level (no tag is "unknown" — any `<tag>:` string is just bytes). So the real question is **empirical**: does any plausible Castilian tag (`<spa-es>`, `<spa-ib>`, `<spa-eu>`, `<spa-castilian>`) yield θ for θ-words while `<spa>` does not? Run the model end-to-end on a θ corpus and compare.

- [ ] **Step 3: Run the θ probe end-to-end**

Write `/tmp/castilian-spike/probe.py` that loads the three ONNX sessions (mirror `rust/src/tts/charsiu/decode.rs`: encoder once, decoder step 0, decoder_with_past steps 1..N, byte-id encode = `byte + 3`, EOS=1) and phonemizes the corpus `["zapato","cielo","gracias","zorro","cinco"]` under each candidate tag plus baseline `<spa>`.

Expected θ-bearing IPA for Castilian (e.g. `zapato → θaˈpato`, `cielo → ˈθjelo`); LatAm gives `s` (`saˈpato`, `ˈsjelo`).

```bash
/tmp/castilian-spike-venv/bin/python3 /tmp/castilian-spike/probe.py
```

- [ ] **Step 4: Record the decision in this file and clean up**

Fill in **one** of the two outcomes below, commit this plan edit, then `rm -rf /tmp/castilian-spike /tmp/castilian-spike-venv`.

> **SPIKE FINDING (2026-06-01): Outcome B — no native Castilian tag.**
> Probed `zapato / cielo / gracias / zorro / cinco` through the cached klebster export
> (reusing the real `decode::greedy` path) under candidate tags `<spa>`, `<spa-es>`,
> `<spa-me>`, `<spa-latin>`, `<spa-castilian>`, `<spa-ib>`:
> - `<spa>` / `<spa-es>` / `<spa-me>` → **seseo /s/** (`zapato→sapato`, `cielo→sjelo`,
>   `zorro→soro`) — identical to LatAm, no θ.
> - `<spa-latin>` → /s/ with trailing-char hallucination.
> - `<spa-castilian>` → garbage (`cielo→silian`) — tag unrecognized.
> - `<spa-ib>` → literal /z/ + French-like ʁ (`zorro→zoʁo`) — also garbage, not θ.
>
> **No tag yields θ.** Decision: **`CASTILIAN: Castilian = Castilian::Degrade`** — `es-ES`
> synthesizes LatAm `<spa>` with a one-time stderr note. Castilian θ deferred (would need
> a grapheme-driven θ-injection layer — out of scope here, see spec Non-goals). Probe was a
> throwaway gated unit test, reverted (not committed).
>
> _(For reference if a future tag appears — Outcome A would have used
> `CASTILIAN: Castilian = Castilian::Tag("<…>")`.)_

**Decision gate:** Tasks 4–6 reference `CASTILIAN`. Implement the matching branch; both branches are fully specified in Task 4 so the engineer codes only the one the spike selected, but the other compiles too (no dead code — see Task 4 Step 6).

---

## Task 1: Portuguese number connectors

**Files:**
- Modify: `rust/src/tts/normalize/numbers.rs:420-437` (`pt_words`)
- Test: `rust/src/tts/normalize/numbers.rs` (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `numbers.rs`:
```rust
#[test]
fn portuguese_thousands_connector() {
    // "e" joins thousands↔remainder only when remainder < 100 or a multiple of 100.
    assert_eq!(to_words(1024, "pt"), "mil e vinte e quatro");        // rem 24  < 100
    assert_eq!(to_words(1500, "pt"), "mil e quinhentos");           // rem 500 multiple of 100
    assert_eq!(to_words(1100, "pt"), "mil e cem");                  // rem 100 multiple of 100
    assert_eq!(to_words(1524, "pt"), "mil quinhentos e vinte e quatro"); // rem 524 non-round hundreds
    assert_eq!(to_words(2350, "pt"), "dois mil trezentos e cinquenta"); // rem 350 non-round hundreds
    assert_eq!(to_words(2000, "pt"), "dois mil");                   // no remainder
    assert_eq!(to_words(24, "pt"), "vinte e quatro");               // no thousands group
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd rust && cargo nextest run --features tts numbers::tests::portuguese_thousands_connector`
Expected: FAIL — `to_words(1524, "pt")` returns `"mil e quinhentos e vinte e quatro"` (extra "e").

- [ ] **Step 3: Implement the conditional connector**

Replace the body of `pt_words` (currently ending in `parts.join(" e ")`) with:
```rust
fn pt_words(n: u32) -> String {
    if n == 0 {
        return "zero".into();
    }
    let (thousands, rem) = (n / 1000, n % 1000);
    let mut parts: Vec<String> = Vec::new();
    if thousands > 0 {
        if thousands == 1 {
            parts.push("mil".into());
        } else {
            parts.push(format!("{} mil", pt_under_1000(thousands)));
        }
    }
    if rem > 0 {
        parts.push(pt_under_1000(rem));
    }
    // Portuguese inserts "e" between the thousands group and the remainder only
    // when the remainder is < 100 OR an exact multiple of 100; otherwise the
    // groups are joined with a plain space.
    //   1024 -> "mil e vinte e quatro"             (rem 24, < 100)
    //   1500 -> "mil e quinhentos"                 (rem 500, multiple of 100)
    //   1524 -> "mil quinhentos e vinte e quatro"  (rem 524, non-round hundreds)
    if parts.len() == 2 {
        let connector = if rem < 100 || rem.is_multiple_of(100) {
            " e "
        } else {
            " "
        };
        format!("{}{}{}", parts[0], connector, parts[1])
    } else {
        // 0 or 1 part: nothing to connect.
        parts.join(" ")
    }
}
```
Note: `rem.is_multiple_of(100)` is the repo-preferred form (#224). If the local toolchain rejects it, use `rem % 100 == 0` and expect CI clippy to ask for the change.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd rust && cargo nextest run --features tts numbers::tests::portuguese_thousands_connector`
Expected: PASS. Also run the existing `numbers::tests::large_numbers_do_not_panic` to confirm no regression.

- [ ] **Step 5: Commit**
```bash
git add rust/src/tts/normalize/numbers.rs
git commit -m "fix(tts): correct Portuguese thousands connector (#511)"
```

---

## Task 2: French 71 connector ("soixante-et-onze")

**Files:**
- Modify: `rust/src/tts/normalize/numbers.rs:135-138` (the `70..=79` arm of `fr_under_100`)
- Test: `rust/src/tts/normalize/numbers.rs` (`#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing test**

Add to the `tests` module:
```rust
#[test]
fn french_seventy_one_takes_et() {
    // 71 is the one value in 70-79 that takes the "et" connector (like 21/31/.../61).
    assert_eq!(to_words(71, "fr"), "soixante-et-onze");
    // Controls: the rest of 70-79 stay hyphenated without "et".
    assert_eq!(to_words(72, "fr"), "soixante-douze");
    assert_eq!(to_words(79, "fr"), "soixante-dix-neuf");
    // 80s/90s never take "et".
    assert_eq!(to_words(81, "fr"), "quatre-vingt-un");
    assert_eq!(to_words(91, "fr"), "quatre-vingt-onze");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd rust && cargo nextest run --features tts numbers::tests::french_seventy_one_takes_et`
Expected: FAIL — `to_words(71, "fr")` returns `"soixante-onze"` (no "et").

- [ ] **Step 3: Special-case 71 in the 70..=79 arm**

In `fr_under_100`, replace the `70..=79` arm:
```rust
        // 70-79 = soixante + 10..19
        70..=79 => {
            let sub = FR_UNITS[(n - 60) as usize];
            // 71 takes the "et" connector (soixante-et-onze), mirroring
            // vingt-et-un/.../soixante-et-un. 72-79 stay plain-hyphenated.
            if n == 71 {
                "soixante-et-onze".to_string()
            } else {
                format!("soixante-{sub}")
            }
        }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd rust && cargo nextest run --features tts numbers::tests::french_seventy_one_takes_et`
Expected: PASS. Run the existing `french_integers` test to confirm no regression.

- [ ] **Step 5: Commit**
```bash
git add rust/src/tts/normalize/numbers.rs
git commit -m "fix(tts): French 71 takes the 'et' connector (#511)"
```

---

## Task 3: Per-language acronym stop-lists

**Files:**
- Modify: `rust/src/tts/normalize/acronyms.rs` (add stop-list consts + consult them in `spell`/the spell path)
- Test: `rust/src/tts/normalize/acronyms.rs` (`#[cfg(test)] mod tests`)

Mirrors the English path (`rust/src/tts/en/acronym.rs:24` `STOP_LIST` + its `every_stop_list_entry_round_trips` test).

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `acronyms.rs`:
```rust
#[test]
fn stop_listed_word_acronyms_pass_through_unspelled() {
    // Word-acronyms read as words must NOT be letter-spelled.
    assert_eq!(spell("OTAN", "es"), "OTAN");
    assert_eq!(spell("OVNI", "es"), "OVNI");
    assert_eq!(spell("FIFA", "fr"), "FIFA");
    assert_eq!(spell("FIAT", "it"), "FIAT");
    assert_eq!(spell("SIDA", "pt"), "SIDA");
    // True initialisms still spell letter-by-letter.
    assert_eq!(spell("DNI", "es"), "de ene i");
    // Cross-language isolation: an es-only entry does not suppress under it.
    // "OEA" is es/pt-list only; under "it" it letter-spells.
    assert_eq!(spell("OEA", "it"), "o e a");
}

#[test]
fn every_stop_list_entry_passes_through() {
    for (lang, list) in [
        ("es", ES_STOP_LIST),
        ("fr", FR_STOP_LIST),
        ("it", IT_STOP_LIST),
        ("pt", PT_STOP_LIST),
    ] {
        for w in list {
            assert_eq!(spell(w, lang), *w, "stop-list entry was spelled: {w} ({lang})");
        }
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd rust && cargo nextest run --features tts acronyms::tests`
Expected: FAIL — `spell("OTAN","es")` returns `"o te a ene"` (letter-spelled); `ES_STOP_LIST` is undefined (compile error is acceptable as the failing state).

- [ ] **Step 3: Add the stop-list consts**

Add near the top of `acronyms.rs` (after the letter-name tables):
```rust
// ── Stop-lists: all-caps tokens that are read as WORDS, not spelled out ──────
// Hand-curated seeds, case-sensitive ALL-CAPS keys. NOT exhaustive — extend by
// ear. Mirrors `tts/en/acronym.rs::STOP_LIST`. Initialisms that SHOULD spell
// (DNI, ADN, RAI, EUA) are deliberately absent.
pub(crate) const ES_STOP_LIST: &[&str] =
    &["OTAN", "OVNI", "SIDA", "OPEP", "OEA", "ONU", "UNESCO", "FIFA", "OMS"];
pub(crate) const FR_STOP_LIST: &[&str] =
    &["OTAN", "OVNI", "SIDA", "UNESCO", "FIFA", "OPEP", "ONU", "OMS"];
pub(crate) const IT_STOP_LIST: &[&str] =
    &["FIAT", "NATO", "FIFA", "AIDS", "UNESCO", "ONU"];
pub(crate) const PT_STOP_LIST: &[&str] =
    &["OTAN", "OVNI", "SIDA", "AIDS", "FIFA", "UNESCO", "ONU", "OMS"];

/// True if `token` is in `lang`'s stop-list (read as a word, not letter-spelled).
fn is_stop_listed(token: &str, lang: &str) -> bool {
    let list: &[&str] = match lang {
        "es" => ES_STOP_LIST,
        "fr" => FR_STOP_LIST,
        "it" => IT_STOP_LIST,
        "pt" => PT_STOP_LIST,
        _ => &[],
    };
    list.iter().any(|w| w.eq_ignore_ascii_case(token))
}
```

- [ ] **Step 4: Consult the stop-list in `spell`**

At the very top of the existing `pub fn spell(token: &str, lang: &str) -> String` body, before the per-language letter-name match, add:
```rust
    // Word-acronyms (read as words) pass through unspelled.
    if is_stop_listed(token, lang) {
        return token.to_string();
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd rust && cargo nextest run --features tts acronyms::tests`
Expected: PASS (all, including the existing `spells_acronyms_with_spanish_letter_names` and `spells_italian_acronyms_including_jkwxy`).

- [ ] **Step 6: Commit**
```bash
git add rust/src/tts/normalize/acronyms.rs
git commit -m "feat(tts): per-language acronym stop-lists for es/fr/it/pt (#511)"
```

---

## Task 4: Castilian dialect — region parsing + G2P tag selection

**Files:**
- Modify: `rust/src/tts/charsiu/mod.rs:43-74` (`Charsiu::to_ipa` tag selection)
- Create: a small `castilian` helper (region parsing + the spike decision) inside `rust/src/tts/charsiu/mod.rs` or `rust/src/tts/normalize/mod.rs`
- Test: `rust/src/tts/charsiu/mod.rs` (`#[cfg(test)] mod tests`)

**Depends on:** Phase 0 `CASTILIAN` decision.

- [ ] **Step 1: Write the failing test for region parsing**

Add to the `charsiu` tests module:
```rust
#[test]
fn castilian_region_detection() {
    // Region subtag drives Castilian; base/LatAm regions do not.
    assert!(is_castilian_region("es-ES"));
    assert!(is_castilian_region("es-es"));      // case-insensitive
    assert!(!is_castilian_region("es"));
    assert!(!is_castilian_region("es-419"));
    assert!(!is_castilian_region("es-MX"));
    assert!(!is_castilian_region("fr"));        // non-Spanish never Castilian
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd rust && cargo nextest run --features tts charsiu::tests::castilian_region_detection`
Expected: FAIL — `is_castilian_region` undefined.

- [ ] **Step 3: Implement region parsing + base-lang split**

Add to `charsiu/mod.rs`:
```rust
/// True when an espeak-style lang code selects Castilian Spanish (e.g. "es-ES").
/// LatAm regions ("es", "es-419", "es-MX", …) and non-Spanish codes are false.
pub(crate) fn is_castilian_region(lang: &str) -> bool {
    let lower = lang.to_ascii_lowercase();
    matches!(lower.as_str(), "es-es") || lower.starts_with("es-es-")
}

/// Reduce a (possibly region-tagged) code to the base lang Charsiu understands:
/// "es-ES"/"es-419"/"es-MX" → "es"; "pt-br" → "pt"; passthrough otherwise.
pub(crate) fn base_lang(lang: &str) -> &str {
    match lang.split('-').next() {
        Some(b) if matches!(b.to_ascii_lowercase().as_str(), "es" | "fr" | "it" | "pt") => b,
        _ => lang,
    }
}
```

- [ ] **Step 4: Add the spike-derived Castilian decision**

Add the `CASTILIAN` constant per the Phase-0 finding:
```rust
/// Spike-derived (#511 Phase 0): how to realize Castilian θ.
enum Castilian {
    /// Native CharsiuG2P tag that emits θ (Outcome A). Holds the tag string.
    Tag(&'static str),
    /// No upstream Castilian tag (Outcome B). `es-ES` degrades to LatAm `<spa>`
    /// with a one-time stderr note.
    Degrade,
}

// FILL IN from the Phase-0 finding (exactly one):
//   const CASTILIAN: Castilian = Castilian::Tag("<spa-es>");   // Outcome A
//   const CASTILIAN: Castilian = Castilian::Degrade;           // Outcome B
const CASTILIAN: Castilian = Castilian::Degrade;
```

- [ ] **Step 5: Thread the dialect into `to_ipa`**

Change `Charsiu::to_ipa` to accept the full (region-tagged) lang and pick the tag:
```rust
    #[allow(clippy::wrong_self_convention)]
    pub fn to_ipa(&mut self, text: &str, lang: &str) -> Result<String> {
        let castilian = is_castilian_region(lang);
        let tag = match base_lang(lang) {
            "es" => match (&CASTILIAN, castilian) {
                (Castilian::Tag(t), true) => t,
                (Castilian::Degrade, true) => {
                    // User-facing, one-time per process (survives --stdin-loop).
                    use std::sync::Once;
                    static NOTE: Once = Once::new();
                    NOTE.call_once(|| {
                        eprintln!(
                            "note: Castilian (θ) pronunciation is unavailable; \
                             using Latin-American Spanish."
                        );
                    });
                    "<spa>"
                }
                _ => "<spa>",
            },
            "fr" => "<fra>",
            "it" => "<ita>",
            "pt" => "<por-bz>",
            other => anyhow::bail!("CharsiuG2P: unsupported language {other:?}"),
        };
        // … unchanged per-word decode loop using `tag` …
    }
```

- [ ] **Step 6: Avoid dead-code lint on the unused `Castilian` variant**

Because only one `CASTILIAN` value ships, the other enum variant is unreferenced and `-D warnings` will fail (`dead_code`). Annotate the enum with a justification (allowed per CLAUDE.md "NO SPECULATIVE FIELDS"):
```rust
/// Spike-derived (#511 Phase 0): how to realize Castilian θ. Both variants are
/// part of the documented decision surface; only one is selected per build.
#[allow(dead_code)] // the non-selected variant is the documented alternative outcome
enum Castilian { /* … */ }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd rust && cargo nextest run --features tts charsiu::tests`
Expected: PASS. The existing gated `to_ipa_phonemizes_when_model_available` still passes (it calls `to_ipa("…","fr")` etc., unaffected).

- [ ] **Step 8: Commit**
```bash
git add rust/src/tts/charsiu/mod.rs
git commit -m "feat(tts): Castilian region parsing + G2P tag selection (#511)"
```

---

## Task 5: Wire `--lang es-ES` through the synth paths

**Files:**
- Modify: `rust/src/tts/g2p.rs:24` (Romance routing match — accept region-tagged es)
- Modify: `rust/src/tts/g2p.rs:71-78` (`charsiu_ipa` passes the full lang through)
- Modify: `rust/src/say_loop.rs:271` (CharsiuCache branch match — accept region-tagged es)
- Modify: `rust/src/tts/sessions.rs:200-207` (`CharsiuCache::to_ipa` keeps the region tag)
- Test: `rust/src/tts/g2p.rs` (`#[cfg(test)] mod tests`)

**Depends on:** Task 4.

- [ ] **Step 1: Write the failing test**

Add to `g2p.rs` tests:
```rust
#[test]
fn castilian_region_routes_to_charsiu() {
    // "es-ES" must route to CharsiuG2P (not bail to the misaki/#212 path).
    match text_to_ipa("cielo", "es-ES") {
        Ok(ipa) => assert!(!ipa.is_empty(), "es-ES: empty IPA"),
        Err(e) => {
            let m = e.to_string();
            assert!(m.contains("install") || m.contains("G2P"), "es-ES unexpected: {m}");
            assert!(!m.contains("not supported in this build"), "es-ES bailed to #212: {m}");
        }
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd rust && cargo nextest run --features tts g2p::tests::castilian_region_routes_to_charsiu`
Expected: FAIL — "es-es" misses the `matches!(lower, "es"|"fr"|"it"|"pt")` guard and bails with the #212 message.

- [ ] **Step 3: Accept region-tagged Romance codes in `text_to_ipa`**

In `g2p.rs`, replace the Romance guard (line ~24) to test the **base** language and pass the full code to Charsiu:
```rust
    // Romance languages: normalize then CharsiuG2P (ONNX ByT5-tiny, #212).
    // Region subtags (e.g. "es-ES" for Castilian) are preserved for tag choice.
    let base = crate::tts::charsiu::base_lang(&lower);
    if matches!(base, "es" | "fr" | "it" | "pt") {
        crate::dtrace!("g2p::route lang={lang} backend=charsiu text_chars={text_chars}");
        let dir = crate::models::cache_dir().join("models/g2p/byt5-tiny");
        check_charsiu_files(&dir)?;
        let mut g = crate::tts::charsiu::Charsiu::load(&dir)?;
        let ipa = charsiu_ipa(&mut g, text, &lower)?; // pass full code (region-aware)
        crate::dtrace!("g2p::result ipa_chars={}", ipa.chars().count());
        return Ok(ipa);
    }
```
And in `charsiu_ipa`, normalize with the **base** lang but phonemize with the **full** code:
```rust
pub(crate) fn charsiu_ipa(
    g: &mut crate::tts::charsiu::Charsiu,
    text: &str,
    lang: &str,
) -> Result<String> {
    let base = crate::tts::charsiu::base_lang(lang);
    let normalized = crate::tts::normalize::normalize(text, base);
    g.to_ipa(&normalized, lang) // full code so to_ipa sees the region subtag
}
```
(`normalize` only matches bare `"es"|"fr"|"it"|"pt"`, so it must receive `base`, not `"es-ES"`.)

- [ ] **Step 4: Accept region-tagged es in the cached loop path**

In `say_loop.rs:271`, change the CharsiuCache guard to test the base language:
```rust
                let ipa = if matches!(
                    crate::tts::charsiu::base_lang(espeak_lang),
                    "es" | "fr" | "it" | "pt"
                ) {
                    state
                        .charsiu
                        .to_ipa(&state.cache_dir, &req.text, espeak_lang) // full code
                        // … unchanged …
```
Confirm `CharsiuCache::to_ipa` (`sessions.rs:200-207`) forwards `lang` unchanged to `charsiu_ipa` (it already does: `super::g2p::charsiu_ipa(g, text, lang)`), so no change there beyond passing the region-tagged `espeak_lang`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd rust && cargo nextest run --features tts g2p::tests::castilian_region_routes_to_charsiu`
Expected: PASS. Also run `g2p::tests::romance_langs_route_to_charsiu_not_212_bail` and the full `cargo nextest run --features tts` to confirm no regression.

- [ ] **Step 6: Commit**
```bash
git add rust/src/tts/g2p.rs rust/src/say_loop.rs rust/src/tts/sessions.rs
git commit -m "feat(tts): route --lang es-ES through CharsiuG2P (#511)"
```

---

## Task 6: Docs + audio regression fixture

**Files:**
- Modify: `rust/fixtures/tts/multilang_corpus.json` (add es-ES θ, PT 4-digit, FR-71 lines)
- Modify: `CLAUDE.md` (TTS section — `es-ES` lever + degrade note)
- Modify: `docs/runbooks/tts-internals.md` (Castilian + stop-list seeds)

- [ ] **Step 1: Add regression lines to the corpus fixture**

`rust/fixtures/tts/multilang_corpus.json` is a `{ lang: [sentences] }` map, and the
harness (`rust/tests/tts_multilang_audio.rs`) keys on the lang via `default_voice(lang)`,
which `panic!`s on unknown keys. So **do not** add an `"es-ES"` key — append the new
sentences to the existing `"pt"` and `"fr"` arrays (exercises the PT connector + FR-71 fixes
through the unchanged harness). Castilian θ is covered by the audio-quality-check agent in
Step 4, not here — the structural test (RMS/silence/rate/length) cannot distinguish θ from
s anyway.

Edit the file to:
```json
{
  "es": ["El veloz murciélago hindú comía feliz cardillo y kiwi.", "Compré 27 libros y el código ISBN empezaba por X."],
  "fr": ["Un bon vin blanc, un grand pont, enfin les enfants chantent.", "Il a soixante-et-onze ans et lit le journal."],
  "it": ["Ma la volpe col suo balzo ha raggiunto il quieto Fido."],
  "pt": ["Um pequeno jabuti xereta viu dez cegonhas felizes.", "O documento data do ano de mil quinhentos e vinte e quatro."]
}
```

- [ ] **Step 2: Run the gated audio-regression test**

Run: `cd rust && CHARSIU_ONNX=~/.cache/kesha/models/g2p/byt5-tiny cargo nextest run --features tts tts_multilang_audio`
Expected: PASS (no-clip / 24 kHz / RMS / length within bounds) for all four langs incl. the
two new sentences. If models are absent the test self-skips with an `eprintln!` (Gate 1/2);
in that case note the skip in the commit message and rely on the agent in Step 4.

- [ ] **Step 3: Update docs**

In `CLAUDE.md` TTS section, add after the multilingual paragraph:
```markdown
Castilian Spanish (θ / *distinción*) is selectable with `--lang es-ES`; `es` /
`es-419` / `es-MX` use Latin-American (*seseo*). [If Outcome B shipped:] When the
upstream G2P lacks a Castilian tag, `es-ES` synthesizes Latin-American phonology
and prints a one-time stderr note.
```
In `docs/runbooks/tts-internals.md`, document `is_castilian_region`/`base_lang`, the `CASTILIAN` decision, and that the acronym stop-lists (`ES/FR/IT/PT_STOP_LIST`) are curated seeds, not exhaustive.

- [ ] **Step 4: Generate samples and run the audio-quality-check agent**

Build the debug engine and synthesize the three new lines plus an es-ES vs es contrast (`zapato`, `cielo`), then dispatch the `audio-quality-check` agent over the WAVs (RMS/silence/clip/rate/length). Record the verdict in the PR body.

- [ ] **Step 5: Commit**
```bash
git add rust/fixtures/tts/multilang_corpus.json CLAUDE.md docs/runbooks/tts-internals.md
git commit -m "docs(tts): document es-ES dialect + add regression fixtures (#511)"
```

---

## Final steps (after all tasks)

- [ ] **Full gate:** `cd rust && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo nextest run --features tts`
- [ ] **CoreML guard** (Task 4/5 touch `tts` modules, not `backend`, but `charsiu`/`g2p` compile under both feature sets): `cd rust && cargo check --features coreml --no-default-features`
- [ ] **Open PR:** `gh pr create --base main --head feat/mlang-g2p-polish` with body `Closes #511, Refs #212`, the Phase-0 spike finding (Outcome A/B), and the audio-quality-check verdict. Add the `WIP` label when starting (`gh issue edit 511 --add-label WIP`).
- [ ] **Greptile gate:** wait for CI + Greptile on the head SHA; address P1/P2; re-wait after each push (per CLAUDE.md "GREPTILE PR REVIEW IS A GATE").
