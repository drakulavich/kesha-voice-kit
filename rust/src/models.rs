use anyhow::{Context, Result};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const ASR_HF_REPO: &str = "istupakov/parakeet-tdt-0.6b-v3-onnx";
const ASR_FILES: &[&str] = &[
    "encoder-model.onnx",
    "encoder-model.onnx.data",
    "decoder_joint-model.onnx",
    "nemo128.onnx",
    "vocab.txt",
];

const LANG_ID_HF_REPO: &str = "drakulavich/SpeechBrain-coreml";
const LANG_ID_FILES: &[&str] = &[
    "lang-id-ecapa.onnx",
    "lang-id-ecapa.onnx.data",
    "labels.json",
];

/// A file in a model manifest. SHA256 is optional for legacy models; new
/// TTS downloads verify it.
#[cfg(feature = "tts")]
#[derive(Debug, Clone)]
pub struct ModelFile {
    pub rel_path: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
}

#[cfg(feature = "tts")]
pub fn kokoro_manifest() -> Vec<ModelFile> {
    vec![
        ModelFile {
            rel_path: "models/kokoro-82m/model.onnx",
            url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx",
            sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb",
        },
        ModelFile {
            rel_path: "models/kokoro-82m/voices/af_heart.bin",
            url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin",
            sha256: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
        },
    ]
}

/// Piper Russian voice (denis, medium quality). See [rhasspy/piper-voices].
#[cfg(feature = "tts")]
pub fn piper_ru_manifest() -> Vec<ModelFile> {
    vec![
        ModelFile {
            rel_path: "models/piper-ru/ru_RU-denis-medium.onnx",
            url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx",
            sha256: "15fab56e11a097858ee115545d0f697fc2a316c41a291a5362349fb870411b0a",
        },
        ModelFile {
            rel_path: "models/piper-ru/ru_RU-denis-medium.onnx.json",
            url: "https://huggingface.co/rhasspy/piper-voices/resolve/main/ru/ru_RU/denis/medium/ru_RU-denis-medium.onnx.json",
            sha256: "831c860dac0b5073eaa81610a0a638ec23d90a6cf8e5f871b4485c2cec3767c8",
        },
    ]
}

