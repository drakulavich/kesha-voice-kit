#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
use super::download::parallel_download;
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
use super::manifest::*;
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
use super::paths::*;
#[cfg(any(
    all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ),
    test
))]
use super::progress::with_stderr;
#[cfg(any(
    all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ),
    test
))]
use crate::protocol::events;
#[cfg(any(
    all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ),
    test
))]
use anyhow::Context;
#[cfg(any(
    all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ),
    test
))]
use anyhow::Result;
#[cfg(any(
    all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ),
    test
))]
use std::fs;
#[cfg(any(
    all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ),
    test
))]
use std::io;
#[cfg(any(
    all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ),
    test
))]
use std::path::{Path, PathBuf};

/// Download + SHA-verify every advertised Kokoro voice pack directly into
/// FluidAudio's ANE cache so `KokoroAneManager.ensureVoicePack` resolves them
/// local-first (#475). Idempotent: an existing pack that already matches its
/// pinned hash short-circuits the network round-trip, identical to
/// [`download_verified`]. Runs only on the `system_kokoro` darwin path; the
/// ONNX Kokoro path keeps using `kokoro_manifest_for()` under `KESHA_CACHE_DIR`.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub fn stage_ane_kokoro_voices(langs: &[&str], no_cache: bool) -> Result<()> {
    let manifest = ane_voices_for(langs);
    if manifest.is_empty() {
        return Ok(());
    }
    let ane_dir = fluidaudio_ane_kokoro_dir()?;
    fs::create_dir_all(&ane_dir)
        .with_context(|| format!("create FluidAudio ANE dir {}", ane_dir.display()))?;
    parallel_download(&ane_dir, &manifest, no_cache)
}

/// Languages served by the English KokoroAne variant. `zh` has its own bundle
/// and `ru` never reaches Kokoro on this build (Vosk / AVSpeech).
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
const ANE_ENGLISH_VARIANT_LANGS: &[&str] = &["en", "es", "fr", "hi", "it", "ja", "pt"];

/// Stage the assets FluidAudio would otherwise fetch at first synthesis (#823).
///
/// Everything `KokoroAneManager.initialize` looks for, put where it looks,
/// during the command the user asked to download things in. Each group lands in
/// its own directory because upstream reads them from three different places:
/// the ANE chain and the Mandarin bundle follow whichever root the bridge is
/// pointed at, while the shared G2P assets are pinned to a home-directory path
/// no root can move (see [`fluidaudio_kokoro_g2p_dir`]).
///
/// Idempotent and hash-verified on every run, like [`stage_ane_kokoro_voices`].
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub fn stage_fluidaudio_kokoro_assets(langs: &[&str], no_cache: bool) -> Result<()> {
    if langs.iter().any(|l| ANE_ENGLISH_VARIANT_LANGS.contains(l)) {
        stage_into(&fluidaudio_ane_kokoro_dir()?, ANE_EN_FILES, no_cache)?;
        stage_into(&fluidaudio_kokoro_g2p_dir()?, KOKORO_G2P_FILES, no_cache)?;
    }
    if langs.contains(&"zh") {
        let zh = fluidaudio_ane_zh_kokoro_dir()?;
        stage_into(&zh, ANE_ZH_FILES, no_cache)?;
        stage_into(&zh, ANE_ZH_G2P_ASSETS, no_cache)?;
    }
    Ok(())
}

/// Files that must already be on disk before `voice` can be synthesized, and
/// which of them are not (#823 P2).
///
/// The offline flag alone cannot carry the no-auto-download guarantee: upstream's
/// `AssetDownloader` consults no flag, so `ensureVoicePack` will happily fetch a
/// pack that `kesha install --tts <other-lang>` never staged. Checking locally
/// first is what makes the guarantee hold for every voice rather than only the
/// staged happy path — the answer is a list of paths, so the caller can name
/// what is missing instead of guessing.
///
/// The required set is derived from the staging manifests themselves, so a
/// manifest change cannot leave the check behind.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub fn missing_kokoro_assets(lang: &str, voice: &str) -> Vec<PathBuf> {
    // The empty returns below ("nothing missing") are safe ONLY because the same
    // null-home that unresolves these dirs also unresolves fluidaudio_kokoro_location,
    // so synthesis bails with E_INTERNAL before this preflight's result is trusted. A
    // future path that reached here with a resolvable bundle dir but no home would turn
    // "couldn't find the dir" into "no missing assets" — a silent auto-download, the
    // exact thing the no-auto-download rule forbids. Keep the home requirement upstream (#953).
    if lang == "zh" {
        let Ok(zh) = fluidaudio_ane_zh_kokoro_dir() else {
            return Vec::new();
        };
        missing_kokoro_assets_in(&zh, &zh, lang, voice)
    } else {
        let (Ok(ane), Ok(g2p)) = (fluidaudio_ane_kokoro_dir(), fluidaudio_kokoro_g2p_dir()) else {
            return Vec::new();
        };
        missing_kokoro_assets_in(&ane, &g2p, lang, voice)
    }
}

