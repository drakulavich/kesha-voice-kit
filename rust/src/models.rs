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

fn cache_dir() -> PathBuf {
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
