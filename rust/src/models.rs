use anyhow::{Context, Result};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// A file in a model manifest. `rel_path` is relative to `cache_dir()`,
/// uniform across ASR / lang-id / TTS. Every entry carries a pinned
/// SHA-256 so an upstream rehost or a compromised `KESHA_MODEL_MIRROR`
/// produces a clear hash mismatch rather than silently delivering
/// unverified weights (#174).
#[derive(Debug, Clone)]
pub struct ModelFile {
    pub rel_path: &'static str,
    pub url: &'static str,
    pub sha256: &'static str,
}

/// Parakeet TDT v3 ONNX weights. Hashes pinned from a clean install against
/// `huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx` — an upstream
/// republish becomes a deliberate PR to bump.
const ASR_FILES: &[ModelFile] = &[
    ModelFile {
        rel_path: "models/parakeet-tdt-v3/encoder-model.onnx",
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.onnx",
        sha256: "98a74b21b4cc0017c1e7030319a4a96f4a9506e50f0708f3a516d02a77c96bb1",
    },
    ModelFile {
        rel_path: "models/parakeet-tdt-v3/encoder-model.onnx.data",
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/encoder-model.onnx.data",
        sha256: "9a22d372c51455c34f13405da2520baefb7125bd16981397561423ed32d24f36",
    },
    ModelFile {
        rel_path: "models/parakeet-tdt-v3/decoder_joint-model.onnx",
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/decoder_joint-model.onnx",
        sha256: "e978ddf6688527182c10fde2eb4b83068421648985ef23f7a86be732be8706c1",
    },
    ModelFile {
        rel_path: "models/parakeet-tdt-v3/nemo128.onnx",
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/nemo128.onnx",
        sha256: "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f",
    },
    ModelFile {
        rel_path: "models/parakeet-tdt-v3/vocab.txt",
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main/vocab.txt",
        sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
    },
];

/// SpeechBrain ECAPA-TDNN VoxLingua107 lang-id ONNX. Hashes pinned from
/// `huggingface.co/drakulavich/SpeechBrain-coreml`.
const LANG_ID_FILES: &[ModelFile] = &[
    ModelFile {
        rel_path: "models/lang-id-ecapa/lang-id-ecapa.onnx",
        url: "https://huggingface.co/drakulavich/SpeechBrain-coreml/resolve/main/lang-id-ecapa.onnx",
        sha256: "4af3b6a5b4165f78715fe363ed6b7650d5f77ed0a6e2966c500eadc46252a288",
    },
    ModelFile {
        rel_path: "models/lang-id-ecapa/lang-id-ecapa.onnx.data",
        url: "https://huggingface.co/drakulavich/SpeechBrain-coreml/resolve/main/lang-id-ecapa.onnx.data",
        sha256: "78fefd776536f4a686bcf705dedb8e9a497b924a2107a949b42a24b2b90174a2",
    },
    ModelFile {
        rel_path: "models/lang-id-ecapa/labels.json",
        url: "https://huggingface.co/drakulavich/SpeechBrain-coreml/resolve/main/labels.json",
        sha256: "9e515c3c7932659fd1e6c3febc395529d0a8092328adb9f5e75185a04bb523d0",
    },
];

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

/// Emit the "Model mirror active: <url>" banner once per process so any
/// download entry point (`install`, `download_tts`, future programmatic
/// callers) surfaces the redirect. `OnceLock` keeps us quiet on the
/// second-through-Nth call — a user running `kesha install --tts` would
/// otherwise see the line twice.
fn log_mirror_once() {
    use std::sync::OnceLock;
    static LOGGED: OnceLock<()> = OnceLock::new();
    LOGGED.get_or_init(|| {
        if let Some(base) = model_mirror() {
            eprintln!("Model mirror active: {base}");
        }
    });
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
    has_all_files(dir, ASR_FILES)
}

pub fn is_lang_id_cached(dir: &str) -> bool {
    has_all_files(dir, LANG_ID_FILES)
}

/// Caller passes the per-model dir (e.g. `asr_model_dir()`); we pull the
/// basename out of each manifest entry's cache-relative `rel_path` and
/// check it's present. Keeps the public `dir`-based API while letting the
/// manifest own the full URL + hash for the download path.
fn has_all_files(dir: &str, files: &[ModelFile]) -> bool {
    let dir = Path::new(dir);
    files.iter().all(|f| {
        Path::new(f.rel_path)
            .file_name()
            .map(|n| dir.join(n).exists())
            .unwrap_or(false)
    })
}

pub fn install(no_cache: bool) -> Result<()> {
    log_mirror_once();
    let cache = cache_dir();

    // Always run through download_verified so a silently-corrupted cached
    // file gets caught on the next `kesha install` (hash mismatch → fall
    // through and re-download). The per-file "OK (cached)" / "GET" log is
    // emitted by download_verified itself — intentionally no summary line
    // so the verbose-per-file output is the single source of truth.
    //
    // ASR + lang-id downloads run concurrently through a bounded 4-worker
    // pool (#178) so the HF round-trips overlap on a cold install. 8 files
    // total (5 ASR + 3 lang-id); 4 workers keeps us inside HF's
    // per-IP tolerance while filling the pipe on typical home bandwidth.
    let manifest: Vec<&ModelFile> = ASR_FILES.iter().chain(LANG_ID_FILES.iter()).collect();
    parallel_download(&cache, &manifest, no_cache)?;

    cleanup_legacy();
    Ok(())
}

