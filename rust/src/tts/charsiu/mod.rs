//! CharsiuG2P: multilingual byte-level G2P via a ByT5-tiny seq2seq ONNX model.
//!
//! Three `ort` sessions implement the KV-cache autoregressive decode:
//! `encoder_model` (once), `decoder_model` (step 0, seeds all 16 KV presents),
//! and `decoder_with_past_model` (steps 1..N, 8 rolling decoder presents while
//! the 8 encoder K/V stay constant). Output IPA is remapped into Kokoro's
//! phoneme inventory (see [`remap`]). IO contract from #185 §3.
//!
use std::path::Path;

use anyhow::Result;
use ort::session::Session;

pub(crate) mod decode;
pub(crate) mod remap;
pub(crate) mod tokenizer;

/// True when an espeak-style lang code selects Castilian Spanish (e.g. "es-ES").
/// LatAm regions ("es", "es-419", "es-MX", …) and non-Spanish codes are false.
pub(crate) fn is_castilian_region(lang: &str) -> bool {
    let lower = lang.to_ascii_lowercase();
    lower == "es-es" || lower.starts_with("es-es-")
}

/// Reduce a (possibly region-tagged) code to the base lang Charsiu understands:
/// "es-ES"/"es-419"/"es-MX" → "es"; "pt-br" → "pt"; passthrough otherwise.
pub(crate) fn base_lang(lang: &str) -> &str {
    match lang.split('-').next() {
        Some(b) if matches!(b.to_ascii_lowercase().as_str(), "es" | "fr" | "it" | "pt") => b,
        _ => lang,
    }
}

/// Spike-derived (#511 Phase 0): how to realize Castilian θ. Both variants are
/// part of the documented decision surface; only one is selected per build.
#[allow(dead_code)] // the non-selected variant is the documented alternative outcome
enum Castilian {
    /// Native CharsiuG2P tag that emits θ (Outcome A). Holds the tag string.
    Tag(&'static str),
    /// No upstream Castilian tag (Outcome B, what shipped): degrade to LatAm <spa>.
    Degrade,
}

/// #511 Phase-0 spike found no Castilian tag (every candidate gave seseo /s/ or garbage).
const CASTILIAN: Castilian = Castilian::Degrade;

/// CharsiuG2P phonemizer holding the three decode sessions.
pub struct Charsiu {
    encoder: Session,
    decoder: Session,
    decoder_past: Session,
}

impl Charsiu {
    /// Open the three ONNX sessions from a model directory containing
    /// `encoder_model.onnx`, `decoder_model.onnx`, `decoder_with_past_model.onnx`.
    pub fn load(dir: &Path) -> Result<Self> {
        let open = |name: &str| -> Result<Session> {
            let path = dir.join(name);
            Session::builder()
                .map_err(|e| anyhow::anyhow!("ort: failed to create session builder: {e}"))?
                .commit_from_file(&path)
                .map_err(|e| anyhow::anyhow!("ort: failed to load {}: {e}", path.display()))
        };
        Ok(Self {
            encoder: open("encoder_model.onnx")?,
            decoder: open("decoder_model.onnx")?,
            decoder_past: open("decoder_with_past_model.onnx")?,
        })
    }

    /// Phonemize `text` in language `lang` into Kokoro-vocab IPA.
    ///
    /// Splits on whitespace, runs the KV-cache greedy decode per word, decodes
    /// the byte ids, remaps to Kokoro's inventory, and rejoins with spaces.
    /// Supported langs map to CharsiuG2P tags: `es`→`<spa>`, `fr`→`<fra>`,
    /// `it`→`<ita>`, `pt`→`<por-bz>`. Other langs bail.
    // `&mut self` is required: ort `Session::run` mutates the session. The `to_`
    // name reflects the conversion semantics, so silence wrong_self_convention.
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

        let mut words = Vec::new();
        for word in text.split_whitespace() {
            let input_ids = tokenizer::encode_with_tag(word, tag);
            let out_ids = decode::greedy(
                &mut self.encoder,
                &mut self.decoder,
                &mut self.decoder_past,
                &input_ids,
            )?;
            let raw = tokenizer::decode(&out_ids);
            words.push(remap::remap(&raw));
        }
        Ok(words.join(" "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn castilian_region_detection() {
        assert!(is_castilian_region("es-ES"));
        assert!(is_castilian_region("es-es"));
        assert!(!is_castilian_region("es"));
        assert!(!is_castilian_region("es-419"));
        assert!(!is_castilian_region("es-MX"));
        assert!(!is_castilian_region("fr"));
    }

    /// Gated on CHARSIU_ONNX env var. Skipped when unset so default CI stays fast.
    #[test]
    fn to_ipa_phonemizes_when_model_available() {
        let Some(dir) = std::env::var_os("CHARSIU_ONNX") else {
            eprintln!("CHARSIU_ONNX not set; skipping");
            return;
        };
        let mut g = Charsiu::load(std::path::Path::new(&dir)).unwrap();
        // Authoritative #185 reference: French "bonjour" → "bɔ̃ʒuʁ".
        assert_eq!(g.to_ipa("bonjour", "fr").unwrap(), "bɔ̃ʒuʁ");
        // Spanish/Italian/Portuguese: non-empty AND zero-OOV after remap.
        let vocab = crate::tts::tokenizer::Tokenizer::load().unwrap();
        for (w, lang) in [
            ("hola", "es"),
            ("mundo", "es"),
            ("cucina", "it"),
            ("jabuti", "pt"),
        ] {
            let ipa = g.to_ipa(w, lang).unwrap();
            assert!(!ipa.is_empty(), "empty IPA for {w}");
            let nonspace = ipa.chars().filter(|c| !c.is_whitespace()).count();
            assert_eq!(
                vocab.encode(&ipa).len(),
                nonspace,
                "OOV leaked: {w} -> {ipa:?}"
            );
        }
    }
}
