//! FluidAudio Kokoro backend — macOS arm64, behind `system_kokoro`.
//!
//! Uses the `fluidaudio-rs` crate's native Kokoro binding (in-process),
//! replacing the previous Swift sidecar. Non-Darwin builds stay on the existing
//! ONNX Kokoro implementation.

#![cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]

use anyhow::{Context, Result};

use fluidaudio_rs::{FluidAudio, KokoroComputeUnits};

use crate::coded_bail;
use crate::errors::ErrorCode;

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

/// One FluidAudio voice: the public id is always `<prefix>-<fluid_id>`, so
/// deriving it in the macro keeps the two from drifting.
macro_rules! fluid_voice {
    ($prefix:literal, $fluid_id:literal, $lang:literal) => {
        VoiceSpec {
            public_id: concat!($prefix, "-", $fluid_id),
            fluid_id: $fluid_id,
            lang: $lang,
        }
    };
}

// FluidAudio 0.15.5 voice snapshot plus the multilingual Kokoro voice packs
// validated against the ANE cache. Keep this list in sync with the FluidAudio
// pin in the fluidaudio-rs git rev (rust/Cargo.toml) whenever it changes.
const VOICES: &[VoiceSpec] = &[
    fluid_voice!("en", "af_alloy", "en-us"),
    fluid_voice!("en", "af_aoede", "en-us"),
    fluid_voice!("en", "af_bella", "en-us"),
    fluid_voice!("en", "af_heart", "en-us"),
    fluid_voice!("en", "af_jessica", "en-us"),
    fluid_voice!("en", "af_kore", "en-us"),
    fluid_voice!("en", "af_nicole", "en-us"),
    fluid_voice!("en", "af_nova", "en-us"),
    fluid_voice!("en", "af_river", "en-us"),
    fluid_voice!("en", "af_sarah", "en-us"),
    fluid_voice!("en", "af_sky", "en-us"),
    fluid_voice!("en", "am_adam", "en-us"),
    fluid_voice!("en", "am_echo", "en-us"),
    fluid_voice!("en", "am_eric", "en-us"),
    fluid_voice!("en", "am_fenrir", "en-us"),
    fluid_voice!("en", "am_liam", "en-us"),
    fluid_voice!("en", "am_michael", "en-us"),
    fluid_voice!("en", "am_onyx", "en-us"),
    fluid_voice!("en", "am_puck", "en-us"),
    fluid_voice!("en", "am_santa", "en-us"),
    fluid_voice!("en", "bm_lewis", "en-gb"),
    fluid_voice!("es", "em_alex", "es"),
    fluid_voice!("hi", "hm_omega", "hi"),
    fluid_voice!("it", "im_nicola", "it"),
    fluid_voice!("ja", "jm_kumo", "ja"),
    fluid_voice!("pt", "pm_alex", "pt-br"),
    fluid_voice!("zh", "zm_050", "zh"),
    fluid_voice!("fr", "ff_siwis", "fr-fr"),
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

/// FluidAudio's Kokoro G2P handles Latin (en/es/fr/it/pt) and, since the
/// FluidAudio 0.15.5 `.mandarin` KokoroAne variant, Chinese (Han). For the other
/// non-Latin languages it ships voices for (hi/ja) native-script text is not
/// converted to phonemes and synthesizes as noise rather than speech (#492).
/// FluidAudio 0.15.5 added a `.japanese` variant, but the binding still routes
/// only `zh` away from `.english`, so `ja` keeps bailing until that is wired.
/// Returns the human-facing script name when `text` actually contains characters
/// of the script `fluid_id`'s language is written in — romanized (Latin) input
/// for the same voice returns `None` because it works.
fn unsupported_native_script(text: &str, fluid_id: &str) -> Option<&'static str> {
    let any = |f: fn(char) -> bool| text.chars().any(f);
    match lang_for_fluid_id(fluid_id)? {
        "hi" => any(|c| ('\u{0900}'..='\u{097F}').contains(&c)).then_some("Devanagari"),
        "ja" => any(|c| matches!(c, '\u{3040}'..='\u{30FF}') || is_han(c))
            .then_some("Japanese (kana/kanji)"),
        // zh (Han) is supported via FluidAudio 0.15.5's Mandarin KokoroAne variant.
        _ => None,
    }
}

