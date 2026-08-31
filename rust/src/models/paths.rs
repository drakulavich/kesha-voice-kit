use anyhow::Result;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use super::manifest::*;
#[cfg(feature = "coreml")]
use super::progress::with_stderr;
use crate::coded_bail;
use crate::errors::ErrorCode;

/// Where one FluidAudio subsystem's files live, and the root that puts them there.
pub struct FluidAudioLocation {
    /// The directory the subsystem reads and writes.
    pub dir: PathBuf,
    /// Base to hand `FluidAudio::with_models_dir`. `None` keeps FluidAudio's own defaults.
    pub root: Option<PathBuf>,
}

/// FluidAudio's models root inside Kesha's cache (#688). `with_models_dir` treats this as a
/// base that each subsystem appends its own repo folder to, so Parakeet ASR, the Kokoro ANE
/// chain and the compiled-Sortformer cache become siblings here instead of three separate
/// home-directory roots FluidAudio picks for itself.
/// Mirrored by `src/fluid-asr-cache.ts`; `fluid-asr-cache.test.ts` reads this value to pin them.
pub const FLUIDAUDIO_ROOT_DIR: &str = "fluidaudio";

/// FluidAudio's repo folder for the Parakeet bundle, mirrored TS-side the same way (#684).
pub const FLUID_ASR_REPO_DIR: &str = "parakeet-tdt-0.6b-v3";

pub fn fluidaudio_models_root() -> Result<PathBuf> {
    Ok(cache_dir()?.join(FLUIDAUDIO_ROOT_DIR))
}

/// Resolve one subsystem, preferring a legacy location that already holds a usable bundle.
///
/// An install predating #688 holds ~2 GB under FluidAudio's own defaults, and injecting a
/// root would make FluidAudio re-download all of it. So `legacy_ready` pins the subsystem
/// where it already is and injects nothing; only what is absent — a fresh install, or a
/// bundle the user deleted — lands under [`fluidaudio_models_root`]. Nothing is ever moved
/// or removed, so the fallback is pure reading.
///
/// Returning both halves of the decision together is the point: `dir` and `root` must agree,
/// or Kesha stages voice packs into a directory FluidAudio never reads.
pub fn fluidaudio_location(
    legacy: &Path,
    legacy_ready: bool,
    repo_subpath: &str,
) -> Result<FluidAudioLocation> {
    if legacy_ready {
        return Ok(FluidAudioLocation {
            dir: legacy.to_path_buf(),
            root: None,
        });
    }
    let root = fluidaudio_models_root()?;
    Ok(FluidAudioLocation {
        dir: root.join(repo_subpath),
        root: Some(root),
    })
}

/// Open a FluidAudio bridge honouring `at`. Routing every construction site through this
/// keeps the directory Kesha reports and the directory FluidAudio writes to from drifting.
#[cfg(any(
    feature = "coreml",
    feature = "system_kokoro",
    feature = "system_diarize"
))]
pub fn fluidaudio_bridge(
    at: &FluidAudioLocation,
) -> std::result::Result<fluidaudio_rs::FluidAudio, fluidaudio_rs::FluidAudioError> {
    match &at.root {
        Some(root) => fluidaudio_rs::FluidAudio::with_models_dir(root),
        None => fluidaudio_rs::FluidAudio::new(),
    }
}

/// True when `dir` exists and holds at least one entry. Deliberately weak: the cost of a
/// false positive is keeping a legacy directory in use, the cost of a false negative is
/// re-downloading it (#688).
fn dir_has_entries(dir: &Path) -> bool {
    fs::read_dir(dir).is_ok_and(|mut e| e.next().is_some())
}

/// One stderr line for the moment a legacy bundle stops being read, or `None` when there is
/// nothing to say.
///
/// When a probe rejects a directory that still holds files — a fetch that died half-way, or a
/// pin bump that changed the required model set — the subsystem moves under
/// [`fluidaudio_models_root`] and ~461 MB stays behind with nothing pointing at it (#688).
/// Silent otherwise: a legacy bundle that passes its probe is the one in use, and a machine
/// that never had one is the common case, where a warning would name a path the user has
/// never seen. `latched` holds it to once per process — the location is resolved per bridge
/// construction, not once.
///
/// Only the ASR path can reach the firing case. Kokoro and the compiled diarizer probe with
/// [`dir_has_entries`], where a rejection *means* the directory is missing or empty, so by
/// construction they never abandon anything.
pub fn stale_legacy_notice(
    legacy: &Path,
    legacy_ready: bool,
    latched: &AtomicBool,
) -> Option<String> {
    if legacy_ready || !dir_has_entries(legacy) || latched.swap(true, Ordering::Relaxed) {
        return None;
    }
    let root = fluidaudio_models_root().ok()?;
    Some(format!(
        "warning: legacy FluidAudio bundle at {} is no longer read (incomplete, or superseded by a model-set change); models now load from {}, so the old directory can be deleted",
        legacy.display(),
        root.display()
    ))
}

