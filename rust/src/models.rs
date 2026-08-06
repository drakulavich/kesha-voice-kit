use anyhow::{Context, Result};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
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
/// FluidAudio 0.14.7's `KokoroAneManager` resolves `<voice>.bin` LOCAL-FIRST
/// from its own cache (`~/.cache/fluidaudio/Models/kokoro-82m-coreml/ANE/`)
/// before any download. The ANE bundle only ships `af_heart`, so `am_michael`
/// (kesha's male brand default) and the rest of the advertised Kokoro catalog
/// 404 from the bundle. These packs are 510×256 f32 `.bin` — byte-identical to
/// the standard onnx-community Kokoro packs kesha used on the ONNX path — so we
/// download them from onnx-community and stage them into the ANE cache at install
/// time (see [`stage_ane_kokoro_voices`]). `af_heart` is intentionally EXCLUDED:
/// FluidAudio 0.14.7 auto-downloads its own `af_heart.bin` into the ANE dir on
/// first synth, and staging our own copy would risk an SHA mismatch overwriting
/// FluidAudio's authoritative pack. Kesha only stages the voices the ANE bundle
/// LACKS (`am_michael` and the rest of the advertised catalog).
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
    // `af_heart` intentionally excluded: FluidAudio 0.14.7 ships/auto-downloads
    // its own `af_heart.bin` into this ANE dir. Staging our own copy would risk
    // overwriting FluidAudio's authoritative pack if the upstream hash ever
    // drifted.
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
    // zh (Mandarin) voices are NOT staged here — the FluidAudio 0.14.8 `.mandarin`
    // KokoroAne variant fetches its own `ANE-zh/` bundle (nested `voices/<id>.bin`)
    // on first synth, and those ids are numbered (e.g. zm_050), not the
    // onnx-community names. A flat kesha-staged pack would be unused. See
    // `tts::fluid_kokoro` zh-* voices.
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

/// FluidAudio's Kokoro ANE voice-pack cache directory. NOT under
/// `KESHA_CACHE_DIR` — FluidAudio 0.14.7 owns this path and reads voice packs
/// from here local-first. We pre-stage onnx-community packs here so the full
/// advertised Kokoro catalog (and the male `am_michael` default) resolve
/// without a 404 against the ANE bundle.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub fn fluidaudio_ane_kokoro_dir() -> PathBuf {
    dirs::home_dir()
        .expect("cannot determine home directory")
        .join(".cache")
        .join("fluidaudio")
        .join("Models")
        .join("kokoro-82m-coreml")
        .join("ANE")
}

