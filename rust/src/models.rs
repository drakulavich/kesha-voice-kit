use anyhow::{Context, Result};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use crate::coded_bail;
use crate::errors::{code_of, CodedContext, CodedError, ErrorCode};

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
///
/// Absent on `coreml` builds: that backend transcribes through FluidAudio's own
/// bundle and `create_backend` discards the ONNX dir outright, so downloading
/// these 2.43 GB would be pure waste (#684).
#[cfg(not(feature = "coreml"))]
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

/// Silero VAD v5 ONNX (snakers4/silero-vad). Single 2.3 MB file; not cached
/// on HuggingFace so we pull from the GitHub raw URL.
///
/// NOTE: `apply_mirror` only rewrites `huggingface.co` URLs, so this one
/// passes through unchanged even with `KESHA_MODEL_MIRROR` set. Operators
/// who need a mirrored VAD can pre-stage the file under the cache dir.
// Pinned to a release tag (not `master`) so upstream can't break fresh
// installs with a force-push. Hash verification already guards integrity;
// the tag pin guards availability.
const VAD_FILES: &[ModelFile] = &[ModelFile {
    rel_path: "models/silero-vad/silero_vad.onnx",
    url: "https://github.com/snakers4/silero-vad/raw/v6.2.1/src/silero_vad/data/silero_vad.onnx",
    sha256: "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
}];

/// FluidAudio Sortformer streaming diarizer (`balancedV2` /
/// `SortformerNvidiaLow_v2.mlpackage`). 4 files totalling ~245 MB. Opt-in
/// via `kesha install --diarize` (#199) on darwin-arm64 only — the
/// `system_diarize` cargo feature gates the engine, so non-darwin builds
/// never reach this manifest.
///
/// `.mlpackage` is a directory; CoreML compiles it to `.mlmodelc` at first
/// load via `MLModel.compileModel(at:)`. We pin the source-of-truth `.mlpackage`
/// (Manifest.json + model.mlmodel + 2 weight blobs) rather than the
/// alternative pre-compiled `.mlmodelc` form, since the upstream HF tree
/// ships both and the .mlpackage is roughly half the bytes.
#[cfg(any(feature = "system_diarize", test))]
const DIARIZE_FILES: &[ModelFile] = &[
    ModelFile {
        rel_path: "models/diarize/SortformerNvidiaLow_v2.mlpackage/Manifest.json",
        url: "https://huggingface.co/FluidInference/diar-streaming-sortformer-coreml/resolve/main/SortformerNvidiaLow_v2.mlpackage/Manifest.json",
        sha256: "48005880c54b1b7f5b0ae81a33fead3a36e3e2a773eb3fbf1f61ebe08515bba6",
    },
    ModelFile {
        rel_path: "models/diarize/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/model.mlmodel",
        url: "https://huggingface.co/FluidInference/diar-streaming-sortformer-coreml/resolve/main/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/model.mlmodel",
        sha256: "478267113144c0292a3db41fb22148b6c052d2399ae3dab0ca20cd3687880358",
    },
    ModelFile {
        rel_path: "models/diarize/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/weights/0-weight.bin",
        url: "https://huggingface.co/FluidInference/diar-streaming-sortformer-coreml/resolve/main/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/weights/0-weight.bin",
        sha256: "ad40d62ccd7a0943d2cd9cc8eeee7f27116e58cf6532ab43196b34142fc86583",
    },
    ModelFile {
        rel_path: "models/diarize/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/weights/1-weight.bin",
        url: "https://huggingface.co/FluidInference/diar-streaming-sortformer-coreml/resolve/main/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/weights/1-weight.bin",
        sha256: "e8ebd6767429fd224671b79ad2a3e3cd8bd34f83373ff84fca2f5387414191a0",
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

/// TTS languages installable on THIS build, in maintainer-curated order.
/// Source of truth for `kesha-engine install --tts <lang>` validation and the
/// `tts.languages` capabilities rows. `es/fr/it/pt` exist on both the ONNX
/// (CharsiuG2P) and darwin ANE builds; `hi/ja/zh` exist only on the
/// `system_kokoro` feature (darwin arm64 ANE).
/// `macos-*` AVSpeech is NOT listed — it needs no install.
#[cfg(feature = "tts")]
pub fn tts_languages() -> Vec<&'static str> {
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    {
        vec!["en", "es", "fr", "hi", "it", "ja", "pt", "zh", "ru"]
    }
    #[cfg(not(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    )))]
    {
        vec!["en", "es", "fr", "it", "pt", "ru"]
    }
}

/// Default downloadable engine for a TTS language code. One engine per
/// language today; the capabilities `engines` list is a Vec to allow more later.
#[cfg(feature = "tts")]
pub fn tts_engine_for(lang: &str) -> &'static str {
    match lang {
        "ru" => "vosk",
        _ => "kokoro",
    }
}

/// Validate requested TTS language codes against what THIS build supports.
/// Hard error (download nothing) naming the offending code and supported set.
#[cfg(feature = "tts")]
pub fn validate_tts_langs(langs: &[&str]) -> Result<()> {
    let supported = tts_languages();
    for &l in langs {
        if !supported.contains(&l) {
            coded_bail!(
                ErrorCode::VoiceUnknown,
                "TTS language '{l}' is not available on this build (supported: {})",
                supported.join(", ")
            );
        }
    }
    Ok(())
}

/// The Kokoro-82M ONNX graph (~326 MB). Single copy regardless of how many
/// Kokoro languages are installed — all voices share this graph.
///
/// The HF onnx-community variant produces unintelligible audio with
/// `af_heart` — confirmed by audio bisection, see #207. Use the
/// official kokoro-onnx project release, which uses different IO
/// tensor names (`tokens`/`audio` vs `input_ids`/`waveform`) but
/// same dtypes/shapes — handled in `kokoro::Kokoro::infer`.
#[cfg(all(
    feature = "tts",
    not(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))
))]
const KOKORO_GRAPH: ModelFile = ModelFile {
    rel_path: "models/kokoro-82m/model.onnx",
    url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
    sha256: "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
};

/// Default English male voice pack (Кеша is a male name — CLAUDE.md brand rule).
/// Switched from `af_heart` (female) in #210.
/// One pinned ONNX-path Kokoro voice under `models/kokoro-82m/voices/`;
/// same drift-proofing as `ane_kokoro_voice!`.
#[cfg(all(
    feature = "tts",
    not(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))
))]
macro_rules! kokoro_voice {
    ($name:literal, $sha:literal) => {
        ModelFile {
            rel_path: concat!("models/kokoro-82m/voices/", $name, ".bin"),
            url: concat!(
                "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/",
                $name,
                ".bin"
            ),
            sha256: $sha,
        }
    };
}

#[cfg(all(
    feature = "tts",
    not(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))
))]
const KOKORO_EN_VOICE: ModelFile = kokoro_voice!(
    "am_michael",
    "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1"
);

/// klebster CharsiuG2P byt5-tiny ONNX export (CC-BY 4.0).
/// Pinned hashes from #185 (see NOTICES.md for attribution).
/// These 3 files enable multilingual G2P for es/fr/it/pt voices.
#[cfg(all(
    feature = "tts",
    not(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))
))]
const G2P_CHARSIU_FILES: &[ModelFile] = &[
    ModelFile {
        rel_path: "models/g2p/byt5-tiny/encoder_model.onnx",
        url: "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/main/encoder_model.onnx",
        sha256: "1ac7aca11845527873f9e0e870fbe1e3c3ac2cb009d8852230332d10541aab04",
    },
    ModelFile {
        rel_path: "models/g2p/byt5-tiny/decoder_model.onnx",
        url: "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/main/decoder_model.onnx",
        sha256: "de32477aae14e254d4a7dee4b2c324fb39f93a0dc254181c5bfdd8fc67492919",
    },
    ModelFile {
        rel_path: "models/g2p/byt5-tiny/decoder_with_past_model.onnx",
        url: "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/main/decoder_with_past_model.onnx",
        sha256: "fae30b9f3a8d935be01b32af851bae6d54f330813167073e84caf6d0a1890fcb",
    },
];

/// Multilingual Kokoro voice packs (es/fr/it/pt). All from
/// onnx-community/Kokoro-82M-v1.0-ONNX on HuggingFace.
/// em_alex (es, male), im_nicola (it, male), pm_alex (pt, male)
/// satisfy the brand male-default rule. ff_siwis (fr, female) is
/// the sole French voice Kokoro v1.0 ships — see voices.rs comment.
#[cfg(all(
    feature = "tts",
    not(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))
))]
fn multilang_voice(lang: &str) -> Option<ModelFile> {
    Some(match lang {
        "es" => kokoro_voice!(
            "em_alex",
            "27809e9eafdcbcfff90a3016c697568676531de2a2c39cee29c96c7bd6b83e95"
        ),
        "fr" => kokoro_voice!(
            "ff_siwis",
            "a35f5675ad08948e326ae75fd0ea16ba5d0042e4f76b5f3d1df77d0a48c54861"
        ),
        "it" => kokoro_voice!(
            "im_nicola",
            "bc578e510d52a96d6940d46f12e96d7b3df00905dbea075113226d100e6e1ab0"
        ),
        "pt" => kokoro_voice!(
            "pm_alex",
            "0175c753f59c54e7fd5a995bedef0c5ff2fb67e0043dd3dcb2ae74ec2acbeb2a"
        ),
        _ => return None,
    })
}

/// ONNX-path Kokoro files needed for `langs`. Graph included if any Kokoro
/// language is selected; G2P only if a multilingual lang (es/fr/it/pt) is
/// selected; per-language voices added individually.
///
/// An English-only install skips the ~30 MB CharsiuG2P pack and a Russian-only
/// install skips Kokoro entirely. Consumed by [`download_tts`].
#[cfg(all(
    feature = "tts",
    not(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))
))]
fn kokoro_manifest_for(langs: &[&str]) -> Vec<ModelFile> {
    const KOKORO_LANGS: [&str; 5] = ["en", "es", "fr", "it", "pt"];
    const MULTILANG: [&str; 4] = ["es", "fr", "it", "pt"];
    let mut out = Vec::new();
    if langs.iter().any(|l| KOKORO_LANGS.contains(l)) {
        out.push(KOKORO_GRAPH.clone());
    }
    if langs.contains(&"en") {
        out.push(KOKORO_EN_VOICE.clone());
    }
    if langs.iter().any(|l| MULTILANG.contains(l)) {
        out.extend(G2P_CHARSIU_FILES.iter().cloned());
    }
    for l in langs {
        if let Some(v) = multilang_voice(l) {
            out.push(v);
        }
    }
    out
}

/// FluidAudio ANE Kokoro voice packs (`system_kokoro` darwin path, #475).
///
/// FluidAudio 0.15.5's `KokoroAneManager` resolves `<voice>.bin` LOCAL-FIRST
/// from its own cache (`~/.cache/fluidaudio/Models/kokoro-82m-coreml/ANE/`)
/// before any download. The ANE bundle only ships `af_heart`, so `am_michael`
/// (kesha's male brand default) and the rest of the advertised Kokoro catalog
/// 404 from the bundle. These packs are 510×256 f32 `.bin` — byte-identical to
/// the standard onnx-community Kokoro packs kesha used on the ONNX path — so we
/// download them from onnx-community and stage them into the ANE cache at install
/// time (see [`stage_ane_kokoro_voices`]). `af_heart` is not here because it
/// belongs to the bundle's own required set and is staged by [`ANE_EN_FILES`]
/// instead — see there for why the conflict this list once feared never existed.
///
/// SHA-256 pins computed from `onnx-community/Kokoro-82M-v1.0-ONNX` — an
/// upstream rehost becomes a deliberate PR to bump (CLAUDE.md MODEL HASHES).
/// One pinned ANE Kokoro voice: rel_path and URL derive from the basename,
/// so name/path/URL cannot drift — the SHA-256 stays the only per-entry fact.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
macro_rules! ane_kokoro_voice {
    ($name:literal, $sha:literal) => {
        ModelFile {
            rel_path: concat!($name, ".bin"),
            url: concat!(
                "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/",
                $name,
                ".bin"
            ),
            sha256: $sha,
        }
    };
}

#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
const ANE_KOKORO_VOICES: &[ModelFile] = &[
    ane_kokoro_voice!(
        "af_alloy",
        "c4a6b876047fd7fb472edf4ebd63cfac7c3b958a7cae7c106e8f038ca6308c45"
    ),
    ane_kokoro_voice!(
        "af_aoede",
        "4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361"
    ),
    ane_kokoro_voice!(
        "af_bella",
        "f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b"
    ),
    // `af_heart` is staged by `ANE_EN_FILES` instead — it is part of the ANE
    // bundle's required set, not an addition to it.
    ane_kokoro_voice!(
        "af_jessica",
        "a240a5e3c15b43563d6e923bdca8ef5613a23471d9b77653694012435df23bd8"
    ),
    ane_kokoro_voice!(
        "af_kore",
        "9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e"
    ),
    ane_kokoro_voice!(
        "af_nicole",
        "cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a"
    ),
    ane_kokoro_voice!(
        "af_nova",
        "18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f"
    ),
    ane_kokoro_voice!(
        "af_river",
        "00a2bcf82b1d86e8f19902ede58c65ccf6c0e43b44b7d74fad54e5d8933c9c30"
    ),
    ane_kokoro_voice!(
        "af_sarah",
        "4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a"
    ),
    ane_kokoro_voice!(
        "af_sky",
        "4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9"
    ),
    ane_kokoro_voice!(
        "am_adam",
        "162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716"
    ),
    ane_kokoro_voice!(
        "am_echo",
        "3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3"
    ),
    ane_kokoro_voice!(
        "am_eric",
        "e8b5be17edd1e3636901ce7598baafe2dc8dd8ff707a0c23bf9e461add7e2832"
    ),
    ane_kokoro_voice!(
        "am_fenrir",
        "c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43"
    ),
    ane_kokoro_voice!(
        "am_liam",
        "52403be32fd047c6a44517cb0bcd6b134f2a18baa73e70ef41651e0eab921ade"
    ),
    ane_kokoro_voice!(
        "am_michael",
        "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1"
    ),
    ane_kokoro_voice!(
        "am_onyx",
        "da5d135b424164916d75a68ffb4c2abce3d7d5ccc82dd1ee6cf447ce286145e6"
    ),
    ane_kokoro_voice!(
        "am_puck",
        "fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0"
    ),
    ane_kokoro_voice!(
        "am_santa",
        "61150cf726ab6c5ed7a99f90a304f91f5a72c00c592e89ec94e5df11c319227a"
    ),
    ane_kokoro_voice!(
        "bm_lewis",
        "b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97"
    ),
    ane_kokoro_voice!(
        "em_alex",
        "27809e9eafdcbcfff90a3016c697568676531de2a2c39cee29c96c7bd6b83e95"
    ),
    ane_kokoro_voice!(
        "ff_siwis",
        "a35f5675ad08948e326ae75fd0ea16ba5d0042e4f76b5f3d1df77d0a48c54861"
    ),
    ane_kokoro_voice!(
        "hm_omega",
        "b02d9222d9ed00ce26b302173a862c2c93f96cc40b5c422b8d14910b9ff34137"
    ),
    ane_kokoro_voice!(
        "im_nicola",
        "bc578e510d52a96d6940d46f12e96d7b3df00905dbea075113226d100e6e1ab0"
    ),
    ane_kokoro_voice!(
        "jm_kumo",
        "09e959d239724c734d65661f06f14cdabcddfd476bfaaad905a937099ae9e64f"
    ),
    ane_kokoro_voice!(
        "pm_alex",
        "0175c753f59c54e7fd5a995bedef0c5ff2fb67e0043dd3dcb2ae74ec2acbeb2a"
    ),
    // re-pinned (#492): removed the flat `zm_yunjian.bin`
    // (was sha de48a00bdbf3649f07162269a2b6e0513604389bfac8a2e6c75cb34b323ad6fa).
    // zh (Mandarin) voices are NOT staged here — the FluidAudio 0.15.5 `.mandarin`
    // KokoroAne variant fetches its own `ANE-zh/` bundle (nested `voices/<id>.bin`)
    // on first synth, and those ids are numbered (e.g. zm_050), not the
    // onnx-community names. A flat kesha-staged pack would be unused. See
    // `tts::fluid_kokoro` zh-* voices.
];

