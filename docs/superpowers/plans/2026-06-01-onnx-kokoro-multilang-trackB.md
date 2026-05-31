# Multilingual Kokoro on ONNX (es/fr/it/pt) — Track B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the ONNX TTS path real per-language G2P for Spanish, French, Italian, Portuguese so `kesha say --voice {es,fr,it,pt}-*` produces natural (not English-accented, not digit-collapsed) speech.

**Architecture:** A new `tts::charsiu` ONNX G2P engine — loading the **pre-converted [`klebster/g2p_multilingual_byT5_tiny_onnx`](https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx)** export (encoder + decoder + KV-cache `decoder_with_past`), byte tokenizer, KV-cache autoregressive decode on the existing `ort` — feeding the existing Kokoro tokenizer/session, with a per-language `tts::normalize` pass (numbers + acronyms) ahead of it. Routing/model-pin wiring in `voices.rs`/`models.rs`. English (misaki) and the CoreML path are untouched.

**Tech Stack:** Rust (`ort 2.0.0-rc.12`, `ndarray`), the existing `tts::{tokenizer, kokoro}`, `cargo nextest`. No Python / no model export — we consume a published ONNX artifact.

**Spec:** `docs/superpowers/specs/2026-06-01-onnx-kokoro-multilang-trackB-implementation-design.md`
**Predecessor spikes:** Track-B-choice spike PR #507; **and the authoritative G2P-ONNX feasibility spike — `docs/superpowers/specs/2026-04-22-onnx-g2p-spike.md` (PR #185, on `main`)**, which already downloaded klebster, pinned its SHA-256 hashes, documented the full IO contract + `ort 2.0` gotchas, and verified byte-identical Rust↔Python IPA across 7 scripts.
**Tracking issue:** #212

> **Not a spike-gated plan.** Feasibility is already established by the April #185 spike (real, on-main, byte-identical Rust/ort parity with the klebster artifact). We pin and load that published export rather than exporting anything ourselves. The IO contract, hashes, decode algorithm, and `ort 2.0` gotchas all come from #185 — treat that doc as the source of truth.

> **Path note:** `Run:` blocks use this worktree (`/Users/anton/Personal/repos/kesha-voice-kit/.worktrees/trackb-impl`). Cache path for models is `~/.cache/kesha/models/`.

---

## Phase 0 — Stage & verify the klebster artifact (no export)

Feasibility is already proven by the #185 spike. This phase only confirms the published artifact we'll pin is the exact one #185 validated — no export, no Python, no throwaway code.

### Task 0.1: Download + hash-verify the klebster ONNX export

**Files:**
- None (stages cache files; the source pins land in Task 4.1).

- [ ] **Step 1: Download the three klebster ONNX files into the kesha cache**

Run:
```bash
mkdir -p ~/.cache/kesha/models/g2p/byt5-tiny
cd ~/.cache/kesha/models/g2p/byt5-tiny
for f in encoder_model.onnx decoder_model.onnx decoder_with_past_model.onnx; do
  curl -fsSL -o "$f" "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/main/$f"
done
ls -la
```
Expected: three files (~55 MB / 25 MB / 22 MB).

- [ ] **Step 2: Verify SHA-256 against the #185-pinned hashes**

Run:
```bash
cd ~/.cache/kesha/models/g2p/byt5-tiny
shasum -a 256 encoder_model.onnx decoder_model.onnx decoder_with_past_model.onnx
```
Expected — must match the #185 pins exactly. A mismatch means upstream rehosted; STOP and treat it as a deliberate model bump (MODEL HASHES rule), not a "get it working" override:
```
1ac7aca11845527873f9e0e870fbe1e3c3ac2cb009d8852230332d10541aab04  encoder_model.onnx
de32477aae14e254d4a7dee4b2c324fb39f93a0dc254181c5bfdd8fc67492919  decoder_model.onnx
fae30b9f3a8d935be01b32af851bae6d54f330813167073e84caf6d0a1890fcb  decoder_with_past_model.onnx
```

- [ ] **Step 3: Confirm the IO contract still matches #185 §3**

The three sessions must expose the inputs/outputs #185 documented (encoder: `input_ids`,`attention_mask`→`last_hidden_state`; `decoder_model`: +`encoder_hidden_states`,`encoder_attention_mask`→`logits` + 16 `present.*` KV; `decoder_with_past_model`: +16 `past_key_values.*`→`logits` + 8 decoder-only `present.*`). These are the names Phase 1's decode loop wires against. No source change and no commit in this phase — it only stages the cache and confirms the contract is current.

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