/// Fail fast when native-script text is handed to a FluidAudio Kokoro voice
/// that can't phonemize it (#492). FluidAudio's Kokoro G2P only handles Latin
/// input, so Devanagari/kana-kanji/Han would synthesize as noise rather than
/// speech — refusing with a stable [`ErrorCode::ScriptUnsupported`] beats
/// emitting a successful WAV of garbage. Romanized (Latin) input for the same
/// voice passes the check.
fn ensure_script_supported(fluid_id: &str, text: &str) -> Result<()> {
    if let Some(script) = unsupported_native_script(text, fluid_id) {
        coded_bail!(
            ErrorCode::ScriptUnsupported,
            "FluidAudio Kokoro voice '{fluid_id}' cannot phonemize {script} text; it only \
             supports Latin-script input. Romanize the text (transliterate to Latin), or use a \
             voice whose engine supports {script}. \
             See https://github.com/drakulavich/kesha-voice-kit/issues/492"
        );
    }
    Ok(())
}

/// Env var overriding which CoreML compute units the Kokoro pipeline loads on.
const COMPUTE_UNITS_ENV: &str = "KESHA_KOKORO_COMPUTE_UNITS";

/// Accepted [`COMPUTE_UNITS_ENV`] values, spelled as FluidAudio's own `TtsComputeUnitPreset` CLI names.
const COMPUTE_UNIT_PRESETS: &[(&str, KokoroComputeUnits)] = &[
    ("default", KokoroComputeUnits::Default),
    ("cpu-and-gpu", KokoroComputeUnits::CpuAndGpu),
    ("all-ane", KokoroComputeUnits::AllAne),
    ("cpu-only", KokoroComputeUnits::CpuOnly),
];

fn preset_name(units: KokoroComputeUnits) -> &'static str {
    COMPUTE_UNIT_PRESETS
        .iter()
        .find(|(_, u)| *u == units)
        .map(|(name, _)| *name)
        .unwrap_or("default")
}

