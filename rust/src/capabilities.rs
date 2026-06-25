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