pub fn cache_dir() -> PathBuf {
    if let Ok(p) = std::env::var("KESHA_CACHE_DIR") {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .expect("cannot determine home directory")
        .join(".cache")
        .join("kesha")
}

/// Optional HuggingFace mirror base URL. Respects `KESHA_MODEL_MIRROR` (#121).
///
/// Empty string and unset both fall through to the default upstream. Trailing
/// slashes are stripped so callers can safely concat with URL paths.
pub fn model_mirror() -> Option<String> {
    match std::env::var("KESHA_MODEL_MIRROR") {
        Ok(s) => {
            let trimmed = s.trim().trim_end_matches('/');
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Err(_) => None,
    }
}

/// Rewrite a `huggingface.co` URL onto `KESHA_MODEL_MIRROR` if set. The HF
/// path hierarchy (`/<owner>/<repo>/resolve/<ref>/<file>`) is preserved
/// verbatim after the mirror base so operators can clone with `wget --mirror`
/// or plain `rsync`. URLs on other hosts (e.g. github.com release assets)
/// pass through unchanged — this env var only redirects model fetches.
pub fn apply_mirror(url: &str) -> String {
    if let Some(base) = model_mirror() {
        if let Some(path) = url.strip_prefix("https://huggingface.co") {
            return format!("{base}{path}");
        }
    }
    url.to_string()
}

pub fn asr_model_dir() -> String {
    cache_dir()
        .join("models")
        .join("parakeet-tdt-v3")
        .to_string_lossy()
        .to_string()
}

pub fn lang_id_model_dir() -> String {
    cache_dir()
        .join("models")
        .join("lang-id-ecapa")
        .to_string_lossy()
        .to_string()
}

pub fn is_asr_cached(dir: &str) -> bool {
    ASR_FILES.iter().all(|f| Path::new(dir).join(f).exists())
}

pub fn is_lang_id_cached(dir: &str) -> bool {
    LANG_ID_FILES
        .iter()
        .all(|f| Path::new(dir).join(f).exists())
}

pub fn install(no_cache: bool) -> Result<()> {
    if let Some(base) = model_mirror() {
        eprintln!("Model mirror active: {base}");
    }
    // ASR models (ONNX backend only for now)
    let asr_dir = asr_model_dir();
    if no_cache || !is_asr_cached(&asr_dir) {
        download_hf_files(ASR_HF_REPO, ASR_FILES, &asr_dir)?;
        eprintln!("ASR models downloaded.");
    } else {
        eprintln!("ASR models already cached.");
    }

    // Lang-ID models
    let lang_id_dir = lang_id_model_dir();
    if no_cache || !is_lang_id_cached(&lang_id_dir) {
        download_hf_files(LANG_ID_HF_REPO, LANG_ID_FILES, &lang_id_dir)?;
        eprintln!("Lang-ID models downloaded.");
    } else {
        eprintln!("Lang-ID models already cached.");
    }

    cleanup_legacy();
    Ok(())
}

#[cfg(test)]
mod mirror_tests {
    use super::*;
    use std::sync::Mutex;

    // env-var tests race if parallelized — serialize them here.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct MirrorEnv {
        _guard: std::sync::MutexGuard<'static, ()>,
        original: Option<String>,
    }

    impl MirrorEnv {
        fn set(val: &str) -> Self {
            let guard = ENV_LOCK.lock().unwrap();
            let original = std::env::var("KESHA_MODEL_MIRROR").ok();
            unsafe {
                std::env::set_var("KESHA_MODEL_MIRROR", val);
            }
            Self {
                _guard: guard,
                original,
            }
        }
        fn unset() -> Self {
            let guard = ENV_LOCK.lock().unwrap();
            let original = std::env::var("KESHA_MODEL_MIRROR").ok();
            unsafe {
                std::env::remove_var("KESHA_MODEL_MIRROR");
            }
            Self {
                _guard: guard,
                original,
            }
        }
    }

    impl Drop for MirrorEnv {
        fn drop(&mut self) {
            match &self.original {
                Some(v) => unsafe { std::env::set_var("KESHA_MODEL_MIRROR", v) },
                None => unsafe { std::env::remove_var("KESHA_MODEL_MIRROR") },
            }
        }
    }

    #[test]
    fn unset_env_falls_through_to_upstream() {
        let _g = MirrorEnv::unset();
        assert_eq!(model_mirror(), None);
        assert_eq!(
            apply_mirror("https://huggingface.co/foo/bar/resolve/main/file.onnx"),
            "https://huggingface.co/foo/bar/resolve/main/file.onnx"
        );
    }

    #[test]
    fn empty_env_falls_through_to_upstream() {
        let _g = MirrorEnv::set("");
        assert_eq!(model_mirror(), None);
        assert_eq!(
            apply_mirror("https://huggingface.co/foo/bar/resolve/main/file.onnx"),
            "https://huggingface.co/foo/bar/resolve/main/file.onnx"
        );
    }

    #[test]
    fn whitespace_env_falls_through_to_upstream() {
        let _g = MirrorEnv::set("   ");
        assert_eq!(model_mirror(), None);
    }

    #[test]
    fn rewrites_hf_url_onto_mirror_base_preserving_path() {
        let _g = MirrorEnv::set("https://mirror.example.com/kesha");
        assert_eq!(
            apply_mirror("https://huggingface.co/foo/bar/resolve/main/file.onnx"),
            "https://mirror.example.com/kesha/foo/bar/resolve/main/file.onnx"
        );
    }

    #[test]
    fn strips_trailing_slash_from_mirror_base() {
        let _g = MirrorEnv::set("https://mirror.example.com/kesha/");
        assert_eq!(
            apply_mirror("https://huggingface.co/x/y/resolve/main/z.bin"),
            "https://mirror.example.com/kesha/x/y/resolve/main/z.bin"
        );
    }

    #[test]
    fn non_hf_urls_pass_through_unchanged() {
        // github.com release assets (engine binary + avspeech sidecar) must
        // NOT be redirected — KESHA_MODEL_MIRROR only covers model files.
        let _g = MirrorEnv::set("https://mirror.example.com");
        let url = "https://github.com/drakulavich/kesha-voice-kit/releases/download/v1.3.0/kesha-engine-darwin-arm64";
        assert_eq!(apply_mirror(url), url);
    }
}

#[cfg(all(test, feature = "tts"))]
mod tts_tests {
    use super::*;

    #[test]
    fn kokoro_manifest_has_expected_files() {
        let m = kokoro_manifest();
        assert!(m.iter().any(|f| f.rel_path.ends_with("model.onnx")));
        assert!(m.iter().any(|f| f.rel_path.ends_with("af_heart.bin")));
        for f in &m {
            assert_eq!(f.sha256.len(), 64, "{:?} sha256 not 64 hex chars", f);
            assert!(f.url.starts_with("https://"), "{f:?} url not https");
        }
    }

    #[test]
    fn piper_ru_manifest_has_expected_files() {
        let m = piper_ru_manifest();
        assert!(m
            .iter()
            .any(|f| f.rel_path.ends_with("ru_RU-denis-medium.onnx")));
        assert!(m
            .iter()
            .any(|f| f.rel_path.ends_with("ru_RU-denis-medium.onnx.json")));
        for f in &m {
            assert_eq!(f.sha256.len(), 64, "{:?} sha256 not 64 hex chars", f);
            assert!(f.url.starts_with("https://"), "{f:?} url not https");
        }
    }

    #[test]
    fn cache_dir_honors_env_var() {
        let guard = EnvGuard::set("KESHA_CACHE_DIR", "/tmp/kesha-test-xyz");
        assert_eq!(cache_dir(), PathBuf::from("/tmp/kesha-test-xyz"));
        drop(guard);
    }

    /// Restores the env var to its original value on drop.
    struct EnvGuard {
        key: &'static str,
        original: Option<String>,
    }

    impl EnvGuard {
        fn set(key: &'static str, val: &str) -> Self {
            let original = std::env::var(key).ok();
            unsafe {
                std::env::set_var(key, val);
            }
            Self { key, original }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.original {
                Some(v) => unsafe {
                    std::env::set_var(self.key, v);
                },
                None => unsafe {
                    std::env::remove_var(self.key);
                },
            }
        }
    }
}

fn download_hf_files(repo: &str, files: &[&str], dest_dir: &str) -> Result<()> {
    fs::create_dir_all(dest_dir)?;
    for file in files {
        let upstream = format!("https://huggingface.co/{}/resolve/main/{}", repo, file);
        let url = apply_mirror(&upstream);
        let dest = Path::new(dest_dir).join(file);
        eprintln!("Downloading {}...", file);

        let response = ureq::get(&url)
            .call()
            .with_context(|| format!("failed to download {}", file))?;

        let mut reader = response.into_body().into_reader();
        let mut out = fs::File::create(&dest)
            .with_context(|| format!("failed to create {}", dest.display()))?;
        io::copy(&mut reader, &mut out)?;
    }
    Ok(())
}

/// Download every TTS model file: Kokoro English + Piper Russian.
/// Each file is streamed to disk, then SHA256-verified.
#[cfg(feature = "tts")]
pub fn download_tts(no_cache: bool) -> Result<()> {
    let cache = cache_dir();
    let mut manifest = kokoro_manifest();
    manifest.extend(piper_ru_manifest());
    for f in manifest {
        download_verified(&cache, &f, no_cache)?;
    }
    Ok(())
}

#[cfg(feature = "tts")]
fn download_verified(cache: &Path, f: &ModelFile, no_cache: bool) -> Result<()> {
    let target = cache.join(f.rel_path);
    if !no_cache && target.exists() && verify_sha256(&target, f.sha256)? {
        eprintln!("OK  {} (cached)", f.rel_path);
        return Ok(());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    eprintln!("GET {}", f.rel_path);
    let url = apply_mirror(f.url);
    let response = ureq::get(&url)
        .call()
        .with_context(|| format!("download {}", f.rel_path))?;
    let mut reader = response.into_body().into_reader();
    let mut out =
        fs::File::create(&target).with_context(|| format!("create {}", target.display()))?;
    io::copy(&mut reader, &mut out)?;
    drop(out);
    if !verify_sha256(&target, f.sha256)? {
        anyhow::bail!("sha256 mismatch for {}", f.rel_path);
    }
    eprintln!("OK  {}", f.rel_path);
    Ok(())
}

#[cfg(feature = "tts")]
fn verify_sha256(path: &Path, expected: &str) -> Result<bool> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut hasher = Sha256::new();
    io::copy(&mut file, &mut hasher)?;
    let actual = hex_encode(&hasher.finalize());
    Ok(actual.eq_ignore_ascii_case(expected))
}

#[cfg(feature = "tts")]
fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn cleanup_legacy() {
    let cache = cache_dir();
    let old_onnx = cache.join("v3");
    if old_onnx.exists() {
        eprintln!("Cleaning up legacy ONNX models...");
        let _ = fs::remove_dir_all(&old_onnx);
    }
    let old_swift = cache.join("coreml").join("bin").join("parakeet-coreml");
    if old_swift.exists() {
        eprintln!("Cleaning up legacy CoreML binary...");
        let _ = fs::remove_file(&old_swift);
    }
}