/// Everything FluidAudio 0.15.5 fetches for itself on a first `kesha say`, so
/// that `kesha install --tts` can put it there instead (#823).
///
/// Without this, `KokoroAneManager.initialize` pulls the 7-stage ANE chain, the
/// shared G2P bundle and the Misaki lexicon at *synthesis* time — a download on
/// a command the user did not think was one, which is what NEVER AUTO-DOWNLOAD
/// exists to prevent. Once these are staged, upstream's presence checks
/// short-circuit before any network call, and `set_offline_mode` turns any gap
/// that remains into a loud error instead of a silent fetch.
///
/// Pinned SHA-256s like every other staged artifact; a rehost or a re-export
/// upstream becomes a deliberate bump (CLAUDE.md MODEL HASHES ARE PINNED).
/// `rel_path` doubles as the remote path under each repo prefix, so a name,
/// path or URL cannot drift independently of the hash.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
macro_rules! ane_en_file {
    ($rel:literal, $sha:literal) => {
        ModelFile {
            rel_path: $rel,
            url: concat!(
                "https://huggingface.co/FluidInference/kokoro-82m-coreml/resolve/main/",
                "ANE/",
                $rel
            ),
            sha256: $sha,
        }
    };
}

/// The English (`ANE/`) 7-stage chain, its vocab, and `af_heart`.
///
/// `af_heart` is staged here and NOT among [`ANE_KOKORO_VOICES`]: it belongs to
/// this bundle's required set, so a missing copy makes upstream re-fetch the
/// whole repo. Taking it from FluidInference rather than onnx-community also
/// settles the conflict the old exclusion note guessed at — the two are
/// byte-identical (sha256 d583ccff…), and this is the authoritative copy.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
const ANE_EN_FILES: &[ModelFile] = &[
    ane_en_file!(
        "KokoroAlbert.mlmodelc/analytics/coremldata.bin",
        "14a61873d8759a38b79c93f9021ae865f408f56301209a0168dbfc2283265ccd"
    ),
    ane_en_file!(
        "KokoroAlbert.mlmodelc/coremldata.bin",
        "70b6d2f8429229f6800dda9480341669f7ac0eabf05a82934d8632ab2b4b63a6"
    ),
    ane_en_file!(
        "KokoroAlbert.mlmodelc/metadata.json",
        "fe1d005481f646707a948267ac089dfb2cd2ccea7d5827a14c28587eb4c89930"
    ),
    ane_en_file!(
        "KokoroAlbert.mlmodelc/model.mil",
        "2038154d06a20e399a8ae35ec5c9242702cb23db8dd24dde7679cd53708e4eae"
    ),
    ane_en_file!(
        "KokoroAlbert.mlmodelc/weights/weight.bin",
        "36089a39359b800d3e2c60e5e8ac9217d8f2d1010a8b9273192290e621f1fabc"
    ),
    ane_en_file!(
        "KokoroPostAlbert.mlmodelc/analytics/coremldata.bin",
        "6640044c875505382edbc361cdd56f3f1c30f082953e0f9473a31ae3f71e6c43"
    ),
    ane_en_file!(
        "KokoroPostAlbert.mlmodelc/coremldata.bin",
        "86de3ab0c1e8c6f8842b57bc24695a5099590c49b864e3fa2737b1fb5b15ba3b"
    ),
    ane_en_file!(
        "KokoroPostAlbert.mlmodelc/metadata.json",
        "2e3be1af412a76e340120a01cd04a502666371ada86b1fdaf5a622896e0bf979"
    ),
    ane_en_file!(
        "KokoroPostAlbert.mlmodelc/model.mil",
        "450b73a3b179e1702e7b2210bad008eac20d58b2d6076e3c2de76290a66e5fef"
    ),
    ane_en_file!(
        "KokoroPostAlbert.mlmodelc/weights/weight.bin",
        "e4f300a23cc2e05d38680d9fc94681cc722d445076d1d248f83255122ba091c8"
    ),
    ane_en_file!(
        "KokoroAlignment.mlmodelc/analytics/coremldata.bin",
        "f6074d1039a9151d0f97dc6ec9ee0cd9c7b865f1af646d718ab38b659fa84f3f"
    ),
    ane_en_file!(
        "KokoroAlignment.mlmodelc/coremldata.bin",
        "9a0fb4a536f665a052914d7f17b0e6ac80a3614f702e4be87ac0302c1143a4ea"
    ),
    ane_en_file!(
        "KokoroAlignment.mlmodelc/metadata.json",
        "6f610d23b9f93c7f1a968d6a861efa99725a191de696bf1c3be334ead39b7f00"
    ),
    ane_en_file!(
        "KokoroAlignment.mlmodelc/model.mil",
        "eb3a618bda0cdf95cdffab586ef5c76333d0d0a1dcb881190b3ef414f3421b3e"
    ),
    ane_en_file!(
        "KokoroAlignment.mlmodelc/weights/weight.bin",
        "2e7d69128b59d615fc3d3cf85637a687235fc086b1eb136359adb11a61615f6b"
    ),
    ane_en_file!(
        "KokoroProsody.mlmodelc/analytics/coremldata.bin",
        "7708aab83deabd72539512acd850447fa955187608d9710a828943aa8498c6b8"
    ),
    ane_en_file!(
        "KokoroProsody.mlmodelc/coremldata.bin",
        "d65d87f246a6546c0fb7af6efe020106c38604e5c2b9ca00a78561c115dda33e"
    ),
    ane_en_file!(
        "KokoroProsody.mlmodelc/metadata.json",
        "a780887a790fe54e2ad14d26b2d936eca4fc6ab9f727e60f7e01f0c208163eef"
    ),
    ane_en_file!(
        "KokoroProsody.mlmodelc/model.mil",
        "e6b332f1ed1b22178a406a16c9767c0eed2d64b7f0c17c86ccb2b6abf863b1ed"
    ),
    ane_en_file!(
        "KokoroProsody.mlmodelc/weights/weight.bin",
        "d3c2670eb0c528802f0815d917dcb77bf17faf063bd2bc09cfd0970e2bc1444c"
    ),
    ane_en_file!(
        "KokoroNoise_v2.mlmodelc/analytics/coremldata.bin",
        "53af6bf61482f6002bdb6e3a62f30774cde6e96411aebd888222a34b369f3d04"
    ),
    ane_en_file!(
        "KokoroNoise_v2.mlmodelc/coremldata.bin",
        "9911047f924b41f8b92811c32c50b7c718bd7b0c14842b3bc1b66b9ffe341a19"
    ),
    ane_en_file!(
        "KokoroNoise_v2.mlmodelc/metadata.json",
        "eb3102217532d952479c6f1b04d26d7ac4cdbc59875b6a23e8aae86e5e02c2bc"
    ),
    ane_en_file!(
        "KokoroNoise_v2.mlmodelc/model.mil",
        "60233949d896f15ef38aea19afda558935d7569fa77a3ca4babddd3ffe845a36"
    ),
    ane_en_file!(
        "KokoroNoise_v2.mlmodelc/weights/weight.bin",
        "1102fc2d31dfcfe3de3978a4c78b65202ff8b0a4d55a9304213bd4e8bda66bc2"
    ),
    ane_en_file!(
        "KokoroVocoder.mlmodelc/analytics/coremldata.bin",
        "8c7c1a25a46ad46b1068905ece8f841c4bd23df23306551bad175d0da28ae74b"
    ),
    ane_en_file!(
        "KokoroVocoder.mlmodelc/coremldata.bin",
        "e73aaf146c7543c0f75f544ac52e3287fa4eaa7e9a04bf3ac6a94d0023f16c00"
    ),
    ane_en_file!(
        "KokoroVocoder.mlmodelc/metadata.json",
        "0c3decd8c05850a80964fda07e3f9be17030fcb0724e223ea5b187d370a821b1"
    ),
    ane_en_file!(
        "KokoroVocoder.mlmodelc/model.mil",
        "c42be65f1e0b502dc80aba3173df1cbb02e1c8f474c550feb0f6d83c3128aae7"
    ),
    ane_en_file!(
        "KokoroVocoder.mlmodelc/weights/weight.bin",
        "6d1f96eb50218ab687b12d6d862d2ae854c12b7165c3cd9b6b5cef261ef02ff1"
    ),
    ane_en_file!(
        "KokoroTail.mlmodelc/analytics/coremldata.bin",
        "7dd3d6b8cfbcdcac37b46f6eb1312b842b972dc75f7cb9968f349fedfc0d77db"
    ),
    ane_en_file!(
        "KokoroTail.mlmodelc/coremldata.bin",
        "f28f17e4217d7ec1bed48bff4c65287169daa9198315f6fffb00a1483831f5d3"
    ),
    ane_en_file!(
        "KokoroTail.mlmodelc/metadata.json",
        "7708ecc145eecf8e3ef5ef8979ea7a4f77d04c8da787454c6d9190e5300fc50b"
    ),
    ane_en_file!(
        "KokoroTail.mlmodelc/model.mil",
        "b0b8fd573bac76ba7eb85730eeb25538fc7f1c666ecbf939fd4b3a4ad4495ad7"
    ),
    ane_en_file!(
        "KokoroTail.mlmodelc/weights/weight.bin",
        "2d4877b5d2725a9f017653e391638bee1262d1877a080bce09726aae128fecb2"
    ),
    ane_en_file!(
        "vocab.json",
        "8d65b0188b77eafc60751dac42bbac7ab5f5685074af44db91d1877b42dc1d7c"
    ),
    ane_en_file!(
        "af_heart.bin",
        "d583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b"
    ),
];

#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
macro_rules! kokoro_g2p_file {
    ($rel:literal, $sha:literal) => {
        ModelFile {
            rel_path: $rel,
            url: concat!(
                "https://huggingface.co/FluidInference/kokoro-82m-coreml/resolve/main/",
                "",
                $rel
            ),
            sha256: $sha,
        }
    };
}

/// The shared BART G2P bundle plus the Misaki lexicon cache, staged into the
/// one directory FluidAudio will look in: `G2PModel.shared` is a singleton
/// pinned to `~/.cache/fluidaudio/Models/kokoro`, so unlike the ANE chain these
/// cannot follow `with_models_dir` (fluidaudio-rs 4e488d7).
///
/// The lexicon is 10 MB of Misaki weak forms — best-effort upstream, a
/// pronunciation-quality booster rather than a hard dependency, but staging it
/// is what stops it downloading behind the user's back.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
const KOKORO_G2P_FILES: &[ModelFile] = &[
    kokoro_g2p_file!(
        "G2PEncoder.mlmodelc/analytics/coremldata.bin",
        "cf7fbd7e7a65529b2d2bf3941e458a0ab6dff7a298bf48e205a1727c81c26a99"
    ),
    kokoro_g2p_file!(
        "G2PEncoder.mlmodelc/coremldata.bin",
        "0f14d46ca9fd06c68b4717294575b2b99449e67d40b7a2c56f926bf05cd90b11"
    ),
    kokoro_g2p_file!(
        "G2PEncoder.mlmodelc/metadata.json",
        "c8e0cfd7f494ac1b3662ff8f1914b2b45f79ffb2791724cdc0576981996732e1"
    ),
    kokoro_g2p_file!(
        "G2PEncoder.mlmodelc/model.mil",
        "8c617e569f37286b056dad800d862dc145be9a95fa9ed43857bb646ba199d7da"
    ),
    kokoro_g2p_file!(
        "G2PEncoder.mlmodelc/weights/weight.bin",
        "6926bcd2827d21fec82839487b987e06f85fd8a6a5bb896bc4f6062461d014ec"
    ),
    kokoro_g2p_file!(
        "G2PDecoder.mlmodelc/analytics/coremldata.bin",
        "dbf1767747fdc188222d467a45b04608b396c76c71db3abb18a5fb3680ef9827"
    ),
    kokoro_g2p_file!(
        "G2PDecoder.mlmodelc/coremldata.bin",
        "607e960f19b4d9a30317a5a11869fcce84b300a909fcab2cc756c0d98e2dacd9"
    ),
    kokoro_g2p_file!(
        "G2PDecoder.mlmodelc/metadata.json",
        "e54e98484fd60d26f22fd3c4e7fe87b0d92a5d2de1f958cc3c4bb36d4ae06a44"
    ),
    kokoro_g2p_file!(
        "G2PDecoder.mlmodelc/model.mil",
        "fe647c598e0d9454d360b8ee49a59ae57ca147fc5330863ba84ccb90dce482ad"
    ),
    kokoro_g2p_file!(
        "G2PDecoder.mlmodelc/weights/weight.bin",
        "cbaeb4e743359f607ab161af0c6d8a817462fdaec622ee788ef8ef952c5f8214"
    ),
    kokoro_g2p_file!(
        "g2p_vocab.json",
        "295ed64b86c2820cd665b0602ae50c6947c0e82ac643082873e0be87dca282ce"
    ),
    kokoro_g2p_file!(
        "us_lexicon_cache.json",
        "6b36ba313202227d6914ad32cd684a0304bd2757e9ec4158ea7bc36ec40e224e"
    ),
];

#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
macro_rules! ane_zh_file {
    ($rel:literal, $sha:literal) => {
        ModelFile {
            rel_path: $rel,
            url: concat!(
                "https://huggingface.co/FluidInference/kokoro-82m-coreml/resolve/main/",
                "ANE-zh/",
                $rel
            ),
            sha256: $sha,
        }
    };
}

