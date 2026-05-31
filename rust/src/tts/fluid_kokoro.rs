//! FluidAudio Kokoro backend — macOS arm64, behind `system_kokoro`.
//!
//! Uses the forked `fluidaudio-rs` crate's native Kokoro binding (in-process),
//! replacing the previous Swift sidecar. Non-Darwin builds stay on the existing
//! ONNX Kokoro implementation.

#![cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]

use anyhow::{Context, Result};
use std::sync::Once;

use fluidaudio_rs::FluidAudio;

/// FluidAudio Kokoro native output rate (24 kHz mono, 16-bit PCM). Used to size
/// SSML `<break>` silence buffers when the segment walker stitches audio.
pub const SAMPLE_RATE: u32 = 24_000;

#[derive(Clone, Copy)]
pub struct VoiceSpec {
    /// Public Kesha voice id, including the language prefix.
    pub public_id: &'static str,
    /// Bare FluidAudio/Kokoro voice id staged in the ANE cache.
    pub fluid_id: &'static str,
    /// Language tag used for diagnostics and non-Fluid Kokoro compatibility.
    pub lang: &'static str,
}

// FluidAudio 0.14.5 voice snapshot plus the multilingual Kokoro voice packs
// validated against the ANE cache. Keep this list in sync with the FluidAudio
// pin in the fluidaudio-rs fork whenever it changes.
const VOICES: &[VoiceSpec] = &[
    VoiceSpec {
        public_id: "en-af_alloy",
        fluid_id: "af_alloy",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-af_aoede",
        fluid_id: "af_aoede",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-af_bella",
        fluid_id: "af_bella",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-af_heart",
        fluid_id: "af_heart",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-af_jessica",
        fluid_id: "af_jessica",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-af_kore",
        fluid_id: "af_kore",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-af_nicole",
        fluid_id: "af_nicole",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-af_nova",
        fluid_id: "af_nova",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-af_river",
        fluid_id: "af_river",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-af_sarah",
        fluid_id: "af_sarah",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-af_sky",
        fluid_id: "af_sky",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-am_adam",
        fluid_id: "am_adam",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-am_echo",
        fluid_id: "am_echo",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-am_eric",
        fluid_id: "am_eric",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-am_fenrir",
        fluid_id: "am_fenrir",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-am_liam",
        fluid_id: "am_liam",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-am_michael",
        fluid_id: "am_michael",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-am_onyx",
        fluid_id: "am_onyx",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-am_puck",
        fluid_id: "am_puck",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-am_santa",
        fluid_id: "am_santa",
        lang: "en-us",
    },
    VoiceSpec {
        public_id: "en-bm_lewis",
        fluid_id: "bm_lewis",
        lang: "en-gb",
    },
    VoiceSpec {
        public_id: "es-em_alex",
        fluid_id: "em_alex",
        lang: "es",
    },
    VoiceSpec {
        public_id: "hi-hm_omega",
        fluid_id: "hm_omega",
        lang: "hi",
    },
    VoiceSpec {
        public_id: "it-im_nicola",
        fluid_id: "im_nicola",
        lang: "it",
    },
    VoiceSpec {
        public_id: "ja-jm_kumo",
        fluid_id: "jm_kumo",
        lang: "ja",
    },
    VoiceSpec {
        public_id: "pt-pm_alex",
        fluid_id: "pm_alex",
        lang: "pt-br",
    },
    VoiceSpec {
        public_id: "zh-zm_yunjian",
        fluid_id: "zm_yunjian",
        lang: "zh",
    },
    VoiceSpec {
        public_id: "fr-ff_siwis",
        fluid_id: "ff_siwis",
        lang: "fr-fr",
    },
];

pub fn available_voice_ids() -> Vec<String> {
    VOICES.iter().map(|v| v.public_id.to_string()).collect()
}

pub fn resolve_voice(public_id: &str) -> Option<VoiceSpec> {
    VOICES.iter().copied().find(|v| v.public_id == public_id)
}

fn lang_for_fluid_id(fluid_id: &str) -> Option<&'static str> {
    VOICES
        .iter()
        .find(|v| v.fluid_id == fluid_id)
        .map(|v| v.lang)
}

fn is_han(c: char) -> bool {
    matches!(
        c,
        '\u{3400}'..='\u{4DBF}'        // CJK Extension A
            | '\u{4E00}'..='\u{9FFF}'  // CJK Unified Ideographs
            | '\u{F900}'..='\u{FAFF}'  // CJK Compatibility Ideographs
            | '\u{20000}'..='\u{2A6DF}' // Extension B
            | '\u{2A700}'..='\u{2CEAF}' // Extensions C, D, E
            | '\u{2CEB0}'..='\u{2EBEF}' // Extension F
    )
}

