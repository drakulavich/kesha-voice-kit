use anyhow::{Context, Result};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::coded_bail;
use crate::errors::{CodedContext, ErrorCode};

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
#[cfg(feature = "system_diarize")]
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

#[cfg(feature = "tts")]
pub fn kokoro_manifest() -> Vec<ModelFile> {
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    {
        return Vec::new();
    }
    #[allow(unreachable_code)]
    {
        vec![
        ModelFile {
            // The HF onnx-community variant produces unintelligible audio with
            // `af_heart` — confirmed by audio bisection, see #207. Use the
            // official kokoro-onnx project release, which uses different IO
            // tensor names (`tokens`/`audio` vs `input_ids`/`waveform`) but
            // same dtypes/shapes — handled in `kokoro::Kokoro::infer`.
            rel_path: "models/kokoro-82m/model.onnx",
            url: "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/kokoro-v1.0.onnx",
            sha256: "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
        },
        ModelFile {
            // Kesha (Кеша) is a male name — default to a male voice.
            // Switched from `af_heart` (female) in #210; per-CLAUDE.md
            // "DEFAULT TTS VOICES MUST BE MALE". Other voices download on
            // demand via explicit `--voice` after `kesha install --tts`.
            rel_path: "models/kokoro-82m/voices/am_michael.bin",
            url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_michael.bin",
            sha256: "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1",
        },
        // klebster CharsiuG2P byt5-tiny ONNX export (CC-BY 4.0).
        // Pinned hashes from #185 (see NOTICES.md for attribution).
        // These 3 files enable multilingual G2P for es/fr/it/pt voices.
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
        // Multilingual Kokoro voice packs (es/fr/it/pt). All from
        // onnx-community/Kokoro-82M-v1.0-ONNX on HuggingFace.
        // em_alex (es, male), im_nicola (it, male), pm_alex (pt, male)
        // satisfy the brand male-default rule. ff_siwis (fr, female) is
        // the sole French voice Kokoro v1.0 ships — see voices.rs comment.
        ModelFile {
            rel_path: "models/kokoro-82m/voices/em_alex.bin",
            url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/em_alex.bin",
            sha256: "27809e9eafdcbcfff90a3016c697568676531de2a2c39cee29c96c7bd6b83e95",
        },
        ModelFile {
            rel_path: "models/kokoro-82m/voices/ff_siwis.bin",
            url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/ff_siwis.bin",
            sha256: "a35f5675ad08948e326ae75fd0ea16ba5d0042e4f76b5f3d1df77d0a48c54861",
        },
        ModelFile {
            rel_path: "models/kokoro-82m/voices/im_nicola.bin",
            url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/im_nicola.bin",
            sha256: "bc578e510d52a96d6940d46f12e96d7b3df00905dbea075113226d100e6e1ab0",
        },
        ModelFile {
            rel_path: "models/kokoro-82m/voices/pm_alex.bin",
            url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/pm_alex.bin",
            sha256: "0175c753f59c54e7fd5a995bedef0c5ff2fb67e0043dd3dcb2ae74ec2acbeb2a",
        },
    ]
    }
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
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
const ANE_KOKORO_VOICES: &[ModelFile] = &[
    ModelFile {
        rel_path: "af_alloy.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_alloy.bin",
        sha256: "c4a6b876047fd7fb472edf4ebd63cfac7c3b958a7cae7c106e8f038ca6308c45",
    },
    ModelFile {
        rel_path: "af_aoede.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_aoede.bin",
        sha256: "4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361",
    },
    ModelFile {
        rel_path: "af_bella.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_bella.bin",
        sha256: "f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b",
    },
    // `af_heart` intentionally excluded: FluidAudio 0.14.7 ships/auto-downloads
    // its own `af_heart.bin` into this ANE dir. Staging our own copy would risk
    // overwriting FluidAudio's authoritative pack if the upstream hash ever
    // drifted.
    ModelFile {
        rel_path: "af_jessica.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_jessica.bin",
        sha256: "a240a5e3c15b43563d6e923bdca8ef5613a23471d9b77653694012435df23bd8",
    },
    ModelFile {
        rel_path: "af_kore.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_kore.bin",
        sha256: "9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e",
    },
    ModelFile {
        rel_path: "af_nicole.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_nicole.bin",
        sha256: "cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a",
    },
    ModelFile {
        rel_path: "af_nova.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_nova.bin",
        sha256: "18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f",
    },
    ModelFile {
        rel_path: "af_river.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_river.bin",
        sha256: "00a2bcf82b1d86e8f19902ede58c65ccf6c0e43b44b7d74fad54e5d8933c9c30",
    },
    ModelFile {
        rel_path: "af_sarah.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_sarah.bin",
        sha256: "4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a",
    },
    ModelFile {
        rel_path: "af_sky.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_sky.bin",
        sha256: "4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9",
    },
    ModelFile {
        rel_path: "am_adam.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_adam.bin",
        sha256: "162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716",
    },
    ModelFile {
        rel_path: "am_echo.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_echo.bin",
        sha256: "3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3",
    },
    ModelFile {
        rel_path: "am_eric.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_eric.bin",
        sha256: "e8b5be17edd1e3636901ce7598baafe2dc8dd8ff707a0c23bf9e461add7e2832",
    },
    ModelFile {
        rel_path: "am_fenrir.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_fenrir.bin",
        sha256: "c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43",
    },
    ModelFile {
        rel_path: "am_liam.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_liam.bin",
        sha256: "52403be32fd047c6a44517cb0bcd6b134f2a18baa73e70ef41651e0eab921ade",
    },
    ModelFile {
        rel_path: "am_michael.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_michael.bin",
        sha256: "1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1",
    },
    ModelFile {
        rel_path: "am_onyx.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_onyx.bin",
        sha256: "da5d135b424164916d75a68ffb4c2abce3d7d5ccc82dd1ee6cf447ce286145e6",
    },
    ModelFile {
        rel_path: "am_puck.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_puck.bin",
        sha256: "fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0",
    },
    ModelFile {
        rel_path: "am_santa.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_santa.bin",
        sha256: "61150cf726ab6c5ed7a99f90a304f91f5a72c00c592e89ec94e5df11c319227a",
    },
    ModelFile {
        rel_path: "bm_lewis.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/bm_lewis.bin",
        sha256: "b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97",
    },
    ModelFile {
        rel_path: "em_alex.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/em_alex.bin",
        sha256: "27809e9eafdcbcfff90a3016c697568676531de2a2c39cee29c96c7bd6b83e95",
    },
    ModelFile {
        rel_path: "ff_siwis.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/ff_siwis.bin",
        sha256: "a35f5675ad08948e326ae75fd0ea16ba5d0042e4f76b5f3d1df77d0a48c54861",
    },
    ModelFile {
        rel_path: "hm_omega.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/hm_omega.bin",
        sha256: "b02d9222d9ed00ce26b302173a862c2c93f96cc40b5c422b8d14910b9ff34137",
    },
    ModelFile {
        rel_path: "im_nicola.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/im_nicola.bin",
        sha256: "bc578e510d52a96d6940d46f12e96d7b3df00905dbea075113226d100e6e1ab0",
    },
    ModelFile {
        rel_path: "jm_kumo.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/jm_kumo.bin",
        sha256: "09e959d239724c734d65661f06f14cdabcddfd476bfaaad905a937099ae9e64f",
    },
    ModelFile {
        rel_path: "pm_alex.bin",
        url: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/pm_alex.bin",
        sha256: "0175c753f59c54e7fd5a995bedef0c5ff2fb67e0043dd3dcb2ae74ec2acbeb2a",
    },
    // re-pinned (#492): removed the flat `zm_yunjian.bin`
    // (was sha de48a00bdbf3649f07162269a2b6e0513604389bfac8a2e6c75cb34b323ad6fa).
    // zh (Mandarin) voices are NOT staged here — the FluidAudio 0.14.8 `.mandarin`
    // KokoroAne variant fetches its own `ANE-zh/` bundle (nested `voices/<id>.bin`)
    // on first synth, and those ids are numbered (e.g. zm_050), not the
    // onnx-community names. A flat kesha-staged pack would be unused. See
    // `tts::fluid_kokoro` zh-* voices.
];

/// FluidAudio's Kokoro ANE voice-pack cache directory. NOT under
/// `KESHA_CACHE_DIR` — FluidAudio 0.14.7 owns this path and reads voice packs
/// from here local-first. We pre-stage onnx-community packs here so the full
/// advertised Kokoro catalog (and the male `am_michael` default) resolve
/// without a 404 against the ANE bundle. Mirrors the existing CLAUDE.md note
/// that darwin Kokoro uses the fluidaudio cache rather than `KESHA_CACHE_DIR`.
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

/// Download + SHA-verify every advertised Kokoro voice pack directly into
/// FluidAudio's ANE cache so `KokoroAneManager.ensureVoicePack` resolves them
/// local-first (#475). Idempotent: an existing pack that already matches its
/// pinned hash short-circuits the network round-trip, identical to
/// [`download_verified`]. Runs only on the `system_kokoro` darwin path; the
/// ONNX Kokoro path keeps using `kokoro_manifest()` under `KESHA_CACHE_DIR`.
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
pub fn stage_ane_kokoro_voices(no_cache: bool) -> Result<()> {
    let ane_dir = fluidaudio_ane_kokoro_dir();
    fs::create_dir_all(&ane_dir)
        .with_context(|| format!("create FluidAudio ANE dir {}", ane_dir.display()))?;
    // `rel_path = "<voice>.bin"` + `cache = ane_dir` → flat ANE dir.
    let manifest: Vec<&ModelFile> = ANE_KOKORO_VOICES.iter().collect();
    parallel_download(&ane_dir, &manifest, no_cache)
}

/// Vosk-TTS multi-speaker Russian model, mirrored to HF at
/// `drakulavich/vosk-tts-ru-0.9-multi`. Replaces Piper-ru per
/// `docs/superpowers/specs/2026-04-27-vosk-ru-replacement-design.md`.
/// SHA-256 pins computed from the HF mirror — see CLAUDE.md MODEL HASHES
/// ARE PINNED rule.
#[cfg(feature = "tts")]
pub fn vosk_ru_manifest() -> Vec<ModelFile> {
    vec![
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
            url: "https://huggingface.co/drakulavich/vosk-tts-ru-0.9-multi/resolve/main/bert/model.onnx",
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

/// True iff `kind`'s required files are present in `dir` — callers that
/// resolved the directory themselves (e.g. from a function-supplied cache
/// root) use this instead of [`is_cached`] so the cache root parameter
/// stays single-source.
pub fn is_cached_in(kind: ModelKind, dir: &Path) -> bool {
    match kind {
        ModelKind::Asr => has_all_files(dir, ASR_FILES),
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
        #[cfg(all(
            feature = "system_kokoro",
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        {
            assert!(m.is_empty());
        }
        #[cfg(not(all(
            feature = "system_kokoro",
            target_os = "macos",
            target_arch = "aarch64"
        )))]
        {
            assert!(m.iter().any(|f| f.rel_path.ends_with("model.onnx")));
            assert!(m.iter().any(|f| f.rel_path.ends_with("am_michael.bin")));
            for f in &m {
                assert_eq!(f.sha256.len(), 64, "{:?} sha256 not 64 hex chars", f);
                assert!(f.url.starts_with("https://"), "{f:?} url not https");
            }
        }
    }

    #[test]
    fn vosk_ru_manifest_has_expected_files() {
        let m = vosk_ru_manifest();
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
        for f in &m {
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

/// Download the Sortformer `.mlpackage`. Opt-in via `kesha install --diarize`
/// (#199) — feature-gated to `system_diarize`, which build-engine.yml only
/// turns on for darwin-arm64. Non-darwin builds neither expose the flag nor
/// reach this function. 4-file manifest, ~245 MB total; goes through the
/// same hash-verify + retry path as the rest.
#[cfg(feature = "system_diarize")]
pub fn download_diarize(no_cache: bool) -> Result<()> {
    let cache = cache_dir();
    let refs: Vec<&ModelFile> = DIARIZE_FILES.iter().collect();
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
/// Single-file manifest, so `parallel_download` reduces to one HTTP round
/// trip — keeps the uniform hash-verify + retry path.
pub fn download_vad(no_cache: bool) -> Result<()> {
    let cache = cache_dir();
    let refs: Vec<&ModelFile> = VAD_FILES.iter().collect();
    parallel_download(&cache, &refs, no_cache)
}

/// Download every TTS model file: Kokoro English + Vosk Russian.
/// Each file is streamed to disk, then SHA256-verified. 4 concurrent
/// downloads (#178).
#[cfg(feature = "tts")]
pub fn download_tts(no_cache: bool) -> Result<()> {
    let cache = cache_dir();
    let mut manifest = kokoro_manifest();
    manifest.extend(vosk_ru_manifest());
    let refs: Vec<&ModelFile> = manifest.iter().collect();
    parallel_download(&cache, &refs, no_cache)?;
    // On the FluidAudio ANE Kokoro path `kokoro_manifest()` is empty (the model
    // graph + `af_heart` auto-download into FluidAudio's own cache on first
    // synth). Stage the rest of the en-* catalog — including the male
    // `am_michael` default — into FluidAudio's ANE voice-pack cache so they
    // resolve local-first instead of 404ing against the ANE bundle (#475).
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    stage_ane_kokoro_voices(no_cache)?;
    Ok(())
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
    // Include the resolved URL in the error chain (#275 D11). On
    // `KESHA_MODEL_MIRROR`-redirected downloads, the user otherwise has no
    // visibility into which host was actually contacted when the download
    // fails — anyhow's context surfaces the URL through the bail.
    let response = ureq::get(&url)
        .call()
        .with_context(|| format!("GET {url} ({})", f.rel_path))
        .coded(ErrorCode::ModelDownload)?;
    let mut reader = response.into_body().into_reader();
    let mut out =
        fs::File::create(&target).with_context(|| format!("create {}", target.display()))?;
    io::copy(&mut reader, &mut out)?;
    drop(out);
    if !verify_sha256(&target, f.sha256)? {
        // Recompute to embed the actual hash in the bail (#275 D5). One
        // extra hash pass on a freshly-downloaded file is cheap relative
        // to the failure-mode value: the user can now tell stale-mirror
        // vs corrupt-download vs upstream-rehost from one line of stderr.
        let actual = compute_sha256(&target).unwrap_or_else(|_| "<unreadable>".to_string());
        // Remove so the existence-only cache probes don't later resurrect
        // unverified weights (#174). Best-effort — errors here are masked
        // by the bail below which surfaces the real problem.
        let _ = fs::remove_file(&target);
        coded_bail!(
            ErrorCode::CacheCorrupt,
            "sha256 mismatch for {}: expected {} got {}",
            f.rel_path,
            f.sha256.get(..12).unwrap_or(f.sha256),
            actual.get(..12).unwrap_or(&actual)
        );
    }
    eprintln!("OK  {}", f.rel_path);
    Ok(())
}

fn verify_sha256(path: &Path, expected: &str) -> Result<bool> {
    Ok(compute_sha256(path)?.eq_ignore_ascii_case(expected))
}

/// SHA-256 of `path`'s contents, lowercase hex. Split out from
/// [`verify_sha256`] so the mismatch bail in `download_verified` can embed
/// the actual hash next to the expected one (#275 D5). 64 KiB BufReader
/// keeps `io::copy` off its 8 KiB default so hashing a 2.4 GB model file
/// stays IO-bound rather than syscall-bound.
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
}