In `tokenizer.rs` (constants per #185 §2):
```rust
//! ByT5 byte-level tokenizer for CharsiuG2P. ByT5 maps each UTF-8 byte to
//! `byte + BYTE_OFFSET`; the first ids are reserved (pad/eos/unk). No
//! sentencepiece — encode/decode are pure byte arithmetic.

/// ByT5 reserves ids 0..3 (pad=0, eos=1, unk=2) and offsets bytes by 3.
pub const BYTE_OFFSET: i64 = 3;
/// EOS token id (#185 §2).
pub const EOS_ID: i64 = 1;

/// Encode `"<tag>: text"` into ByT5 byte ids with a trailing EOS.
/// The `": "` separator matches CharsiuG2P's training format (#185 §4,
/// e.g. `"<spa>: hola"`).
pub fn encode_with_tag(text: &str, tag: &str) -> Vec<i64> {
    let mut ids: Vec<i64> = format!("{tag}: {text}")
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

    /// Gated on CHARSIU_ONNX (klebster dir: encoder/decoder/decoder_with_past .onnx).
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

`decode.rs` — **KV-cache** greedy decode over the klebster 3-session split. Step 0 runs `decoder_model` (seeds all 16 `present.*` KV); steps 1..N run `decoder_with_past_model`, re-feeding the constant encoder KV and the updated decoder KV. **Exact IO names + shapes are in #185 §3** — the KV plumbing below follows that name list verbatim:
```rust
//! KV-cache autoregressive decode for the klebster CharsiuG2P ByT5 export.
//! Three ort sessions (encoder, decoder, decoder_with_past). IO per #185 §3.
use anyhow::{anyhow, Result};
use ndarray::{Array2, Array3, Array4};
use ort::session::Session;
use ort::value::Value;

const MAX_NEW_TOKENS: usize = 128;
const DECODER_START_ID: i64 = 0; // pad id (#185 §2)
const N_LAYERS: usize = 4;       // num_decoder_layers (#185 §2)

/// argmax over the last decoder position of a `[1, S, 384]` logits tensor.
fn argmax_last(logits: &Value) -> Result<i64> {
    let (shape, data) = logits.try_extract_tensor::<f32>()?;
    let vocab = shape[shape.len() - 1] as usize;
    let last = &data[data.len() - vocab..];
    Ok(last
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap())
        .map(|(i, _)| i as i64)
        .unwrap())
}