/// FluidAudio's Kokoro CoreML cache root. Each KokoroAne variant gets its own
/// subdirectory of bundles here (`ANE` for English/Latin, `ANE-zh` for the
/// Mandarin variant, and so on per `ModelNames.Repo.subPath`).
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub fn fluidaudio_kokoro_cache_dir() -> Result<PathBuf> {
    Ok(fluidaudio_kokoro_location()?.dir)
}

/// FluidAudio's Kokoro ANE voice-pack cache directory. FluidAudio 0.15.5 reads voice packs
/// from here local-first, so we pre-stage onnx-community packs into it and the full
/// advertised Kokoro catalog (and the male `am_michael` default) resolve without a 404
/// against the ANE bundle. Follows [`fluidaudio_kokoro_location`], so staging always lands
/// wherever the bridge is actually pointed.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub fn fluidaudio_ane_kokoro_dir() -> Result<PathBuf> {
    Ok(fluidaudio_kokoro_cache_dir()?.join("ANE"))
}

/// FluidAudio's Mandarin (`ANE-zh/`) bundle directory, the Kokoro sibling of
/// [`fluidaudio_ane_kokoro_dir`].
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub fn fluidaudio_ane_zh_kokoro_dir() -> Result<PathBuf> {
    Ok(fluidaudio_kokoro_cache_dir()?.join("ANE-zh"))
}

/// Where the shared BART G2P bundle and the Misaki lexicon must be staged.
///
/// The one FluidAudio directory `with_models_dir` cannot move: `G2PModel.shared`
/// is a singleton that resolves `TtsCacheDirectory.ensure()/Models/kokoro`
/// itself, so a copy anywhere else is invisible to it (fluidaudio-rs 4e488d7,
/// still true at upstream 0.15.5). Staging elsewhere would leave English
/// synthesis failing with `G2PModelError.vocabLoadFailed`.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub fn fluidaudio_kokoro_g2p_dir() -> Result<PathBuf> {
    Ok(require_home_dir()?
        .join(".cache")
        .join("fluidaudio")
        .join("Models")
        .join("kokoro"))
}

/// Where FluidAudio's Kokoro CoreML bundles live, and the root that puts them there.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub fn fluidaudio_kokoro_location() -> Result<FluidAudioLocation> {
    let legacy = legacy_fluidaudio_kokoro_cache_dir()?;
    let staged = dir_has_entries(&legacy);
    fluidaudio_location(&legacy, staged, "kokoro-82m-coreml")
}

/// The `.cache/fluidaudio` tree FluidAudio picks on its own. Kept as the read-fallback so an
/// upgrade never re-fetches the ~800 MB of ANE bundles already sitting here (#688).
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn legacy_fluidaudio_kokoro_cache_dir() -> Result<PathBuf> {
    Ok(require_home_dir()?
        .join(".cache")
        .join("fluidaudio")
        .join("Models")
        .join("kokoro-82m-coreml"))
}

/// FluidAudio's ASR bundle directory — the one `AsrModels` loads from, wherever that
/// currently is. See [`fluidaudio_asr_location`] for which of the two it can be.
#[cfg(feature = "coreml")]
pub fn fluidaudio_asr_dir() -> Result<PathBuf> {
    Ok(fluidaudio_asr_location()?.dir)
}

/// Where the Parakeet bundle lives, and the root that puts it there.
#[cfg(feature = "coreml")]
pub fn fluidaudio_asr_location() -> Result<FluidAudioLocation> {
    static ANNOUNCED: AtomicBool = AtomicBool::new(false);
    let legacy = legacy_fluidaudio_asr_dir()?;
    let complete = fluidaudio_asr_ready_in(&legacy);
    if let Some(notice) = stale_legacy_notice(&legacy, complete, &ANNOUNCED) {
        with_stderr(|| eprintln!("{notice}"));
    }
    fluidaudio_location(&legacy, complete, FLUID_ASR_REPO_DIR)
}

