//! Long-lived inference sessions.
//!
//! `tts::say()` is one-shot: it loads the Kokoro / Vosk model on every call,
//! pays the ~1 s (Kokoro) / ~21 s (Vosk RU cold) load cost, then drops it.
//! That's fine for CLI usage. For batch / interactive callers (`--stdin-loop`,
//! issue #213) we want to amortise that cost across many requests.
//!
//! [`KokoroSession`] and [`VoskCache`] are the shared building blocks. The
//! one-shot path in `tts::say()` constructs them fresh per call (preserving
//! existing behaviour bit-for-bit); the loop path holds them across requests.
//!
//! Voice embeddings (510 × 256 f32 ≈ 0.5 MB each) are cached unbounded; a
//! bounded LRU is a follow-up if anyone ships more than a few dozen voices.
//! `VoskCache::infer` evicts on synth error so half-corrupted state can't
//! poison subsequent calls.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use super::{charsiu::Charsiu, kokoro::Kokoro, tokenizer::Tokenizer, voices, vosk::Vosk};

/// Cached Kokoro inference state. One ONNX session, one tokenizer, one voice
/// cache. Cheap to clone-key (`PathBuf`); the actual session is non-Clone.
pub struct KokoroSession {
    kokoro: Kokoro,
    model_path: PathBuf,
    tokenizer: Tokenizer,
    voices: HashMap<PathBuf, Vec<f32>>,
}

impl KokoroSession {
    /// Load the Kokoro model at `model_path` and the embedded tokenizer.
    /// Voice embeddings are loaded lazily on first use.
    pub fn load(model_path: &Path) -> anyhow::Result<Self> {
        let tokenizer = Tokenizer::load().map_err(|e| anyhow::anyhow!("tokenizer load: {e}"))?;
        let kokoro = Kokoro::load(model_path).map_err(|e| anyhow::anyhow!("kokoro load: {e}"))?;
        Ok(Self {
            kokoro,
            model_path: model_path.to_path_buf(),
            tokenizer,
            voices: HashMap::new(),
        })
    }

    /// Swap to a different Kokoro checkpoint if `path` differs from the
    /// loaded one. Voice embeddings cache survives — the .bin layout is
    /// stable across kokoro-onnx checkpoints with the same vocab.
    pub fn ensure_model(&mut self, path: &Path) -> anyhow::Result<()> {
        if self.model_path == path {
            return Ok(());
        }
        self.kokoro = Kokoro::load(path).map_err(|e| anyhow::anyhow!("kokoro reload: {e}"))?;
        self.model_path = path.to_path_buf();
        Ok(())
    }

    fn voice(&mut self, voice_path: &Path) -> anyhow::Result<&[f32]> {
        use std::collections::hash_map::Entry;
        let v = match self.voices.entry(voice_path.to_path_buf()) {
            Entry::Occupied(e) => e.into_mut(),
            Entry::Vacant(e) => {
                let loaded = voices::load_voice(voice_path)?;
                e.insert(loaded)
            }
        };
        Ok(v.as_slice())
    }

    /// Synthesise raw IPA. Returns mono f32 PCM at [`super::kokoro::SAMPLE_RATE`].
    /// Returns an empty `Vec` (not an error) when the IPA contains no recognisable
    /// phonemes — callers decide whether that's a hard error (one-shot) or a
    /// silent skip (SSML segments).
    pub fn infer_ipa(
        &mut self,
        ipa: &str,
        voice_path: &Path,
        speed: f32,
    ) -> anyhow::Result<Vec<f32>> {
        let ids = self.tokenizer.encode(ipa);
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let active = ids.len();
        let padded = Tokenizer::pad_to_context(ids);

        // Detach style row from the &self.voices borrow before we touch
        // &mut self.kokoro — the row is 256 floats (~1 KB), copy is free.
        let style: Vec<f32> = {
            let voice = self.voice(voice_path)?;
            voices::select_style(voice, active).to_vec()
        };
        self.kokoro.infer(&padded, &style, speed)
    }
}

/// Map of `Vosk` instances keyed by model directory. Eviction on infer error.
///
/// Vosk holds mutable BERT prosody / dictionary state; a synth error may leave
/// it inconsistent, so we evict rather than risk poisoning the next call.
/// Kokoro's `Session::run` is stateless per call, so no eviction needed there.
#[derive(Default)]
pub struct VoskCache {
    inner: HashMap<PathBuf, Vosk>,
}

