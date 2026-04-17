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
#[derive(Debug, Clone)]
pub struct ModelFile {
    pub rel_path: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
}

#[cfg(feature = "tts")]
pub fn kokoro_manifest() -> Vec<ModelFile> {
    vec![
        ModelFile {
            rel_path: "models/kokoro-82m/model.onnx",
            url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model.onnx",
            sha256: "8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb",
            size_bytes: 326_000_000,
        },
        ModelFile {
            rel_path: "models/kokoro-82m/voices/af_heart.bin",
            url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin",
            sha256: "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b",
            size_bytes: 522_240,
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
            assert!(f.size_bytes > 0, "{:?} missing size", f);
            assert!(f.url.starts_with("https://"), "{:?} url not https", f);
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
        let url = format!("https://huggingface.co/{}/resolve/main/{}", repo, file);
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

/// Kokoro TTS install. Downloads model.onnx + af_heart voice, verifies SHA256.
#[cfg(feature = "tts")]
pub fn download_tts_kokoro(no_cache: bool) -> Result<()> {
    let cache = cache_dir();
    for f in kokoro_manifest() {
        let target = cache.join(f.rel_path);
        if !no_cache && target.exists() && verify_sha256(&target, f.sha256)? {
            eprintln!("OK  {} (cached)", f.rel_path);
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        eprintln!("GET {}", f.rel_path);
        let response = ureq::get(f.url)
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
    }
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