/// The Application Support tree FluidAudio picks on its own, kept as the read-fallback.
///
/// `AsrModels` resolves it as `<ApplicationSupport>/FluidAudio/Models/<repo.folderName>`,
/// where `folderName` **strips** the `-coreml` suffix from `parakeet-tdt-0.6b-v3-coreml`.
/// Keying on the `…-v3-coreml` sibling that also exists on disk would report a healthy
/// install as broken (#684).
#[cfg(feature = "coreml")]
pub(super) fn legacy_fluidaudio_asr_dir() -> Result<PathBuf> {
    Ok(require_home_dir()?
        .join("Library")
        .join("Application Support")
        .join("FluidAudio")
        .join("Models")
        .join(FLUID_ASR_REPO_DIR))
}

/// Where `fluidaudio-rs` keeps compiled Sortformer `.mlmodelc` bundles, and the root that
/// puts them there. Relocating this costs a ~100 s ANE recompile rather than a download, but
/// the fallback rule is the same: an existing cache stays where it is.
#[cfg(feature = "system_diarize")]
pub fn fluidaudio_diarize_location() -> Result<FluidAudioLocation> {
    let legacy = legacy_sortformer_compiled_dir()?;
    let compiled = dir_has_entries(&legacy);
    fluidaudio_location(&legacy, compiled, "fluidaudio-rs/SortformerCompiled")
}

#[cfg(feature = "system_diarize")]
fn legacy_sortformer_compiled_dir() -> Result<PathBuf> {
    Ok(require_home_dir()?
        .join("Library")
        .join("Application Support")
        .join("fluidaudio-rs")
        .join("SortformerCompiled"))
}

/// What FluidAudio's own `modelsExist` requires. The encoder is pinned to int8
/// because the bridge calls `downloadAndLoad(to:)` with its default
/// `useInt8Encoder: true` — accepting `EncoderInt4.mlmodelc` here would pass
/// preflight and then let FluidAudio fetch the int8 encoder on first transcribe.
/// If the bridge ever selects precision, this must follow it.
#[cfg(feature = "coreml")]
pub(super) const FLUID_ASR_REQUIRED: &[&str] = &[
    "Preprocessor.mlmodelc",
    "Encoder.mlmodelc",
    "Decoder.mlmodelc",
    "JointDecisionv3.mlmodelc",
    "parakeet_vocab.json",
];

/// True iff FluidAudio's bundle is complete enough to transcribe. A bare
/// `is_dir()` is not enough: an interrupted fetch leaves the directory present
/// but partial, preflight would pass, and FluidAudio would then download the
/// remainder mid-transcribe — exactly the silent multi-GB download the
/// no-auto-download rule exists to prevent (#684).
#[cfg(feature = "coreml")]
pub fn fluidaudio_asr_ready() -> bool {
    fluidaudio_asr_dir().is_ok_and(|d| fluidaudio_asr_ready_in(&d))
}

#[cfg(feature = "coreml")]
pub(super) fn fluidaudio_asr_ready_in(dir: &Path) -> bool {
    FLUID_ASR_REQUIRED.iter().all(|f| dir.join(f).exists())
}

pub fn cache_dir() -> Result<PathBuf> {
    cache_dir_from(std::env::var("KESHA_CACHE_DIR").ok(), dirs::home_dir())
}

/// The cache root from its two inputs, split out so the null-home path is
/// unit-testable without an unsettable process environment (#953). A set
/// `KESHA_CACHE_DIR` wins even with no resolvable home; otherwise a missing
/// home is a coded `E_INTERNAL` naming the escape hatch, never a panic past
/// the `error [CODE]:` contract.
pub(crate) fn cache_dir_from(env_cache: Option<String>, home: Option<PathBuf>) -> Result<PathBuf> {
    if let Some(p) = env_cache {
        return Ok(PathBuf::from(p));
    }
    let Some(home) = home else {
        coded_bail!(
            ErrorCode::Internal,
            "cannot determine home directory; set $HOME, or set KESHA_CACHE_DIR to an explicit cache path"
        );
    };
    Ok(home.join(".cache").join("kesha"))
}