/// The Mandarin (`ANE-zh/`) chain, staged only when `zh` is requested.
///
/// Carries `g2pw/g2pw.mlmodelc` (159 MB) because upstream lists it in
/// `requiredModelsZh`, even though the g2pW disambiguator cannot currently
/// activate: `ensureMandarinG2pw` needs `ANE-zh/g2pw/vocab.txt`, which upstream
/// has not published (404 at this pin), so Mandarin G2P runs dict-only either
/// way. Dropping the bundle would only make upstream re-download the whole
/// repo.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
const ANE_ZH_FILES: &[ModelFile] = &[
    ane_zh_file!(
        "KokoroAlbert.mlmodelc/analytics/coremldata.bin",
        "e3b66851b7a61e9b2f2fb17a5050a46f5d98acaec46b3822b65c3e509c15c94e"
    ),
    ane_zh_file!(
        "KokoroAlbert.mlmodelc/coremldata.bin",
        "bae8190320b079bc995d69b19c2247c2e66faf5ebefe0cfb99bddf4efa98a86c"
    ),
    ane_zh_file!(
        "KokoroAlbert.mlmodelc/metadata.json",
        "d5fbc004f1b6eb8e15efe4392e702b7d064e704536e1b585e7cd910a62680fd2"
    ),
    ane_zh_file!(
        "KokoroAlbert.mlmodelc/model.mil",
        "3af07f753779fdd7d81cf482098a2a94feda50f677b8ce606c14596c2f44e732"
    ),
    ane_zh_file!(
        "KokoroAlbert.mlmodelc/weights/weight.bin",
        "8c3d8458f357f2e60380de284139af566c6c22e3719bb985524616d0a4f57e5b"
    ),
    ane_zh_file!(
        "KokoroPostAlbert.mlmodelc/analytics/coremldata.bin",
        "9ac50dad158a0dc349a240675d84ad920ae3202f282fc70fb2b833d78eb6829f"
    ),
    ane_zh_file!(
        "KokoroPostAlbert.mlmodelc/coremldata.bin",
        "c9246412170c6118149ccf412efafbb76db5bd47946776a1897b046ca2576f95"
    ),
    ane_zh_file!(
        "KokoroPostAlbert.mlmodelc/metadata.json",
        "fdc356568fef6d2a7a88a31d1934498c9466da48e95822e7176d9ec055b8be5c"
    ),
    ane_zh_file!(
        "KokoroPostAlbert.mlmodelc/model.mil",
        "325c79e75c3f883b575dbef00efd22a9cee523bdd6a556efe5506c505c2a624d"
    ),
    ane_zh_file!(
        "KokoroPostAlbert.mlmodelc/weights/weight.bin",
        "bca73c9f402ccd18052fe8cc418741caa196c3caceeb3637187cdc5d67d8daf7"
    ),
    ane_zh_file!(
        "KokoroAlignment.mlmodelc/analytics/coremldata.bin",
        "7c84c8820e2e6f1b27229db6ce4ec2cc2817c546aa31d2d2f677d35be5445443"
    ),
    ane_zh_file!(
        "KokoroAlignment.mlmodelc/coremldata.bin",
        "8bede89325746a1b540c3350a473ceeaea39a5cea7a641c340e9013655865936"
    ),
    ane_zh_file!(
        "KokoroAlignment.mlmodelc/metadata.json",
        "a1e61d00267f01da2ea32fea44a2c1c04e1a04533b1464bdbc48de03f69e3099"
    ),
    ane_zh_file!(
        "KokoroAlignment.mlmodelc/model.mil",
        "107daf70364aab37665fd29509c3be81a1b046c04a368d780ec43b0afe5b5064"
    ),
    ane_zh_file!(
        "KokoroAlignment.mlmodelc/weights/weight.bin",
        "2e7d69128b59d615fc3d3cf85637a687235fc086b1eb136359adb11a61615f6b"
    ),
    ane_zh_file!(
        "KokoroProsody.mlmodelc/analytics/coremldata.bin",
        "3c90a008bfe021f8c24f39d26706a894cffb3cc6d5dca1ad131f54547f0554a1"
    ),
    ane_zh_file!(
        "KokoroProsody.mlmodelc/coremldata.bin",
        "7f1932bc07f52171e0fff898ae0e9c289a8c73aaf0a2ac06b2352b8ef58afc61"
    ),
    ane_zh_file!(
        "KokoroProsody.mlmodelc/metadata.json",
        "dea9dbc84c8b96cd0e17961f4bd5eb6972d762e9b18f0a08ceee4b4e1cdb49ab"
    ),
    ane_zh_file!(
        "KokoroProsody.mlmodelc/model.mil",
        "df6b4852bbade0f94c63721ad2e05171efbe915bcc9bbd59d05cdbda8cda17d7"
    ),
    ane_zh_file!(
        "KokoroProsody.mlmodelc/weights/weight.bin",
        "0d7229d31a47e1d5c054c24b7aed8ce0df20460523472a55ff998f5939a75cf8"
    ),
    ane_zh_file!(
        "KokoroNoise_v2.mlmodelc/analytics/coremldata.bin",
        "7eacfc0eb5b0f576ccc38e6ac8c1746e740dab1459cb9a3408542576723cc012"
    ),
    ane_zh_file!(
        "KokoroNoise_v2.mlmodelc/coremldata.bin",
        "3d8f933a62fc1d0b08f97bd776afa61d887bca7c3f93a21b5ff3d92cb88099ee"
    ),
    ane_zh_file!(
        "KokoroNoise_v2.mlmodelc/metadata.json",
        "44e7cab52849d84da4b603e17b2b6ab61ee31f5ea5645b4765b5160942b63afa"
    ),
    ane_zh_file!(
        "KokoroNoise_v2.mlmodelc/model.mil",
        "58b78ba89d89e1e3aacecabd2ad5f504f6eae5ae1796b11b819598452afb1dc3"
    ),
    ane_zh_file!(
        "KokoroNoise_v2.mlmodelc/weights/weight.bin",
        "2bf3f47ba8851668634ae7e28e0df8854c0f56add4177ca38054036a846de24a"
    ),
    ane_zh_file!(
        "KokoroVocoder.mlmodelc/analytics/coremldata.bin",
        "12bf39f5117a2fe2645b0158d75d71a99b328b237f1add55a1511d0e2ee3b456"
    ),
    ane_zh_file!(
        "KokoroVocoder.mlmodelc/coremldata.bin",
        "24ad83fed32d94eff2b3d9d70159140057ebad500b2a7f8fb54b0be0204b1cd2"
    ),
    ane_zh_file!(
        "KokoroVocoder.mlmodelc/metadata.json",
        "56a46a2f4f9015b6845b0e39c544be4d9923f00a48d5dd0ea58905dd0e336ba4"
    ),
    ane_zh_file!(
        "KokoroVocoder.mlmodelc/model.mil",
        "d55193676724a4bcaf0d419146994fa651ee6061d458edfd88dee518dff9268c"
    ),
    ane_zh_file!(
        "KokoroVocoder.mlmodelc/weights/weight.bin",
        "daa560673b32e3efce3ca99299d083c42c5844dd8022a8a847c23f2d00b20c6b"
    ),
    ane_zh_file!(
        "KokoroTail.mlmodelc/analytics/coremldata.bin",
        "cbffea509dfcba72fae7a9dc7ae424e19f8af08eabc70360fe30fd7c1de09151"
    ),
    ane_zh_file!(
        "KokoroTail.mlmodelc/coremldata.bin",
        "94e611a84f91c7b135b031a0f978cc47b0edab42912e68a86c3f3e78f9edf6a0"
    ),
    ane_zh_file!(
        "KokoroTail.mlmodelc/metadata.json",
        "d3c8a18ae48455281d614c098658c606174c2f02f594022232d427ac7070c899"
    ),
    ane_zh_file!(
        "KokoroTail.mlmodelc/model.mil",
        "05abf10a8c6fdc77a614948a1d2a8b2374ac71daf2b24aaee077044067fde15f"
    ),
    ane_zh_file!(
        "KokoroTail.mlmodelc/weights/weight.bin",
        "1865207df8b7608f3fd443b5a3c744634a8942ccc917b5c8734818d569c0f4eb"
    ),
    ane_zh_file!(
        "vocab.json",
        "3c4eb3ae5080b67c6ddae731f35e1bad0a3dd7d7afc9c356f906284ae0f9e6f3"
    ),
    ane_zh_file!(
        "voices/zf_001.bin",
        "0a89ec12bb93fb9c74077924daf02568baad64e1f869389f5aaee01a386035f8"
    ),
    // The one Mandarin voice kesha advertises (`zh-zm_050`, the male brand
    // default). Upstream would fetch it through `ensureVoicePack`, which is not
    // covered by offline mode, so staging is the only thing that stops it.
    ane_zh_file!(
        "voices/zm_050.bin",
        "7869f25a5e71ea9b67a1893777e375ac411bdbfb75feff5efe25fad2fc766c8d"
    ),
    ane_zh_file!(
        "g2pw/g2pw.mlmodelc/analytics/coremldata.bin",
        "b5697bf7c53b3ef37aed797c91ba198ff8804fe04858131710644023e62f15c7"
    ),
    ane_zh_file!(
        "g2pw/g2pw.mlmodelc/coremldata.bin",
        "3a4aa20b8e59a846f0946f8213e41e121294866218716c3c670ad0371ef1e06e"
    ),
    ane_zh_file!(
        "g2pw/g2pw.mlmodelc/metadata.json",
        "c938ccdebac94bce1a72dfb0e96eb86caa8b4ec530382e1a530fd164e39b2bbc"
    ),
    ane_zh_file!(
        "g2pw/g2pw.mlmodelc/model.mil",
        "168f7e71f7501c33583ec3fa4c61fe725e42493b73660f8369f5e38328f0388b"
    ),
    ane_zh_file!(
        "g2pw/g2pw.mlmodelc/weights/weight.bin",
        "95b5d709600e2133f8ea5139268ed2b5e539787d37e1f69d8bed37ba2cdc5aaa"
    ),
];

#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
macro_rules! ane_zh_asset {
    ($rel:literal, $remote:literal, $sha:literal) => {
        ModelFile {
            rel_path: $rel,
            url: concat!(
                "https://huggingface.co/FluidInference/kokoro-82m-coreml/resolve/main/",
                $remote
            ),
            sha256: $sha,
        }
    };
}

/// The Mandarin pinyin dictionaries. Split from [`ANE_ZH_FILES`] because they
/// are the one group whose local path differs from its remote path: upstream
/// publishes them under `ANE-zh/assets/` and reads them from `<repoDir>/g2p/`.
///
/// The jieba HMM tables `ensureMandarinJiebaHmm` also wants are not staged —
/// upstream never published them, so that fetch fails and segmentation falls
/// back to FMM by design.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
const ANE_ZH_G2P_ASSETS: &[ModelFile] = &[
    ane_zh_asset!(
        "g2p/pinyin_phrases.bin",
        "ANE-zh/assets/pinyin_phrases.bin",
        "ee86607bd17bee526a2a503c9aa99e87adfe61f336707531ba7eec866f796049"
    ),
    ane_zh_asset!(
        "g2p/pinyin_single.bin",
        "ANE-zh/assets/pinyin_single.bin",
        "6afc4165be18718ab64ca623044ea1dfef30e7b652e59917967bd752b7c9d73f"
    ),
];

/// Map a flat ANE voice-pack basename (`<x><gender>_name.bin`) to its Kokoro
/// language code. The first character of a Kokoro voice id selects language
/// (`a`/`b` = English, `e` = Spanish, etc.); the second is the gender prefix.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn ane_voice_lang(rel_path: &str) -> Option<&'static str> {
    // Kokoro voice files are `<x><gender>_name.bin`; first char picks language.
    match rel_path.chars().next() {
        Some('a') | Some('b') => Some("en"),
        Some('e') => Some("es"),
        Some('f') => Some("fr"),
        Some('h') => Some("hi"),
        Some('i') => Some("it"),
        Some('j') => Some("ja"),
        Some('p') => Some("pt"),
        Some('z') => Some("zh"),
        _ => None,
    }
}

/// Subset of [`ANE_KOKORO_VOICES`] whose language is in `langs`. Drives the
/// language-aware ANE staging so an English-only install skips the es/it/pt/…
/// packs (and a Russian-only install stages nothing here).
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
fn ane_voices_for(langs: &[&str]) -> Vec<&'static ModelFile> {
    ANE_KOKORO_VOICES
        .iter()
        .filter(|f| ane_voice_lang(f.rel_path).is_some_and(|l| langs.contains(&l)))
        .collect()
}

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

