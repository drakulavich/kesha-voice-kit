//! Kokoro voice embedding files.
//!
//! Layout: 510 rows × 256 cols, f32 little-endian, contiguous. Row index selected by
//! active token count: `min(token_count - 1, 509)`.

use std::path::Path;

pub const VOICE_ROWS: usize = 510;
/// Dimensions per row (voice embedding width).
pub const VOICE_COLS: usize = 256;
/// Expected voice file size in bytes.
pub const VOICE_FILE_BYTES: usize = VOICE_ROWS * VOICE_COLS * 4;

/// Load a Kokoro voice file into a flat Vec of [`VOICE_ROWS`] * [`VOICE_COLS`] floats.
pub fn load_voice(path: &Path) -> anyhow::Result<Vec<f32>> {
    let bytes = std::fs::read(path)?;
    if bytes.len() != VOICE_FILE_BYTES {
        anyhow::bail!(
            "voice file size {} != expected {} ({} rows × {} cols × 4 bytes)",
            bytes.len(),
            VOICE_FILE_BYTES,
            VOICE_ROWS,
            VOICE_COLS
        );
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

/// Select the style embedding row for a given active-token count.
/// Indexes by `min(token_count - 1, VOICE_ROWS - 1)` (clamp both ends to valid range).
pub fn select_style(voice: &[f32], token_count: usize) -> &[f32] {
    let row = token_count.saturating_sub(1).min(VOICE_ROWS - 1);
    &voice[row * VOICE_COLS..(row + 1) * VOICE_COLS]
}

/// Default voice id used when neither `--voice` nor auto-routing resolves one.
pub const DEFAULT_VOICE_ID: &str = "en-af_heart";

/// Resolved engine + paths for a given voice id.
#[derive(Debug)]
pub enum ResolvedVoice {
    Kokoro {
        model_path: std::path::PathBuf,
        voice_path: std::path::PathBuf,
        espeak_lang: &'static str,
    },
    Piper {
        model_path: std::path::PathBuf,
        config_path: std::path::PathBuf,
        espeak_lang: &'static str,
    },
    /// macOS system TTS via AVSpeechSynthesizer (#141). The voice id is
    /// whatever the user passed after the `macos-` prefix — forwarded to the
    /// Swift helper, which tries `AVSpeechSynthesisVoice(identifier:)` first
    /// and falls back to `AVSpeechSynthesisVoice(language:)`.
    #[cfg(all(feature = "system_tts", target_os = "macos"))]
    AVSpeech { voice_id: String },
}

impl ResolvedVoice {
    pub fn espeak_lang(&self) -> &'static str {
        match self {
            Self::Kokoro { espeak_lang, .. } | Self::Piper { espeak_lang, .. } => espeak_lang,
            // AVSpeech does its own G2P; the espeak language tag is unused.
            #[cfg(all(feature = "system_tts", target_os = "macos"))]
            Self::AVSpeech { .. } => "",
        }
    }
}

/// Parse a voice id like `en-af_heart` or `ru-denis` into engine + paths.
/// Voice id is `<lang>-<name>`; lang picks the engine and espeak language code.
/// The special `macos-*` prefix routes to AVSpeechSynthesizer on supported builds.
pub fn resolve_voice(cache_dir: &Path, voice_id: &str) -> anyhow::Result<ResolvedVoice> {
    let (lang, name) = voice_id.split_once('-').ok_or_else(|| {
        anyhow::anyhow!("voice id must be in 'lang-name' form (got '{voice_id}')")
    })?;
    match lang {
        "en" => resolve_kokoro(cache_dir, voice_id, name),
        "ru" => resolve_piper_ru(cache_dir, voice_id, name),
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        "macos" => {
            if name.is_empty() {
                anyhow::bail!(
                    "'macos-' voice id requires a suffix (identifier or language code, e.g. macos-en-US)"
                );
            }
            Ok(ResolvedVoice::AVSpeech {
                voice_id: name.to_string(),
            })
        }
        #[cfg(not(all(feature = "system_tts", target_os = "macos")))]
        "macos" => anyhow::bail!(
            "'macos-*' voices require a macOS build with --features system_tts (got '{voice_id}')"
        ),
        other => {
            anyhow::bail!("language '{other}' not supported (use 'en-*', 'ru-*', or 'macos-*')")
        }
    }
}

fn resolve_kokoro(cache_dir: &Path, voice_id: &str, name: &str) -> anyhow::Result<ResolvedVoice> {
    let model_path = cache_dir.join("models/kokoro-82m/model.onnx");
    let voice_path = cache_dir
        .join("models/kokoro-82m/voices")
        .join(format!("{name}.bin"));
    if !voice_path.exists() {
        anyhow::bail!("voice '{voice_id}' not installed. run: kesha install --tts");
    }
    if !model_path.exists() {
        anyhow::bail!(
            "kokoro model not installed at {}. run: kesha install --tts",
            model_path.display()
        );
    }
    Ok(ResolvedVoice::Kokoro {
        model_path,
        voice_path,
        espeak_lang: "en-us",
    })
}

fn resolve_piper_ru(cache_dir: &Path, voice_id: &str, name: &str) -> anyhow::Result<ResolvedVoice> {
    // Piper filenames follow the upstream convention `ru_RU-<name>-medium.*`.
    let base = cache_dir
        .join("models/piper-ru")
        .join(format!("ru_RU-{name}-medium"));
    let model_path = base.with_extension("onnx");
    let config_path = base.with_extension("onnx.json");
    if !model_path.exists() || !config_path.exists() {
        anyhow::bail!("voice '{voice_id}' not installed. run: kesha install --tts");
    }
    Ok(ResolvedVoice::Piper {
        model_path,
        config_path,
        espeak_lang: "ru",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_bytes(bytes: &[u8]) -> tempfile::NamedTempFile {
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        tmp.write_all(bytes).unwrap();
        tmp
    }

    #[test]
    fn load_rejects_wrong_size() {
        let tmp = write_bytes(&[0u8; 100]);
        let err = load_voice(tmp.path()).unwrap_err();
        assert!(err.to_string().contains("voice file size"));
    }

    #[test]
    fn load_ok_for_correct_size() {
        let tmp = write_bytes(&vec![0u8; VOICE_FILE_BYTES]);
        let voice = load_voice(tmp.path()).unwrap();
        assert_eq!(voice.len(), VOICE_ROWS * VOICE_COLS);
    }

    #[test]
    fn select_style_clamps_high_indices() {
        let voice = vec![0.0; VOICE_ROWS * VOICE_COLS];
        let s = select_style(&voice, 10_000);
        assert_eq!(s.len(), VOICE_COLS);
    }

    #[test]
    fn select_style_handles_zero() {
        let voice = vec![0.0; VOICE_ROWS * VOICE_COLS];
        let s = select_style(&voice, 0);
        assert_eq!(s.len(), VOICE_COLS);
    }

    #[test]
    fn select_style_picks_correct_row() {
        // Row i contains value = i as f32
        let mut voice = Vec::with_capacity(VOICE_ROWS * VOICE_COLS);
        for row in 0..VOICE_ROWS {
            for _ in 0..VOICE_COLS {
                voice.push(row as f32);
            }
        }
        // token_count = 8 should pick row 7
        let s = select_style(&voice, 8);
        assert_eq!(s[0], 7.0);
        assert_eq!(s[VOICE_COLS - 1], 7.0);
    }

    fn populate_cache(cache: &Path) {
        let voices = cache.join("models/kokoro-82m/voices");
        std::fs::create_dir_all(&voices).unwrap();
        std::fs::write(voices.join("af_heart.bin"), vec![0u8; VOICE_FILE_BYTES]).unwrap();
        std::fs::write(cache.join("models/kokoro-82m/model.onnx"), b"dummy").unwrap();
    }

    #[test]
    fn resolve_installed_kokoro_voice() {
        let tmp = tempfile::tempdir().unwrap();
        populate_cache(tmp.path());
        let r = resolve_voice(tmp.path(), "en-af_heart").unwrap();
        match r {
            ResolvedVoice::Kokoro {
                voice_path,
                model_path,
                espeak_lang,
            } => {
                assert!(voice_path.ends_with("af_heart.bin"));
                assert!(model_path.ends_with("model.onnx"));
                assert_eq!(espeak_lang, "en-us");
            }
            other => panic!("expected Kokoro, got {other:?}"),
        }
    }

    fn populate_piper_ru(cache: &Path) {
        let dir = cache.join("models/piper-ru");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ru_RU-denis-medium.onnx"), b"dummy").unwrap();
        std::fs::write(dir.join("ru_RU-denis-medium.onnx.json"), b"{}").unwrap();
    }

    #[cfg(all(feature = "system_tts", target_os = "macos"))]
    #[test]
    fn resolve_macos_voice_returns_avspeech() {
        let tmp = tempfile::tempdir().unwrap();
        let r = resolve_voice(tmp.path(), "macos-com.apple.voice.compact.en-US.Samantha").unwrap();
        match r {
            ResolvedVoice::AVSpeech { voice_id } => {
                // Prefix stripped; the rest (including embedded dashes) passes through.
                assert_eq!(voice_id, "com.apple.voice.compact.en-US.Samantha");
            }
            other => panic!("expected AVSpeech, got {other:?}"),
        }
    }

    #[cfg(all(feature = "system_tts", target_os = "macos"))]
    #[test]
    fn resolve_macos_empty_suffix_errors() {
        // `macos-` alone would forward an empty string to the Swift helper,
        // which then fails with an unhelpful "voice not found". Reject early.
        let tmp = tempfile::tempdir().unwrap();
        let err = resolve_voice(tmp.path(), "macos-").unwrap_err().to_string();
        assert!(err.contains("requires a suffix"), "msg: {err}");
    }

    #[cfg(all(feature = "system_tts", target_os = "macos"))]
    #[test]
    fn resolve_macos_short_voice_id_works() {
        let tmp = tempfile::tempdir().unwrap();
        let r = resolve_voice(tmp.path(), "macos-en-US").unwrap();
        match r {
            ResolvedVoice::AVSpeech { voice_id } => assert_eq!(voice_id, "en-US"),
            other => panic!("expected AVSpeech, got {other:?}"),
        }
    }

    #[cfg(not(all(feature = "system_tts", target_os = "macos")))]
    #[test]
    fn resolve_macos_voice_errors_without_feature() {
        let tmp = tempfile::tempdir().unwrap();
        let err = resolve_voice(tmp.path(), "macos-en-US")
            .unwrap_err()
            .to_string();
        assert!(err.contains("system_tts"), "msg: {err}");
    }

    #[test]
    fn resolve_installed_piper_voice() {
        let tmp = tempfile::tempdir().unwrap();
        populate_piper_ru(tmp.path());
        let r = resolve_voice(tmp.path(), "ru-denis").unwrap();
        match r {
            ResolvedVoice::Piper {
                model_path,
                config_path,
                espeak_lang,
            } => {
                assert!(model_path.ends_with("ru_RU-denis-medium.onnx"));
                assert!(config_path.ends_with("ru_RU-denis-medium.onnx.json"));
                assert_eq!(espeak_lang, "ru");
            }
            other => panic!("expected Piper, got {other:?}"),
        }
    }

    #[test]
    fn resolve_missing_voice_errors_with_hint() {
        let tmp = tempfile::tempdir().unwrap();
        // Cache exists but voice does not
        let err = resolve_voice(tmp.path(), "en-af_heart").unwrap_err();
        assert!(err.to_string().contains("install --tts"), "msg: {err}");
    }

    #[test]
    fn resolve_missing_model_errors() {
        let tmp = tempfile::tempdir().unwrap();
        // Voice present but model missing
        let voices = tmp.path().join("models/kokoro-82m/voices");
        std::fs::create_dir_all(&voices).unwrap();
        std::fs::write(voices.join("af_heart.bin"), vec![0u8; VOICE_FILE_BYTES]).unwrap();
        let err = resolve_voice(tmp.path(), "en-af_heart").unwrap_err();
        assert!(err.to_string().contains("install --tts"), "msg: {err}");
    }

    #[test]
    fn resolve_bad_id_format() {
        let tmp = tempfile::tempdir().unwrap();
        let err = resolve_voice(tmp.path(), "gibberish").unwrap_err();
        assert!(err.to_string().contains("lang-name"));
    }

    #[test]
    fn resolve_unsupported_language() {
        let tmp = tempfile::tempdir().unwrap();
        let err = resolve_voice(tmp.path(), "fr-something").unwrap_err();
        assert!(err.to_string().contains("not supported"), "msg: {err}");
    }
}