/// The home directory, or a coded `E_INTERNAL` naming the `$HOME` remedy. The
/// FluidAudio caches below hardcode `~/.cache/fluidaudio` / `~/Library/...`, so
/// `KESHA_CACHE_DIR` cannot relocate them — the hint must not offer it (#953).
#[cfg(any(
    feature = "coreml",
    feature = "system_kokoro",
    feature = "system_diarize"
))]
fn require_home_dir() -> Result<PathBuf> {
    require_home(dirs::home_dir())
}

#[cfg(any(
    feature = "coreml",
    feature = "system_kokoro",
    feature = "system_diarize"
))]
fn require_home(home: Option<PathBuf>) -> Result<PathBuf> {
    let Some(home) = home else {
        coded_bail!(
            ErrorCode::Internal,
            "cannot determine home directory; set $HOME"
        );
    };
    Ok(home)
}

#[cfg(all(
    test,
    any(
        feature = "coreml",
        feature = "system_kokoro",
        feature = "system_diarize"
    )
))]
mod require_home_tests {
    use super::*;
    use crate::errors::code_of;

    // #953: the FluidAudio caches are not KESHA_CACHE_DIR-relocatable, so a null
    // home is coded E_INTERNAL whose hint names only $HOME.
    #[test]
    fn require_home_null_is_coded_internal_without_cache_dir_hint() {
        let err = require_home(None).unwrap_err();
        assert_eq!(code_of(&err), ErrorCode::Internal);
        let msg = format!("{err:#}");
        assert!(msg.contains("$HOME"), "message must name $HOME: {msg}");
        assert!(
            !msg.contains("KESHA_CACHE_DIR"),
            "these paths are not KESHA_CACHE_DIR-relocatable: {msg}"
        );
    }

    #[test]
    fn require_home_passes_through_a_resolved_home() {
        assert_eq!(
            require_home(Some(PathBuf::from("/home/u"))).unwrap(),
            PathBuf::from("/home/u")
        );
    }
}

/// Kinds of model bundle the engine can install, locate, and check. Adding
/// a new backend means adding a variant plus a `subdir` arm and (if the
/// layout isn't flat enough for `has_all_files`) a custom layout helper.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelKind {
    /// Parakeet TDT ONNX ASR weights.
    Asr,
    /// SpeechBrain ECAPA-TDNN VoxLingua107 audio lang-id ONNX.
    LangId,
    /// Silero VAD v5 ONNX.
    Vad,
    /// Vosk-TTS multi-speaker Russian model (model + dictionary + BERT).
    #[cfg(feature = "tts")]
    VoskRu,
    /// FluidAudio Sortformer streaming diarizer (`.mlpackage`).
    #[cfg(feature = "system_diarize")]
    Diarize,
}

impl ModelKind {
    /// Cache-relative subdirectory.
    pub fn subdir(self) -> &'static str {
        match self {
            ModelKind::Asr => "models/parakeet-tdt-v3",
            ModelKind::LangId => "models/lang-id-ecapa",
            ModelKind::Vad => "models/silero-vad",
            #[cfg(feature = "tts")]
            ModelKind::VoskRu => "models/vosk-ru",
            #[cfg(feature = "system_diarize")]
            ModelKind::Diarize => "models/diarize/SortformerNvidiaLow_v2.mlpackage",
        }
    }
}

/// Absolute path to a kind's directory under the active cache (honours
/// `KESHA_CACHE_DIR`).
pub fn model_dir(kind: ModelKind) -> Result<PathBuf> {
    Ok(model_dir_at(kind, &cache_dir()?))
}

/// Same as [`model_dir`] but with a caller-supplied cache root — for the
/// list-voices / resolver paths that already have the root and want to
/// avoid re-reading the env var.
pub fn model_dir_at(kind: ModelKind, cache_root: &Path) -> PathBuf {
    cache_root.join(kind.subdir())
}

/// True iff `kind`'s required files are present under the active cache.
pub fn is_cached(kind: ModelKind) -> bool {
    model_dir(kind).is_ok_and(|d| is_cached_in(kind, &d))
}

