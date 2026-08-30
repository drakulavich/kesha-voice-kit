#[cfg(any(feature = "tts", test))]
use anyhow::Result;

#[cfg(feature = "tts")]
use crate::coded_bail;
#[cfg(feature = "tts")]
use crate::errors::ErrorCode;

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
pub(super) const ASR_FILES: &[ModelFile] = &[
    ModelFile {
        rel_path: "models/parakeet-tdt-v3/encoder-model.onnx",
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/encoder-model.onnx",
        sha256: "98a74b21b4cc0017c1e7030319a4a96f4a9506e50f0708f3a516d02a77c96bb1",
    },
    ModelFile {
        rel_path: "models/parakeet-tdt-v3/encoder-model.onnx.data",
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/encoder-model.onnx.data",
        sha256: "9a22d372c51455c34f13405da2520baefb7125bd16981397561423ed32d24f36",
    },
    ModelFile {
        rel_path: "models/parakeet-tdt-v3/decoder_joint-model.onnx",
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/decoder_joint-model.onnx",
        sha256: "e978ddf6688527182c10fde2eb4b83068421648985ef23f7a86be732be8706c1",
    },
    ModelFile {
        rel_path: "models/parakeet-tdt-v3/nemo128.onnx",
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/nemo128.onnx",
        sha256: "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f",
    },
    ModelFile {
        rel_path: "models/parakeet-tdt-v3/vocab.txt",
        url: "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce/vocab.txt",
        sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
    },
];