/// [`missing_kokoro_assets`] against explicit directories. `bundle_dir` is the
/// variant's own bundle (`ANE` or `ANE-zh`); `g2p_dir` is where that variant's
/// text frontend reads from, which for English is a path no models-root can move.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn missing_kokoro_assets_in(
    bundle_dir: &Path,
    g2p_dir: &Path,
    lang: &str,
    voice: &str,
) -> Vec<PathBuf> {
    let (bundle, g2p, voice_rel) = if lang == "zh" {
        (
            ANE_ZH_FILES,
            ANE_ZH_G2P_ASSETS,
            format!("voices/{voice}.bin"),
        )
    } else {
        (ANE_EN_FILES, KOKORO_G2P_FILES, format!("{voice}.bin"))
    };
    // The default voices (`af_heart`, `zf_001`, `zm_050`) are in the manifests
    // already, so a request for one would otherwise be named twice.
    let mut seen = std::collections::HashSet::new();
    bundle
        .iter()
        .map(|f| bundle_dir.join(f.rel_path))
        .chain(std::iter::once(bundle_dir.join(voice_rel)))
        .chain(g2p.iter().map(|f| g2p_dir.join(f.rel_path)))
        .filter(|p| !p.exists() && seen.insert(p.clone()))
        .collect()
}

#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn stage_into(dir: &Path, manifest: &'static [ModelFile], no_cache: bool) -> Result<()> {
    fs::create_dir_all(dir)
        .with_context(|| format!("create FluidAudio cache dir {}", dir.display()))?;
    let refs: Vec<&ModelFile> = manifest.iter().collect();
    parallel_download(dir, &refs, no_cache)
}

/// `.mlmodelc` bundles in FluidAudio's Kokoro cache that are missing
/// `model.mil`, i.e. left half-fetched by an earlier version.
///
/// FluidAudio's "already downloaded" check is directory-name based, so such a
/// bundle is never repaired on its own: 0.14.8 fully fetched the
/// `KokoroNoise.mlmodelc` it loaded and only partially fetched its
/// `KokoroNoise_v2.mlmodelc` sibling, and 0.15.5 loads `_v2` — turning an
/// upgrade on an existing cache into `Error in reading the MIL network` (#709,
/// upstream #821/#826). Every Kokoro ANE bundle is CoreML ML Program format, so
/// a missing `model.mil` means incomplete, never a valid alternative encoding.
///
/// Scans every `ANE*` variant directory (`ANE`, `ANE-zh`, …), which share the
/// same required bundle set, and one extension-less level below each so the
/// Mandarin variant's nested `g2pw/g2pw.mlmodelc` is covered. `.mlpackage`
/// sources, `.bin` voice packs and `vocab.json` are never candidates.
#[cfg(any(
    all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ),
    test
))]
fn incomplete_ane_bundles_in(kokoro_dir: &Path) -> Result<Vec<PathBuf>> {
    let mut found = Vec::new();
    for variant in read_dir_paths(kokoro_dir)? {
        let is_variant = variant.is_dir()
            && variant
                .file_name()
                .is_some_and(|n| n.to_string_lossy().starts_with("ANE"));
        if is_variant {
            collect_incomplete_bundles(&variant, 1, &mut found)?;
        }
    }
    Ok(found)
}

#[cfg(any(
    all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ),
    test
))]
fn collect_incomplete_bundles(dir: &Path, depth: u32, found: &mut Vec<PathBuf>) -> Result<()> {
    for path in read_dir_paths(dir)? {
        if !path.is_dir() {
            continue;
        }
        if path.extension().is_some_and(|x| x == "mlmodelc") {
            if !path.join("model.mil").exists() {
                found.push(path);
            }
        } else if depth > 0 && path.extension().is_none() {
            collect_incomplete_bundles(&path, depth - 1, found)?;
        }
    }
    Ok(())
}

#[cfg(any(
    all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ),
    test
))]
fn read_dir_paths(dir: &Path) -> Result<Vec<PathBuf>> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e).with_context(|| format!("read {}", dir.display())),
    };
    entries
        .map(|e| {
            Ok(
                e.with_context(|| format!("read entry in {}", dir.display()))?
                    .path(),
            )
        })
        .collect()
}