/// FluidAudio's Kokoro G2P only phonemizes **Latin** input; for the non-Latin
/// languages it ships voices for (hi/ja/zh) native-script text is not converted
/// to phonemes and synthesizes as noise rather than speech (#492). Returns the
/// human-facing script name when `text` actually contains characters of the
/// script `fluid_id`'s language is written in — romanized (Latin) input for the
/// same voice returns `None` because it works. Latin-script Kokoro languages
/// (en/es/fr/it/pt) always return `None`.
fn unsupported_native_script(text: &str, fluid_id: &str) -> Option<&'static str> {
    let any = |f: fn(char) -> bool| text.chars().any(f);
    match lang_for_fluid_id(fluid_id)? {
        "hi" => any(|c| ('\u{0900}'..='\u{097F}').contains(&c)).then_some("Devanagari"),
        "ja" => any(|c| matches!(c, '\u{3040}'..='\u{30FF}') || is_han(c))
            .then_some("Japanese (kana/kanji)"),
        "zh" => any(is_han).then_some("Chinese (Han)"),
        _ => None,
    }
}

/// One-time stderr warning when native-script text is handed to a FluidAudio
/// Kokoro voice that can't phonemize it (#492). It's a silent failure otherwise:
/// audio is produced, just not speech.
///
/// Deduplication is **per language**, not process-wide: a multi-segment SSML
/// utterance in one language warns at most once, but a process that synthesizes
/// two non-Latin languages (e.g. Hindi then Japanese) still warns for each — a
/// shared `Once` would let whichever fired first swallow the others' warnings.
fn warn_if_unsupported_script(fluid_id: &str, text: &str) {
    static WARNED_HI: Once = Once::new();
    static WARNED_JA: Once = Once::new();
    static WARNED_ZH: Once = Once::new();
    let Some(script) = unsupported_native_script(text, fluid_id) else {
        return;
    };
    let once = match lang_for_fluid_id(fluid_id) {
        Some("hi") => &WARNED_HI,
        Some("ja") => &WARNED_JA,
        Some("zh") => &WARNED_ZH,
        _ => return,
    };
    once.call_once(|| {
        eprintln!(
            "warning: FluidAudio Kokoro can only phonemize Latin-script input; voice \
             '{fluid_id}' received {script} text, which synthesizes as noise rather than \
             speech. Romanize the text (transliterate to Latin) for now. \
             Tracking: https://github.com/drakulavich/kesha-voice-kit/issues/492"
        );
    });
}

/// Initialize a FluidAudio Kokoro bridge for `voice_id` and run `f` against it
/// with the process's stdout silenced for the whole bridge lifetime (create →
/// call → drop). FluidAudio's CoreML pipeline writes diagnostics to stdout that
/// would corrupt `kesha say`'s WAV byte stream; the oneshot guard restores fd 1
/// on return (#259, mirrors the diarize/ASR guard).
fn with_kokoro<R>(voice_id: &str, f: impl FnOnce(&FluidAudio) -> Result<R>) -> Result<R> {
    crate::fluid_stdout::with_silenced_stdout_oneshot(|| {
        let audio = FluidAudio::new().context("init FluidAudio bridge")?;
        audio
            .init_kokoro(voice_id)
            .context("init FluidAudio Kokoro (downloads the model on first run)")?;
        f(&audio)
    })
}

/// Synthesize `text` with FluidAudio Kokoro (CoreML/ANE) via the native
/// `fluidaudio-rs` binding. `voice_id` is the bare FluidAudio voice (e.g.
/// `am_michael`). Returns a complete WAV byte buffer (24 kHz mono, 16-bit PCM);
/// `tts::say::transcode_to` decodes/re-encodes it for the requested format.
pub fn synthesize(text: &str, voice_id: &str, speed: f32) -> Result<Vec<u8>> {
    if text.is_empty() {
        anyhow::bail!("fluid-kokoro: text is empty");
    }
    warn_if_unsupported_script(voice_id, text);
    with_kokoro(voice_id, |audio| {
        audio
            .synthesize_kokoro(text, voice_id, speed)
            .context("FluidAudio Kokoro synthesis")
    })
}

/// Synthesize one text chunk and return raw PCM f32 samples at [`SAMPLE_RATE`].
///
/// Used by the SSML segment walker (`tts::say::synth_segments_fluid_kokoro`),
/// which decodes/concatenates per-segment audio and interleaves `<break>`
/// silence before encoding once. Empty/whitespace-only text returns an empty
/// buffer (the walker skips it) rather than erroring the whole utterance.
///
/// Each call re-inits the FluidAudio bridge: the dominant SSML case is a single
/// `<prosody>`-wrapped utterance (one call), and the `.mlmodelc` is disk-cached
/// after the first compile so multi-segment re-inits load the compiled model
/// rather than recompiling.
pub fn synthesize_pcm(text: &str, voice_id: &str, speed: f32) -> Result<Vec<f32>> {
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    warn_if_unsupported_script(voice_id, text);
    let wav = with_kokoro(voice_id, |audio| {
        audio
            .synthesize_kokoro(text, voice_id, speed)
            .context("FluidAudio Kokoro synthesis")
    })?;
    wav_to_f32(&wav)
}

