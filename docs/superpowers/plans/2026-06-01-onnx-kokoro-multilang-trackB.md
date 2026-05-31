# Multilingual Kokoro on ONNX (es/fr/it/pt) — Track B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the ONNX TTS path real per-language G2P for Spanish, French, Italian, Portuguese so `kesha say --voice {es,fr,it,pt}-*` produces natural (not English-accented, not digit-collapsed) speech.

**Architecture:** A new `tts::charsiu` ONNX G2P engine (ByT5-tiny exported to ONNX, byte tokenizer, greedy autoregressive decode on the existing `ort`) feeding the existing Kokoro tokenizer/session, with a per-language `tts::normalize` pass (numbers + acronyms) ahead of it. Routing/model-pin wiring in `voices.rs`/`models.rs`. English (misaki) and the CoreML path are untouched.

**Tech Stack:** Rust (`ort`, `ndarray`), the existing `tts::{tokenizer, kokoro}`, a disposable Python venv for the Phase 0 export/spike, `cargo nextest`.

**Spec:** `docs/superpowers/specs/2026-06-01-onnx-kokoro-multilang-trackB-implementation-design.md`
**Predecessor spike:** PR #507 (`spike/onnx-kokoro-multilang-g2p`).
**Tracking issue:** #212

> **Spike-gated plan.** Phase 0 is a hard gate. It writes a findings file `docs/superpowers/specs/charsiu-onnx-contract.md` recording the concrete ONNX IO contract — encoder/decoder input+output tensor names, the byte-token special-id offset, EOS id, and the per-language tag strings. **Phases 1+ reference those recorded values.** If Phase 0 fails (export infeasible, decode can't reproduce the Python IPA, or latency unacceptable for interactive `kesha say`), STOP and re-brainstorm the offline-lexicon fallback — do not proceed into Phase 1.

> **Path note:** `Run:` blocks use this worktree (`/Users/anton/Personal/repos/kesha-voice-kit/.worktrees/trackb-impl`) and the scratch dir `/tmp/charsiu-onnx-spike/`. Substitute your own roots if re-running elsewhere.

---

## Phase 0 — Feasibility + latency spike (GATE)

### Task 0.1: Export CharsiuG2P ByT5 to ONNX

**Files:**
- Create: `/tmp/charsiu-onnx-spike/export.sh` (scratch, not committed)

- [ ] **Step 1: Disposable venv (CLAUDE.md: never system-wide)**

Run:
```bash
mkdir -p /tmp/charsiu-onnx-spike
python3 -m venv /tmp/charsiu-onnx-spike/venv
/tmp/charsiu-onnx-spike/venv/bin/pip install --quiet "optimum[exporters]" transformers onnxruntime
echo ok
```
Expected: `ok`.

- [ ] **Step 2: Export the model to ONNX**

Run:
```bash
/tmp/charsiu-onnx-spike/venv/bin/optimum-cli export onnx \
  --model charsiu/g2p_multilingual_byT5_tiny_16_layers_100 \
  --task text2text-generation \
  /tmp/charsiu-onnx-spike/onnx/
ls /tmp/charsiu-onnx-spike/onnx/
```
Expected: an `encoder_model.onnx` + `decoder_model.onnx` (and possibly `decoder_with_past_model.onnx`), plus `config.json`. If the export errors, record the failure in the findings file and STOP (gate fail).

- [ ] **Step 3: Record the IO contract**

Run (inspect tensor names + special tokens):
```bash
/tmp/charsiu-onnx-spike/venv/bin/python3 - <<'PY'
import onnxruntime as ort, json, pathlib
base = pathlib.Path("/tmp/charsiu-onnx-spike/onnx")
for f in ["encoder_model.onnx","decoder_model.onnx"]:
    s = ort.InferenceSession(str(base/f))
    print(f"== {f} ==")
    print(" inputs :", [(i.name, i.shape) for i in s.get_inputs()])
    print(" outputs:", [(o.name, o.shape) for o in s.get_outputs()])
cfg = json.loads((base/"config.json").read_text())
print("eos_token_id:", cfg.get("eos_token_id"), "decoder_start_token_id:", cfg.get("decoder_start_token_id"), "pad:", cfg.get("pad_token_id"), "vocab_size:", cfg.get("vocab_size"))
PY
```
Expected: prints the encoder/decoder input+output names, EOS id, decoder-start id, vocab size. **Write these into `docs/superpowers/specs/charsiu-onnx-contract.md`** along with the ByT5 byte-offset (3) and the per-language tag strings (`<spa>`, `<fra>`, `<ita>`, `<por-bz>` — confirm against the spike's `spike/charsiu_g2p.py` on PR #507).

### Task 0.2: Prove a Rust/ort greedy decode reproduces the Python IPA

**Files:**
- Create: `rust/examples/charsiu_spike.rs` (throwaway; removed before the feature PR)

- [ ] **Step 1: Write a minimal greedy-decode example using the recorded contract**

Implement: byte-tokenize `"<spa> hola"` (UTF-8 bytes + offset 3, append EOS), run encoder once, loop decoder (start token → argmax → append → until EOS/maxlen), map output ids back to bytes→UTF-8 IPA. Use the exact tensor names from `charsiu-onnx-contract.md`.

- [ ] **Step 2: Build and run on the spike corpus**

Run:
```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/trackb-impl/rust
cargo run --example charsiu_spike --features onnx -- /tmp/charsiu-onnx-spike/onnx "hola mundo"
```
Expected: an IPA string (e.g. `ola mundo`-like phonemes). Compare against the Python `transformers` output for the same words; they must match.

- [ ] **Step 3: Latency check**

Run the example over the 16-sentence corpus (es/fr/it/pt) and print total + per-utterance ms.
Expected: record the number. **Gate:** if a typical sentence takes longer than ~300 ms of pure G2P, flag it — the findings file records whether latency is acceptable for interactive `kesha say` or whether the lexicon fallback is needed.

- [ ] **Step 4: Record the gate decision + clean up**

Append to `charsiu-onnx-contract.md`: feasibility (export ✅/❌), IPA match (✅/❌), latency (ms). Commit the findings file. Then `rm rust/examples/charsiu_spike.rs` (throwaway) and commit its removal. If any gate failed → STOP, re-brainstorm the lexicon approach.

```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/trackb-impl
git add docs/superpowers/specs/charsiu-onnx-contract.md
git commit -m "spike(tts): record CharsiuG2P ONNX IO contract + feasibility (refs #212)"
```

---

## Phase 1 — `charsiu` ONNX G2P engine

### Task 1.1: ByT5 byte tokenizer

**Files:**
- Create: `rust/src/tts/charsiu/mod.rs` (module decl + re-exports)
- Create: `rust/src/tts/charsiu/tokenizer.rs`
- Modify: `rust/src/tts/mod.rs` (add `pub(crate) mod charsiu;` under the `tts` feature)
- Test: inline `#[cfg(test)]` in `tokenizer.rs`

- [ ] **Step 1: Write the failing test**

In `tokenizer.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_ascii_as_bytes_plus_offset_with_eos() {
        // ByT5: token id = byte value + BYTE_OFFSET (3); EOS appended.
        let ids = encode_with_tag("hi", "<spa>");
        // "<spa>" tag is encoded as its UTF-8 bytes too, then a space, then "hi".
        assert_eq!(*ids.last().unwrap(), EOS_ID);
        // 'h'=104 -> 107, 'i'=105 -> 108 appear in order somewhere before EOS.
        let win = ids.windows(2).any(|w| w == [107, 108]);
        assert!(win, "expected h,i byte tokens: {ids:?}");
    }

    #[test]
    fn decodes_byte_ids_back_to_utf8() {
        let s = decode(&[107, 108]); // 104,105 after removing offset
        assert_eq!(s, "hi");
    }

    #[test]
    fn decode_skips_special_ids() {
        // ids below BYTE_OFFSET (pad/eos/bos) are not literal bytes.
        assert_eq!(decode(&[EOS_ID, 107, 108]), "hi");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd rust && cargo nextest run --features tts charsiu::tokenizer 2>&1 | tail`
Expected: FAIL (module/functions not defined).

- [ ] **Step 3: Implement the tokenizer**

In `tokenizer.rs` (constants from `charsiu-onnx-contract.md`):
```rust
//! ByT5 byte-level tokenizer for CharsiuG2P. ByT5 maps each UTF-8 byte to
//! `byte + BYTE_OFFSET`; the first ids are reserved (pad/eos/unk). No
//! sentencepiece — encode/decode are pure byte arithmetic.

/// ByT5 reserves ids 0..3 (pad=0, eos=1, unk=2) and offsets bytes by 3.
pub const BYTE_OFFSET: i64 = 3;
/// EOS token id (confirmed in charsiu-onnx-contract.md).
pub const EOS_ID: i64 = 1;

/// Encode `tag` + space + `text` into ByT5 byte ids with a trailing EOS.
pub fn encode_with_tag(text: &str, tag: &str) -> Vec<i64> {
    let mut ids: Vec<i64> = format!("{tag} {text}")
        .bytes()
        .map(|b| b as i64 + BYTE_OFFSET)
        .collect();
    ids.push(EOS_ID);
    ids
}

/// Decode generated ids back to a UTF-8 string, dropping reserved ids.
pub fn decode(ids: &[i64]) -> String {
    let bytes: Vec<u8> = ids
        .iter()
        .filter(|&&id| id >= BYTE_OFFSET)
        .map(|&id| (id - BYTE_OFFSET) as u8)
        .collect();
    String::from_utf8_lossy(&bytes).trim().to_string()
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo nextest run --features tts charsiu::tokenizer 2>&1 | tail`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add rust/src/tts/charsiu/ rust/src/tts/mod.rs
git commit -m "feat(tts): ByT5 byte tokenizer for CharsiuG2P (refs #212)"
```

### Task 1.2: IPA-remap table (ported from spike, locked by regression test)

**Files:**
- Create: `rust/src/tts/charsiu/remap.rs`
- Modify: `rust/src/tts/charsiu/mod.rs` (`mod remap;`)
- Test: inline in `remap.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_tie_bar_affricates() {
        // t͡s -> ʦ, t͡ʃ -> ʧ, d͡ʒ -> ʤ (tie bar U+0361 consumed by the rule)
        assert_eq!(remap("a t͡s b"), "a ʦ b");
        assert_eq!(remap("d͡ʒusto"), "ʤusto");
        assert_eq!(remap("t͡ʃiko"), "ʧiko");
    }

    #[test]
    fn normalizes_latin_g_to_script_g() {
        assert_eq!(remap("gato"), "ɡato"); // U+0067 -> U+0261
    }

    #[test]
    fn decomposes_precomposed_nasals_to_nfd() {
        // õ U+00F5 -> o + U+0303 ; same for ũ ẽ
        assert_eq!(remap("õ"), "o\u{0303}");
        assert_eq!(remap("ũ"), "u\u{0303}");
        assert_eq!(remap("ẽ"), "e\u{0303}");
    }

    #[test]
    fn remapped_output_has_zero_oov_vs_kokoro_vocab() {
        let vocab = crate::tts::tokenizer::Tokenizer::load().unwrap();
        // Sample CharsiuG2P-style strings exercising every OOV class.
        for s in ["t͡salat͡so", "d͡ʒusto", "gato", "kõsiderasõw", "t͡ʃiko"] {
            let mapped = remap(s);
            let ids = vocab.encode(&mapped);
            // encode drops unknowns; require it kept every non-space char.
            let nonspace = mapped.chars().filter(|c| !c.is_whitespace()).count();
            assert_eq!(ids.len(), nonspace, "OOV leaked for {s:?} -> {mapped:?}");
        }
    }
}
```

> Note: `Tokenizer::encode` is `pub` (confirmed in spike). If `encode` length-vs-char comparison needs a space-aware count, keep spaces out of the assertion as above.

- [ ] **Step 2: Run to verify it fails**

Run: `cd rust && cargo nextest run --features tts charsiu::remap 2>&1 | tail`
Expected: FAIL.

- [ ] **Step 3: Implement remap**

```rust
//! CharsiuG2P → Kokoro-vocab IPA remap. Ported from the spike (PR #507).
//! CharsiuG2P emits a few symbols Kokoro's vocab lacks; map them to the
//! in-vocab equivalents. Locked by a zero-residual-OOV regression test.

/// Remap CharsiuG2P IPA into Kokoro's phoneme inventory.
pub fn remap(ipa: &str) -> String {
    // Order matters: collapse tie-bar affricates before stripping stray ties.
    let s = ipa
        .replace("t͡s", "ʦ")
        .replace("t͡ʃ", "ʧ")
        .replace("d͡ʒ", "ʤ")
        .replace('\u{0067}', "\u{0261}") // Latin g -> script ɡ
        .replace('õ', "o\u{0303}")
        .replace('ũ', "u\u{0303}")
        .replace('ẽ', "e\u{0303}")
        .replace('\u{0361}', ""); // drop any residual standalone tie bar
    s
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo nextest run --features tts charsiu::remap 2>&1 | tail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust/src/tts/charsiu/remap.rs rust/src/tts/charsiu/mod.rs
git commit -m "feat(tts): CharsiuG2P IPA->Kokoro-vocab remap with zero-OOV regression (refs #212)"
```

### Task 1.3: Greedy decode + engine entrypoint

**Files:**
- Create: `rust/src/tts/charsiu/decode.rs`
- Modify: `rust/src/tts/charsiu/mod.rs` (`to_ipa` entrypoint)
- Test: inline (gated on a `CHARSIU_ONNX` env var like `kokoro.rs`'s `KOKORO_MODEL` pattern, so default CI stays fast)

- [ ] **Step 1: Write the gated integration test**

In `mod.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// Gated on CHARSIU_ONNX (dir with encoder_model.onnx/decoder_model.onnx).
    #[test]
    fn to_ipa_phonemizes_spanish_when_model_available() {
        let Some(dir) = std::env::var_os("CHARSIU_ONNX") else {
            eprintln!("CHARSIU_ONNX not set; skipping");
            return;
        };
        let mut g = Charsiu::load(Path::new(&dir)).unwrap();
        let ipa = g.to_ipa("hola mundo", "es").unwrap();
        assert!(!ipa.is_empty(), "empty IPA");
        // remap guarantees vocab membership:
        let vocab = crate::tts::tokenizer::Tokenizer::load().unwrap();
        let nonspace = ipa.chars().filter(|c| !c.is_whitespace()).count();
        assert_eq!(vocab.encode(&ipa).len(), nonspace, "OOV leaked: {ipa:?}");
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd rust && cargo nextest run --features tts charsiu:: 2>&1 | tail`
Expected: FAIL (no `Charsiu`/`load`/`to_ipa`).

- [ ] **Step 3: Implement decode + engine**

`decode.rs` — greedy loop over two `ort` sessions, using tensor names from `charsiu-onnx-contract.md` (shown here with the canonical optimum names; adjust to the recorded contract):
```rust
//! Greedy autoregressive decode for CharsiuG2P ByT5 on ort.
use anyhow::Result;
use ndarray::{Array1, Array2};
use ort::session::Session;
use ort::value::Value;

const MAX_NEW_TOKENS: usize = 64;
const DECODER_START_ID: i64 = 0; // pad id; per charsiu-onnx-contract.md

/// Run encoder once, then greedily decode token-by-token until EOS/cap.
pub fn greedy(
    encoder: &mut Session,
    decoder: &mut Session,
    input_ids: &[i64],
) -> Result<Vec<i64>> {
    let n = input_ids.len();
    let ids = Value::from_array(Array2::<i64>::from_shape_vec((1, n), input_ids.to_vec())?)?;
    let mask = Value::from_array(Array2::<i64>::from_shape_vec((1, n), vec![1i64; n])?)?;
    let enc = encoder.run(ort::inputs![
        "input_ids" => ids, "attention_mask" => mask,
    ])?;
    let (eshape, edata) = enc["last_hidden_state"].try_extract_tensor::<f32>()?;
    let hidden = Array2::from_shape_vec(
        (eshape[1] as usize, eshape[2] as usize),
        edata.to_vec(),
    )?;

    let mut out = vec![DECODER_START_ID];
    for _ in 0..MAX_NEW_TOKENS {
        let dn = out.len();
        let dec_ids = Value::from_array(Array2::<i64>::from_shape_vec((1, dn), out.clone())?)?;
        let enc_hs = Value::from_array(
            hidden.clone().insert_axis(ndarray::Axis(0)),
        )?;
        let enc_mask = Value::from_array(Array2::<i64>::from_shape_vec((1, n), vec![1i64; n])?)?;
        let dec = decoder.run(ort::inputs![
            "input_ids" => dec_ids,
            "encoder_hidden_states" => enc_hs,
            "encoder_attention_mask" => enc_mask,
        ])?;
        let (lshape, logits) = dec["logits"].try_extract_tensor::<f32>()?;
        let vocab = lshape[2] as usize;
        let last = &logits[(logits.len() - vocab)..];
        let next = last
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .map(|(i, _)| i as i64)
            .unwrap();
        if next == super::tokenizer::EOS_ID {
            break;
        }
        out.push(next);
    }
    Ok(out)
}
```

`mod.rs` — engine wrapper:
```rust
pub(crate) mod decode;
pub(crate) mod remap;
pub(crate) mod tokenizer;

use std::path::Path;
use anyhow::{Context, Result};
use ort::session::Session;

pub struct Charsiu {
    encoder: Session,
    decoder: Session,
}

/// CharsiuG2P language tags (from charsiu-onnx-contract.md / spike).
fn tag_for(lang: &str) -> Result<&'static str> {
    Ok(match lang {
        "es" => "<spa>",
        "fr" => "<fra>",
        "it" => "<ita>",
        "pt" => "<por-bz>",
        other => anyhow::bail!("charsiu: unsupported lang '{other}'"),
    })
}

impl Charsiu {
    pub fn load(dir: &Path) -> Result<Self> {
        let enc = Session::builder()?.commit_from_file(dir.join("encoder_model.onnx"))?;
        let dec = Session::builder()?.commit_from_file(dir.join("decoder_model.onnx"))?;
        Ok(Self { encoder: enc, decoder: dec })
    }

    /// Phonemize one chunk of text to Kokoro-vocab IPA.
    pub fn to_ipa(&mut self, text: &str, lang: &str) -> Result<String> {
        if text.trim().is_empty() {
            return Ok(String::new());
        }
        let tag = tag_for(lang)?;
        // Word-by-word: CharsiuG2P is trained on single tokens.
        let mut words = Vec::new();
        for w in text.split_whitespace() {
            let ids = tokenizer::encode_with_tag(w, tag);
            let out = decode::greedy(&mut self.encoder, &mut self.decoder, &ids)
                .with_context(|| format!("charsiu decode failed for {w:?}"))?;
            words.push(remap::remap(&tokenizer::decode(&out)));
        }
        Ok(words.join(" "))
    }
}
```

- [ ] **Step 4: Run the gated test with a model**

Run:
```bash
cd rust && CHARSIU_ONNX=/tmp/charsiu-onnx-spike/onnx cargo nextest run --features tts charsiu:: 2>&1 | tail
```
Expected: PASS (and the un-gated tokenizer/remap tests still pass). If decode output diverges from Phase 0's Python IPA, fix tensor names/decoder-start id against `charsiu-onnx-contract.md`.

- [ ] **Step 5: Commit**

```bash
git add rust/src/tts/charsiu/
git commit -m "feat(tts): CharsiuG2P greedy ONNX decode engine (refs #212)"
```

---

## Phase 2 — `normalize` (numbers + acronyms)

### Task 2.1: Decide number-to-words crate vs hand-roll

**Files:**
- Modify: `rust/Cargo.toml` (only if a crate is chosen)

- [ ] **Step 1: Evaluate crates**

Run:
```bash
cd rust && cargo search num2words 2>&1 | head; cargo search numbers_to_words 2>&1 | head
```
Decide: a crate is acceptable ONLY if it is MIT/Apache-2.0 (CLAUDE.md license posture) AND supports es/fr/it/pt. Record the decision in a one-line comment at the top of `numbers.rs`. If none qualifies, hand-roll (Task 2.2 covers the hand-rolled path; if a crate is used, replace the body with crate calls but keep the same tests).

### Task 2.2: Per-language integer→words

**Files:**
- Create: `rust/src/tts/normalize/mod.rs`
- Create: `rust/src/tts/normalize/numbers.rs`
- Modify: `rust/src/tts/mod.rs` (`pub(crate) mod normalize;`)
- Test: inline in `numbers.rs`

- [ ] **Step 1: Write failing tests (table-driven, per language)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spanish_integers() {
        assert_eq!(to_words(27, "es"), "veintisiete");
        assert_eq!(to_words(512, "es"), "quinientos doce");
        assert_eq!(to_words(936, "es"), "novecientos treinta y seis");
    }
    #[test]
    fn italian_integers() {
        assert_eq!(to_words(512, "it"), "cinquecento dodici");
    }
    #[test]
    fn portuguese_integers() {
        assert_eq!(to_words(936, "pt"), "novecentos e trinta e seis");
    }
    #[test]
    fn french_integers() {
        assert_eq!(to_words(348, "fr"), "trois cent quarante-huit");
    }
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd rust && cargo nextest run --features tts normalize::numbers 2>&1 | tail`
Expected: FAIL.

- [ ] **Step 3: Implement `to_words`**

Implement integer→words for es/fr/it/pt (0..=999_999 is sufficient for v1; cap larger inputs by reading digit-by-digit). If a crate was chosen in 2.1, delegate to it here; otherwise hand-roll the four Romance grammars. Keep each language in its own `fn` for clarity.

The four grammars are regular — encode each as a table-driven function over units/teens/tens/hundreds with per-language connectors. Spanish template (the others follow the same shape with their own tables/connectors):
```rust
const ES_UNITS: [&str; 20] = ["cero","uno","dos","tres","cuatro","cinco","seis","siete","ocho","nueve","diez","once","doce","trece","catorce","quince","dieciséis","diecisiete","dieciocho","diecinueve"];
const ES_TENS: [&str; 10] = ["","","veinte","treinta","cuarenta","cincuenta","sesenta","setenta","ochenta","noventa"];
const ES_HUNDREDS: [&str; 10] = ["","ciento","doscientos","trescientos","cuatrocientos","quinientos","seiscientos","setecientos","ochocientos","novecientos"];

fn es_under_1000(n: u32) -> String {
    let (h, r) = (n / 100, n % 100);
    let mut parts = Vec::new();
    if n == 100 { return "cien".into(); }
    if h > 0 { parts.push(ES_HUNDREDS[h as usize].to_string()); }
    if r < 20 { if r > 0 || n == 0 { parts.push(ES_UNITS[r as usize].into()); } }
    else if r < 30 { parts.push(format!("veinti{}", ES_UNITS[(r-20) as usize])); } // veintisiete
    else { let (t,u) = (r/10, r%10); parts.push(ES_TENS[t as usize].into());
           if u > 0 { parts.push(format!("y {}", ES_UNITS[u as usize])); } } // treinta y seis
    parts.join(" ")
}
```
fr adds hyphenation + "et un"/"quatre-vingts"; it elides ("ventuno", "trentotto"); pt inserts "e" connectors ("novecentos e trinta e seis"). The Step 1 tests pin the exact expected strings for each.

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo nextest run --features tts normalize::numbers 2>&1 | tail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust/src/tts/normalize/ rust/src/tts/mod.rs
git commit -m "feat(tts): per-language integer->words normalization (refs #212)"
```

### Task 2.3: Per-language acronym spell-out + normalize dispatch

**Files:**
- Create: `rust/src/tts/normalize/acronyms.rs`
- Modify: `rust/src/tts/normalize/mod.rs` (`normalize(text, lang)` wiring digits + acronyms)
- Test: inline

- [ ] **Step 1: Write failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn spells_acronyms_with_spanish_letter_names() {
        // RAI -> "erre a i", IBGE handled in pt test
        assert_eq!(spell("RAI", "es"), "erre a i");
    }
    #[test]
    fn normalize_expands_digits_and_acronyms() {
        // integration: numbers + acronym together
        let out = super::normalize("Compré 27 libros RAI", "es");
        assert!(out.contains("veintisiete"), "got: {out}");
        assert!(out.contains("erre a i"), "got: {out}");
        assert!(!out.contains("27"), "digit leaked: {out}");
    }
    #[test]
    fn normalize_leaves_english_untouched() {
        assert_eq!(super::normalize("hello 5", "en"), "hello 5");
    }
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd rust && cargo nextest run --features tts normalize:: 2>&1 | tail`
Expected: FAIL.

- [ ] **Step 3: Implement acronym spell-out + dispatch**

`acronyms.rs`: per-language letter-name tables (es: a,be,ce,…,erre,…; fr; it; pt), spell all-caps tokens (length 2..=5, mirroring the gate logic in `tts/en/acronym.rs::is_acronym_token`) by joining letter names with spaces. `mod.rs::normalize(text, lang)`: for es/fr/it/pt, replace integer tokens via `numbers::to_words` and acronym tokens via `acronyms::spell`; for any other lang (incl. `en`), return text unchanged.

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo nextest run --features tts normalize:: 2>&1 | tail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust/src/tts/normalize/
git commit -m "feat(tts): per-language acronym spell-out + normalize dispatch (refs #212)"
```

---

## Phase 3 — Wire G2P dispatch + kokoro fixes

### Task 3.1: Route es/fr/it/pt through normalize → charsiu in `g2p.rs`

**Files:**
- Modify: `rust/src/tts/g2p.rs`
- Test: inline

- [ ] **Step 1: Update the failing tests**

`g2p.rs` currently has `unsupported_language_errors_with_pointer` asserting `fr` bails. Replace with routing expectations:
```rust
#[test]
fn romance_langs_no_longer_bail() {
    // Without a model present, routing still must not hit the misaki bail path.
    for lang in ["es", "fr", "it", "pt"] {
        let err = text_to_ipa("hola", lang).unwrap_err().to_string();
        // Acceptable failure is "model not installed", NOT "not supported / #212".
        assert!(
            err.contains("install --tts") || err.contains("charsiu"),
            "lang {lang} should route to charsiu, got: {err}"
        );
        assert!(!err.contains("212"), "lang {lang} still bails to #212");
    }
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd rust && cargo nextest run --features tts g2p:: 2>&1 | tail`
Expected: FAIL (still bails to #212).

- [ ] **Step 3: Implement routing**

In `text_to_ipa`, before the misaki `match`, add: if lang ∈ {es,fr,it,pt}, run `normalize::normalize(text, lang)` then load `Charsiu` from the cached model dir (`models/charsiu-g2p/` under the kesha cache) and return `to_ipa`. If the model dir is missing, bail with the loud `kesha install --tts` message (never auto-download). English/`en-*` keep the existing misaki path untouched.

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo nextest run --features tts g2p:: 2>&1 | tail`
Expected: PASS (routes to charsiu/install error, not #212).

- [ ] **Step 5: Commit**

```bash
git add rust/src/tts/g2p.rs
git commit -m "feat(tts): route es/fr/it/pt G2P through normalize+charsiu (refs #212)"
```

### Task 3.2: kokoro.rs — f32 clamp + style-row index fix

**Files:**
- Modify: `rust/src/tts/kokoro.rs`
- Test: inline

- [ ] **Step 1: Write failing tests**

```rust
#[test]
fn clamp_keeps_samples_in_range() {
    let out = clamp_audio(vec![-1.5, -0.2, 0.5, 1.8]);
    assert!(out.iter().all(|s| (-1.0..=1.0).contains(s)), "{out:?}");
    assert_eq!(out[1], -0.2); // in-range untouched
}
#[test]
fn style_row_uses_phoneme_count_minus_one() {
    assert_eq!(style_row(8), 7);
    assert_eq!(style_row(0), 0);     // saturating
    assert_eq!(style_row(10_000), 509);
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd rust && cargo nextest run --features tts kokoro:: 2>&1 | tail`
Expected: FAIL.

- [ ] **Step 3: Implement**

```rust
/// Clamp synthesized audio to [-1.0, 1.0]; Kokoro can emit out-of-range
/// samples that would hard-clip on i16 encode (spike fr_0). Apply before encode.
pub fn clamp_audio(mut samples: Vec<f32>) -> Vec<f32> {
    for s in &mut samples {
        *s = s.clamp(-1.0, 1.0);
    }
    samples
}

/// Voice-pack style row index = min(max(phonemeCount-1, 0), 509)
/// (FluidAudio KokoroAne docs; spike used the padded length).
pub fn style_row(phoneme_count: usize) -> usize {
    phoneme_count.saturating_sub(1).min(509)
}
```
Wire `clamp_audio` into the synth path before WAV encode, and use `style_row` where the style slice is selected.

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo nextest run --features tts kokoro:: 2>&1 | tail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust/src/tts/kokoro.rs
git commit -m "fix(tts): clamp Kokoro audio pre-encode + phonemeCount-1 style row (refs #212)"
```

---

## Phase 4 — Voices + model distribution

### Task 4.1: Pin CharsiuG2P ONNX + multilingual voices in `models.rs`

**Files:**
- Modify: `rust/src/tts/charsiu/` (none) — `rust/src/models.rs`
- Test: `cargo test models::manifest_tests` (existing shape invariants)

- [ ] **Step 1: Compute SHA-256 of the artifacts**

Run:
```bash
shasum -a 256 /tmp/charsiu-onnx-spike/onnx/encoder_model.onnx /tmp/charsiu-onnx-spike/onnx/decoder_model.onnx
# voice .bin packs (already used by the spike harness / onnx-community):
for v in em_alex ff_siwis im_nicola pm_alex; do
  shasum -a 256 /tmp/kokoro-mlang-spike/voices/$v.bin 2>/dev/null || echo "re-extract $v"
done
```
Record the hashes.

- [ ] **Step 2: Add `ModelFile` entries**

In `models.rs`, add to the ONNX (non-`system_kokoro`) TTS manifest: the two CharsiuG2P ONNX files under `rel_path: "models/charsiu-g2p/{encoder,decoder}_model.onnx"` with their HF `resolve` URLs + pinned `sha256`, and the four voice `.bin` packs under `models/kokoro-82m/voices/{em_alex,ff_siwis,im_nicola,pm_alex}.bin` from onnx-community with pinned `sha256` (mirror the existing `am_michael.bin` entry shape).

- [ ] **Step 3: Run manifest shape tests**

Run: `cd rust && cargo test --features tts models::manifest_tests 2>&1 | tail`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add rust/src/models.rs
git commit -m "feat(tts): pin CharsiuG2P ONNX + es/fr/it/pt voice packs (refs #212)"
```

### Task 4.2: Route voices in `voices.rs` (with documented French exception)

**Files:**
- Modify: `rust/src/tts/voices.rs`
- Test: inline

- [ ] **Step 1: Write failing tests**

```rust
#[test]
fn resolves_romance_default_voices() {
    let tmp = /* staged cache dir like existing tests */;
    for (id, _) in [("es-em_alex", "es"), ("it-im_nicola", "it"), ("pt-pm_alex", "pt"), ("fr-ff_siwis", "fr")] {
        // Without models staged this returns the install error; with the
        // charsiu+voice files staged it resolves to the ONNX Kokoro path.
        let _ = resolve_voice(tmp.path(), id); // assert it does NOT bail "language not supported"
    }
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cd rust && cargo nextest run --features tts voices:: 2>&1 | tail`
Expected: FAIL (es/fr/it/pt unsupported on the non-`system_kokoro` build).

- [ ] **Step 3: Implement routing + default-voice resolution**

On the ONNX (non-`system_kokoro`) path, map `es-*`/`fr-*`/`it-*`/`pt-*` to a `ResolvedVoice::Kokoro` using `models/kokoro-82m/voices/<voice>.bin` + the charsiu G2P dir, with `espeak_lang` set to the language code consumed by `g2p::text_to_ipa`. Add a code comment at the French default documenting the brand-rule exception:
```rust
// BRAND-RULE EXCEPTION (CLAUDE.md "default voices must be male"):
// Kokoro v1.0 ships NO male French voice — only ff_siwis (female). fr
// therefore defaults to ff_siwis until a male fr voice exists. es/it/pt
// default to male (em_alex/im_nicola/pm_alex). Revisit on a male fr voice.
```

- [ ] **Step 4: Run to verify pass**

Run: `cd rust && cargo nextest run --features tts voices:: 2>&1 | tail`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust/src/tts/voices.rs
git commit -m "feat(tts): route es/fr/it/pt voices on ONNX path; doc French exception (refs #212)"
```

### Task 4.3: Add the new models to `kesha install --tts`

**Files:**
- Modify: `src/install-plan.ts` (and `src/cli/install.ts` if it enumerates sizes)
- Test: `src/__tests__/` (bun) for the install plan

- [ ] **Step 1: Write failing bun test**

In an install-plan test: assert the `--tts` plan now includes `charsiu-g2p` and the four voice packs, and that total size string updates.

- [ ] **Step 2: Run to verify fail**

Run: `bun test src/__tests__ 2>&1 | tail`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add the CharsiuG2P + voice-pack entries to the `--tts` install plan so they download explicitly (never auto-download).

- [ ] **Step 4: Run to verify pass**

Run: `bun test src/__tests__ 2>&1 | tail && bunx tsc --noEmit`
Expected: PASS + clean types.

- [ ] **Step 5: Commit**

```bash
git add src/install-plan.ts src/cli/install.ts src/__tests__/
git commit -m "feat(cli): add CharsiuG2P + multilingual voices to kesha install --tts (refs #212)"
```

---

## Phase 5 — CI audio-regression gate + finalize

### Task 5.1: Audio-regression test over the corpus

**Files:**
- Create: `rust/tests/tts_multilang_audio.rs` (gated integration test) + corpus fixture from the spike
- Create: `rust/fixtures/tts/multilang_corpus.json` (port `spike/corpus.json` from PR #507)

- [ ] **Step 1: Write the gated test**

Render each corpus sentence (gated on `CHARSIU_ONNX` + Kokoro model present), then assert the spike's deterministic checks: non-silent (RMS > threshold), no clipping (peak ≤ 1.0 — locks Task 3.2), duration within a grapheme-ratio band, 24 kHz mono.

- [ ] **Step 2: Run with models present**

Run:
```bash
cd rust && CHARSIU_ONNX=/tmp/charsiu-onnx-spike/onnx cargo nextest run --features tts tts_multilang_audio 2>&1 | tail
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add rust/tests/tts_multilang_audio.rs rust/fixtures/tts/multilang_corpus.json
git commit -m "test(tts): multilingual audio-regression gate (no-clip, length band) (refs #212)"
```

### Task 5.2: Full verification + docs + PR

- [ ] **Step 1: Full local verification**

Run:
```bash
cd /Users/anton/Personal/repos/kesha-voice-kit/.worktrees/trackb-impl
cd rust && cargo fmt && cargo clippy --all-targets --features tts -- -D warnings && cargo nextest run --features tts && cargo check --features coreml --no-default-features
cd .. && bun test && bunx tsc --noEmit
```
Expected: all green. (`--all-targets` + the coreml check are required per CLAUDE.md.)

- [ ] **Step 2: Update user docs**

Update `docs/runbooks/tts-internals.md` + `CLAUDE.md` TTS section: es/fr/it/pt now supported on the ONNX path via CharsiuG2P + normalizer; note the LatAm-Spanish default and the French-female exception.

- [ ] **Step 3: Verify build-engine matrix unaffected**

Run: `diff <(grep 'features = ' .github/workflows/build-engine.yml) <(grep default rust/Cargo.toml)` — confirm no new default feature was added (charsiu rides the existing `tts`). If a feature was added, mirror it into every matrix row (CLAUDE.md).

- [ ] **Step 4: Commit docs + open PR**

```bash
git add docs/ CLAUDE.md
git commit -m "docs(tts): document es/fr/it/pt ONNX support (LatAm es, fr-female exception) (refs #212)"
git push -u origin feat/onnx-kokoro-multilang-trackb
gh pr create --base main --head feat/onnx-kokoro-multilang-trackb \
  --title "feat(tts): multilingual Kokoro on ONNX — es/fr/it/pt via CharsiuG2P (refs #212)" \
  --body "Implements Track B from the spike (#507). CharsiuG2P ByT5→ONNX G2P + per-language numbers/acronym normalizer + voice/model wiring + kokoro clamp/style fixes + audio-regression gate. Spanish defaults LatAm; French defaults ff_siwis (female, documented brand-rule exception — no male fr voice in Kokoro v1.0). Weights-license clarification with the CharsiuG2P author tracked before merge. Refs #212."
```

- [ ] **Step 5: Wait for CI + Greptile**

Per CLAUDE.md: wait for CI + Greptile to cover the head SHA; address P1/P2 findings; merge only when both are green. Tag #212 `WIP` while in flight; add `Closes #212` only once all four languages have landed (or keep `Refs` if French is split out).

---

## Pre-merge blockers (carry from the spec)
- **CharsiuG2P weights license** — code is MIT; the HF weights repo lacks an explicit license. Clarify with the author before Task 4.1's pin merges. If unresolved, this blocks the model-pin PR.
- **Phase 0 gate** — if the ONNX decode spike fails feasibility/latency, STOP and re-brainstorm the offline-lexicon fallback; do not proceed into Phase 1.
- **French-female exception** — needs drakulavich sign-off in the PR (brand-rule carve-out).