/// Delete the bundles [`incomplete_ane_bundles_in`] finds so FluidAudio
/// refetches them instead of failing to load. Filesystem-only: it never
/// downloads, so every `kesha install` can run it (#709).
#[cfg(any(
    all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ),
    test
))]
fn purge_incomplete_ane_bundles_in(kokoro_dir: &Path) -> Result<()> {
    for path in incomplete_ane_bundles_in(kokoro_dir)? {
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        with_stderr(|| {
            events::progress(
                None,
                format!("REPAIR {name} (incomplete, will refetch on first synth)"),
            )
        });
        fs::remove_dir_all(&path)
            .with_context(|| format!("remove incomplete CoreML bundle {}", path.display()))?;
    }
    Ok(())
}

#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub fn purge_incomplete_ane_bundles() -> Result<()> {
    purge_incomplete_ane_bundles_in(&fluidaudio_kokoro_cache_dir()?)
}

/// Names of the incomplete bundles currently in the cache, for the hint
/// `tts::fluid_kokoro` attaches to a Kokoro init failure. Best-effort: it runs
/// while another error is being reported, so a scan failure must not mask it.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub fn incomplete_ane_bundle_names() -> Vec<String> {
    let Ok(dir) = fluidaudio_kokoro_cache_dir() else {
        return Vec::new();
    };
    incomplete_ane_bundles_in(&dir)
        .unwrap_or_default()
        .iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect()
}

#[cfg(test)]
mod ane_bundle_repair_tests {
    use super::*;

    fn bundle(dir: &Path, name: &str, with_mil: bool) -> Result<PathBuf> {
        let path = dir.join(name);
        fs::create_dir_all(&path)?;
        fs::write(path.join("coremldata.bin"), b"x")?;
        if with_mil {
            fs::write(path.join("model.mil"), b"x")?;
        }
        Ok(path)
    }

    #[test]
    fn purge_removes_only_bundles_missing_model_mil() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let ane = tmp.path().join("ANE");
        let complete = bundle(&ane, "KokoroVocoder.mlmodelc", true)?;
        let incomplete = bundle(&ane, "KokoroNoise_v2.mlmodelc", false)?;
        // Staged voice packs, the loose vocab and the .mlpackage sources share the
        // directory and must survive.
        let voice = ane.join("am_michael.bin");
        fs::write(&voice, b"voice")?;
        let vocab = ane.join("vocab.json");
        fs::write(&vocab, b"{}")?;
        let package = ane.join("KokoroNoise_v2.mlpackage");
        fs::create_dir_all(&package)?;

        purge_incomplete_ane_bundles_in(tmp.path())?;

        assert!(complete.exists(), "complete bundle must be kept");
        assert!(!incomplete.exists(), "incomplete bundle must be removed");
        assert!(voice.exists(), "staged voice packs must survive the repair");
        assert!(vocab.exists(), "vocab.json must survive the repair");
        assert!(
            package.exists(),
            ".mlpackage sources must survive the repair"
        );
        Ok(())
    }

    #[test]
    fn purge_covers_sibling_variant_caches() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let zh = bundle(&tmp.path().join("ANE-zh"), "KokoroNoise_v2.mlmodelc", false)?;
        let g2pw = bundle(&tmp.path().join("ANE-zh/g2pw"), "g2pw.mlmodelc", false)?;
        let ja = bundle(&tmp.path().join("ANE-ja"), "KokoroNoise_v2.mlmodelc", false)?;
        let voices = tmp.path().join("ANE-zh/voices/zf_001.bin");
        fs::create_dir_all(voices.parent().expect("voices dir"))?;
        fs::write(&voices, b"voice")?;

        purge_incomplete_ane_bundles_in(tmp.path())?;

        assert!(!zh.exists(), "ANE-zh bundle must be repaired too");
        assert!(!g2pw.exists(), "nested g2pw bundle must be repaired too");
        assert!(!ja.exists(), "ANE-ja bundle must be repaired too");
        assert!(
            voices.exists(),
            "nested voice packs must survive the repair"
        );
        Ok(())
    }

    #[test]
    fn purge_ignores_directories_outside_the_ane_variants() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let other = bundle(&tmp.path().join("GPU"), "KokoroNoise_v2.mlmodelc", false)?;
        let loose = bundle(tmp.path(), "KokoroNoise_v2.mlmodelc", false)?;

        purge_incomplete_ane_bundles_in(tmp.path())?;

        assert!(
            other.exists(),
            "non-ANE variant dirs are not ours to repair"
        );
        assert!(loose.exists(), "only variant subdirectories are scanned");
        Ok(())
    }

    #[test]
    fn purge_is_a_noop_on_a_missing_directory() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        purge_incomplete_ane_bundles_in(&tmp.path().join("absent"))
    }
}

