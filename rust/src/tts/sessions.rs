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

use super::{
    charsiu::Charsiu,
    kokoro::{self, Kokoro},
    seam,
    tokenizer::{self, Tokenizer},
    voices,
    vosk::Vosk,
};

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
    ///
    /// IPA past Kokoro's active-token cap is split with
    /// [`tokenizer::chunk_ipa`] and the chunks' samples joined by
    /// [`seam::join_chunks`], so long input synthesizes in full instead of
    /// being cut at the cap (#715) without a dead-air join (#808).
    pub fn infer_ipa(
        &mut self,
        ipa: &str,
        voice_path: &Path,
        speed: f32,
    ) -> anyhow::Result<Vec<f32>> {
        let mut rendered = Vec::new();
        for chunk in tokenizer::chunk_ipa(ipa, tokenizer::KOKORO_MAX_ACTIVE) {
            let ids = self.tokenizer.encode(&chunk);
            if ids.is_empty() {
                continue;
            }
            // `pad_to_context` truncates past the cap, which is how #715 lost
            // audio silently; fail loudly in debug if chunking stops holding.
            debug_assert!(
                ids.len() <= tokenizer::KOKORO_MAX_ACTIVE,
                "chunk encoded to {} ids, past the {} cap",
                ids.len(),
                tokenizer::KOKORO_MAX_ACTIVE
            );
            let active = ids.len();
            let padded = Tokenizer::pad_to_context(ids);

            // Detach style row from the &self.voices borrow before we touch
            // &mut self.kokoro — the row is 256 floats (~1 KB), copy is free.
            let style: Vec<f32> = {
                let voice = self.voice(voice_path)?;
                voices::select_style(voice, active).to_vec()
            };
            rendered.push(self.kokoro.infer(&padded, &style, speed)?);
        }
        Ok(seam::join_chunks(rendered, kokoro::SAMPLE_RATE))
    }
}

/// Lazily-loaded [`KokoroSession`] that survives model swaps. `get` loads on
/// first use and delegates to `ensure_model` afterwards, so callers share one
/// code path whether they are one-shot (fresh slot per call) or long-lived
/// (`--stdin-loop` holds the slot across requests).
#[derive(Default)]
pub struct KokoroSlot {
    inner: Option<KokoroSession>,
}

impl KokoroSlot {
    pub fn get(&mut self, model_path: &Path) -> anyhow::Result<&mut KokoroSession> {
        use anyhow::Context;
        Ok(match &mut self.inner {
            Some(sess) => {
                sess.ensure_model(model_path).context("kokoro reload")?;
                sess
            }
            slot => slot.insert(KokoroSession::load(model_path).context("kokoro load")?),
        })
    }
}

/// The full set of cacheable TTS sessions. The one-shot `tts::say()` path
/// constructs this fresh per call; `--stdin-loop` holds one across requests
/// so Kokoro (~1 s), Vosk RU (~21 s cold), and CharsiuG2P (~100 MB, #509)
/// load at most once per process.
#[derive(Default)]
pub struct TtsSessions {
    pub kokoro: KokoroSlot,
    pub vosk: VoskCache,
    pub charsiu: CharsiuCache,
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

    fn mini_kokoro_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("rust/ has a parent")
            .join("tests/fixtures/mini-models/kokoro")
    }

    /// The mini pins slot bookkeeping, never audio fidelity — no quality assertion belongs here.
    #[test]
    fn kokoro_slot_reuses_a_loaded_session_and_survives_a_failed_swap() {
        let mini = mini_kokoro_dir();
        let model = mini.join("model.onnx");
        let voice = mini.join("am_michael.bin");

        let mut slot = KokoroSlot::default();
        let first = slot
            .get(&model)
            .expect("first get loads the mini")
            .infer_ipa("həlˈoʊ", &voice, 1.0)
            .expect("mini synthesises");
        assert!(!first.is_empty(), "mini returned no samples");

        let second = slot
            .get(&model)
            .expect("second get reuses the loaded session")
            .infer_ipa("həlˈoʊ", &voice, 1.0)
            .expect("mini synthesises");
        assert_eq!(first, second, "reused session returned different samples");

        let err = match slot.get(&mini.join("no-such-model.onnx")) {
            Ok(_) => panic!("a swap to a missing checkpoint must fail"),
            Err(e) => e,
        };
        assert!(
            format!("{err:#}").contains("reload"),
            "swap failure did not go through ensure_model: {err:#}"
        );

        let after = slot
            .get(&model)
            .expect("a failed swap must leave the slot loaded")
            .infer_ipa("həlˈoʊ", &voice, 1.0)
            .expect("mini synthesises");
        assert_eq!(first, after, "slot lost its session after a failed swap");
    }

    /// Gated on CHARSIU_ONNX env var (mirrors charsiu::tests); skipped in CI.
    #[test]
    fn charsiu_cache_reuses_one_session_and_evicts_a_different_dir() {
        let Some(dir_os) = std::env::var_os("CHARSIU_ONNX") else {
            assert!(
                std::env::var_os("KESHA_REQUIRE_G2P_TESTS").is_none(),
                "CHARSIU_ONNX unset while KESHA_REQUIRE_G2P_TESTS is set — this lane stages \
             CharsiuG2P, and these IPA assertions are what own phoneme fidelity (#741)"
            );
            eprintln!("CHARSIU_ONNX not set; skipping");
            return;
        };
        let dir = std::path::PathBuf::from(dir_os);

        let mut cache = CharsiuCache::default();
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

        let empty = tempfile::tempdir().expect("tempdir");
        let err = match cache.to_ipa(empty.path(), "hola", "es") {
            Ok(ipa) => panic!("a g2p dir with no model must fail, got {ipa:?}"),
            Err(e) => e,
        };
        assert!(
            format!("{err:#}").contains("G2P model not installed"),
            "wrong error for an empty g2p dir: {err:#}"
        );
        assert!(
            !cache.is_loaded(),
            "a different dir must evict the cached session before the file check fails"
        );

        let ipa3 = cache.to_ipa(&dir, "hola", "es").unwrap();
        assert_eq!(ipa1, ipa3, "slot did not refill after eviction");
    }
}
