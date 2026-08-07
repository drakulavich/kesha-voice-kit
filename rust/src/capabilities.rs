use serde::Serialize;

// Mirror runtime gate: system_diarize on Linux has no code path; advertising without it would lie.
#[cfg(all(feature = "system_diarize", target_os = "macos"))]
use crate::transcribe::TRANSCRIBE_DIARIZE_FEATURE;
use crate::transcribe::TRANSCRIBE_SEGMENTS_FEATURE;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsLanguage {
    pub code: &'static str,
    /// Downloadable engines for this language, default first.
    pub engines: Vec<&'static str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsCapabilities {
    pub languages: Vec<TtsLanguage>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub protocol_version: u32,
    pub backend: &'static str,
    pub features: Vec<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tts: Option<TtsCapabilities>,
}

pub fn get_capabilities() -> Capabilities {
    #[allow(unused_mut)]
    let mut features = vec![
        "transcribe",
        TRANSCRIBE_SEGMENTS_FEATURE,
        "detect-lang",
        "vad",
    ];

    #[cfg(target_os = "macos")]
    features.push("detect-text-lang");

    // Mirrors the runtime gate in cli::record::run_live exactly — advertising
    // this where the streaming session does not compile would lie.
    #[cfg(all(feature = "coreml", target_os = "macos"))]
    features.push(crate::record::RECORD_LIVE_FEATURE);

    #[cfg(feature = "tts")]
    features.push("tts");
    #[cfg(feature = "tts")]
    features.push("tts.ru_acronym_expansion");
    #[cfg(feature = "tts")]
    features.push("tts.en_acronym_expansion");
    #[cfg(feature = "tts")]
    features.push("tts.ru_emphasis_marker");
    // Applies to Vosk + Kokoro (incl. FluidAudio, fixed in #481); AVSpeech rejects SSML upstream so callers get a clear error (#236).
    #[cfg(feature = "tts")]
    features.push("tts.prosody_rate");

    #[cfg(all(feature = "system_diarize", target_os = "macos"))]
    features.push(TRANSCRIBE_DIARIZE_FEATURE);

    #[cfg(feature = "tts")]
    let tts = Some(TtsCapabilities {
        languages: crate::models::tts_languages()
            .into_iter()
            .map(|code| TtsLanguage {
                code,
                engines: vec![crate::models::tts_engine_for(code)],
            })
            .collect(),
    });
    #[cfg(not(feature = "tts"))]
    let tts = None;

    Capabilities {
        protocol_version: 3,
        backend: backend_name(),
        features,
        tts,
    }
}

fn backend_name() -> &'static str {
    #[cfg(feature = "coreml")]
    {
        "coreml"
    }
    #[cfg(not(feature = "coreml"))]
    {
        "onnx"
    }
}

#[cfg(test)]
mod caps_tests {
    use super::*;

    /// Ungated: every build shape must expose the core features exactly once —
    /// the vector is a wire contract for the TS CLI and the Raycast extension.
    #[test]
    fn feature_list_core_invariants() {
        let caps = get_capabilities();
        for must in ["transcribe", "detect-lang", "vad"] {
            assert!(
                caps.features.contains(&must),
                "{must} missing: {:?}",
                caps.features
            );
        }
        let mut seen = std::collections::HashSet::new();
        for f in &caps.features {
            assert!(seen.insert(f), "duplicate feature entry {f:?}");
        }
        assert!(!caps.backend.is_empty(), "backend name must be reported");
    }

    /// The flag must track the compiled streaming path, not the OS alone —
    /// a macOS ONNX build cannot serve `--live` either.
    #[test]
    fn record_live_is_advertised_only_where_it_compiles() {
        let advertised = get_capabilities()
            .features
            .contains(&crate::record::RECORD_LIVE_FEATURE);
        let servable = cfg!(all(feature = "coreml", target_os = "macos"));
        assert_eq!(
            advertised, servable,
            "record.live advertisement diverged from the compiled streaming path"
        );
    }
}

#[cfg(all(test, feature = "tts"))]
mod tts_caps_tests {
    use super::*;

    #[test]
    fn capabilities_expose_tts_languages() {
        let caps = get_capabilities();
        let tts = caps.tts.expect("tts field present on a tts build");
        let codes: Vec<&str> = tts.languages.iter().map(|l| l.code).collect();
        assert!(codes.contains(&"en"));
        assert!(codes.contains(&"ru"));
        for lang in &tts.languages {
            assert!(!lang.engines.is_empty(), "{} has no engines", lang.code);
        }
        let ru = tts.languages.iter().find(|l| l.code == "ru").unwrap();
        assert_eq!(ru.engines, vec!["vosk"]);
        let en = tts.languages.iter().find(|l| l.code == "en").unwrap();
        assert_eq!(en.engines, vec!["kokoro"]);
    }

    #[test]
    fn protocol_version_is_3() {
        assert_eq!(get_capabilities().protocol_version, 3);
    }
}