/// Read [`COMPUTE_UNITS_ENV`], defaulting to FluidAudio's empirical per-stage
/// mapping (Albert / PostAlbert / Alignment / Vocoder on the Neural Engine).
///
/// The override exists for hosts with no usable ANE — notably a virtualised
/// macOS guest such as a GitHub-hosted `macos-14` runner, where CoreML fails to
/// prepare exactly those stages ("Failed to prepare the model for predictions",
/// #678). Real Apple Silicon should never set it.
fn compute_units_from_env() -> Result<KokoroComputeUnits> {
    // Unset and blank are the same case: GHA exports a conditional `env:` as "".
    let raw = std::env::var_os(COMPUTE_UNITS_ENV).unwrap_or_default();
    let raw = raw.to_string_lossy();
    let value = raw.trim();
    if value.is_empty() {
        return Ok(KokoroComputeUnits::Default);
    }
    let lowered = value.to_ascii_lowercase();
    if let Some((_, units)) = COMPUTE_UNIT_PRESETS
        .iter()
        .find(|(name, _)| *name == lowered)
    {
        return Ok(*units);
    }
    // Coded: an uncoded error surfaces as E_INTERNAL, blaming the engine for the user's typo.
    coded_bail!(
        ErrorCode::InvalidArg,
        "{COMPUTE_UNITS_ENV}='{value}' is not a known CoreML compute-units preset. \
         Use one of: {}. `default` is the tuned mapping and the right choice on real \
         Apple Silicon; override it only where no Neural Engine is exposed, such as a \
         virtualised macOS guest.",
        COMPUTE_UNIT_PRESETS
            .iter()
            .map(|(name, _)| *name)
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// Initialize a FluidAudio Kokoro bridge for `voice_id` and run `f` against it
/// with the process's stdout silenced for the whole bridge lifetime (create →
/// call → drop). FluidAudio's CoreML pipeline writes diagnostics to stdout that
/// would corrupt `kesha say`'s WAV byte stream; the oneshot guard restores fd 1
/// on return (#259, mirrors the diarize/ASR guard). The non-ANE presets widen
/// that leak — CPU+GPU adds E5RT "Data-dependent shapes were disabled" lines —
/// so the guard matters more, not less, when the override is set.
fn with_kokoro<R>(voice_id: &str, f: impl FnOnce(&FluidAudio) -> Result<R>) -> Result<R> {
    // The voice's language selects the KokoroAne variant in the bridge
    // (`zh` → Mandarin, else English). Unknown voices default to English.
    let lang = lang_for_fluid_id(voice_id).unwrap_or("en-us");
    let compute_units = compute_units_from_env()?;
    crate::fluid_stdout::with_silenced_stdout_oneshot(|| {
        let audio = FluidAudio::new().context("init FluidAudio bridge")?;
        audio
            .init_kokoro_with_compute_units(voice_id, lang, compute_units)
            .with_context(|| {
                format!(
                    "init FluidAudio Kokoro on {} compute units (downloads the model on first run)",
                    preset_name(compute_units)
                )
            })?;
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
    ensure_script_supported(voice_id, text)?;
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
/// silence before encoding once. Text with no alphanumeric content
/// (whitespace- or punctuation-only) returns an empty buffer (the walker skips
/// it) rather than erroring the whole utterance.
///
/// Each call re-inits the FluidAudio bridge: the dominant SSML case is a single
/// `<prosody>`-wrapped utterance (one call), and the `.mlmodelc` is disk-cached
/// after the first compile so multi-segment re-inits load the compiled model
/// rather than recompiling.
pub fn synthesize_pcm(text: &str, voice_id: &str, speed: f32) -> Result<Vec<f32>> {
    // A segment with no alphanumeric content (whitespace, or bare punctuation
    // like the trailing "." in `<speak>Loop <emphasis>ssml</emphasis>.</speak>`)
    // has nothing to phonemize. FluidAudio's internal G2P *errors* on such input
    // ("G2P produced no phonemes for input '.'", #543), which would fail the whole
    // SSML utterance; the ONNX path instead yields empty audio (misaki returns an
    // empty IPA string → `sessions::infer_ipa` early-returns on empty token ids).
    // Mirror that tolerance so a punctuation-only segment contributes silence and
    // the walker's final "no audio produced" guard still catches a fully-empty
    // utterance.
    if !text.chars().any(char::is_alphanumeric) {
        return Ok(Vec::new());
    }
    ensure_script_supported(voice_id, text)?;
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
        assert!(voices.contains(&"zh-zm_050".to_string()));
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
        // zh (Han) is now SUPPORTED via FluidAudio 0.15.5's Mandarin KokoroAne
        // variant (#492) — native-script Chinese must NOT be flagged.
        assert_eq!(unsupported_native_script("你好我叫凯沙", "zm_050"), None);
        assert_eq!(unsupported_native_script("\u{20000}", "zm_050"), None);
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
            unsupported_native_script("Ni hao! Wo jiao Kesha.", "zm_050"),
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
    fn ensure_script_supported_bails_with_code_on_native_script() {
        // hi/ja native script still bails: no hi variant upstream, and the binding
        // does not route ja to 0.15.5's `.japanese` variant.
        for (text, voice) in [("नमस्ते", "hm_omega"), ("こんにちは", "jm_kumo")] {
            let err =
                ensure_script_supported(voice, text).expect_err("should reject native script");
            assert_eq!(
                crate::errors::code_of(&err),
                ErrorCode::ScriptUnsupported,
                "voice {voice} text {text:?} -> {err}"
            );
        }
        // zh (Han) now passes — supported via the Mandarin KokoroAne variant (#492).
        ensure_script_supported("zm_050", "你好").expect("zh native ok");
        // Romanized + Latin-script voices pass.
        ensure_script_supported("hm_omega", "Namaste").expect("romanized hi ok");
        ensure_script_supported("em_alex", "¡Hola!").expect("latin es ok");
        ensure_script_supported("am_michael", "Hello").expect("english ok");
    }

    #[test]
    fn synthesize_pcm_skips_no_phoneme_text_before_model_init() {
        // Bare-punctuation / whitespace-only segments (e.g. the trailing "." in
        // `<speak>Loop <emphasis>ssml</emphasis>.</speak>`, #543) have nothing to
        // phonemize. They must short-circuit to an empty buffer *before* model init:
        // FluidAudio's internal G2P otherwise errors ("G2P produced no phonemes for
        // input '.'") and fails the whole SSML utterance, whereas the ONNX path yields
        // empty audio. No model download needed — the guard returns first.
        for text in [".", "   ", "...", "—", "?!", "“”", ", ."] {
            let pcm = synthesize_pcm(text, "am_michael", 1.0)
                .unwrap_or_else(|e| panic!("no-phoneme synth must not error for {text:?}: {e}"));
            assert!(
                pcm.is_empty(),
                "expected empty PCM for no-phoneme text {text:?}, got {} samples",
                pcm.len()
            );
        }
    }

    #[test]
    fn compute_units_env_defaults_and_validates() {
        use crate::util::test_env::{lock, EnvGuard};
        let _lock = lock();

        {
            let _g = EnvGuard::unset(COMPUTE_UNITS_ENV);
            assert_eq!(
                compute_units_from_env().expect("unset is valid"),
                KokoroComputeUnits::Default
            );
        }

        // GHA exports a conditional `env:` as the empty string rather than omitting it.
        for blank in ["", "   "] {
            let _g = EnvGuard::set(COMPUTE_UNITS_ENV, blank);
            assert_eq!(
                compute_units_from_env().expect("blank is valid"),
                KokoroComputeUnits::Default
            );
        }

        for (value, expected) in [
            ("cpu-and-gpu", KokoroComputeUnits::CpuAndGpu),
            (" cpu-only ", KokoroComputeUnits::CpuOnly),
            ("ALL-ANE", KokoroComputeUnits::AllAne),
            ("default", KokoroComputeUnits::Default),
        ] {
            let _g = EnvGuard::set(COMPUTE_UNITS_ENV, value);
            let parsed = compute_units_from_env().unwrap_or_else(|e| panic!("{value:?}: {e}"));
            assert_eq!(parsed, expected);
            assert_eq!(preset_name(parsed), value.trim().to_ascii_lowercase());
        }

        // Must fail loudly instead of silently using the ANE the caller was avoiding.
        let _g = EnvGuard::set(COMPUTE_UNITS_ENV, "ane-please");
        let err = compute_units_from_env().expect_err("unknown preset must error");
        assert_eq!(crate::errors::code_of(&err), ErrorCode::InvalidArg);
        let msg = err.to_string();
        assert!(msg.contains("ane-please"), "{msg}");
        assert!(msg.contains("cpu-and-gpu"), "{msg}");
    }

    /// `preset_name` falls back to "default" for an unlisted variant, so a
    /// `KokoroComputeUnits` growing a variant must extend the table or the
    /// error text would name a preset the engine is not using.
    #[test]
    fn every_preset_round_trips_through_its_name() {
        for (name, units) in COMPUTE_UNIT_PRESETS {
            assert_eq!(preset_name(*units), *name);
        }
        assert_eq!(COMPUTE_UNIT_PRESETS.len(), 4, "extend the table");
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