/// Decode a FluidAudio Kokoro WAV buffer (24 kHz, 16-bit PCM) into f32 samples
/// normalized to `[-1.0, 1.0]`. FluidAudio emits mono today, but we downmix any
/// multi-channel buffer to mono rather than trusting that — an interleaved
/// stereo buffer left as-is would silently double the sample count and corrupt
/// the SSML walker's duration/`<break>` math. Mirrors `tts::say::wav_to_mono_f32`.
fn wav_to_f32(wav: &[u8]) -> Result<Vec<f32>> {
    let reader =
        hound::WavReader::new(std::io::Cursor::new(wav)).context("decode FluidAudio Kokoro WAV")?;
    let spec = reader.spec();
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample - 1)) as f32;
            reader
                .into_samples::<i32>()
                .map(|s| s.map(|v| v as f32 / max))
                .collect::<std::result::Result<Vec<f32>, _>>()
                .context("read FluidAudio Kokoro PCM samples")?
        }
        hound::SampleFormat::Float => reader
            .into_samples::<f32>()
            .collect::<std::result::Result<Vec<f32>, _>>()
            .context("read FluidAudio Kokoro float samples")?,
    };
    let channels = spec.channels as usize;
    if channels <= 1 {
        return Ok(samples);
    }
    Ok(samples
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_supported_kesha_voice_ids() {
        let voices = available_voice_ids();
        assert!(voices.contains(&"en-am_michael".to_string()));
        assert!(voices.contains(&"en-af_heart".to_string()));
        assert!(voices.contains(&"es-em_alex".to_string()));
        assert!(voices.contains(&"ja-jm_kumo".to_string()));
        assert!(voices.contains(&"zh-zm_yunjian".to_string()));
    }

    #[test]
    fn supports_known_voice() {
        assert!(resolve_voice("en-am_michael").is_some());
        assert!(resolve_voice("es-em_alex").is_some());
        assert!(resolve_voice("en-em_alex").is_none());
        assert!(resolve_voice("nonexistent").is_none());
    }

    #[test]
    fn resolves_public_voice_to_fluid_id_and_lang() {
        let spec = resolve_voice("pt-pm_alex").expect("pt voice");
        assert_eq!(spec.fluid_id, "pm_alex");
        assert_eq!(spec.lang, "pt-br");
    }

    #[test]
    fn flags_native_script_for_non_latin_voices() {
        // Native script for hi/ja/zh → flagged (FluidAudio can't phonemize it, #492).
        assert_eq!(
            unsupported_native_script("नमस्ते मेरा नाम केशा है", "hm_omega"),
            Some("Devanagari")
        );
        assert_eq!(
            unsupported_native_script("こんにちは、ケシャです", "jm_kumo"),
            Some("Japanese (kana/kanji)")
        );
        // Kanji-only Japanese still flags via the Han range.
        assert_eq!(
            unsupported_native_script("日本語", "jm_kumo"),
            Some("Japanese (kana/kanji)")
        );
        assert_eq!(
            unsupported_native_script("你好我叫凯沙", "zm_yunjian"),
            Some("Chinese (Han)")
        );
        // Supplementary-plane CJK (Extension B, U+20000) must also be detected.
        assert_eq!(
            unsupported_native_script("\u{20000}", "zm_yunjian"),
            Some("Chinese (Han)")
        );
    }

    #[test]
    fn allows_romanized_input_for_non_latin_voices() {
        // Romanized (Latin) input for the same voices works — must NOT be flagged.
        assert_eq!(
            unsupported_native_script("Namaste! Mera naam Kesha hai.", "hm_omega"),
            None
        );
        assert_eq!(
            unsupported_native_script("Konnichiwa! Watashi wa Kesha desu.", "jm_kumo"),
            None
        );
        assert_eq!(
            unsupported_native_script("Ni hao! Wo jiao Kesha.", "zm_yunjian"),
            None
        );
    }

    #[test]
    fn never_flags_latin_script_voices() {
        // Latin-script Kokoro languages always pass, including accented/punctuated text.
        assert_eq!(
            unsupported_native_script("¡Hola! Soy Kesha.", "em_alex"),
            None
        );
        assert_eq!(
            unsupported_native_script("Ciao, città però.", "im_nicola"),
            None
        );
        assert_eq!(unsupported_native_script("Olá, coração.", "pm_alex"), None);
        assert_eq!(unsupported_native_script("Hello world", "am_michael"), None);
        // Unknown / unmapped fluid id → no language → never flagged.
        assert_eq!(unsupported_native_script("日本語", "nonexistent"), None);
    }

    #[test]
    #[ignore = "downloads the FluidAudio Kokoro model; run locally on darwin-arm64"]
    fn synthesize_returns_wav() {
        let wav = synthesize("Hello world", "am_michael", 1.0).expect("synth");
        assert!(
            wav.len() > 1000,
            "expected a non-trivial WAV, got {}",
            wav.len()
        );
        assert_eq!(&wav[..4], b"RIFF", "expected a RIFF/WAVE header");
    }
}