pub fn fluidaudio_models_root() -> PathBuf {
    cache_dir().join(FLUIDAUDIO_ROOT_DIR)
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
) -> FluidAudioLocation {
    if legacy_ready {
        return FluidAudioLocation {
            dir: legacy.to_path_buf(),
            root: None,
        };
    }
    let root = fluidaudio_models_root();
    FluidAudioLocation {
        dir: root.join(repo_subpath),
        root: Some(root),
    }
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
    Some(format!(
        "warning: legacy FluidAudio bundle at {} is no longer read (incomplete, or superseded by a model-set change); models now load from {}, so the old directory can be deleted",
        legacy.display(),
        fluidaudio_models_root().display()
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
pub fn fluidaudio_kokoro_cache_dir() -> PathBuf {
    fluidaudio_kokoro_location().dir
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
pub fn fluidaudio_ane_kokoro_dir() -> PathBuf {
    fluidaudio_kokoro_cache_dir().join("ANE")
}

/// FluidAudio's Mandarin (`ANE-zh/`) bundle directory, the Kokoro sibling of
/// [`fluidaudio_ane_kokoro_dir`].
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub fn fluidaudio_ane_zh_kokoro_dir() -> PathBuf {
    fluidaudio_kokoro_cache_dir().join("ANE-zh")
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
pub fn fluidaudio_kokoro_g2p_dir() -> PathBuf {
    dirs::home_dir()
        .expect("cannot determine home directory")
        .join(".cache")
        .join("fluidaudio")
        .join("Models")
        .join("kokoro")
}

/// Where FluidAudio's Kokoro CoreML bundles live, and the root that puts them there.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub fn fluidaudio_kokoro_location() -> FluidAudioLocation {
    let legacy = legacy_fluidaudio_kokoro_cache_dir();
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
fn legacy_fluidaudio_kokoro_cache_dir() -> PathBuf {
    dirs::home_dir()
        .expect("cannot determine home directory")
        .join(".cache")
        .join("fluidaudio")
        .join("Models")
        .join("kokoro-82m-coreml")
}

/// FluidAudio's ASR bundle directory — the one `AsrModels` loads from, wherever that
/// currently is. See [`fluidaudio_asr_location`] for which of the two it can be.
#[cfg(feature = "coreml")]
pub fn fluidaudio_asr_dir() -> PathBuf {
    fluidaudio_asr_location().dir
}

/// Where the Parakeet bundle lives, and the root that puts it there.
#[cfg(feature = "coreml")]
pub fn fluidaudio_asr_location() -> FluidAudioLocation {
    static ANNOUNCED: AtomicBool = AtomicBool::new(false);
    let legacy = legacy_fluidaudio_asr_dir();
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
fn legacy_fluidaudio_asr_dir() -> PathBuf {
    dirs::home_dir()
        .expect("cannot determine home directory")
        .join("Library")
        .join("Application Support")
        .join("FluidAudio")
        .join("Models")
        .join(FLUID_ASR_REPO_DIR)
}

/// Where `fluidaudio-rs` keeps compiled Sortformer `.mlmodelc` bundles, and the root that
/// puts them there. Relocating this costs a ~100 s ANE recompile rather than a download, but
/// the fallback rule is the same: an existing cache stays where it is.
#[cfg(feature = "system_diarize")]
pub fn fluidaudio_diarize_location() -> FluidAudioLocation {
    let legacy = legacy_sortformer_compiled_dir();
    let compiled = dir_has_entries(&legacy);
    fluidaudio_location(&legacy, compiled, "fluidaudio-rs/SortformerCompiled")
}

#[cfg(feature = "system_diarize")]
fn legacy_sortformer_compiled_dir() -> PathBuf {
    dirs::home_dir()
        .expect("cannot determine home directory")
        .join("Library")
        .join("Application Support")
        .join("fluidaudio-rs")
        .join("SortformerCompiled")
}

/// What FluidAudio's own `modelsExist` requires. The encoder is pinned to int8
/// because the bridge calls `downloadAndLoad(to:)` with its default
/// `useInt8Encoder: true` — accepting `EncoderInt4.mlmodelc` here would pass
/// preflight and then let FluidAudio fetch the int8 encoder on first transcribe.
/// If the bridge ever selects precision, this must follow it.
#[cfg(feature = "coreml")]
const FLUID_ASR_REQUIRED: &[&str] = &[
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
    fluidaudio_asr_ready_in(&fluidaudio_asr_dir())
}

#[cfg(feature = "coreml")]
fn fluidaudio_asr_ready_in(dir: &Path) -> bool {
    FLUID_ASR_REQUIRED.iter().all(|f| dir.join(f).exists())
}

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
    let ane_dir = fluidaudio_ane_kokoro_dir();
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
        stage_into(&fluidaudio_ane_kokoro_dir(), ANE_EN_FILES, no_cache)?;
        stage_into(&fluidaudio_kokoro_g2p_dir(), KOKORO_G2P_FILES, no_cache)?;
    }
    if langs.contains(&"zh") {
        let zh = fluidaudio_ane_zh_kokoro_dir();
        stage_into(&zh, ANE_ZH_FILES, no_cache)?;
        stage_into(&zh, ANE_ZH_G2P_ASSETS, no_cache)?;
    }
    Ok(())
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
        with_stderr(|| eprintln!("REPAIR {name} (incomplete, will refetch on first synth)"));
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
    purge_incomplete_ane_bundles_in(&fluidaudio_kokoro_cache_dir())
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
    incomplete_ane_bundles_in(&fluidaudio_kokoro_cache_dir())
        .unwrap_or_default()
        .iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect()
}

/// Vosk-TTS multi-speaker Russian model, mirrored to HF at
/// `drakulavich/vosk-tts-ru-0.9-multi`. Replaces Piper-ru per
/// `docs/superpowers/specs/2026-04-27-vosk-ru-replacement-design.md`.
/// SHA-256 pins computed from the HF mirror — see CLAUDE.md MODEL HASHES
/// ARE PINNED rule.
#[cfg(feature = "tts")]
pub const VOSK_RU_FILES: &[ModelFile] = &[
    ModelFile {
        rel_path: "models/vosk-ru/model.onnx",
        url: "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main/model.onnx",
        sha256: "0fa5a36b22a8bf7fe7179a3882c6371d2c01e5317019e717516f892d329c24b9",
    },
    ModelFile {
        rel_path: "models/vosk-ru/dictionary",
        url: "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main/dictionary",
        sha256: "2939e72c170bb41ac8e256828cca1c5fac4db1e36717f9f53fde843b00a220ba",
    },
    ModelFile {
        rel_path: "models/vosk-ru/config.json",
        url: "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main/config.json",
        sha256: "e155fb266a730e1858a2420442b465acf08a3236dffad7d1a507bf155b213d50",
    },
    ModelFile {
        rel_path: "models/vosk-ru/bert/model.onnx",
        url:
            "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main/bert/model.onnx",
        sha256: "2e2f1740eaae5e29c2b4844625cbb01ff644b2b5fb0560bd34374c35d8a092c1",
    },
    ModelFile {
        rel_path: "models/vosk-ru/bert/vocab.txt",
        url: "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main/bert/vocab.txt",
        sha256: "bbe5063cc3d7a314effd90e9c5099cf493b81f2b9552c155264e16eeab074237",
    },
    // removed: README.md (drakulavich/vosk-tts-ru-0.9-multi) — not opened at
    // runtime; pinning its SHA forced a manifest bump on every upstream
    // doc copy-edit. CharsiuG2P entries (3 byt5-tiny ONNX) were also
    // removed in PR #213 — Russian uses vosk-tts internal G2P now.
];

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

/// Emit the "Model mirror active: <url>" banner so any user staring at a
/// fresh `kesha install` notices that downloads are flowing through
/// `KESHA_MODEL_MIRROR`. **Side effect**: writes a single line to stderr
/// on the first call per process, no-op thereafter. Idempotent via
/// `OnceLock` — repeated calls (test reruns inside one process) are safe.
///
/// Call this once at the start of the install handler in `main.rs` rather
/// than from each `download_*` function. Concentrating the side effect at
/// one boundary keeps `download_tts`, `download_vad`, and `download_diarize`
/// behaviourally pure-from-the-caller — they return `Result<()>` and don't
/// hide a surprise stderr write behind it.
pub fn init_mirror_logging() {
    use std::sync::OnceLock;
    static LOGGED: OnceLock<()> = OnceLock::new();
    LOGGED.get_or_init(|| {
        if let Some(base) = model_mirror() {
            eprintln!("Model mirror active: {base}");
        }
    });
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
pub fn model_dir(kind: ModelKind) -> PathBuf {
    model_dir_at(kind, &cache_dir())
}

/// Same as [`model_dir`] but with a caller-supplied cache root — for the
/// list-voices / resolver paths that already have the root and want to
/// avoid re-reading the env var.
pub fn model_dir_at(kind: ModelKind, cache_root: &Path) -> PathBuf {
    cache_root.join(kind.subdir())
}

/// True iff `kind`'s required files are present under the active cache.
pub fn is_cached(kind: ModelKind) -> bool {
    is_cached_in(kind, &model_dir(kind))
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

/// `vosk_tts::Model::new` opens these three files — keep this layout check
/// aligned with the loader. `has_all_files` flattens the manifest to basenames,
/// which would treat the top-level `model.onnx` and `bert/model.onnx` as
/// duplicates; this custom walk handles the nested path instead.
#[cfg(feature = "tts")]
fn has_vosk_ru_layout(dir: &Path) -> bool {
    dir.join("model.onnx").exists()
        && dir.join("dictionary").exists()
        && dir.join("bert/model.onnx").exists()
}

/// `.mlpackage` is a directory tree — the runtime-required files live at
/// nested paths under `Data/com.apple.CoreML/`. Same basename-flattening
/// problem as the Vosk layout above (two `*-weight.bin` siblings under
/// different `weights/` subdirs), so we walk each path explicitly. (#199)
#[cfg(feature = "system_diarize")]
fn has_diarize_layout(dir: &Path) -> bool {
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

pub fn install(no_cache: bool) -> Result<()> {
    let cache = cache_dir();

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

    cleanup_legacy();
    Ok(())
}

/// Static singleton avoids repeated `pthread_create`/teardown per install call.
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

/// 4 concurrent downloads. Each file runs its own retry budget to completion, so
/// one file's transient 429 no longer cancels the three siblings mid-flight
/// (#724); the install then fails naming every file that exhausted its retries.
fn parallel_download(cache: &Path, manifest: &[&ModelFile], no_cache: bool) -> Result<()> {
    use rayon::prelude::*;
    let mut failures: Vec<(&'static str, anyhow::Error)> = download_pool().install(|| {
        manifest
            .par_iter()
            .filter_map(|f| {
                download_verified(cache, f, no_cache)
                    .err()
                    .map(|e| (f.rel_path, e))
            })
            .collect()
    });
    if failures.is_empty() {
        return Ok(());
    }
    if failures.len() == 1 {
        return Err(failures.remove(0).1);
    }
    let summary = format!(
        "{} of {} model downloads failed: {}",
        failures.len(),
        manifest.len(),
        failures
            .iter()
            .map(|(path, _)| *path)
            .collect::<Vec<_>>()
            .join(", ")
    );
    // The returned chain can only carry one root cause, so the others are
    // reported here rather than dropped.
    for (path, err) in failures.iter().skip(1) {
        with_stderr(|| eprintln!("FAIL {path}: {err:#}"));
    }
    Err(failures.remove(0).1.context(summary))
}

#[cfg(test)]
mod manifest_tests {
    use super::*;

    fn assert_plan_paths(plan: &serde_json::Value, key: &str, files: &[ModelFile]) {
        let plan_paths = plan[key]
            .as_array()
            .unwrap_or_else(|| panic!("install plan {key} must be an array"))
            .iter()
            .map(|file| {
                file["relPath"]
                    .as_str()
                    .unwrap_or_else(|| panic!("install plan {key} entry needs relPath"))
            })
            .collect::<Vec<_>>();
        let runtime_paths = files.iter().map(|file| file.rel_path).collect::<Vec<_>>();
        assert_eq!(
            plan_paths, runtime_paths,
            "install plan {key} drifted from runtime manifest"
        );
    }

    #[cfg(all(
        feature = "tts",
        not(all(
            feature = "system_kokoro",
            target_os = "macos",
            target_arch = "aarch64"
        ))
    ))]
    fn assert_plan_path(plan: &serde_json::Value, key: &str, file: &ModelFile) {
        let plan_path = plan[key]["relPath"]
            .as_str()
            .unwrap_or_else(|| panic!("install plan {key} needs relPath"));
        assert_eq!(
            plan_path, file.rel_path,
            "install plan {key} drifted from runtime manifest"
        );
    }

    #[test]
    fn install_plan_model_paths_match_runtime_manifests() {
        let plan: serde_json::Value = serde_json::from_str(include_str!("../../model-plan.json"))
            .expect("model plan JSON must parse");

        #[cfg(not(feature = "coreml"))]
        assert_plan_paths(&plan, "asr", ASR_FILES);
        assert_plan_paths(&plan, "langId", LANG_ID_FILES);
        assert_plan_paths(&plan, "vad", VAD_FILES);

        assert_plan_paths(&plan, "diarize", DIARIZE_FILES);

        #[cfg(feature = "tts")]
        assert_plan_paths(&plan, "voskRu", VOSK_RU_FILES);

        #[cfg(all(
            feature = "tts",
            not(all(
                feature = "system_kokoro",
                target_os = "macos",
                target_arch = "aarch64"
            ))
        ))]
        {
            assert_plan_paths(&plan, "g2pCharsiu", G2P_CHARSIU_FILES);
            assert_plan_path(&plan, "kokoroGraph", &KOKORO_GRAPH);
            assert_plan_path(&plan["kokoroVoices"], "en", &KOKORO_EN_VOICE);
            for lang in ["es", "fr", "it", "pt"] {
                assert_plan_path(
                    &plan["kokoroVoices"],
                    lang,
                    &multilang_voice(lang).expect("known Kokoro language"),
                );
            }
        }
    }

    #[test]
    #[cfg(not(feature = "coreml"))]
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
    fn vad_manifest_has_expected_files_and_hashes() {
        assert_eq!(VAD_FILES.len(), 1);
        let f = &VAD_FILES[0];
        assert!(f.rel_path.ends_with("/silero_vad.onnx"));
        assert_eq!(f.sha256.len(), 64);
        // Silero VAD is hosted on github.com, not HF — apply_mirror leaves
        // non-HF URLs untouched, so this is by design.
        assert!(f.url.starts_with("https://github.com/snakers4/silero-vad/"));
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

    // `echo -n 'hello world' | shasum -a 256`
    const HELLO_SHA: &str = "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

    struct FailingReader {
        served: bool,
    }

    impl io::Read for FailingReader {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if self.served {
                Err(io::Error::other("connection reset mid-stream"))
            } else {
                self.served = true;
                buf[..5].copy_from_slice(b"hello");
                Ok(5)
            }
        }
    }

    fn write_verified_target(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "kesha-write-verified-{name}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn write_verified_places_good_bytes_at_target() -> Result<()> {
        let target = write_verified_target("ok.bin");
        write_verified(&mut &b"hello world"[..], &target, "ok.bin", HELLO_SHA)?;
        assert_eq!(fs::read(&target)?, b"hello world");
        let _ = fs::remove_file(&target);
        Ok(())
    }

    // Runs on the windows-latest CI leg too, pinning that the final rename
    // replaces an existing destination there (MOVEFILE_REPLACE_EXISTING).
    #[test]
    fn write_verified_replaces_existing_target() -> Result<()> {
        let target = write_verified_target("replace.bin");
        fs::write(&target, b"previous verified weights")?;
        write_verified(&mut &b"hello world"[..], &target, "replace.bin", HELLO_SHA)?;
        assert_eq!(fs::read(&target)?, b"hello world");
        assert!(!staging_path(&target).exists());
        let _ = fs::remove_file(&target);
        Ok(())
    }

    #[test]
    fn write_verified_leaves_nothing_on_hash_mismatch() {
        let target = write_verified_target("mismatch.bin");
        let err = write_verified(
            &mut &b"tampered bytes"[..],
            &target,
            "mismatch.bin",
            HELLO_SHA,
        )
        .expect_err("wrong hash must fail");
        assert!(err.to_string().contains("sha256 mismatch"), "{err}");
        assert!(!target.exists());
        assert!(!staging_path(&target).exists());
    }

    #[test]
    fn write_verified_failure_leaves_existing_target_untouched() -> Result<()> {
        let target = write_verified_target("refresh.bin");
        fs::write(&target, b"previously verified weights")?;
        let err = write_verified(
            &mut FailingReader { served: false },
            &target,
            "refresh.bin",
            HELLO_SHA,
        )
        .expect_err("mid-stream read error must fail");
        assert!(err.to_string().contains("refresh.bin"), "{err}");
        assert_eq!(
            fs::read(&target)?,
            b"previously verified weights",
            "a failed refresh must not lose the working install"
        );
        assert!(!staging_path(&target).exists());
        let _ = fs::remove_file(&target);
        Ok(())
    }
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

#[cfg(all(test, feature = "system_diarize"))]
mod diarize_sidecar_tests {
    use super::*;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(name: &str) -> Result<Self> {
            let path = std::env::temp_dir().join(format!(
                "kesha-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_nanos()
            ));
            fs::create_dir_all(&path)?;
            Ok(Self { path })
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn cleanup_diarize_sidecars_keeps_current_and_removes_stale() -> Result<()> {
        let tmp = TempDir::new("diarize-sidecars")?;
        let current = tmp.path.join("SortformerNvidiaLow_v2.mlpackage");
        let current_sidecar = tmp.path.join("SortformerNvidiaLow_v2.mlpackage.mlmodelc");
        let old_sidecar = tmp.path.join("SortformerNvidiaLow_v1.mlpackage.mlmodelc");
        let old_sidecar_file = tmp.path.join("SortformerNvidiaLow_v0.mlpackage.mlmodelc");
        let source_package = tmp.path.join("SortformerNvidiaLow_v1.mlpackage");
        let unrelated = tmp.path.join("README.md");

        fs::create_dir_all(&current)?;
        fs::create_dir_all(&current_sidecar)?;
        fs::create_dir_all(&old_sidecar)?;
        fs::write(&old_sidecar_file, b"compiled")?;
        fs::create_dir_all(&source_package)?;
        fs::write(&unrelated, b"leave me")?;

        let removed = cleanup_diarize_compiled_sidecars(&current)?;

        assert_eq!(removed, 2);
        assert!(current.exists());
        assert!(current_sidecar.exists());
        assert!(source_package.exists());
        assert!(unrelated.exists());
        assert!(!old_sidecar.exists());
        assert!(!old_sidecar_file.exists());
        Ok(())
    }

    #[test]
    fn cleanup_diarize_sidecars_ignores_missing_parent() -> Result<()> {
        let tmp = TempDir::new("diarize-sidecars-missing")?;
        let missing = tmp.path.join("missing/Current.mlpackage");

        assert_eq!(cleanup_diarize_compiled_sidecars(&missing)?, 0);
        Ok(())
    }

    const DIARIZE_RUNTIME_FILES: [&str; 4] = [
        "Manifest.json",
        "Data/com.apple.CoreML/model.mlmodel",
        "Data/com.apple.CoreML/weights/0-weight.bin",
        "Data/com.apple.CoreML/weights/1-weight.bin",
    ];

    fn write_layout(dir: &Path, files: &[&str]) -> Result<()> {
        for rel in files {
            let path = dir.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&path, b"x")?;
        }
        Ok(())
    }

    #[test]
    fn diarize_layout_needs_every_runtime_file() -> Result<()> {
        let tmp = TempDir::new("diarize-layout")?;
        let complete = tmp.path.join("complete.mlpackage");
        write_layout(&complete, &DIARIZE_RUNTIME_FILES)?;
        assert!(has_diarize_layout(&complete), "complete bundle is ready");

        for (i, missing) in DIARIZE_RUNTIME_FILES.iter().enumerate() {
            let partial = tmp.path.join(format!("partial-{i}.mlpackage"));
            let present: Vec<&str> = DIARIZE_RUNTIME_FILES
                .iter()
                .filter(|f| f != &missing)
                .copied()
                .collect();
            write_layout(&partial, &present)?;
            assert!(
                !has_diarize_layout(&partial),
                "{missing} missing must not read as ready"
            );
        }
        Ok(())
    }

    #[test]
    fn only_compiled_sidecars_are_removable() {
        assert!(is_compiled_mlpackage_sidecar(Path::new(
            "/cache/Sortformer.mlpackage.mlmodelc"
        )));
        assert!(!is_compiled_mlpackage_sidecar(Path::new(
            "/cache/Sortformer.mlpackage"
        )));
        assert!(!is_compiled_mlpackage_sidecar(Path::new(
            "/cache/Sortformer.mlmodelc"
        )));
        assert!(!is_compiled_mlpackage_sidecar(Path::new("/")));
    }
}

#[cfg(test)]
mod mirror_tests {
    use super::*;
    use crate::util::test_env::EnvGuard;

    #[test]
    fn unset_env_falls_through_to_upstream() {
        let _lock = crate::util::test_env::lock();

        {
            let _g = EnvGuard::unset("KESHA_MODEL_MIRROR");
            assert_eq!(model_mirror(), None);
            assert_eq!(
                apply_mirror("https://huggingface.co/foo/bar/resolve/main/file.onnx"),
                "https://huggingface.co/foo/bar/resolve/main/file.onnx"
            );
        }
        {
            let _g = EnvGuard::set("KESHA_MODEL_MIRROR", "");
            assert_eq!(model_mirror(), None);
            assert_eq!(
                apply_mirror("https://huggingface.co/foo/bar/resolve/main/file.onnx"),
                "https://huggingface.co/foo/bar/resolve/main/file.onnx"
            );
        }
        {
            let _g = EnvGuard::set("KESHA_MODEL_MIRROR", "   ");
            assert_eq!(model_mirror(), None);
        }
    }

    #[test]
    fn rewrites_hf_url_onto_mirror_base_preserving_path() {
        let _lock = crate::util::test_env::lock();
        let _g = EnvGuard::set("KESHA_MODEL_MIRROR", "https://mirror.example.com/kesha");
        assert_eq!(
            apply_mirror("https://huggingface.co/foo/bar/resolve/main/file.onnx"),
            "https://mirror.example.com/kesha/foo/bar/resolve/main/file.onnx"
        );
    }

    #[test]
    fn strips_trailing_slash_from_mirror_base() {
        let _lock = crate::util::test_env::lock();
        let _g = EnvGuard::set("KESHA_MODEL_MIRROR", "https://mirror.example.com/kesha/");
        assert_eq!(
            apply_mirror("https://huggingface.co/x/y/resolve/main/z.bin"),
            "https://mirror.example.com/kesha/x/y/resolve/main/z.bin"
        );
    }

    #[test]
    fn non_hf_urls_pass_through_unchanged() {
        // github.com release assets (engine binary + avspeech sidecar) must
        // NOT be redirected — KESHA_MODEL_MIRROR only covers model files.
        let _lock = crate::util::test_env::lock();
        let _g = EnvGuard::set("KESHA_MODEL_MIRROR", "https://mirror.example.com");
        let url = "https://github.com/drakulavich/kesha-voice-kit/releases/download/v1.3.0/kesha-engine-darwin-arm64";
        assert_eq!(apply_mirror(url), url);
    }
}

#[cfg(all(test, feature = "tts"))]
mod tts_tests {
    use super::*;

    #[test]
    fn vosk_ru_manifest_has_expected_files() {
        let m = VOSK_RU_FILES;
        assert_eq!(m.len(), 5);
        let names: std::collections::HashSet<&str> = m.iter().map(|f| f.rel_path).collect();
        for f in [
            "models/vosk-ru/model.onnx",
            "models/vosk-ru/dictionary",
            "models/vosk-ru/config.json",
            "models/vosk-ru/bert/model.onnx",
            "models/vosk-ru/bert/vocab.txt",
        ] {
            assert!(names.contains(f), "missing {f}");
        }
        for f in m {
            assert!(f.sha256.len() == 64, "sha256 must be 64 hex chars");
            assert!(f.url.starts_with(
                "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main/"
            ));
        }
    }

    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn ane_kokoro_voices_shape_and_male_default() {
        // Pins must stay 64 hex chars on huggingface.co so the mirror rewrite
        // and hash gate keep working; rel_path is a flat `<voice>.bin` because
        // it lands directly in the ANE cache dir.
        assert!(!ANE_KOKORO_VOICES.is_empty());
        let names: std::collections::HashSet<&str> =
            ANE_KOKORO_VOICES.iter().map(|f| f.rel_path).collect();
        // The male brand default must be staged (CLAUDE.md DEFAULT TTS VOICES).
        assert!(
            names.contains("am_michael.bin"),
            "missing male default pack"
        );
        for f in ANE_KOKORO_VOICES {
            assert_eq!(f.sha256.len(), 64, "{:?} sha256 not 64 hex chars", f);
            assert!(
                f.url.starts_with("https://huggingface.co/"),
                "{f:?} url not on huggingface.co — mirror rewrite relies on that prefix"
            );
            assert!(
                f.rel_path.ends_with(".bin") && !f.rel_path.contains('/'),
                "{f:?} rel_path must be a flat <voice>.bin for the ANE cache"
            );
        }
        // Every FluidAudio Kokoro voice kesha advertises must have a staged
        // pack, or `--voice <lang>-<x>` resolves and then reaches for the
        // network under a flag that forbids it. Three manifests can supply one:
        // the English catalog here, the ANE bundle's own `af_heart`, and the
        // Mandarin bundle's nested `voices/`.
        let staged_anywhere = |bare: &str| {
            names.contains(format!("{bare}.bin").as_str())
                || ANE_EN_FILES
                    .iter()
                    .any(|f| f.rel_path == format!("{bare}.bin"))
                || ANE_ZH_FILES
                    .iter()
                    .any(|f| f.rel_path == format!("voices/{bare}.bin"))
        };
        for v in crate::tts::fluid_kokoro::available_voice_ids() {
            let bare = v
                .split_once('-')
                .map(|(_, bare)| bare)
                .unwrap_or(v.as_str());
            assert!(staged_anywhere(bare), "advertised voice {v} is not staged");
        }
    }

    /// Every file `KokoroAneManager.initialize` requires has to be in one of the
    /// staging manifests, or offline mode turns a working install into an error
    /// (#823). Names come from upstream's `ModelNames.KokoroAne` /
    /// `ModelNames.G2P`; a pin bump that renames a stage fails here.
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn staged_manifests_cover_what_fluidaudio_requires() {
        const CHAIN: [&str; 7] = [
            "KokoroAlbert.mlmodelc",
            "KokoroPostAlbert.mlmodelc",
            "KokoroAlignment.mlmodelc",
            "KokoroProsody.mlmodelc",
            "KokoroNoise_v2.mlmodelc",
            "KokoroVocoder.mlmodelc",
            "KokoroTail.mlmodelc",
        ];
        // A CoreML ML Program bundle is only loadable with all five of these;
        // `model.mil` missing is exactly the half-fetch #709 was about.
        const PARTS: [&str; 5] = [
            "analytics/coremldata.bin",
            "coremldata.bin",
            "metadata.json",
            "model.mil",
            "weights/weight.bin",
        ];
        let has = |m: &[ModelFile], p: &str| m.iter().any(|f| f.rel_path == p);

        for bundle in CHAIN {
            for part in PARTS {
                let rel = format!("{bundle}/{part}");
                assert!(has(ANE_EN_FILES, &rel), "English chain is missing {rel}");
                assert!(has(ANE_ZH_FILES, &rel), "Mandarin chain is missing {rel}");
            }
        }
        for required in ["vocab.json", "af_heart.bin"] {
            assert!(
                has(ANE_EN_FILES, required),
                "English set is missing {required}"
            );
        }
        for required in ["vocab.json", "voices/zf_001.bin"] {
            assert!(
                has(ANE_ZH_FILES, required),
                "Mandarin set is missing {required}"
            );
        }
        for part in PARTS {
            assert!(
                has(ANE_ZH_FILES, &format!("g2pw/g2pw.mlmodelc/{part}")),
                "requiredModelsZh lists g2pw.mlmodelc, so it must be staged whole"
            );
        }
        for required in [
            "G2PEncoder.mlmodelc/model.mil",
            "G2PDecoder.mlmodelc/model.mil",
            "g2p_vocab.json",
            "us_lexicon_cache.json",
        ] {
            assert!(
                has(KOKORO_G2P_FILES, required),
                "G2P set is missing {required}"
            );
        }
        for required in ["g2p/pinyin_phrases.bin", "g2p/pinyin_single.bin"] {
            assert!(
                has(ANE_ZH_G2P_ASSETS, required),
                "Mandarin G2P is missing {required}"
            );
        }
    }

    /// Same pin discipline the rest of `models.rs` gets: 64 hex chars, on
    /// huggingface.co so `KESHA_MODEL_MIRROR` can rewrite it, and a relative
    /// path that stays inside the directory it is staged into.
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn staged_manifests_are_pinned_and_contained() {
        for manifest in [
            ANE_EN_FILES,
            ANE_ZH_FILES,
            ANE_ZH_G2P_ASSETS,
            KOKORO_G2P_FILES,
        ] {
            assert!(!manifest.is_empty());
            for f in manifest {
                assert_eq!(f.sha256.len(), 64, "{f:?} sha256 not 64 hex chars");
                assert!(
                    f.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                    "{f:?} sha256 is not hex"
                );
                assert!(
                    f.url.starts_with(
                        "https://huggingface.co/FluidInference/kokoro-82m-coreml/resolve/main/"
                    ),
                    "{f:?} must come from the FluidInference repo FluidAudio itself uses"
                );
                let rel = Path::new(f.rel_path);
                assert!(
                    rel.is_relative()
                        && !rel
                            .components()
                            .any(|c| matches!(c, std::path::Component::ParentDir)),
                    "{f:?} rel_path must stay inside its staging directory"
                );
            }
        }
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

    #[test]
    fn cache_dir_honors_env_var() {
        let _lock = crate::util::test_env::lock();
        let guard = EnvGuard::set("KESHA_CACHE_DIR", "/tmp/kesha-test-xyz");
        assert_eq!(cache_dir(), PathBuf::from("/tmp/kesha-test-xyz"));
        drop(guard);
    }

    use crate::util::test_env::EnvGuard;

    #[test]
    fn tts_languages_includes_en_and_ru_everywhere() {
        let langs = tts_languages();
        assert!(langs.contains(&"en"), "en missing: {langs:?}");
        assert!(langs.contains(&"ru"), "ru missing: {langs:?}");
        for l in ["es", "fr", "it", "pt"] {
            assert!(langs.contains(&l), "{l} missing: {langs:?}");
        }
    }

    #[test]
    fn tts_languages_gates_ane_only_langs() {
        let langs = tts_languages();
        let ane_only = ["hi", "ja", "zh"];
        #[cfg(all(
            feature = "system_kokoro",
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        for l in ane_only {
            assert!(
                langs.contains(&l),
                "{l} should be present on system_kokoro build"
            );
        }
        #[cfg(not(all(
            feature = "system_kokoro",
            target_os = "macos",
            target_arch = "aarch64"
        )))]
        for l in ane_only {
            assert!(
                !langs.contains(&l),
                "{l} must NOT be present on the ONNX build"
            );
        }
    }

    #[cfg(not(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    )))]
    #[test]
    fn kokoro_manifest_for_selects_per_language() {
        let ends = |m: &[ModelFile], suffix: &str| m.iter().any(|f| f.rel_path.ends_with(suffix));

        let en = kokoro_manifest_for(&["en"]);
        assert!(ends(&en, "model.onnx"));
        assert!(ends(&en, "am_michael.bin"));
        assert!(
            !en.iter().any(|f| f.rel_path.contains("g2p")),
            "en must not pull g2p"
        );

        let es = kokoro_manifest_for(&["es"]);
        assert!(ends(&es, "model.onnx"));
        assert!(ends(&es, "em_alex.bin"));
        assert!(
            es.iter().any(|f| f.rel_path.contains("g2p")),
            "es needs g2p"
        );
        assert!(!ends(&es, "am_michael.bin"));

        let both = kokoro_manifest_for(&["en", "es"]);
        assert_eq!(
            both.iter()
                .filter(|f| f.rel_path.ends_with("kokoro-82m/model.onnx"))
                .count(),
            1,
            "Kokoro graph must appear exactly once even when both en and es are selected"
        );
        assert!(ends(&both, "am_michael.bin") && ends(&both, "em_alex.bin"));

        assert!(kokoro_manifest_for(&["ru"]).is_empty());
    }

    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn ane_voices_for_filters_by_language_prefix() {
        let names = |langs: &[&str]| {
            ane_voices_for(langs)
                .iter()
                .map(|f| f.rel_path.to_string())
                .collect::<Vec<_>>()
        };
        let en = names(&["en"]);
        assert!(en.iter().any(|n| n.starts_with("am_")));
        assert!(en
            .iter()
            .all(|n| n.starts_with("am_") || n.starts_with("af_") || n.starts_with("bm_")));
        let es = names(&["es"]);
        assert!(!es.is_empty() && es.iter().all(|n| n.starts_with("e")));
        // af_alloy IS in ANE_KOKORO_VOICES and is en-prefixed — the filter must return it for "en".
        assert!(names(&["en"]).iter().any(|n| n == "af_alloy.bin"));
    }

    #[test]
    fn validate_tts_langs_accepts_known_rejects_unknown() {
        assert!(validate_tts_langs(&["en"]).is_ok());
        let err = validate_tts_langs(&["en", "klingon"])
            .unwrap_err()
            .to_string();
        assert!(err.contains("klingon"), "err names the bad code: {err}");
        #[cfg(not(all(
            feature = "system_kokoro",
            target_os = "macos",
            target_arch = "aarch64"
        )))]
        {
            let err = validate_tts_langs(&["ja"]).unwrap_err().to_string();
            assert!(err.contains("ja"), "ja unavailable on ONNX build: {err}");
        }
    }

    #[test]
    fn download_tts_empty_langs_is_noop() {
        assert!(download_tts(&[], false).is_ok());
    }
}

