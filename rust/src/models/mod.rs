mod download;
mod manifest;
mod paths;
mod progress;
mod staging;

#[cfg(feature = "tts")]
pub use download::download_tts;
pub use download::{apply_mirror, download_vad, init_mirror_logging, model_mirror};
#[cfg(feature = "system_diarize")]
pub use download::{cleanup_diarize_compiled_sidecars, download_diarize};
pub use manifest::ModelFile;
#[cfg(feature = "tts")]
pub use manifest::{tts_engine_for, tts_languages, validate_tts_langs, VOSK_RU_FILES};
#[cfg(test)]
pub(crate) use paths::cache_dir_from;
#[cfg(any(
    feature = "coreml",
    feature = "system_kokoro",
    feature = "system_diarize"
))]
pub use paths::fluidaudio_bridge;
#[cfg(feature = "system_diarize")]
pub use paths::fluidaudio_diarize_location;
pub use paths::{
    cache_dir, fluidaudio_location, fluidaudio_models_root, is_cached, is_cached_in, model_dir,
    model_dir_at, stale_legacy_notice, FluidAudioLocation, ModelKind, FLUIDAUDIO_ROOT_DIR,
    FLUID_ASR_REPO_DIR,
};
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub use paths::{
    fluidaudio_ane_kokoro_dir, fluidaudio_ane_zh_kokoro_dir, fluidaudio_kokoro_cache_dir,
    fluidaudio_kokoro_g2p_dir, fluidaudio_kokoro_location,
};
#[cfg(feature = "coreml")]
pub use paths::{fluidaudio_asr_dir, fluidaudio_asr_location, fluidaudio_asr_ready};
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub use staging::{incomplete_ane_bundle_names, missing_kokoro_assets};

use anyhow::Result;

use download::{cleanup_legacy, parallel_download};
use manifest::*;
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
use staging::purge_incomplete_ane_bundles;

pub fn install(no_cache: bool) -> Result<()> {
    let cache = cache_dir()?;

    // Every install repairs the ANE cache, not just `--tts`: a user who already had
    // TTS and only upgrades the engine still carries the incomplete bundle (#709).
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    purge_incomplete_ane_bundles()?;

    // Always hash-verify even on cache hits — catches silent corruption (#174).
    // 4-worker pool (#178) overlaps ASR + lang-id round-trips within HF's per-IP tolerance.
    #[cfg(not(feature = "coreml"))]
    let manifest: Vec<&ModelFile> = ASR_FILES.iter().chain(LANG_ID_FILES.iter()).collect();
    #[cfg(feature = "coreml")]
    let manifest: Vec<&ModelFile> = LANG_ID_FILES.iter().collect();
    parallel_download(&cache, &manifest, no_cache)?;

    cleanup_legacy(&cache);
    Ok(())
}