/// FluidAudio's ASR bundle directory. Not under `KESHA_CACHE_DIR` — FluidAudio
/// downloads and reads it here, and `AsrModels` resolves it as
/// `<ApplicationSupport>/FluidAudio/Models/<repo.folderName>`, where `folderName`
/// **strips** the `-coreml` suffix from `parakeet-tdt-0.6b-v3-coreml`. Keying on
/// the `…-v3-coreml` sibling that also exists on disk would report a healthy
/// install as broken (#684).
#[cfg(feature = "coreml")]
pub fn fluidaudio_asr_dir() -> PathBuf {
    dirs::home_dir()
        .expect("cannot determine home directory")
        .join("Library")
        .join("Application Support")
        .join("FluidAudio")
        .join("Models")
        .join("parakeet-tdt-0.6b-v3")
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
    let names: Vec<&str> = failures.iter().map(|(path, _)| *path).collect();
    let summary = format!(
        "{} of {} model downloads failed: {}",
        failures.len(),
        manifest.len(),
        names.join(", ")
    );
    // The returned chain can only carry one root cause, so the others are
    // reported here rather than dropped.
    for (path, err) in failures.iter().skip(1) {
        with_stderr(|| eprintln!("FAIL {path}: {err:#}"));
    }
    let first = failures.remove(0).1;
    if names.len() == 1 {
        return Err(first);
    }
    Err(first.context(summary))
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

    fn staging_path(target: &std::path::Path) -> PathBuf {
        let mut name = target.file_name().map(std::ffi::OsString::from).unwrap();
        name.push(format!(".part.{}", std::process::id()));
        target.with_file_name(name)
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
        // pack, or `--voice <lang>-<x>` resolves then 404s on the ANE bundle —
        // EXCEPT `af_heart`, which FluidAudio 0.14.7 auto-provides into the
        // same ANE dir on first synth, so kesha must NOT stage its own copy.
        for v in crate::tts::fluid_kokoro::available_voice_ids() {
            let bare = v
                .split_once('-')
                .map(|(_, bare)| bare)
                .unwrap_or(v.as_str());
            // af_heart: FluidAudio auto-provides it into the English ANE dir.
            // zh-*: the Mandarin KokoroAne variant fetches its own ANE-zh bundle
            // (nested voices/) on first synth, so kesha does not stage it (#492).
            // Both are first-synth FluidAudio-owned downloads — the SAME class as
            // the English Kokoro model graph + af_heart, which `download_tts`
            // deliberately leaves to FluidAudio (see the `kokoro_manifest()` is
            // empty note in `download_tts`). Pre-staging zh here is impossible
            // (FluidAudio owns the nested ANE-zh layout) and would be inconsistent
            // with how the en model graph already loads.
            if bare == "af_heart" || v.starts_with("zh-") {
                continue;
            }
            assert!(
                names.contains(format!("{bare}.bin").as_str()),
                "advertised voice {v} has no staged ANE pack"
            );
        }
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

    // On the FluidAudio ANE Kokoro path the model graph + `af_heart`
    // auto-download into FluidAudio's own cache on first synth. Stage only the
    // requested en/es/it/… catalog — including the male `am_michael` default —
    // into FluidAudio's ANE voice-pack cache so they resolve local-first
    // instead of 404ing against the ANE bundle (#475). Vosk-RU still lands
    // under KESHA_CACHE_DIR.
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    {
        if langs.contains(&"ru") {
            download_manifest(VOSK_RU_FILES, no_cache)?;
        }
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
            Err(fail) if fail.transient && attempt < MAX_DOWNLOAD_ATTEMPTS => {
                let delay = backoff_delay(attempt, fail.retry_after, jitter_fraction());
                with_stderr(|| {
                    eprintln!(
                        "retrying {} in {:.1}s (attempt {}/{}, {})",
                        f.rel_path,
                        delay.as_secs_f64(),
                        attempt + 1,
                        MAX_DOWNLOAD_ATTEMPTS,
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
const RETRY_BASE_DELAY: Duration = Duration::from_secs(1);
const RETRY_MAX_DELAY: Duration = Duration::from_secs(30);
/// A server asking for more than this is asking for longer than a user will
/// wait at an install prompt; clamp rather than honour it literally.
const RETRY_AFTER_MAX: Duration = Duration::from_secs(60);

/// One request+stream attempt that failed. `transient` decides whether the
/// retry loop gets another go — a sha256 mismatch never does (#174).
struct AttemptFailure {
    err: anyhow::Error,
    reason: String,
    retry_after: Option<Duration>,
    transient: bool,
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
    let response = match ureq::get(url)
        .config()
        .http_status_as_error(false)
        .build()
        .call()
    {
        Ok(response) => response,
        Err(e) => {
            let transient = ureq_error_is_transient(&e);
            return Err(AttemptFailure {
                reason: e.to_string(),
                err: model_download_error(format!("GET {url} ({}): {e}", f.rel_path)),
                retry_after: None,
                transient,
            });
        }
    };

    let status = response.status().as_u16();
    if !response.status().is_success() {
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| parse_retry_after(v, now_epoch_secs()));
        return Err(AttemptFailure {
            err: model_download_error(format!("GET {url} ({}): HTTP {status}", f.rel_path)),
            reason: format!("HTTP {status}"),
            retry_after,
            transient: status_is_transient(status),
        });
    }

    // Not the raw header — that one reports the compressed size when decompression is active.
    let total = response.body().content_length().unwrap_or(0);
    let mut reader = response.into_body().into_reader();
    let streamed = if total >= PROGRESS_MIN_BYTES && io::IsTerminal::is_terminal(&io::stderr()) {
        let mut reader = ProgressReader::new(&mut reader, total);
        write_verified(&mut reader, target, f.rel_path, f.sha256)
    } else {
        write_verified(&mut reader, target, f.rel_path, f.sha256)
    };
    streamed.map_err(|err| {
        // A truncated stream deserves another go; a sha mismatch means the host
        // is not serving the pinned bytes, and no amount of retrying heals that
        // (#174) — retry must never become a way around verification.
        let transient = code_of(&err) == ErrorCode::ModelDownload;
        AttemptFailure {
            reason: if transient {
                "download interrupted".to_string()
            } else {
                "hash mismatch".to_string()
            },
            err,
            retry_after: None,
            transient,
        }
    })
}

/// Statuses that a later attempt can plausibly resolve. Everything else — 403
/// from a private repo, 404 from a moved artifact — is fatal on the first try.
fn status_is_transient(status: u16) -> bool {
    status == 408 || status == 429 || (500..600).contains(&status)
}

fn ureq_error_is_transient(err: &ureq::Error) -> bool {
    matches!(
        err,
        ureq::Error::Timeout(_) | ureq::Error::Io(_) | ureq::Error::ConnectionFailed
    )
}

/// `Retry-After` per RFC 9110: delay-seconds, or an IMF-fixdate. The two
/// obsolete date formats are not accepted — a sender that uses them falls back
/// to plain exponential backoff rather than to a misparsed delay.
fn parse_retry_after(raw: &str, now_epoch_secs: i64) -> Option<Duration> {
    let raw = raw.trim();
    if let Ok(secs) = raw.parse::<u64>() {
        return Some(Duration::from_secs(secs));
    }
    let at = parse_http_date(raw)?;
    Some(Duration::from_secs(
        at.saturating_sub(now_epoch_secs).max(0) as u64,
    ))
}

const HTTP_DATE_MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// `Sun, 06 Nov 1994 08:49:37 GMT` -> unix seconds.
fn parse_http_date(raw: &str) -> Option<i64> {
    let rest = raw.strip_suffix(" GMT")?;
    let (_weekday, rest) = rest.split_once(", ")?;
    let mut parts = rest.split(' ');
    let day: i64 = parts.next()?.parse().ok()?;
    let month_name = parts.next()?;
    let month = HTTP_DATE_MONTHS.iter().position(|m| *m == month_name)? as i64 + 1;
    let year: i64 = parts.next()?.parse().ok()?;
    let mut hms = parts.next()?.splitn(3, ':');
    let hour: i64 = hms.next()?.parse().ok()?;
    let minute: i64 = hms.next()?.parse().ok()?;
    let second: i64 = hms.next()?.parse().ok()?;
    // `days_from_civil` normalises an impossible day rather than rejecting it, so
    // "31 Feb" would silently become a real date and displace the backoff.
    if parts.next().is_some()
        || !(1..=days_in_month(year, month)).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 for a proleptic-Gregorian date (Hinnant's algorithm).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Exponential backoff with ±25% jitter, or the server's own `Retry-After`
/// where it gave one. Jitter matters more than usual here: four rayon workers
/// hit the same host together, so an unjittered schedule retries them in
/// lockstep and re-triggers the rate limit that caused the backoff.
fn backoff_delay(attempt: u32, retry_after: Option<Duration>, jitter: f64) -> Duration {
    if let Some(after) = retry_after {
        return after.clamp(RETRY_BASE_DELAY, RETRY_AFTER_MAX);
    }
    let exponential = RETRY_BASE_DELAY.saturating_mul(1u32 << attempt.saturating_sub(1).min(10));
    exponential
        .min(RETRY_MAX_DELAY)
        .mul_f64(0.75 + 0.5 * jitter.clamp(0.0, 1.0))
}

fn jitter_fraction() -> f64 {
    let nanos = now_since_epoch().map(|d| d.subsec_nanos()).unwrap_or(0);
    f64::from(nanos % 1_000) / 1_000.0
}

fn now_epoch_secs() -> i64 {
    now_since_epoch().map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn now_since_epoch() -> Option<Duration> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
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
    let mut part_name = target.file_name().map(OsString::from).unwrap_or_default();
    part_name.push(format!(".part.{}", std::process::id()));
    let part = target.with_file_name(part_name);

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
    fn orphan_staging_sweep_removes_stale_keeps_fresh_and_finished() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "kesha-part-gc-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        fs::create_dir_all(dir.join("models"))?;
        let stale = dir.join("models/encoder.onnx.part.12345");
        let fresh = dir.join("models/decoder.onnx.part.999");
        let finished = dir.join("models/encoder.onnx");
        for p in [&stale, &fresh, &finished] {
            fs::write(p, b"bytes")?;
        }
        let old =
            std::time::SystemTime::now() - std::time::Duration::from_secs(STALE_STAGING_SECS + 60);
        fs::File::options()
            .write(true)
            .open(&stale)?
            .set_times(fs::FileTimes::new().set_modified(old))?;

        cleanup_orphan_staging(&dir);

        assert!(!stale.exists(), "stale staging must be swept");
        assert!(fresh.exists(), "a live installer's fresh staging survives");
        assert!(finished.exists(), "real model files are never touched");
        let _ = fs::remove_dir_all(&dir);
        Ok(())
    }

    /// `Repo.folderName` strips the `-coreml` suffix, and a `…-v3-coreml` sibling
    /// exists on disk. Keying on it would report a healthy install as missing ASR.
    #[test]
    #[cfg(feature = "coreml")]
    fn fluidaudio_asr_dir_is_the_directory_fluidaudio_loads_from() {
        let dir = fluidaudio_asr_dir();
        assert!(dir.ends_with("parakeet-tdt-0.6b-v3"), "{dir:?}");
        assert!(
            dir.to_string_lossy()
                .contains("Library/Application Support/FluidAudio/Models"),
            "{dir:?} is not FluidAudio's ASR root"
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
        assert_eq!(parse_retry_after("120", 0), Some(Duration::from_secs(120)));
        assert_eq!(parse_retry_after("  7 ", 0), Some(Duration::from_secs(7)));
        assert_eq!(parse_retry_after("0", 0), Some(Duration::ZERO));
    }

    #[test]
    fn retry_after_reads_an_http_date_relative_to_now() {
        // 1994-11-06T08:49:37Z, the RFC 9110 example date.
        let epoch = 784_111_777;
        assert_eq!(
            parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT", epoch - 30),
            Some(Duration::from_secs(30))
        );
        assert_eq!(
            parse_retry_after("Sun, 06 Nov 1994 08:49:37 GMT", epoch + 5),
            Some(Duration::ZERO),
            "a date already in the past means retry now, never a huge wait"
        );
    }

    #[test]
    fn retry_after_rejects_what_it_cannot_parse() {
        for raw in [
            "soon",
            "",
            "-5",
            "Sun, 06 Nov 1994 08:49:37",
            "Sunday, 06-Nov-94 08:49:37 GMT",
            "Sun, 06 Foo 1994 08:49:37 GMT",
            "Sun, 06 Nov 1994 25:49:37 GMT",
            "Tue, 31 Feb 1994 08:49:37 GMT",
            "Tue, 29 Feb 1900 08:49:37 GMT",
            "Thu, 31 Apr 1994 08:49:37 GMT",
        ] {
            assert_eq!(parse_retry_after(raw, 0), None, "{raw:?} must not parse");
        }
    }

    /// The century rule cuts both ways — 2000 is a leap year, 1900 is not.
    #[test]
    fn retry_after_accepts_a_real_leap_day() {
        let epoch = 951_782_400; // 2000-02-29T00:00:00Z
        assert_eq!(
            parse_retry_after("Tue, 29 Feb 2000 00:00:00 GMT", epoch - 60),
            Some(Duration::from_secs(60))
        );
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
                now_since_epoch().map(|d| d.as_nanos()).unwrap_or(0)
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
}