/// Download the Sortformer `.mlpackage`. Opt-in via `kesha install --diarize`
/// (#199) — feature-gated to `system_diarize`, which build-engine.yml only
/// turns on for darwin-arm64. Non-darwin builds neither expose the flag nor
/// reach this function. 4-file manifest, ~245 MB total; goes through the
/// same hash-verify + retry path as the rest.
#[cfg(feature = "system_diarize")]
pub fn download_diarize(no_cache: bool) -> Result<()> {
    download_manifest(DIARIZE_FILES, no_cache)
}

/// Hash-verified parallel download of a static manifest into the cache dir.
fn download_manifest(files: &[ModelFile], no_cache: bool) -> Result<()> {
    let cache = cache_dir();
    let refs: Vec<&ModelFile> = files.iter().collect();
    parallel_download(&cache, &refs, no_cache)
}

/// Remove stale CoreML-compiled diarization sidecars after the current model
/// was successfully warmed. Only deletes Kesha-owned siblings next to the
/// active `.mlpackage`; never touches the source `.mlpackage` or Apple's e5rt
/// cache.
///
/// Keeping the active sidecar is load-bearing, not just tidiness: e5rt is keyed
/// by the compiled bundle's identity, not its path, so a recompiled `.mlmodelc`
/// at the same path is a cache MISS that re-pays the ~98 s cold ANE compile
/// (#444). Deleting only stale siblings preserves the warmed sidecar's cache hit.
#[cfg(feature = "system_diarize")]
pub fn cleanup_diarize_compiled_sidecars(keep_model_package: &Path) -> Result<usize> {
    let Some(parent) = keep_model_package.parent() else {
        return Ok(0);
    };
    if !parent.exists() {
        return Ok(0);
    }

    let keep_sidecar = compiled_model_sidecar(keep_model_package);
    let mut removed = 0;
    for entry in
        fs::read_dir(parent).with_context(|| format!("read diarize cache {}", parent.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path == keep_sidecar || !is_compiled_mlpackage_sidecar(&path) {
            continue;
        }
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(&path)
                .with_context(|| format!("remove stale diarize sidecar {}", path.display()))?;
        } else {
            fs::remove_file(&path)
                .with_context(|| format!("remove stale diarize sidecar {}", path.display()))?;
        }
        removed += 1;
    }
    Ok(removed)
}

#[cfg(feature = "system_diarize")]
fn compiled_model_sidecar(model_package: &Path) -> PathBuf {
    let mut sidecar = model_package.as_os_str().to_os_string();
    sidecar.push(".mlmodelc");
    PathBuf::from(sidecar)
}

#[cfg(feature = "system_diarize")]
fn is_compiled_mlpackage_sidecar(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".mlpackage.mlmodelc"))
}

/// Download the Silero VAD ONNX. Opt-in via `kesha install --vad` (#128).
pub fn download_vad(no_cache: bool) -> Result<()> {
    download_manifest(VAD_FILES, no_cache)
}