impl VoskCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn ensure(&mut self, model_dir: &Path) -> anyhow::Result<&mut Vosk> {
        use std::collections::hash_map::Entry;
        match self.inner.entry(model_dir.to_path_buf()) {
            Entry::Occupied(e) => Ok(e.into_mut()),
            Entry::Vacant(e) => {
                let v = Vosk::load(model_dir)?;
                Ok(e.insert(v))
            }
        }
    }

    /// Expose the model's reported sample rate without synthesising. Loads
    /// the model on first call. Used by the SSML segment iterator so a
    /// leading `<break>` knows the silence buffer's sample rate before the
    /// first speakable segment arrives.
    pub fn sample_rate(&mut self, model_dir: &Path) -> anyhow::Result<u32> {
        Ok(self.ensure(model_dir)?.sample_rate())
    }

    /// Synthesise `text` and return `(audio, sample_rate)`. The cached
    /// `Vosk` instance is *evicted* on error — the next request triggers a
    /// fresh load, sidestepping any half-corrupted internal state.
    pub fn infer(
        &mut self,
        model_dir: &Path,
        text: &str,
        speaker_id: u32,
        speed: f32,
    ) -> anyhow::Result<(Vec<f32>, u32)> {
        let v = self.ensure(model_dir)?;
        let sr = v.sample_rate();
        match v.infer(text, speaker_id, speed) {
            Ok(audio) => Ok((audio, sr)),
            Err(e) => {
                self.inner.remove(model_dir);
                Err(anyhow::anyhow!(
                    "{e} (cached vosk session evicted; will reload on next request)"
                ))
            }
        }
    }
}

/// Cached CharsiuG2P session keyed by the g2p model directory.
///
/// CharsiuG2P loads three ONNX sessions (~100 MB total); without this cache
/// each `--stdin-loop` Romance-language request would reload them from disk.
/// `to_ipa` is stateless per call, so unlike Vosk we never evict on error.
#[derive(Default)]
pub struct CharsiuCache {
    inner: Option<(PathBuf, Charsiu)>,
}

impl CharsiuCache {
    pub fn new() -> Self {
        Self::default()
    }

    fn ensure(&mut self, model_dir: &Path) -> anyhow::Result<&mut Charsiu> {
        // Evict if the caller asks for a different directory (shouldn't happen
        // in practice — there's only one byt5-tiny dir — but keeps the API
        // safe if a test ever passes a different path).
        if let Some((ref dir, _)) = self.inner {
            if dir != model_dir {
                self.inner = None;
            }
        }
        if self.inner.is_none() {
            super::g2p::check_charsiu_files(model_dir)?;
            let g = Charsiu::load(model_dir)?;
            self.inner = Some((model_dir.to_path_buf(), g));
        }
        Ok(&mut self.inner.as_mut().unwrap().1)
    }

    /// Phonemize `text` in `lang` (es/fr/it/pt) using the cached session.
    /// Surfaces the same "model not installed → kesha install --tts" error as
    /// the one-shot path when the model directory is absent.
    // `&mut self` is required: ort `Session::run` mutates the session.
    #[allow(clippy::wrong_self_convention)]
    pub fn to_ipa(&mut self, model_dir: &Path, text: &str, lang: &str) -> anyhow::Result<String> {
        let g = self.ensure(model_dir)?;
        super::g2p::charsiu_ipa(g, text, lang)
    }

    /// Returns `true` if a session has been loaded (used in tests to verify
    /// caching without re-loading).
    #[cfg(test)]
    pub fn is_loaded(&self) -> bool {
        self.inner.is_some()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gated on CHARSIU_ONNX env var (mirrors charsiu::tests); skipped in CI.
    #[test]
    fn charsiu_cache_loads_once_and_reuses() {
        let Some(dir_os) = std::env::var_os("CHARSIU_ONNX") else {
            eprintln!("CHARSIU_ONNX not set; skipping");
            return;
        };
        let dir = std::path::PathBuf::from(dir_os);

        let mut cache = CharsiuCache::new();
        assert!(!cache.is_loaded(), "cache must start empty");

        let ipa1 = cache.to_ipa(&dir, "hola", "es").unwrap();
        assert!(!ipa1.is_empty(), "first call: empty IPA for 'hola'");
        assert!(
            cache.is_loaded(),
            "cache must be populated after first call"
        );

        // Charsiu is deterministic; same input must return identical IPA and not reload.
        let ipa2 = cache.to_ipa(&dir, "hola", "es").unwrap();
        assert_eq!(
            ipa1, ipa2,
            "second call returned different IPA — session may have been reloaded"
        );

        let ipa_fr = cache.to_ipa(&dir, "bonjour", "fr").unwrap();
        assert!(!ipa_fr.is_empty(), "French 'bonjour' returned empty IPA");
    }
}