/// Holds the 4 layers × {decoder,encoder} × {key,value} cache tensors as owned
/// `Array4<f32>` (`[1, 6, seq, 64]`, #185 §3). `seed` captures step-0 `present.*`;
/// `bind_past` feeds them as `past_key_values.{i}.{decoder,encoder}.{key,value}`;
/// `update_decoder` overwrites only the decoder entries from each step's `present.*`
/// (encoder entries are constant across steps — #185 §3 note).
struct KvCache { /* 16 named Array4<f32>, keyed by (layer, decoder|encoder, key|value) */ }
impl KvCache {
    fn seed(out: &ort::session::SessionOutputs, layers: usize) -> Result<Self> { /* read present.* */ }
    fn bind_past<'a>(&'a self, inputs: &mut Vec<(&'static str, Value)>) -> Result<()> { /* past_key_values.* */ }
    fn update_decoder(&mut self, out: &ort::session::SessionOutputs, layers: usize) -> Result<()> { /* present.*.decoder.* */ }
}

/// Encode once, then KV-cache greedy decode until EOS / MAX_NEW_TOKENS.
pub fn greedy(
    encoder: &mut Session,
    decoder: &mut Session,
    decoder_past: &mut Session,
    input_ids: &[i64],
) -> Result<Vec<i64>> {
    let n = input_ids.len();
    let ids = Value::from_array(Array2::<i64>::from_shape_vec((1, n), input_ids.to_vec())?)?;
    let mask = || Value::from_array(Array2::<i64>::from_shape_vec((1, n), vec![1i64; n]).unwrap());
    let enc = encoder.run(ort::inputs!["input_ids" => ids, "attention_mask" => mask()])?;
    let (hs, hd) = enc["last_hidden_state"].try_extract_tensor::<f32>()?;
    let hidden = Array3::from_shape_vec((1, hs[1] as usize, hs[2] as usize), hd.to_vec())?;

    // Step 0 — full decoder seeds all KV.
    let start = Value::from_array(Array2::<i64>::from_shape_vec((1, 1), vec![DECODER_START_ID])?)?;
    let out0 = decoder.run(ort::inputs![
        "input_ids" => start,
        "encoder_hidden_states" => Value::from_array(hidden)?,
        "encoder_attention_mask" => mask(),
    ])?;
    let mut next = argmax_last(&out0["logits"])?;
    let mut kv = KvCache::seed(&out0, N_LAYERS)?;

    // Steps 1..N — decoder_with_past, feeding last token + past KV.
    let mut tokens = Vec::new();
    let mut step = 0;
    while next != super::tokenizer::EOS_ID && step < MAX_NEW_TOKENS {
        tokens.push(next);
        let mut inputs = ort::inputs![
            "input_ids" => Value::from_array(Array2::<i64>::from_shape_vec((1, 1), vec![next])?)?,
            "encoder_attention_mask" => mask(),
        ];
        kv.bind_past(&mut inputs)?;
        let out = decoder_past.run(inputs)?;
        next = argmax_last(&out["logits"])?;
        kv.update_decoder(&out, N_LAYERS)?;
        step += 1;
    }
    Ok(tokens)
}
```

> `KvCache`'s three method bodies are mechanical 16-tensor plumbing — read each `present.{0..3}.{decoder,encoder}.{key,value}` from the `SessionOutputs` into an owned `Array4<f32>`, and feed them back under the `past_key_values.*` names. The exact name list and `[1,6,seq,64]` shapes are in **#185 §3**; implement them straight from that table.

`mod.rs` — engine wrapper (note the `ort 2.0` `Session::builder()` gotcha from #185 §7: its error is not `Send`, so `?` won't coerce to `anyhow` — wrap with `map_err`):
```rust
pub(crate) mod decode;
pub(crate) mod remap;
pub(crate) mod tokenizer;

use std::path::Path;
use anyhow::{anyhow, Context, Result};
use ort::session::Session;

pub struct Charsiu {
    encoder: Session,
    decoder: Session,
    decoder_past: Session,
}

/// CharsiuG2P language tags (#185 §4). LatAm Spanish is `<spa>`.
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
        let open = |f: &str| -> Result<Session> {
            Session::builder()
                .map_err(|e| anyhow!("ort session builder: {e}"))? // #185 §7: non-Send error
                .commit_from_file(dir.join(f))
                .map_err(|e| anyhow!("ort load {f}: {e}"))
        };
        Ok(Self {
            encoder: open("encoder_model.onnx")?,
            decoder: open("decoder_model.onnx")?,
            decoder_past: open("decoder_with_past_model.onnx")?,
        })
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
            let out = decode::greedy(
                &mut self.encoder, &mut self.decoder, &mut self.decoder_past, &ids,
            )
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
cd rust && CHARSIU_ONNX=~/.cache/kesha/models/g2p/byt5-tiny cargo nextest run --features tts charsiu:: 2>&1 | tail
```
Expected: PASS (and the un-gated tokenizer/remap tests still pass). If decode output diverges from #185's reference IPA (e.g. `hola → olao`), fix the KV-cache name binding against #185 §3.

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

In `text_to_ipa`, before the misaki `match`, add: if lang ∈ {es,fr,it,pt}, run `normalize::normalize(text, lang)` then load `Charsiu` from the cached model dir (`models/g2p/byt5-tiny/` under the kesha cache) and return `to_ipa`. If the model dir is missing, bail with the loud `kesha install --tts` message (never auto-download). English/`en-*` keep the existing misaki path untouched.

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

### Task 4.1: Pin the klebster G2P ONNX + multilingual voices in `models.rs`

**Files:**
- Modify: `rust/src/models.rs`, `NOTICES`
- Test: `cargo test models::manifest_tests` (existing shape invariants)

- [ ] **Step 1: Hashes are already pinned by #185 — reuse them**

The three klebster files' SHA-256 are recorded in #185 §1 (verified in Phase 0 Task 0.1 Step 2):
```
encoder_model.onnx              1ac7aca11845527873f9e0e870fbe1e3c3ac2cb009d8852230332d10541aab04
decoder_model.onnx              de32477aae14e254d4a7dee4b2c324fb39f93a0dc254181c5bfdd8fc67492919
decoder_with_past_model.onnx    fae30b9f3a8d935be01b32af851bae6d54f330813167073e84caf6d0a1890fcb
```
For the four voice `.bin` packs (onnx-community, same family as the existing `am_michael.bin`), compute hashes from the staged cache:
```bash
for v in em_alex ff_siwis im_nicola pm_alex; do
  shasum -a 256 ~/.cache/kesha/models/kokoro-82m/voices/$v.bin
done
```

- [ ] **Step 2: Add `ModelFile` entries + NOTICES attribution**

In `models.rs`, add to the ONNX (non-`system_kokoro`) TTS manifest:
- The **three** klebster G2P files under `rel_path: "models/g2p/byt5-tiny/{encoder_model,decoder_model,decoder_with_past_model}.onnx"`, `url: "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/main/<file>"`, with the pinned `sha256` above (mirror #185's Phase-1 `g2p_onnx_manifest()` snippet exactly).
- The four voice `.bin` packs under `models/kokoro-82m/voices/{em_alex,ff_siwis,im_nicola,pm_alex}.bin` from onnx-community with pinned `sha256` (mirror the existing `am_michael.bin` entry).

**CC-BY 4.0 attribution (required):** add a `NOTICES` entry crediting **Kleber Noel** (ONNX export) and **Zhu et al. 2022** (upstream CharsiuG2P, arXiv:2204.03067). This is the license obligation — not optional.

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
cd rust && CHARSIU_ONNX=~/.cache/kesha/models/g2p/byt5-tiny cargo nextest run --features tts tts_multilang_audio 2>&1 | tail
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

## Pre-merge blockers
- **CC-BY 4.0 attribution** — the klebster export is CC-BY 4.0 (resolved: permissive, no copyleft). The obligation is the `NOTICES` entry (Task 4.1 Step 2) crediting Kleber Noel + Zhu et al. — easy to forget, easy to satisfy.
- **French-female exception** — needs drakulavich sign-off in the PR (brand-rule carve-out: no male French voice exists in Kokoro v1.0).

> Resolved vs. the original plan: the "export it ourselves / Phase 0 feasibility gate" and the "weights license unresolved" blockers are both gone — feasibility is established by #185 and the artifact is CC-BY 4.0.