/// Download the TTS model files needed for `langs` only. Each file is streamed
/// to disk, then SHA256-verified, 4 concurrent (#178). An English-only install
/// skips the CharsiuG2P pack; a Russian-only install skips Kokoro entirely.
/// Empty `langs` is a no-op so the install handler can short-circuit a bare run.
#[cfg(feature = "tts")]
pub fn download_tts(langs: &[&str], no_cache: bool) -> Result<()> {
    if langs.is_empty() {
        return Ok(());
    }

    #[cfg(not(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    )))]
    {
        let cache = cache_dir();
        let mut manifest = kokoro_manifest_for(langs);
        if langs.contains(&"ru") {
            manifest.extend_from_slice(VOSK_RU_FILES);
        }
        let refs: Vec<&ModelFile> = manifest.iter().collect();
        parallel_download(&cache, &refs, no_cache)?;
    }

    // On the FluidAudio ANE Kokoro path everything lands in FluidAudio's own
    // caches: the model chain and its G2P assets so nothing downloads at first
    // synth (#823), plus the requested en/es/it/… voice catalog — including the
    // male `am_michael` default — so those resolve local-first instead of
    // 404ing against the ANE bundle (#475). Vosk-RU still lands under
    // KESHA_CACHE_DIR.
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    {
        if langs.contains(&"ru") {
            download_manifest(VOSK_RU_FILES, no_cache)?;
        }
        stage_fluidaudio_kokoro_assets(langs, no_cache)?;
        stage_ane_kokoro_voices(langs, no_cache)?;
    }

    Ok(())
}

/// Hash-verify on every path — cached hits short-circuit network; mismatch bails before
/// the bad file can reach inference (#174).
fn download_verified(cache: &Path, f: &ModelFile, no_cache: bool) -> Result<()> {
    let target = cache.join(f.rel_path);
    if target.exists() {
        if verify_sha256(&target, f.sha256)? {
            if !no_cache {
                with_stderr(|| eprintln!("OK  {} (cached)", f.rel_path));
                return Ok(());
            }
            // no_cache over a valid file: keep it in place until a verified
            // replacement lands, so a failed refresh can't lose a working
            // install (Greptile P1 on #619).
        } else {
            // Corrupt/stale bytes: clear now so the existence-only cache
            // probes can't resurrect them even if this download fails (#174).
            let _ = fs::remove_file(&target);
        }
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    download_with_retries(&apply_mirror(f.url), f, &target)?;
    with_stderr(|| eprintln!("OK  {}", f.rel_path));
    Ok(())
}

/// Re-issues the request while the failure looks like it might clear, backing
/// off between attempts. The verified write inside each attempt is unchanged:
/// retry covers the request, never the hash check (#174).
fn download_with_retries(url: &str, f: &ModelFile, target: &Path) -> Result<()> {
    let mut attempt: u32 = 1;
    loop {
        match download_attempt(url, f, target) {
            Ok(()) => return Ok(()),
            Err(fail) if attempt < fail.max_attempts => {
                let delay = backoff_delay(attempt, fail.retry_after, jitter_fraction());
                with_stderr(|| {
                    eprintln!(
                        "retrying {} in {:.1}s (attempt {}/{}, {})",
                        f.rel_path,
                        delay.as_secs_f64(),
                        attempt + 1,
                        fail.max_attempts,
                        fail.reason
                    )
                });
                std::thread::sleep(delay);
                attempt += 1;
            }
            Err(fail) => {
                return Err(fail
                    .err
                    .context(format!("{} failed after {attempt} attempt(s)", f.rel_path)));
            }
        }
    }
}

/// Attempts per file before the install gives up. Five spend roughly 15 s of
/// backoff on the default schedule — enough to ride out HuggingFace's anonymous
/// per-IP 429 window without leaving a dead download hanging for minutes (#724).
const MAX_DOWNLOAD_ATTEMPTS: u32 = 5;
const DNS_MAX_ATTEMPTS: u32 = 3;
const RETRY_BASE_DELAY: Duration = Duration::from_secs(1);
const RETRY_MAX_DELAY: Duration = Duration::from_secs(30);
/// A server asking for more than this is asking for longer than a user will
/// wait at an install prompt; clamp rather than honour it literally.
const RETRY_AFTER_MAX: Duration = Duration::from_secs(60);

/// One request+stream attempt that failed. `max_attempts` is the total the
/// retry loop may spend on this kind of failure; 1 means fatal, which is what a
/// sha256 mismatch always is (#174).
struct AttemptFailure {
    err: anyhow::Error,
    reason: String,
    retry_after: Option<Duration>,
    max_attempts: u32,
}

fn model_download_error(message: String) -> anyhow::Error {
    anyhow::Error::new(CodedError {
        code: ErrorCode::ModelDownload,
        message,
    })
}

/// One GET plus its verified stream to disk. Every failure path reports whether
/// it is worth retrying; the caller owns the backoff.
///
/// The resolved URL rides in the error message (#275 D11): under
/// `KESHA_MODEL_MIRROR` the user otherwise cannot tell which host was contacted.
fn download_attempt(
    url: &str,
    f: &ModelFile,
    target: &Path,
) -> std::result::Result<(), AttemptFailure> {
    // Claim in-flight before announcing: the request below blocks on headers, and a
    // sibling's bar must stop repainting over this row first (Greptile P1 on #681).
    let _in_flight = InFlight::new();
    with_stderr(|| eprintln!("GET {}", f.rel_path));

    // Status is inspected here rather than raised by ureq so a 429's
    // `Retry-After` header survives into the backoff decision (#724).
    //
    // ureq ships no timeouts by default, so without these a host that accepts
    // the connection and then goes quiet hangs the install forever. The body is
    // deliberately left unbounded: the 2.4GB encoder legitimately streams for
    // hours on a slow link, and a deadline loose enough to survive that would
    // not catch a stall anyway.
    let response = match ureq::get(url)
        .config()
        .http_status_as_error(false)
        .timeout_resolve(Some(Duration::from_secs(10)))
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_send_request(Some(Duration::from_secs(10)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .build()
        .call()
    {
        Ok(response) => response,
        Err(e) => {
            return Err(AttemptFailure {
                err: model_download_error(format!("GET {url} ({}): {e}", f.rel_path)),
                reason: e.to_string(),
                retry_after: None,
                max_attempts: ureq_error_attempts(&e),
            });
        }
    };

    let status = response.status().as_u16();
    if !response.status().is_success() {
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(parse_retry_after);
        return Err(AttemptFailure {
            err: model_download_error(format!("GET {url} ({}): HTTP {status}", f.rel_path)),
            reason: format!("HTTP {status}"),
            retry_after,
            max_attempts: if status_is_transient(status) {
                MAX_DOWNLOAD_ATTEMPTS
            } else {
                1
            },
        });
    }

    // Not the raw header — that one reports the compressed size when decompression is active.
    let total = response.body().content_length().unwrap_or(0);
    let mut reader = TrackedStream {
        inner: response.into_body().into_reader(),
        read_failed: false,
    };
    let streamed = if total >= PROGRESS_MIN_BYTES && io::IsTerminal::is_terminal(&io::stderr()) {
        let mut reader = ProgressReader::new(&mut reader, total);
        write_verified(&mut reader, target, f.rel_path, f.sha256)
    } else {
        write_verified(&mut reader, target, f.rel_path, f.sha256)
    };
    streamed.map_err(|err| stream_failure(err, reader.read_failed))
}

/// Classifies a failed `write_verified`. A truncated stream deserves another go;
/// a sha mismatch means the host is not serving the pinned bytes and no amount
/// of retrying heals that (#174); a local write failure — full disk, read-only
/// cache — would only re-GET multiple GB to fail the same way (grok P2 on #761).
fn stream_failure(err: anyhow::Error, read_failed: bool) -> AttemptFailure {
    let (reason, max_attempts) = match code_of(&err) {
        ErrorCode::CacheCorrupt => ("hash mismatch", 1),
        _ if read_failed => ("download interrupted", MAX_DOWNLOAD_ATTEMPTS),
        _ => ("cache write failed", 1),
    };
    AttemptFailure {
        err,
        reason: reason.to_string(),
        retry_after: None,
        max_attempts,
    }
}

/// `io::copy` reports a stalled stream and a failing disk identically, so the
/// reader records whose error it was.
struct TrackedStream<R> {
    inner: R,
    read_failed: bool,
}

impl<R: io::Read> io::Read for TrackedStream<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf);
        self.read_failed |= read.is_err();
        read
    }
}

/// Statuses that a later attempt can plausibly resolve. Everything else — 403
/// from a private repo, 404 from a moved artifact — is fatal on the first try.
fn status_is_transient(status: u16) -> bool {
    status == 408 || status == 429 || (500..600).contains(&status)
}

/// A resolver blip should not kill an install, but a genuinely wrong host would
/// burn the whole schedule proving it, so DNS gets a shorter budget.
fn ureq_error_attempts(err: &ureq::Error) -> u32 {
    match err {
        ureq::Error::Timeout(_) | ureq::Error::Io(_) | ureq::Error::ConnectionFailed => {
            MAX_DOWNLOAD_ATTEMPTS
        }
        ureq::Error::HostNotFound => DNS_MAX_ATTEMPTS,
        _ => 1,
    }
}

/// `Retry-After` per RFC 9110, delay-seconds only. HuggingFace's 429s send that
/// form; an HTTP-date falls through to the backoff schedule rather than pull a
/// calendar into the download path.
fn parse_retry_after(raw: &str) -> Option<Duration> {
    raw.trim().parse::<u64>().ok().map(Duration::from_secs)
}

/// Exponential backoff with ±25% jitter, or the server's own `Retry-After`
/// where it gave one. Four rayon workers hit the same host together, so `jitter`
/// must be drawn independently per call — anything they can all read at the same
/// instant, a clock included, retries them in lockstep and re-triggers the rate
/// limit that caused the backoff (#724).
fn backoff_delay(attempt: u32, retry_after: Option<Duration>, jitter: f64) -> Duration {
    if let Some(after) = retry_after {
        return after.clamp(RETRY_BASE_DELAY, RETRY_AFTER_MAX);
    }
    let exponential = RETRY_BASE_DELAY.saturating_mul(1u32 << attempt.saturating_sub(1).min(10));
    exponential
        .min(RETRY_MAX_DELAY)
        .mul_f64(0.75 + 0.5 * jitter.clamp(0.0, 1.0))
}

/// A fresh fraction in `[0, 1)` per call, independent across calls and threads.
/// `RandomState` re-keys on every construction, so workers that back off within
/// the same microsecond still spread; a clock read cannot promise that (#724).
fn jitter_fraction() -> f64 {
    use std::hash::{BuildHasher, Hasher};
    let bits = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    (bits >> 11) as f64 / (1u64 << 53) as f64
}

/// Below this a download finishes fast enough that a bar is noise, not feedback.
const PROGRESS_MIN_BYTES: u64 = 16 * 1024 * 1024;
const PROGRESS_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);
const PROGRESS_BAR_WIDTH: usize = 20;

static DOWNLOADS_IN_FLIGHT: AtomicUsize = AtomicUsize::new(0);
/// `true` while a bar repaint has left the cursor mid-row. Guarded by the same lock
/// as the writes themselves, so ownership of the row transfers atomically.
static BAR_LINE_OPEN: Mutex<bool> = Mutex::new(false);

fn lock_stderr() -> std::sync::MutexGuard<'static, bool> {
    BAR_LINE_OPEN.lock().unwrap_or_else(|e| e.into_inner())
}

fn end_open_bar_line(open: &mut bool) {
    if *open {
        eprintln!();
        *open = false;
    }
}

/// Serializes install-progress writes and ends any open bar row first: the bar paints
/// with `\r` and no newline, so an `eprintln!` would otherwise land inside that row.
fn with_stderr<T>(write: impl FnOnce() -> T) -> T {
    let mut open = lock_stderr();
    end_open_bar_line(&mut open);
    write()
}

/// Counts concurrent `download_verified` network phases so the bar can tell whether it owns stderr.
struct InFlight;

impl InFlight {
    fn new() -> Self {
        DOWNLOADS_IN_FLIGHT.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        DOWNLOADS_IN_FLIGHT.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Redraws a single `\r` line as bytes arrive (#680). Silent unless stderr is a
/// terminal, so redirected installs and CI logs keep the plain `GET`/`OK` lines.
///
/// Draws only while it is the sole download in flight: `parallel_download` runs
/// 4 rayon workers over one stderr, and concurrent bars plus other workers'
/// `GET`/`OK` lines would overwrite each other (Greptile P1 on #681). That still
/// covers the case this exists for — the 2.4GB encoder outlives every sibling by
/// minutes, so the long silent stretch is exactly when the bar is alone.
struct ProgressReader<R> {
    inner: R,
    total: u64,
    read: u64,
    last_draw: std::time::Instant,
}

impl<R: io::Read> ProgressReader<R> {
    fn new(inner: R, total: u64) -> Self {
        Self {
            inner,
            total,
            read: 0,
            last_draw: std::time::Instant::now(),
        }
    }

    fn draw(&mut self) {
        let mut open = lock_stderr();
        if DOWNLOADS_IN_FLIGHT.load(Ordering::SeqCst) != 1 {
            end_open_bar_line(&mut open);
            return;
        }
        let pct = ((self.read.min(self.total) as f64 / self.total as f64) * 100.0) as usize;
        let filled = pct * PROGRESS_BAR_WIDTH / 100;
        // No file name — a deep path wraps the line, and then `\r` can't repaint it (Greptile P2 on #681).
        eprint!(
            "\r    [{}{}] {:>3}%  {:.1}/{:.1}MB",
            "█".repeat(filled),
            "░".repeat(PROGRESS_BAR_WIDTH - filled),
            pct,
            self.read as f64 / 1_048_576.0,
            self.total as f64 / 1_048_576.0,
        );
        let _ = io::Write::flush(&mut io::stderr());
        *open = true;
    }
}

impl<R: io::Read> io::Read for ProgressReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.read += n as u64;
        if n == 0 || self.last_draw.elapsed() >= PROGRESS_INTERVAL {
            self.draw();
            self.last_draw = std::time::Instant::now();
        }
        Ok(n)
    }
}

/// End the line here, not at EOF, so a mid-download bail prints its error on a fresh row.
impl<R> Drop for ProgressReader<R> {
    fn drop(&mut self) {
        end_open_bar_line(&mut lock_stderr());
    }
}

/// Stream `reader` into `target` atomically: bytes land in a per-process
/// `.part.<pid>` sibling, the hash is checked there, and only a verified file
/// is renamed into place. An interrupted or corrupt download therefore never
/// leaves bytes at `target` for the existence-only cache probes to resurrect
/// later (#174), and a failure never disturbs an existing `target` (a
/// concurrent installer's verified rename, or the pre-refresh copy under
/// `--no-cache`). The pid suffix keeps two concurrent installers off each
/// other's staging file; whichever verified rename lands last wins.
fn write_verified<R: io::Read>(
    reader: &mut R,
    target: &Path,
    rel_path: &str,
    expected_sha: &str,
) -> Result<()> {
    let part = staging_path(target);

    let result = (|| -> Result<()> {
        let mut out =
            fs::File::create(&part).with_context(|| format!("create {}", part.display()))?;
        io::copy(reader, &mut out)
            .with_context(|| format!("download {rel_path}"))
            .coded(ErrorCode::ModelDownload)?;
        drop(out);
        if !verify_sha256(&part, expected_sha)? {
            // Recompute to embed the actual hash in the bail (#275 D5). One
            // extra hash pass on a freshly-downloaded file is cheap relative
            // to the failure-mode value: the user can now tell stale-mirror
            // vs corrupt-download vs upstream-rehost from one line of stderr.
            let actual = compute_sha256(&part).unwrap_or_else(|_| "<unreadable>".to_string());
            coded_bail!(
                ErrorCode::CacheCorrupt,
                "sha256 mismatch for {}: expected {} got {}",
                rel_path,
                expected_sha.get(..12).unwrap_or(expected_sha),
                actual.get(..12).unwrap_or(&actual)
            );
        }
        // `fs::rename` replaces an existing destination on every supported
        // platform (POSIX rename; MoveFileExW + MOVEFILE_REPLACE_EXISTING on
        // Windows), so the pre-refresh copy survives until this single call.
        fs::rename(&part, target).with_context(|| format!("rename {}", target.display()))
    })();

    if result.is_err() {
        // Best-effort: drop this process's staging file only — `target` is
        // either absent or a file another writer legitimately owns.
        let _ = fs::remove_file(&part);
    }
    result
}

fn staging_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().map(OsString::from).unwrap_or_default();
    name.push(format!(".part.{}", std::process::id()));
    target.with_file_name(name)
}