/// Silero VAD v5 ONNX (snakers4/silero-vad). Single 2.3 MB file; not cached
/// on HuggingFace so we pull from the GitHub raw URL.
///
/// NOTE: `apply_mirror` only rewrites `huggingface.co` URLs, so this one
/// passes through unchanged even with `KESHA_MODEL_MIRROR` set. Operators
/// who need a mirrored VAD can pre-stage the file under the cache dir.
// Pinned to a commit, not the `v6.2.1` tag, so upstream can't move it under us (#1099)
pub(super) const VAD_FILES: &[ModelFile] = &[ModelFile {
    rel_path: "models/silero-vad/silero_vad.onnx",
    url: "https://github.com/snakers4/silero-vad/raw/7e30209a3e901f9842f81b225f3e93d8199902b1/src/silero_vad/data/silero_vad.onnx",
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
pub(super) const DIARIZE_FILES: &[ModelFile] = &[
    ModelFile {
        rel_path: "models/diarize/SortformerNvidiaLow_v2.mlpackage/Manifest.json",
        url: "https://huggingface.co/FluidInference/diar-streaming-sortformer-coreml/resolve/ae9a27ab45dc0aa3abede7d2d6bad2b7a69aa6d1/SortformerNvidiaLow_v2.mlpackage/Manifest.json",
        sha256: "48005880c54b1b7f5b0ae81a33fead3a36e3e2a773eb3fbf1f61ebe08515bba6",
    },
    ModelFile {
        rel_path: "models/diarize/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/model.mlmodel",
        url: "https://huggingface.co/FluidInference/diar-streaming-sortformer-coreml/resolve/ae9a27ab45dc0aa3abede7d2d6bad2b7a69aa6d1/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/model.mlmodel",
        sha256: "478267113144c0292a3db41fb22148b6c052d2399ae3dab0ca20cd3687880358",
    },
    ModelFile {
        rel_path: "models/diarize/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/weights/0-weight.bin",
        url: "https://huggingface.co/FluidInference/diar-streaming-sortformer-coreml/resolve/ae9a27ab45dc0aa3abede7d2d6bad2b7a69aa6d1/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/weights/0-weight.bin",
        sha256: "ad40d62ccd7a0943d2cd9cc8eeee7f27116e58cf6532ab43196b34142fc86583",
    },
    ModelFile {
        rel_path: "models/diarize/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/weights/1-weight.bin",
        url: "https://huggingface.co/FluidInference/diar-streaming-sortformer-coreml/resolve/ae9a27ab45dc0aa3abede7d2d6bad2b7a69aa6d1/SortformerNvidiaLow_v2.mlpackage/Data/com.apple.CoreML/weights/1-weight.bin",
        sha256: "e8ebd6767429fd224671b79ad2a3e3cd8bd34f83373ff84fca2f5387414191a0",
    },
];

/// SpeechBrain ECAPA-TDNN VoxLingua107 lang-id ONNX. Hashes pinned from
/// `huggingface.co/drakulavich/SpeechBrain-coreml`.
pub(super) const LANG_ID_FILES: &[ModelFile] = &[
    ModelFile {
        rel_path: "models/lang-id-ecapa/lang-id-ecapa.onnx",
        url: "https://huggingface.co/drakulavich/SpeechBrain-coreml/resolve/41e60dea31b80ea5d4f9d9d9e818501ea184e568/lang-id-ecapa.onnx",
        sha256: "4af3b6a5b4165f78715fe363ed6b7650d5f77ed0a6e2966c500eadc46252a288",
    },
    ModelFile {
        rel_path: "models/lang-id-ecapa/lang-id-ecapa.onnx.data",
        url: "https://huggingface.co/drakulavich/SpeechBrain-coreml/resolve/41e60dea31b80ea5d4f9d9d9e818501ea184e568/lang-id-ecapa.onnx.data",
        sha256: "78fefd776536f4a686bcf705dedb8e9a497b924a2107a949b42a24b2b90174a2",
    },
    ModelFile {
        rel_path: "models/lang-id-ecapa/labels.json",
        url: "https://huggingface.co/drakulavich/SpeechBrain-coreml/resolve/41e60dea31b80ea5d4f9d9d9e818501ea184e568/labels.json",
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
///
/// A GitHub release asset has no immutable URL form to pin, so the sha256 pinned below is
/// the only guard against a re-upload under the same tag (#1099).
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
                "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/",
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
        url: "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/0e2cf759874353bcc0cd153d4b6886a27f61e4a7/encoder_model.onnx",
        sha256: "1ac7aca11845527873f9e0e870fbe1e3c3ac2cb009d8852230332d10541aab04",
    },
    ModelFile {
        rel_path: "models/g2p/byt5-tiny/decoder_model.onnx",
        url: "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/0e2cf759874353bcc0cd153d4b6886a27f61e4a7/decoder_model.onnx",
        sha256: "de32477aae14e254d4a7dee4b2c324fb39f93a0dc254181c5bfdd8fc67492919",
    },
    ModelFile {
        rel_path: "models/g2p/byt5-tiny/decoder_with_past_model.onnx",
        url: "https://huggingface.co/klebster/g2p_multilingual_byT5_tiny_onnx/resolve/0e2cf759874353bcc0cd153d4b6886a27f61e4a7/decoder_with_past_model.onnx",
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
pub(super) fn multilang_voice(lang: &str) -> Option<ModelFile> {
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
/// An English-only install skips the ~100 MB CharsiuG2P pack and a Russian-only
/// install skips Kokoro entirely. Consumed by [`download_tts`].
#[cfg(all(
    feature = "tts",
    not(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))
))]
pub(super) fn kokoro_manifest_for(langs: &[&str]) -> Vec<ModelFile> {
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
                "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/voices/",
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
pub(super) const ANE_KOKORO_VOICES: &[ModelFile] = &[
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
                "https://huggingface.co/FluidInference/kokoro-82m-coreml/resolve/c94edcb4b671856795458645cd389c0a9184e8bb/",
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
pub(super) const ANE_EN_FILES: &[ModelFile] = &[
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
                "https://huggingface.co/FluidInference/kokoro-82m-coreml/resolve/c94edcb4b671856795458645cd389c0a9184e8bb/",
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
pub(super) const KOKORO_G2P_FILES: &[ModelFile] = &[
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
                "https://huggingface.co/FluidInference/kokoro-82m-coreml/resolve/c94edcb4b671856795458645cd389c0a9184e8bb/",
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
/// way. It is staged anyway because `ensureModels` checks the whole required set
/// before it will load anything: omit the bundle and Mandarin stops working
/// entirely under offline mode. Staging an empty directory would satisfy that
/// check and then be purged by the next `kesha install`, which repairs
/// `.mlmodelc` bundles missing `model.mil` (#709).
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub(super) const ANE_ZH_FILES: &[ModelFile] = &[
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
                "https://huggingface.co/FluidInference/kokoro-82m-coreml/resolve/c94edcb4b671856795458645cd389c0a9184e8bb/",
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
pub(super) const ANE_ZH_G2P_ASSETS: &[ModelFile] = &[
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
pub(super) fn ane_voice_lang(rel_path: &str) -> Option<&'static str> {
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
pub(super) fn ane_voices_for(langs: &[&str]) -> Vec<&'static ModelFile> {
    ANE_KOKORO_VOICES
        .iter()
        .filter(|f| ane_voice_lang(f.rel_path).is_some_and(|l| langs.contains(&l)))
        .collect()
}

/// Vosk-TTS multi-speaker Russian model, mirrored to HF at
/// `drakulavich/vosk-tts-ru-0.9-multi` (upstream ships a zip on alphacephei.com;
/// the mirror is what the pinned hashes below are taken against). Replaced
/// Piper-ru, which needed espeak-ng as a system dependency.
/// SHA-256 pins computed from the HF mirror — see CLAUDE.md MODEL HASHES
/// ARE PINNED rule.
#[cfg(feature = "tts")]
pub const VOSK_RU_FILES: &[ModelFile] = &[
    ModelFile {
        rel_path: "models/vosk-ru/model.onnx",
        url: "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/37c7b45a32b3fa62f3a2bbce89677080dcd2107f/model.onnx",
        sha256: "0fa5a36b22a8bf7fe7179a3882c6371d2c01e5317019e717516f892d329c24b9",
    },
    ModelFile {
        rel_path: "models/vosk-ru/dictionary",
        url: "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/37c7b45a32b3fa62f3a2bbce89677080dcd2107f/dictionary",
        sha256: "2939e72c170bb41ac8e256828cca1c5fac4db1e36717f9f53fde843b00a220ba",
    },
    ModelFile {
        rel_path: "models/vosk-ru/config.json",
        url: "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/37c7b45a32b3fa62f3a2bbce89677080dcd2107f/config.json",
        sha256: "e155fb266a730e1858a2420442b465acf08a3236dffad7d1a507bf155b213d50",
    },
    ModelFile {
        rel_path: "models/vosk-ru/bert/model.onnx",
        url:
            "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/37c7b45a32b3fa62f3a2bbce89677080dcd2107f/bert/model.onnx",
        sha256: "2e2f1740eaae5e29c2b4844625cbb01ff644b2b5fb0560bd34374c35d8a092c1",
    },
    ModelFile {
        rel_path: "models/vosk-ru/bert/vocab.txt",
        url: "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/37c7b45a32b3fa62f3a2bbce89677080dcd2107f/bert/vocab.txt",
        sha256: "bbe5063cc3d7a314effd90e9c5099cf493b81f2b9552c155264e16eeab074237",
    },
    // removed: README.md (drakulavich/vosk-tts-ru-0.9-multi) — not opened at
    // runtime; pinning its SHA forced a manifest bump on every upstream
    // doc copy-edit. CharsiuG2P entries (3 byt5-tiny ONNX) were also
    // removed in PR #214 — Russian uses vosk-tts internal G2P now.
];

#[cfg(test)]
mod manifest_tests {
    use super::*;
    use crate::models::download::{staging_path, verify_sha256, write_verified};
    use std::fs;
    use std::io;
    use std::path::PathBuf;

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
        let plan: serde_json::Value =
            serde_json::from_str(include_str!("../../../model-plan.json"))
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

    /// Reads the literal `VAR="value"` assignment line for `var`, ignoring comments —
    /// `script.contains(needle)` would pass on a decoy value reassigned in code while the
    /// real one sits in a `# pinned: ...` comment. Requires exactly one such line rather than
    /// taking the first: bash itself resolves a shadowed reassignment to the *last* one, so
    /// "first" matching a decoy and "last" being real would still stage the wrong pin silently.
    fn shell_assignment<'a>(script: &'a str, var: &str) -> &'a str {
        let prefix = format!("{var}=\"");
        let matches: Vec<&str> = script
            .lines()
            .filter_map(|line| line.trim().strip_prefix(prefix.as_str()))
            .filter_map(|rest| rest.strip_suffix('"'))
            .collect();
        assert_eq!(
            matches.len(),
            1,
            "expected exactly one `{prefix}...\"` assignment in download-vad.sh, found {}",
            matches.len()
        );
        matches[0]
    }

    /// The CI staging script carries its own copy of the URL and hash, because a
    /// shell script cannot read a Rust const. Two copies of a pin drift, and the
    /// drift is invisible: CI would keep staging the old weights and the span
    /// goldens would keep passing against a model the engine no longer uses.
    #[test]
    fn ci_download_script_matches_the_pinned_vad_manifest() {
        let script = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("ci/download-vad.sh"),
        )
        .expect("read rust/ci/download-vad.sh");
        let f = &VAD_FILES[0];
        assert_eq!(
            shell_assignment(&script, "URL"),
            f.url,
            "download-vad.sh's URL= assignment does not match the pinned URL"
        );
        assert_eq!(
            shell_assignment(&script, "SHA256"),
            f.sha256,
            "download-vad.sh's SHA256= assignment does not match the pinned sha256"
        );
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
        write_verified(&mut &b"hello world"[..], &target, "ok.bin", HELLO_SHA, None)?;
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
        write_verified(
            &mut &b"hello world"[..],
            &target,
            "replace.bin",
            HELLO_SHA,
            None,
        )?;
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
            None,
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
            None,
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

    /// Every `huggingface.co` URL must resolve a 40-hex commit, never a mutable
    /// ref like `main` — upstream republishing under `main` silently invalidates
    /// every hash pinned against it in one shot (#1093).
    fn assert_pins_immutable_revision(f: &ModelFile) {
        let Some(rest) = f.url.strip_prefix("https://huggingface.co/") else {
            return;
        };
        let Some((_, after_resolve)) = rest.split_once("/resolve/") else {
            panic!("{f:?} huggingface.co url has no /resolve/<ref>/ segment");
        };
        let ref_segment = after_resolve.split('/').next().unwrap_or("");
        assert!(
            ref_segment.len() == 40 && ref_segment.chars().all(|c| c.is_ascii_hexdigit()),
            "{f:?} pins mutable ref {ref_segment:?} instead of a 40-hex commit — an \
             upstream republish under it breaks every hash already pinned against it (#1093)"
        );
    }

    #[test]
    fn every_huggingface_url_pins_an_immutable_revision() {
        #[cfg(not(feature = "coreml"))]
        for f in ASR_FILES {
            assert_pins_immutable_revision(f);
        }
        for f in DIARIZE_FILES {
            assert_pins_immutable_revision(f);
        }
        for f in LANG_ID_FILES {
            assert_pins_immutable_revision(f);
        }
        #[cfg(feature = "tts")]
        for f in VOSK_RU_FILES {
            assert_pins_immutable_revision(f);
        }
        #[cfg(all(
            feature = "tts",
            not(all(
                feature = "system_kokoro",
                target_os = "macos",
                target_arch = "aarch64"
            ))
        ))]
        {
            for f in G2P_CHARSIU_FILES {
                assert_pins_immutable_revision(f);
            }
            assert_pins_immutable_revision(&KOKORO_EN_VOICE);
            for lang in ["es", "fr", "it", "pt"] {
                assert_pins_immutable_revision(
                    &multilang_voice(lang).expect("known Kokoro language"),
                );
            }
        }
        #[cfg(all(
            feature = "system_kokoro",
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        {
            for f in ANE_KOKORO_VOICES {
                assert_pins_immutable_revision(f);
            }
            for manifest in [
                ANE_EN_FILES,
                ANE_ZH_FILES,
                ANE_ZH_G2P_ASSETS,
                KOKORO_G2P_FILES,
            ] {
                for f in manifest {
                    assert_pins_immutable_revision(f);
                }
            }
        }
    }
}

#[cfg(all(test, feature = "tts"))]
mod tts_tests {
    use super::*;
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    use std::path::Path;

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
                "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/37c7b45a32b3fa62f3a2bbce89677080dcd2107f/"
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
                        "https://huggingface.co/FluidInference/kokoro-82m-coreml/resolve/c94edcb4b671856795458645cd389c0a9184e8bb/"
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
}