/// Process-wide 4-worker pool reused across `install()` and
/// `download_tts()` — building a fresh pool per call spawns 4
/// `pthread_create`s and tears them down again for no reason. 4 workers
/// keeps us inside HF's per-IP tolerance while filling the pipe.
fn download_pool() -> &'static rayon::ThreadPool {
    use std::sync::OnceLock;
    static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(4)
            .thread_name(|i| format!("kesha-dl-{i}"))
            .build()
            .expect("download thread pool build failed")
    })
}

/// Kick off up to 4 concurrent `download_verified` calls against the
/// manifest. A single hash-mismatch (or any other error) bails the whole
/// install via `try_for_each` — matches the sequential contract from
/// before, just faster on a cold network.
fn parallel_download(cache: &Path, manifest: &[&ModelFile], no_cache: bool) -> Result<()> {
    use rayon::prelude::*;
    download_pool().install(|| {
        manifest
            .par_iter()
            .try_for_each(|f| download_verified(cache, f, no_cache))
    })
}

#[cfg(test)]
mod manifest_tests {
    use super::*;

    #[test]
    fn asr_manifest_has_expected_files_and_hashes() {
        assert_eq!(ASR_FILES.len(), 5);
        assert!(ASR_FILES.iter().any(|f| f.rel_path.ends_with("/vocab.txt")));
        assert!(ASR_FILES
            .iter()
            .any(|f| f.rel_path.ends_with("/encoder-model.onnx")));
        for f in ASR_FILES {
            assert_eq!(f.sha256.len(), 64, "{:?} sha256 not 64 hex chars", f);
            assert!(
                f.url.starts_with("https://huggingface.co/"),
                "{f:?} url not on huggingface.co — mirror rewrite relies on that prefix"
            );
            assert!(
                f.rel_path.starts_with("models/parakeet-tdt-v3/"),
                "{f:?} rel_path must live under the per-model cache dir"
            );
        }
    }

    #[test]
    fn lang_id_manifest_has_expected_files_and_hashes() {
        assert_eq!(LANG_ID_FILES.len(), 3);
        assert!(LANG_ID_FILES
            .iter()
            .any(|f| f.rel_path.ends_with("/labels.json")));
        for f in LANG_ID_FILES {
            assert_eq!(f.sha256.len(), 64);
            assert!(f.url.starts_with("https://huggingface.co/"));
            assert!(f.rel_path.starts_with("models/lang-id-ecapa/"));
        }
    }

    #[test]
    fn verify_sha256_matches_and_mismatches() -> Result<()> {
        let tmp = std::env::temp_dir().join("kesha-sha256-test.bin");
        fs::write(&tmp, b"hello world")?;
        // `echo -n 'hello world' | shasum -a 256`
        let expected = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";
        assert!(verify_sha256(&tmp, expected)?);
        assert!(!verify_sha256(&tmp, &"0".repeat(64))?);
        // Uppercase hashes in the manifest would still match (case-insensitive).
        assert!(verify_sha256(&tmp, &expected.to_uppercase())?);
        let _ = fs::remove_file(&tmp);
        Ok(())
    }
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

/// Download every TTS model file: Kokoro English + Piper Russian.
/// Each file is streamed to disk, then SHA256-verified. 4 concurrent
/// downloads (#178) — 4 files total here, one HF round-trip per file.
#[cfg(feature = "tts")]
pub fn download_tts(no_cache: bool) -> Result<()> {
    log_mirror_once();
    let cache = cache_dir();
    let mut manifest = kokoro_manifest();
    manifest.extend(piper_ru_manifest());
    let refs: Vec<&ModelFile> = manifest.iter().collect();
    parallel_download(&cache, &refs, no_cache)
}

/// Streams a manifest entry to its `cache/<rel_path>` destination, then
/// SHA-256-verifies. Runs for ASR, lang-id, and TTS (uniform integrity
/// check — see #174). A cached file that already matches the pinned hash
/// short-circuits the network round-trip. A mismatch after download
/// bails out hard so the bad file never loads at inference time.
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
        // Remove so the existence-only cache probes don't later resurrect
        // unverified weights (#174). Best-effort — errors here are masked
        // by the bail below which surfaces the real problem.
        let _ = fs::remove_file(&target);
        anyhow::bail!("sha256 mismatch for {}", f.rel_path);
    }
    eprintln!("OK  {}", f.rel_path);
    Ok(())
}

fn verify_sha256(path: &Path, expected: &str) -> Result<bool> {
    use sha2::{Digest, Sha256};
    // 64 KiB buffer keeps `io::copy` off its 8 KiB default so hashing a
    // 2.4 GB model file stays IO-bound rather than syscall-bound.
    let file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut reader = std::io::BufReader::with_capacity(65_536, file);
    let mut hasher = Sha256::new();
    io::copy(&mut reader, &mut hasher)?;
    let actual = format!("{:x}", hasher.finalize());
    Ok(actual.eq_ignore_ascii_case(expected))
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