fn verify_sha256(path: &Path, expected: &str) -> Result<bool> {
    Ok(compute_sha256(path)?.eq_ignore_ascii_case(expected))
}

/// SHA-256 of `path`'s contents, lowercase hex (#275 D5).
/// 64 KiB BufReader avoids syscall-bound hashing on large model files.
fn compute_sha256(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut reader = std::io::BufReader::with_capacity(65_536, file);
    let mut hasher = Sha256::new();
    io::copy(&mut reader, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
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
    #[cfg(unix)]
    cleanup_orphan_staging(&cache);
}

/// Age threshold for orphaned download staging. A SIGKILLed download leaves
/// its `<name>.part.<pid>` behind forever (#619); a live concurrent
/// installer's staging keeps a fresh mtime while `io::copy` streams into it.
/// The 24 h threshold makes a stalled-but-alive download (no bytes for a full
/// day, process still up) practically impossible to misclassify while still
/// clearing true orphans on the next install. Unix-only: Windows
/// keeps last-write time stale while a handle is open and permits unlinking
/// open files, so an in-flight multi-hour download could be swept there.
#[cfg(unix)]
const STALE_STAGING_SECS: u64 = 24 * 60 * 60;

#[cfg(unix)]
fn cleanup_orphan_staging(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            cleanup_orphan_staging(&path);
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.contains(".part.") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() > STALE_STAGING_SECS);
        if stale {
            eprintln!("Cleaning up orphaned download staging: {name}");
            let _ = fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod characterization_tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn orphan_staging_sweep_removes_only_what_passed_the_24h_threshold() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "kesha-part-gc-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        fs::create_dir_all(dir.join("models"))?;
        let stale = dir.join("models/encoder.onnx.part.12345");
        let at_threshold = dir.join("models/joint.onnx.part.4242");
        let fresh = dir.join("models/decoder.onnx.part.999");
        let finished = dir.join("models/encoder.onnx");
        for p in [&stale, &at_threshold, &fresh, &finished] {
            fs::write(p, b"bytes")?;
        }
        let now = std::time::SystemTime::now();
        for (path, age) in [
            (&stale, STALE_STAGING_SECS + 60),
            (&at_threshold, STALE_STAGING_SECS),
        ] {
            fs::File::options().write(true).open(path)?.set_times(
                fs::FileTimes::new().set_modified(now - std::time::Duration::from_secs(age)),
            )?;
        }

        cleanup_orphan_staging(&dir);

        assert!(!stale.exists(), "stale staging must be swept");
        assert!(
            at_threshold.exists(),
            "24h is the boundary a download must pass, not reach"
        );
        assert!(fresh.exists(), "a live installer's fresh staging survives");
        assert!(finished.exists(), "real model files are never touched");
        let _ = fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn is_cached_resolves_against_the_active_cache_root() {
        let _lock = crate::util::test_env::lock();
        let tmp = tempfile::tempdir().unwrap();
        let _guard = crate::util::test_env::EnvGuard::set(
            "KESHA_CACHE_DIR",
            tmp.path().to_str().expect("utf-8 temp path"),
        );

        assert!(!is_cached(ModelKind::LangId), "empty cache is not cached");

        let dir = tmp.path().join(ModelKind::LangId.subdir());
        fs::create_dir_all(&dir).unwrap();
        for f in LANG_ID_FILES {
            let name = std::path::Path::new(f.rel_path).file_name().unwrap();
            fs::write(dir.join(name), b"dummy").unwrap();
        }
        assert!(is_cached(ModelKind::LangId), "staged cache is cached");
    }

    /// `Repo.folderName` strips the `-coreml` suffix, and a `…-v3-coreml` sibling
    /// exists on disk. Keying on it would report a healthy install as missing ASR.
    #[test]
    #[cfg(feature = "coreml")]
    fn fluidaudio_asr_dir_is_the_directory_fluidaudio_loads_from() {
        let dir = legacy_fluidaudio_asr_dir();
        assert!(dir.ends_with("parakeet-tdt-0.6b-v3"), "{dir:?}");
        assert!(
            dir.to_string_lossy()
                .contains("Library/Application Support/FluidAudio/Models"),
            "{dir:?} is not FluidAudio's ASR root"
        );
    }

    /// A machine with nothing staged yet gets one tree: the injected root and the directory
    /// we report must be the same decision, or `kesha install` stages voice packs into a
    /// directory FluidAudio never reads and re-fetches the bundle anyway (#688).
    #[test]
    fn a_missing_bundle_lands_under_the_kesha_cache() {
        let _lock = crate::util::test_env::lock();
        let tmp = tempfile::tempdir().unwrap();
        let _guard = crate::util::test_env::EnvGuard::set(
            "KESHA_CACHE_DIR",
            tmp.path().to_str().expect("utf-8 temp path"),
        );

        let legacy = PathBuf::from("/nonexistent/FluidAudio/Models/parakeet-tdt-0.6b-v3");
        let at = fluidaudio_location(&legacy, false, "parakeet-tdt-0.6b-v3");

        let root = at
            .root
            .as_ref()
            .expect("a missing bundle must inject a root");
        assert_eq!(root, &tmp.path().join("fluidaudio"));
        assert_eq!(
            at.dir,
            root.join("parakeet-tdt-0.6b-v3"),
            "the reported directory must be where the injected root puts it"
        );
    }

    /// The whole point of the read-fallback: an existing install holds ~2 GB under
    /// FluidAudio's own defaults, and injecting a root would re-download all of it (#688).
    #[test]
    fn an_existing_bundle_stays_put_and_injects_no_root() {
        let _lock = crate::util::test_env::lock();
        let tmp = tempfile::tempdir().unwrap();
        let _guard = crate::util::test_env::EnvGuard::set(
            "KESHA_CACHE_DIR",
            tmp.path().to_str().expect("utf-8 temp path"),
        );

        let legacy = PathBuf::from("/somewhere/FluidAudio/Models/parakeet-tdt-0.6b-v3");
        let at = fluidaudio_location(&legacy, true, "parakeet-tdt-0.6b-v3");

        assert_eq!(at.dir, legacy);
        assert!(
            at.root.is_none(),
            "a usable legacy bundle must keep FluidAudio's defaults rather than relocate"
        );
    }

    /// Every subsystem appends its own repo folder to the same base, so they end up as
    /// siblings under one root rather than three home-directory trees.
    #[test]
    fn subsystems_share_one_root_as_siblings() {
        let _lock = crate::util::test_env::lock();
        let tmp = tempfile::tempdir().unwrap();
        let _guard = crate::util::test_env::EnvGuard::set(
            "KESHA_CACHE_DIR",
            tmp.path().to_str().expect("utf-8 temp path"),
        );

        let missing = PathBuf::from("/nonexistent");
        let asr = fluidaudio_location(&missing, false, "parakeet-tdt-0.6b-v3");
        let kokoro = fluidaudio_location(&missing, false, "kokoro-82m-coreml");
        let sortformer = fluidaudio_location(&missing, false, "fluidaudio-rs/SortformerCompiled");

        assert_eq!(asr.root, kokoro.root);
        assert_eq!(kokoro.root, sortformer.root);
        assert_eq!(asr.dir.parent(), kokoro.dir.parent());
    }

    /// The transition the notice exists for: a pin bump changes the required model set, the
    /// probe rejects a bundle that still holds ~461 MB, and nothing ever reads it again. It
    /// was silent before #688, so the bytes stranded with nothing pointing at them.
    #[test]
    fn a_rejected_legacy_bundle_that_still_holds_files_names_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("parakeet-tdt-0.6b-v3");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("Encoder.mlmodelc"), b"x").unwrap();

        let notice = stale_legacy_notice(&legacy, false, &AtomicBool::new(false))
            .expect("a bundle the probe rejected but that still holds files must be announced");

        assert!(
            notice.contains(&legacy.display().to_string()),
            "the notice must name the directory to delete: {notice}"
        );
        assert_eq!(
            notice.lines().count(),
            1,
            "one line, not a paragraph: {notice}"
        );
    }

    /// The common case is a machine that never had a legacy bundle, and a warning there would
    /// greet every first-run user with a path they have never seen.
    #[test]
    fn a_missing_legacy_directory_is_silent() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(
            stale_legacy_notice(&tmp.path().join("absent"), false, &AtomicBool::new(false))
                .is_none()
        );
    }

    /// An empty directory strands no bytes, so there is nothing to tell anyone to delete.
    #[test]
    fn an_empty_legacy_directory_is_silent() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(stale_legacy_notice(tmp.path(), false, &AtomicBool::new(false)).is_none());
    }

    /// A bundle that still passes its probe is the one being read — announcing it as
    /// abandoned would invite a healthy install to delete the models it is using.
    #[test]
    fn a_legacy_bundle_still_in_use_is_silent() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("Encoder.mlmodelc"), b"x").unwrap();
        assert!(stale_legacy_notice(tmp.path(), true, &AtomicBool::new(false)).is_none());
    }

    /// The location is resolved per bridge construction, not once — five sites do it, and a
    /// single `kesha transcribe` reaches more than one.
    #[test]
    fn the_notice_is_emitted_once_per_process() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("Encoder.mlmodelc"), b"x").unwrap();
        let latched = AtomicBool::new(false);

        assert!(stale_legacy_notice(tmp.path(), false, &latched).is_some());
        assert!(
            stale_legacy_notice(tmp.path(), false, &latched).is_none(),
            "a second resolution must stay quiet"
        );
    }

    /// An interrupted FluidAudio fetch leaves the directory present but partial.
    /// Treating that as cached lets preflight pass and the backend finish the
    /// download mid-transcribe, violating the no-auto-download rule (#684).
    #[test]
    #[cfg(feature = "coreml")]
    fn fluidaudio_asr_readiness_requires_the_whole_bundle() {
        let dir = std::env::temp_dir().join(format!("kesha-fluid-asr-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        assert!(
            !fluidaudio_asr_ready_in(&dir),
            "empty dir must not be ready"
        );

        fs::write(dir.join("Encoder.mlmodelc"), b"x").unwrap();
        assert!(
            !fluidaudio_asr_ready_in(&dir),
            "encoder alone must not be ready"
        );

        for f in FLUID_ASR_REQUIRED {
            fs::write(dir.join(f), b"x").unwrap();
        }
        assert!(
            fluidaudio_asr_ready_in(&dir),
            "complete bundle must be ready"
        );

        // The bridge loads int8, so an int4-only bundle is unusable: calling it ready
        // would pass preflight and let FluidAudio fetch the int8 encoder mid-transcribe.
        fs::remove_file(dir.join("Encoder.mlmodelc")).unwrap();
        fs::write(dir.join("EncoderInt4.mlmodelc"), b"x").unwrap();
        assert!(
            !fluidaudio_asr_ready_in(&dir),
            "int4-only bundle must not satisfy an int8 loader"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn model_kind_subdir_table() {
        assert_eq!(ModelKind::Asr.subdir(), "models/parakeet-tdt-v3");
        assert_eq!(ModelKind::LangId.subdir(), "models/lang-id-ecapa");
        assert_eq!(ModelKind::Vad.subdir(), "models/silero-vad");
    }

    #[cfg(feature = "tts")]
    #[test]
    fn model_kind_subdir_vosk_ru() {
        assert_eq!(ModelKind::VoskRu.subdir(), "models/vosk-ru");
    }

    #[test]
    fn is_cached_in_lang_id_and_vad_arms_check_their_own_files() {
        // The match arms wire each kind to its own file list independently of
        // the Asr/Vosk arms — pin present→true / empty→false per arm.
        for (kind, files) in [
            (ModelKind::LangId, LANG_ID_FILES),
            (ModelKind::Vad, VAD_FILES),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let dir = tmp.path().join(kind.subdir());
            fs::create_dir_all(&dir).unwrap();
            assert!(!is_cached_in(kind, &dir), "{kind:?} empty dir");
            for f in files {
                let name = std::path::Path::new(f.rel_path).file_name().unwrap();
                fs::write(dir.join(name), b"dummy").unwrap();
            }
            assert!(is_cached_in(kind, &dir), "{kind:?} all files present");
        }
    }

    #[test]
    #[cfg(not(feature = "coreml"))]
    fn is_cached_in_asr_true_when_all_files_present() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("models/parakeet-tdt-v3");
        fs::create_dir_all(&dir).unwrap();
        for f in ASR_FILES {
            let name = std::path::Path::new(f.rel_path).file_name().unwrap();
            fs::write(dir.join(name), b"dummy").unwrap();
        }
        assert!(is_cached_in(ModelKind::Asr, &dir));
    }

    #[test]
    #[cfg(not(feature = "coreml"))]
    fn is_cached_in_asr_false_when_one_file_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("models/parakeet-tdt-v3");
        fs::create_dir_all(&dir).unwrap();
        for f in &ASR_FILES[..ASR_FILES.len() - 1] {
            let name = std::path::Path::new(f.rel_path).file_name().unwrap();
            fs::write(dir.join(name), b"dummy").unwrap();
        }
        assert!(!is_cached_in(ModelKind::Asr, &dir));
    }

    #[cfg(feature = "tts")]
    #[test]
    fn is_cached_in_vosk_ru_true_when_layout_present() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("models/vosk-ru");
        fs::create_dir_all(dir.join("bert")).unwrap();
        fs::write(dir.join("model.onnx"), b"dummy").unwrap();
        fs::write(dir.join("dictionary"), b"dummy").unwrap();
        fs::write(dir.join("bert/model.onnx"), b"dummy").unwrap();
        assert!(is_cached_in(ModelKind::VoskRu, &dir));
    }

    #[cfg(feature = "tts")]
    #[test]
    fn is_cached_in_vosk_ru_false_when_bert_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("models/vosk-ru");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("model.onnx"), b"dummy").unwrap();
        fs::write(dir.join("dictionary"), b"dummy").unwrap();
        assert!(!is_cached_in(ModelKind::VoskRu, &dir));
    }

    #[cfg(all(
        feature = "tts",
        not(all(
            feature = "system_kokoro",
            target_os = "macos",
            target_arch = "aarch64"
        ))
    ))]
    #[test]
    fn multilang_voice_returns_expected_packs() {
        // es → em_alex.bin (male ✓)
        let es = multilang_voice("es").unwrap();
        assert!(es.rel_path.ends_with("em_alex.bin"), "{}", es.rel_path);
        // fr → ff_siwis.bin (female, brand-rule exception)
        let fr = multilang_voice("fr").unwrap();
        assert!(fr.rel_path.ends_with("ff_siwis.bin"), "{}", fr.rel_path);
        // it → im_nicola.bin (male ✓)
        let it = multilang_voice("it").unwrap();
        assert!(it.rel_path.ends_with("im_nicola.bin"), "{}", it.rel_path);
        // pt → pm_alex.bin (male ✓)
        let pt = multilang_voice("pt").unwrap();
        assert!(pt.rel_path.ends_with("pm_alex.bin"), "{}", pt.rel_path);
        // ru and de → None (not in multilang Kokoro)
        assert!(multilang_voice("ru").is_none());
        assert!(multilang_voice("de").is_none());
    }

    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn ane_voice_lang_maps_prefixes_correctly() {
        assert_eq!(ane_voice_lang("am_michael.bin"), Some("en"));
        assert_eq!(ane_voice_lang("bm_george.bin"), Some("en"));
        assert_eq!(ane_voice_lang("em_alex.bin"), Some("es"));
        assert_eq!(ane_voice_lang("ff_siwis.bin"), Some("fr"));
        assert_eq!(ane_voice_lang("hm_test.bin"), Some("hi"));
        assert_eq!(ane_voice_lang("im_nicola.bin"), Some("it"));
        assert_eq!(ane_voice_lang("jm_test.bin"), Some("ja"));
        assert_eq!(ane_voice_lang("pm_alex.bin"), Some("pt"));
        assert_eq!(ane_voice_lang("zm_050.bin"), Some("zh"));
        assert_eq!(ane_voice_lang("xm_unknown.bin"), None);
        assert_eq!(ane_voice_lang(""), None);
    }
}