#[cfg(all(test, feature = "tts"))]
mod tts_tests {
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    use super::*;

    /// Lay down every file `lang`/`voice` needs under `bundle`/`g2p`, so a test
    /// can then take exactly one away.
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    fn stage_fixture(bundle: &Path, g2p: &Path, lang: &str, voice: &str) {
        let (files, g2p_files, voice_rel) = if lang == "zh" {
            (
                ANE_ZH_FILES,
                ANE_ZH_G2P_ASSETS,
                format!("voices/{voice}.bin"),
            )
        } else {
            (ANE_EN_FILES, KOKORO_G2P_FILES, format!("{voice}.bin"))
        };
        let touch = |p: PathBuf| {
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(&p, b"x").unwrap();
        };
        for f in files {
            touch(bundle.join(f.rel_path));
        }
        touch(bundle.join(voice_rel));
        for f in g2p_files {
            touch(g2p.join(f.rel_path));
        }
    }

    /// A complete install reports nothing missing — otherwise the preflight
    /// would refuse to synthesize on a healthy machine.
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn a_complete_install_is_missing_nothing() {
        for (lang, voice) in [("en-us", "am_michael"), ("zh", "zm_050")] {
            let tmp = tempfile::tempdir().unwrap();
            let bundle = tmp.path().join("bundle");
            let g2p = tmp.path().join("g2p");
            stage_fixture(&bundle, &g2p, lang, voice);
            assert!(
                missing_kokoro_assets_in(&bundle, &g2p, lang, voice).is_empty(),
                "{lang}/{voice} should be complete"
            );
        }
    }

    /// The hole this preflight exists to close: `kesha install --tts en` leaves
    /// `em_alex.bin` unstaged, `--list-voices` still advertises it, and upstream's
    /// `ensureVoicePack` is on the un-flagged `AssetDownloader` path — so without
    /// a local check `kesha say --voice es-em_alex` downloads mid-synthesis.
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn an_unstaged_voice_pack_is_reported_before_anything_can_fetch_it() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let g2p = tmp.path().join("g2p");
        stage_fixture(&bundle, &g2p, "en-us", "am_michael");

        let missing = missing_kokoro_assets_in(&bundle, &g2p, "es", "em_alex");
        assert_eq!(
            missing,
            vec![bundle.join("em_alex.bin")],
            "only the unstaged pack should be missing"
        );
    }

    /// Mandarin packs live under `voices/`, not at the bundle root, so checking
    /// the flat English path would report a present pack as missing and a
    /// missing one as present.
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn mandarin_voice_packs_are_checked_under_their_voices_subdir() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        stage_fixture(&bundle, &bundle, "zh", "zm_050");
        fs::remove_file(bundle.join("voices/zm_050.bin")).unwrap();

        let missing = missing_kokoro_assets_in(&bundle, &bundle, "zh", "zm_050");
        assert_eq!(missing, vec![bundle.join("voices/zm_050.bin")]);
    }

    /// A half-finished install is caught the same way, whichever half is short —
    /// including the G2P assets, which sit in a different directory entirely.
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn a_partial_install_names_every_gap_wherever_it_lives() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("bundle");
        let g2p = tmp.path().join("g2p");
        stage_fixture(&bundle, &g2p, "en-us", "am_michael");

        let chain = bundle.join("KokoroVocoder.mlmodelc/model.mil");
        let vocab = g2p.join("g2p_vocab.json");
        fs::remove_file(&chain).unwrap();
        fs::remove_file(&vocab).unwrap();

        let missing = missing_kokoro_assets_in(&bundle, &g2p, "en-us", "am_michael");
        assert!(missing.contains(&chain), "chain gap missed: {missing:?}");
        assert!(missing.contains(&vocab), "G2P gap missed: {missing:?}");
        assert_eq!(missing.len(), 2, "nothing else should be reported");
    }

    /// Staging follows the language the user asked for: an English-only install
    /// never pays for the 250 MB Mandarin bundle, and a Russian-only install
    /// touches neither (Vosk / AVSpeech serve `ru` on this build).
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn staging_is_scoped_to_the_requested_languages() {
        let english = |langs: &[&str]| langs.iter().any(|l| ANE_ENGLISH_VARIANT_LANGS.contains(l));
        assert!(english(&["en"]));
        assert!(english(&["pt", "ru"]));
        assert!(!english(&["ru"]));
        assert!(!english(&["zh"]));
    }
}