/// True iff `kind` is usable. `dir` is the Kesha cache location; the coreml `Asr`
/// arm ignores it, since FluidAudio owns that bundle outside the cache entirely.
pub fn is_cached_in(kind: ModelKind, dir: &Path) -> bool {
    match kind {
        #[cfg(not(feature = "coreml"))]
        ModelKind::Asr => has_all_files(dir, ASR_FILES),
        // `dir` is the ONNX layout, which this backend never reads; FluidAudio owns
        // where its weights live, so that is the only thing worth checking here.
        #[cfg(feature = "coreml")]
        ModelKind::Asr => fluidaudio_asr_ready(),
        ModelKind::LangId => has_all_files(dir, LANG_ID_FILES),
        ModelKind::Vad => has_all_files(dir, VAD_FILES),
        #[cfg(feature = "tts")]
        ModelKind::VoskRu => has_vosk_ru_layout(dir),
        #[cfg(feature = "system_diarize")]
        ModelKind::Diarize => has_diarize_layout(dir),
    }
}

/// The five files `Vosk::load` opens — keep this layout check aligned with the
/// loader. `has_all_files` flattens the manifest to basenames, which would treat
/// the top-level `model.onnx` and `bert/model.onnx` as duplicates; this custom
/// walk handles the nested path instead.
#[cfg(feature = "tts")]
fn has_vosk_ru_layout(dir: &Path) -> bool {
    dir.join("model.onnx").exists()
        && dir.join("dictionary").exists()
        && dir.join("config.json").exists()
        && dir.join("bert/model.onnx").exists()
        && dir.join("bert/vocab.txt").exists()
}

/// `.mlpackage` is a directory tree — the runtime-required files live at
/// nested paths under `Data/com.apple.CoreML/`. Same basename-flattening
/// problem as the Vosk layout above (two `*-weight.bin` siblings under
/// different `weights/` subdirs), so we walk each path explicitly. (#199)
#[cfg(feature = "system_diarize")]
pub(super) fn has_diarize_layout(dir: &Path) -> bool {
    dir.join("Manifest.json").exists()
        && dir.join("Data/com.apple.CoreML/model.mlmodel").exists()
        && dir
            .join("Data/com.apple.CoreML/weights/0-weight.bin")
            .exists()
        && dir
            .join("Data/com.apple.CoreML/weights/1-weight.bin")
            .exists()
}

/// Caller passes the per-model dir (typically [`model_dir`] /
/// [`model_dir_at`]); we pull the basename out of each manifest entry's
/// cache-relative `rel_path` and check it's present. Keeps the per-kind
/// layout check simple while letting the manifest own the full URL + hash
/// for the download path.
fn has_all_files(dir: &Path, files: &[ModelFile]) -> bool {
    files.iter().all(|f| {
        Path::new(f.rel_path)
            .file_name()
            .map(|n| dir.join(n).exists())
            .unwrap_or(false)
    })
}

#[cfg(all(test, feature = "tts"))]
mod tts_tests {
    use super::*;
    use crate::errors::code_of;

    #[test]
    fn cache_dir_honors_env_var() {
        let _lock = crate::util::test_env::lock();
        let guard = EnvGuard::set(&_lock, "KESHA_CACHE_DIR", "/tmp/kesha-test-xyz");
        assert_eq!(cache_dir().unwrap(), PathBuf::from("/tmp/kesha-test-xyz"));
        drop(guard);
    }

    // #953: a null home must surface as a coded E_INTERNAL naming KESHA_CACHE_DIR,
    // not a panic past the `error [CODE]:` contract.
    #[test]
    fn cache_dir_from_null_home_is_coded_internal() {
        let err = cache_dir_from(None, None).unwrap_err();
        assert_eq!(code_of(&err), ErrorCode::Internal);
        assert!(
            format!("{err:#}").contains("KESHA_CACHE_DIR"),
            "message must name the escape hatch: {err:#}"
        );
    }

    #[test]
    fn cache_dir_from_env_wins_without_home() {
        let dir = cache_dir_from(Some("/tmp/x".into()), None).unwrap();
        assert_eq!(dir, PathBuf::from("/tmp/x"));
    }

    #[test]
    fn cache_dir_from_derives_under_home() {
        let dir = cache_dir_from(None, Some(PathBuf::from("/home/u"))).unwrap();
        assert_eq!(dir, PathBuf::from("/home/u/.cache/kesha"));
    }

    use crate::util::test_env::EnvGuard;
}
