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

/// Resolved paths + language for a given voice id, looked up against the cache.
#[derive(Debug)]
pub struct ResolvedVoice {
    pub voice_path: std::path::PathBuf,
    pub model_path: std::path::PathBuf,
    pub espeak_lang: &'static str,
}

/// Parse a voice id like `en-af_heart` into espeak language + filesystem paths.
/// Returns an error if the voice is not installed at `<cache>/models/kokoro-82m/voices/<name>.bin`.
/// Only English voices are supported currently; Silero (ru, uk) lands in a later milestone.
pub fn resolve_voice(cache_dir: &Path, voice_id: &str) -> anyhow::Result<ResolvedVoice> {
    let (lang, name) = voice_id.split_once('-').ok_or_else(|| {
        anyhow::anyhow!("voice id must be in 'lang-name' form (got '{voice_id}')")
    })?;
    let espeak_lang: &'static str = match lang {
        "en" => "en-us",
        other => anyhow::bail!("language '{other}' not supported (use 'en-*')"),
    };
    let voice_path = cache_dir
        .join("models/kokoro-82m/voices")
        .join(format!("{name}.bin"));
    let model_path = cache_dir.join("models/kokoro-82m/model.onnx");
    if !voice_path.exists() {
        anyhow::bail!("voice '{voice_id}' not installed. run: kesha install --tts");
    }
    if !model_path.exists() {
        anyhow::bail!(
            "kokoro model not installed at {}. run: kesha install --tts",
            model_path.display()
        );
    }
    Ok(ResolvedVoice {
        voice_path,
        model_path,
        espeak_lang,
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
    fn resolve_installed_voice() {
        let tmp = tempfile::tempdir().unwrap();
        populate_cache(tmp.path());
        let r = resolve_voice(tmp.path(), "en-af_heart").unwrap();
        assert!(r.voice_path.ends_with("af_heart.bin"));
        assert!(r.model_path.ends_with("model.onnx"));
        assert_eq!(r.espeak_lang, "en-us");
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
        let err = resolve_voice(tmp.path(), "ru-something").unwrap_err();
        assert!(err.to_string().contains("not supported"), "msg: {err}");
    }
}