#[cfg(test)]
mod progress_tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn progress_reader_is_byte_transparent() {
        let payload: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        let mut out = Vec::new();
        let mut reader = ProgressReader::new(payload.as_slice(), payload.len() as u64);
        reader.read_to_end(&mut out).expect("read");
        assert_eq!(out, payload);
    }

    #[test]
    fn in_flight_guard_balances() {
        assert_eq!(DOWNLOADS_IN_FLIGHT.load(Ordering::SeqCst), 0);
        {
            let _outer = InFlight::new();
            assert_eq!(DOWNLOADS_IN_FLIGHT.load(Ordering::SeqCst), 1);
            let _inner = InFlight::new();
            assert_eq!(DOWNLOADS_IN_FLIGHT.load(Ordering::SeqCst), 2);
        }
        assert_eq!(DOWNLOADS_IN_FLIGHT.load(Ordering::SeqCst), 0);
    }

    /// The bar must stay silent unless it owns stderr — 4 rayon workers share it (#681 P1).
    #[test]
    fn bar_draws_only_when_alone() {
        let payload = vec![7u8; 512];
        let mut reader = ProgressReader::new(payload.as_slice(), payload.len() as u64);
        let _a = InFlight::new();
        let _b = InFlight::new();
        reader.draw();
        assert!(!*lock_stderr(), "must not draw beside another download");

        drop(_b);
        reader.read = payload.len() as u64;
        reader.draw();
        assert!(*lock_stderr(), "must draw when it is the only download");
    }

    /// A sibling's `GET`/`OK` must not land inside the bar's open `\r` row (grok review on #681).
    #[test]
    fn sibling_write_ends_the_open_bar_row() {
        let payload = vec![7u8; 512];
        let mut reader = ProgressReader::new(payload.as_slice(), payload.len() as u64);
        let _alone = InFlight::new();
        reader.draw();
        assert!(*lock_stderr(), "bar row is open");

        with_stderr(|| {});
        assert!(!*lock_stderr(), "a non-bar write must close the row first");
    }

    #[test]
    fn dropping_the_reader_ends_the_open_bar_row() {
        let payload = vec![7u8; 512];
        let _alone = InFlight::new();
        {
            let mut reader = ProgressReader::new(payload.as_slice(), payload.len() as u64);
            reader.draw();
            assert!(*lock_stderr(), "bar row is open");
        }
        assert!(!*lock_stderr(), "drop must close the row");
    }
}

#[cfg(test)]
mod retry_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn only_rate_limit_timeout_and_server_errors_are_retried() {
        for status in [408, 429, 500, 502, 503, 504] {
            assert!(status_is_transient(status), "{status} must be retried");
        }
        for status in [400, 401, 403, 404, 410, 451, 200, 301] {
            assert!(!status_is_transient(status), "{status} must be fatal");
        }
    }

    #[test]
    fn retry_after_reads_delay_seconds() {
        assert_eq!(parse_retry_after("120"), Some(Duration::from_secs(120)));
        assert_eq!(parse_retry_after("  7 "), Some(Duration::from_secs(7)));
        assert_eq!(parse_retry_after("0"), Some(Duration::ZERO));
    }

    #[test]
    fn retry_after_rejects_what_it_cannot_parse() {
        for raw in ["soon", "", "-5", "Sun, 06 Nov 1994 08:49:37 GMT"] {
            assert_eq!(parse_retry_after(raw), None, "{raw:?} must not parse");
        }
    }

    #[test]
    fn dns_failures_retry_less_than_the_other_network_ones() {
        for err in [
            ureq::Error::ConnectionFailed,
            ureq::Error::Timeout(ureq::Timeout::Connect),
            ureq::Error::Io(io::Error::from(io::ErrorKind::UnexpectedEof)),
        ] {
            assert_eq!(ureq_error_attempts(&err), MAX_DOWNLOAD_ATTEMPTS, "{err}");
        }
        assert_eq!(
            ureq_error_attempts(&ureq::Error::HostNotFound),
            DNS_MAX_ATTEMPTS
        );
        for err in [
            ureq::Error::TooManyRedirects,
            ureq::Error::RedirectFailed,
            ureq::Error::BadUri("nonsense".to_string()),
        ] {
            assert_eq!(ureq_error_attempts(&err), 1, "{err} must be fatal");
        }
    }

    /// `io::copy` cannot tell a stalled socket from a failing disk on its own,
    /// and only the first is worth re-GETting gigabytes for (grok P2 on #761).
    #[test]
    fn a_local_write_failure_is_never_retried() {
        let interrupted = stream_failure(model_download_error("download x".to_string()), true);
        assert_eq!(interrupted.max_attempts, MAX_DOWNLOAD_ATTEMPTS);
        assert_eq!(interrupted.reason, "download interrupted");

        let disk = stream_failure(model_download_error("download x".to_string()), false);
        assert_eq!(disk.max_attempts, 1);
        assert_eq!(disk.reason, "cache write failed");

        let mismatch = stream_failure(
            anyhow::Error::new(CodedError {
                code: ErrorCode::CacheCorrupt,
                message: "sha256 mismatch".to_string(),
            }),
            false,
        );
        assert_eq!(mismatch.max_attempts, 1);
        assert_eq!(mismatch.reason, "hash mismatch");
    }

    #[test]
    fn backoff_grows_exponentially_and_stays_capped() {
        let plain = |attempt| backoff_delay(attempt, None, 0.5).as_secs_f64();
        assert!((plain(1) - 1.0).abs() < 1e-9);
        assert!((plain(2) - 2.0).abs() < 1e-9);
        assert!((plain(3) - 4.0).abs() < 1e-9);
        assert!((plain(4) - 8.0).abs() < 1e-9);
        assert!(
            plain(20) <= RETRY_MAX_DELAY.as_secs_f64(),
            "a long schedule must not run away"
        );
    }

    #[test]
    fn backoff_jitter_stays_within_a_quarter_of_the_schedule() {
        for jitter in [0.0, 0.25, 0.5, 0.75, 1.0] {
            let delay = backoff_delay(3, None, jitter).as_secs_f64();
            assert!((3.0..=5.0).contains(&delay), "{jitter} produced {delay}s");
        }
    }

    /// The workers that matter draw at the same instant, so sequential variance is
    /// not the contract — independence across threads is (#724).
    #[test]
    fn jitter_fraction_is_independent_across_simultaneous_workers() {
        const THREADS: usize = 4;
        const DRAWS: usize = 8;

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(THREADS));
        let workers: Vec<_> = (0..THREADS)
            .map(|_| {
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    (0..DRAWS).map(|_| jitter_fraction()).collect::<Vec<f64>>()
                })
            })
            .collect();
        let samples: Vec<f64> = workers
            .into_iter()
            .flat_map(|w| w.join().expect("jitter worker panicked"))
            .collect();

        for j in &samples {
            assert!((0.0..1.0).contains(j), "jitter {j} escaped [0, 1)");
        }
        let distinct: std::collections::HashSet<u64> =
            samples.iter().map(|j| j.to_bits()).collect();
        assert_eq!(
            distinct.len(),
            THREADS * DRAWS,
            "64-bit draws must not repeat; a shared clock is what makes them collide"
        );
        let spread = samples.iter().cloned().fold(f64::MIN, f64::max)
            - samples.iter().cloned().fold(f64::MAX, f64::min);
        assert!(spread > 0.001, "jitter spread {spread} is not usable");
    }

    #[test]
    fn retry_after_overrides_the_schedule_but_is_clamped() {
        assert_eq!(
            backoff_delay(1, Some(Duration::from_secs(12)), 0.5),
            Duration::from_secs(12)
        );
        assert_eq!(
            backoff_delay(1, Some(Duration::from_secs(3_600)), 0.5),
            RETRY_AFTER_MAX,
            "an hour-long Retry-After is clamped, not honoured"
        );
        assert_eq!(
            backoff_delay(4, Some(Duration::ZERO), 0.5),
            RETRY_BASE_DELAY,
            "Retry-After: 0 must not become a hot loop"
        );
    }

    /// Serves `responses` in order, one per connection, and reports how many
    /// requests it answered. Each response must close the connection.
    fn stub_server(responses: Vec<Vec<u8>>) -> (String, std::thread::JoinHandle<usize>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub server");
        let base = format!("http://{}", listener.local_addr().expect("stub addr"));
        let handle = std::thread::spawn(move || {
            let mut served = 0;
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut request = Vec::new();
                let mut buf = [0u8; 512];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                if stream.write_all(&response).is_err() {
                    break;
                }
                let _ = stream.flush();
                served += 1;
            }
            served
        });
        (base, handle)
    }

    fn ok_response(body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    fn header_only_response(head: &str) -> Vec<u8> {
        format!("{head}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()
    }

    struct TempCache(PathBuf);

    impl TempCache {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "kesha-retry-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            fs::create_dir_all(&dir).expect("create temp cache");
            Self(dir)
        }
    }

    impl Drop for TempCache {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn model_file(rel_path: &'static str, url: String, body: &[u8]) -> ModelFile {
        use sha2::{Digest, Sha256};
        let sha = format!("{:x}", Sha256::digest(body));
        ModelFile {
            rel_path,
            url: Box::leak(url.into_boxed_str()),
            sha256: Box::leak(sha.into_boxed_str()),
        }
    }

    #[test]
    fn a_rate_limited_download_retries_and_then_verifies() {
        let body = b"kesha model bytes".to_vec();
        let (base, server) = stub_server(vec![
            header_only_response("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0"),
            header_only_response("HTTP/1.1 302 Found\r\nLocation: /payload.bin"),
            ok_response(&body),
        ]);
        let cache = TempCache::new("429");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            &body,
        );

        download_verified(&cache.0, &file, false).expect("429 then success must install");

        assert_eq!(
            fs::read(cache.0.join(file.rel_path)).expect("payload written"),
            body
        );
        assert_eq!(
            server.join().expect("stub server"),
            3,
            "one 429, one redirect hop, one delivery"
        );
    }

    #[test]
    fn a_missing_artifact_fails_on_the_first_attempt() {
        let (base, server) = stub_server(vec![header_only_response("HTTP/1.1 404 Not Found")]);
        let cache = TempCache::new("404");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            b"unused",
        );

        let err = download_verified(&cache.0, &file, false).expect_err("404 must fail");

        assert_eq!(code_of(&err), ErrorCode::ModelDownload);
        let rendered = format!("{err:#}");
        assert!(rendered.contains("HTTP 404"), "{rendered}");
        assert!(rendered.contains("after 1 attempt"), "{rendered}");
        assert_eq!(server.join().expect("stub server"), 1, "404 never retries");
    }

    /// One file's fatal failure used to short-circuit rayon and could cancel a
    /// sibling before it ever ran. Every file now gets its own attempt (#724).
    #[test]
    fn a_failing_file_does_not_cancel_its_siblings() {
        let body = b"sibling bytes".to_vec();
        let (good_base, good) = stub_server(vec![ok_response(&body)]);
        let (bad_base, bad) = stub_server(vec![header_only_response("HTTP/1.1 404 Not Found")]);
        let cache = TempCache::new("sibling");
        let ok_file = model_file(
            "models/retry/good.bin",
            format!("{good_base}/good.bin"),
            &body,
        );
        let bad_file = model_file("models/retry/bad.bin", format!("{bad_base}/bad.bin"), b"x");

        let err = parallel_download(&cache.0, &[&bad_file, &ok_file], false)
            .expect_err("the 404 still fails the install");

        assert_eq!(code_of(&err), ErrorCode::ModelDownload);
        assert_eq!(
            fs::read(cache.0.join(ok_file.rel_path)).expect("sibling installed"),
            body
        );
        assert_eq!(good.join().expect("good server"), 1);
        assert_eq!(bad.join().expect("bad server"), 1);
    }

    #[test]
    fn every_exhausted_file_is_named_in_the_install_failure() {
        let (first_base, first) = stub_server(vec![header_only_response("HTTP/1.1 404 Not Found")]);
        let (second_base, second) =
            stub_server(vec![header_only_response("HTTP/1.1 403 Forbidden")]);
        let cache = TempCache::new("aggregate");
        let a = model_file("models/retry/a.bin", format!("{first_base}/a.bin"), b"a");
        let b = model_file("models/retry/b.bin", format!("{second_base}/b.bin"), b"b");

        let err = parallel_download(&cache.0, &[&a, &b], false).expect_err("both files fail");

        let rendered = format!("{err:#}");
        assert!(
            rendered.contains("2 of 2 model downloads failed"),
            "{rendered}"
        );
        assert!(rendered.contains(a.rel_path), "{rendered}");
        assert!(rendered.contains(b.rel_path), "{rendered}");
        assert_eq!(first.join().expect("first server"), 1);
        assert_eq!(second.join().expect("second server"), 1);
    }

    /// Retry wraps the request only. Bytes that do not match the pinned hash are
    /// rejected on the first attempt — retrying them would be a way around
    /// verification (#174).
    #[test]
    fn a_hash_mismatch_is_never_retried() {
        let (base, server) = stub_server(vec![ok_response(b"wrong bytes")]);
        let cache = TempCache::new("hash");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            b"expected bytes",
        );

        let err = download_verified(&cache.0, &file, false).expect_err("bad hash must fail");

        assert_eq!(code_of(&err), ErrorCode::CacheCorrupt);
        assert_eq!(server.join().expect("stub server"), 1);
        assert!(
            !cache.0.join(file.rel_path).exists(),
            "unverified bytes never land at the target"
        );
    }

    #[test]
    fn a_truncated_stream_is_re_requested_and_then_verifies() {
        let body = b"kesha model bytes".to_vec();
        let mut truncated =
            b"HTTP/1.1 200 OK\r\nContent-Length: 64\r\nConnection: close\r\n\r\n".to_vec();
        truncated.extend_from_slice(&body[..4]);
        let (base, server) = stub_server(vec![truncated, ok_response(&body)]);
        let cache = TempCache::new("truncated");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            &body,
        );

        download_verified(&cache.0, &file, false).expect("a short read must be retried");

        assert_eq!(
            fs::read(cache.0.join(file.rel_path)).expect("payload written"),
            body
        );
        assert_eq!(server.join().expect("stub server"), 2);
    }

    /// A staging path that cannot be opened stands in for any permanent local
    /// I/O failure: one GET, never five (grok P2 on #761).
    #[test]
    fn a_blocked_cache_write_gives_up_after_one_request() {
        let body = b"kesha model bytes".to_vec();
        let (base, server) = stub_server(vec![ok_response(&body)]);
        let cache = TempCache::new("blocked");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            &body,
        );
        let target = cache.0.join(file.rel_path);
        fs::create_dir_all(target.parent().expect("target parent")).expect("create model dir");
        fs::create_dir(staging_path(&target)).expect("occupy the staging path");

        let err = download_verified(&cache.0, &file, false).expect_err("staging is blocked");

        let rendered = format!("{err:#}");
        assert!(rendered.contains("after 1 attempt"), "{rendered}");
        assert_eq!(server.join().expect("stub server"), 1);
    }

    #[test]
    fn an_exhausted_budget_names_every_attempt_it_spent() {
        let rate_limited =
            || header_only_response("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0");
        let (base, server) = stub_server(
            (0..MAX_DOWNLOAD_ATTEMPTS)
                .map(|_| rate_limited())
                .collect::<Vec<_>>(),
        );
        let cache = TempCache::new("exhausted");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            b"never served",
        );

        let err = download_verified(&cache.0, &file, false).expect_err("every attempt 429s");

        let rendered = format!("{err:#}");
        assert!(
            rendered.contains(&format!("after {MAX_DOWNLOAD_ATTEMPTS} attempt")),
            "{rendered}"
        );
        assert_eq!(
            server.join().expect("stub server"),
            MAX_DOWNLOAD_ATTEMPTS as usize
        );
    }
}
