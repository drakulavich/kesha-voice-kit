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

/// FluidAudio Kokoro native output rate (24 kHz mono f32). Used to size SSML
/// `<break>` silence buffers when the segment walker stitches audio.
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

/// Public voice id for a bare FluidAudio id, so diagnostics name what the user typed.
fn public_id_for_fluid_id(fluid_id: &str) -> Option<&'static str> {
    VOICES
        .iter()
        .find(|v| v.fluid_id == fluid_id)
        .map(|v| v.public_id)
}

/// Refuse text whose dominant script this voice's G2P cannot phonemize, and warn
/// about a minority run it will mispronounce (#492). An unknown id is not gated.
/// Callers gate the whole utterance once, before chunking: a minority run must not be refused for dominating one chunk.
pub(crate) fn ensure_script_supported(fluid_id: &str, text: &str) -> Result<()> {
    match public_id_for_fluid_id(fluid_id) {
        Some(public_id) => crate::tts::script::ensure_supported(public_id, text),
        None => Ok(()),
    }
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
/// mapping: the RNN-bearing stages (Albert / PostAlbert / Alignment / Prosody /
/// Vocoder) on the Neural Engine, the all-fp32 Noise and Tail iSTFT on the GPU.
/// That is the only placement that runs on every Apple Silicon generation — the
/// prosody RNN aborts the GPU MPSGraph JIT (`GPURNNOps`) on M5, and the tail
/// crashes `libBNNS` on CPU/ANE (FluidAudio #667; kesha #717).
///
/// The override exists for hosts with no usable ANE — notably a virtualised
/// macOS guest such as a GitHub-hosted `macos-14` runner, where CoreML fails to
/// prepare exactly those stages ("Failed to prepare the model for predictions",
/// #678). Real Apple Silicon should never set it; `cpu-and-gpu` in particular
/// moves the prosody RNN onto the GPU, which is the M5 abort above.
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

/// What to say when a model asset is absent: the install did not finish (or
/// something removed part of it), and re-running it is the fix. `lang` names the
/// exact install to run so a Mandarin user is not told to install English, and
/// `missing` names what to look for when a re-install does not help.
fn missing_assets_error(lang: &str, missing: &[std::path::PathBuf]) -> anyhow::Error {
    // `kesha install --tts` takes bare language codes, so the region has to go:
    // the voice's lang is `en-us` here but `es` / `zh` there.
    let install_lang = lang.split('-').next().unwrap_or(lang);
    // The full list can be the whole 40-file manifest on a bare machine, which
    // buries the instruction; the first few identify the gap just as well.
    let named: Vec<String> = missing
        .iter()
        .take(3)
        .map(|p| p.display().to_string())
        .collect();
    let detail = match missing.len() {
        0 => String::new(),
        n if n > 3 => format!(" (missing {}, and {} more)", named.join(", "), n - 3),
        _ => format!(" (missing {})", named.join(", ")),
    };
    anyhow::Error::new(crate::errors::CodedError {
        code: ErrorCode::ModelMissing,
        message: format!(
            "FluidAudio Kokoro assets are missing and kesha never downloads them \
             behind your back — run `kesha install --tts {install_lang}`{detail}{}",
            incomplete_bundle_hint()
        ),
    })
}

/// Suffix naming the one Kokoro init failure kesha can repair: a `.mlmodelc`
/// left incomplete in FluidAudio's cache by an older version (#709). The Swift
/// bridge collapses every init failure into `-1` and logs the CoreML reason
/// (`Error in reading the MIL network`) to stderr itself, so the cause is not in
/// the Rust error — the cache is what we can inspect. Empty when the cache is
/// clean, so a healthy install never gets misleading advice.
fn incomplete_bundle_hint() -> String {
    let names = crate::models::incomplete_ane_bundle_names();
    if names.is_empty() {
        return String::new();
    }
    format!(
        "; FluidAudio's CoreML cache has incomplete bundle(s) ({}) — re-run \
         `kesha install --tts` to repair",
        names.join(", ")
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
    // Two defences, because neither covers the other. The flag stops FluidAudio's
    // repo downloads; it does NOT cover `AssetDownloader`, which is how a voice
    // pack `kesha install --tts <other-lang>` never staged would be fetched
    // mid-synthesis. So check locally first and refuse before FluidAudio is
    // handed anything (#823). Setting the flag process-globally is safe: the
    // engine runs one subcommand per process, and `say` never initialises ASR.
    fluidaudio_rs::set_offline_mode(true);
    let missing = crate::models::missing_kokoro_assets(lang, voice_id);
    if !missing.is_empty() {
        return Err(missing_assets_error(lang, &missing));
    }
    crate::fluid_stdout::with_silenced_stdout_oneshot(|| {
        let audio = crate::models::fluidaudio_bridge(&crate::models::fluidaudio_kokoro_location()?)
            .context("init FluidAudio bridge")?;
        audio
            .init_kokoro_with_compute_units(voice_id, lang, compute_units)
            .map_err(|e| match e {
                // Reachable despite the preflight: a file can be present but
                // truncated or unreadable, which only the loader finds out.
                fluidaudio_rs::FluidAudioError::AssetsUnavailable(_) => {
                    missing_assets_error(lang, &[])
                }
                other => anyhow::Error::new(other).context(format!(
                    "init FluidAudio Kokoro on {} compute units{}",
                    preset_name(compute_units),
                    incomplete_bundle_hint()
                )),
            })?;
        // FluidAudio phonemizes raw text itself, so `en::normalize_segments`
        // never runs here and substituting IPA into the text is not an option.
        // Handing it the table instead makes our pronunciations authoritative
        // ahead of its bundled Misaki lexicon and its G2P fallback (#818).
        if crate::tts::en::is_en(lang) {
            audio
                .set_kokoro_english_lexicon(&crate::tts::en::ane_ipa_overrides())
                .map_err(|e| {
                    anyhow::Error::new(e).context("install the English pronunciation overrides")
                })?;
        }
        f(&audio)
    })
}

/// Synthesize `text` with FluidAudio Kokoro (CoreML/ANE) via the native
/// `fluidaudio-rs` binding. `voice_id` is the bare FluidAudio voice (e.g.
/// `am_michael`). Returns the chain's raw mono f32 samples and their rate, at
/// the model's native level.
///
/// The samples come from `synthesizeDetailed` rather than FluidAudio's WAV
/// wrapper, which peak-normalizes English and Mandarin to 0 dBFS irreversibly
/// (#718). That also keeps the audio in f32 end to end instead of round-tripping
/// through the wrapper's 16-bit PCM.
pub fn synthesize(text: &str, voice_id: &str, speed: f32) -> Result<(Vec<f32>, u32)> {
    if text.is_empty() {
        anyhow::bail!("fluid-kokoro: text is empty");
    }
    let text = prepare_text(voice_id, text);
    ensure_pronounceable(voice_id, &text)?;
    let (result, captured) = crate::fluid_stderr::with_captured_stderr(|| {
        with_kokoro(voice_id, |audio| {
            audio
                .synthesize_kokoro_samples(&text, voice_id, speed)
                .context("FluidAudio Kokoro synthesis")
        })
    });
    match result {
        Ok(samples) => {
            crate::fluid_stderr::relay_captured(&captured);
            Ok(samples)
        }
        Err(err) => Err(classify_bridge_failure(err, &captured, &text, voice_id)),
    }
}

/// FluidAudio's G2P errors on text with nothing to pronounce, so refuse before the model rather than leak its line (T3-7).
fn ensure_pronounceable(voice_id: &str, text: &str) -> Result<()> {
    if text.chars().any(char::is_alphanumeric) {
        return Ok(());
    }
    coded_bail!(
        ErrorCode::ScriptUnsupported,
        "no pronounceable content for voice '{voice_id}'"
    );
}

/// Longest whitespace-free run FluidAudio's G2P encoder accepts is ~100 characters; 40 identifies it without echoing it.
const MAX_TOKEN_CHARS: usize = 40;

/// The word FluidAudio named on fd 2, else the longest token of the input when its message is a phonemization failure.
fn rejected_token(captured: &str, text: &str) -> Option<String> {
    const MARKERS: [&str; 4] = [
        "encoderPredictionFailed",
        "inputProcessingFailed",
        "no phonemes",
        "G2P",
    ];
    // FluidAudio lower-cases the word it names; quote the user's own spelling of it.
    let named = captured
        .split_once("G2P failed on word '")
        .and_then(|(_, rest)| rest.split_once('\''))
        .map(|(word, _)| {
            text.split_whitespace()
                .map(|t| t.trim_matches(|c: char| !c.is_alphanumeric()))
                .find(|t| t.to_lowercase() == word.to_lowercase())
                .unwrap_or(word)
                .to_string()
        });
    let token = match named {
        Some(word) => word,
        None => {
            if !MARKERS.iter().any(|m| captured.contains(m)) {
                return None;
            }
            text.split_whitespace()
                .max_by_key(|t| t.chars().count())?
                .to_string()
        }
    };
    if token.chars().count() <= MAX_TOKEN_CHARS {
        return Some(token);
    }
    Some(format!(
        "{}…",
        token.chars().take(MAX_TOKEN_CHARS).collect::<String>()
    ))
}

/// FluidAudio reports a rejected token only on fd 2, so without this the CLI quotes that raw line as E_INTERNAL (T1-14).
fn classify_bridge_failure(
    err: anyhow::Error,
    captured: &str,
    text: &str,
    voice_id: &str,
) -> anyhow::Error {
    if crate::errors::code_of(&err) != ErrorCode::Internal {
        crate::fluid_stderr::relay_captured(captured);
        return err;
    }
    crate::fluid_stderr::relay_events_only(captured);
    if let Some(token) = rejected_token(captured, text) {
        return anyhow::Error::new(crate::errors::CodedError {
            code: ErrorCode::ScriptUnsupported,
            message: format!("voice '{voice_id}' cannot pronounce '{token}'"),
        });
    }
    anyhow::Error::new(crate::errors::CodedError {
        code: ErrorCode::Internal,
        message: format!("{err:#}{}", crate::fluid_stderr::failure_detail(captured)),
    })
}

/// FluidAudio phonemizes raw text itself, so English amounts must be words before the handoff; its G2P has no hook that could express a currency sign (the ONNX arm does this in `en::normalize_segments`).
fn prepare_text<'a>(voice_id: &str, text: &'a str) -> std::borrow::Cow<'a, str> {
    let text = crate::tts::script::compatibility_normalize(text);
    match lang_for_fluid_id(voice_id) {
        Some(lang) if crate::tts::en::is_en(lang) => {
            std::borrow::Cow::Owned(crate::tts::en::numbers::verbalize(&text).into_owned())
        }
        _ => text,
    }
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
    Ok(synthesize(text, voice_id, speed)?.0)
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
    fn native_script_for_hi_and_ja_is_still_refused() {
        for (text, voice) in [
            ("नमस्ते मेरा नाम केशा है", "hm_omega"),
            ("こんにちは、ケシャです", "jm_kumo"),
            ("日本語", "jm_kumo"),
        ] {
            let err = ensure_script_supported(voice, text).expect_err("native script refused");
            assert_eq!(
                crate::errors::code_of(&err),
                ErrorCode::ScriptUnsupported,
                "voice {voice} text {text:?} -> {err}"
            );
        }
    }

    #[test]
    fn han_on_the_zh_voice_and_romanized_input_everywhere_still_pass() {
        // zh Han is served by FluidAudio 0.15.5's Mandarin KokoroAne variant (#492).
        ensure_script_supported("zm_050", "你好我叫凯沙").expect("zh native ok");
        ensure_script_supported("zm_050", "\u{20000}").expect("zh extension B ok");
        ensure_script_supported("hm_omega", "Namaste! Mera naam Kesha hai.").expect("romanized hi");
        ensure_script_supported("jm_kumo", "Konnichiwa! Watashi wa Kesha desu.")
            .expect("romanized ja");
        ensure_script_supported("em_alex", "¡Hola! Soy Kesha.").expect("latin es");
        ensure_script_supported("im_nicola", "Ciao, città però.").expect("latin it");
        ensure_script_supported("pm_alex", "Olá, coração.").expect("latin pt");
        ensure_script_supported("am_michael", "Hello world").expect("english");
    }

    #[test]
    fn english_voices_get_their_currency_verbalized_before_the_handoff() {
        assert_eq!(
            prepare_text("am_michael", "He paid $1,234.56"),
            "He paid one thousand two hundred thirty four dollars and fifty six cents"
        );
        assert_eq!(prepare_text("am_michael", "Room 405"), "Room 405");
        assert_eq!(prepare_text("am_michael", "Ｒｏｏｍ ４０５"), "Room 405");
        assert_eq!(prepare_text("zm_050", "Ｒｏｏｍ"), "Room");
        assert_eq!(prepare_text("em_alex", "Cuesta $5"), "Cuesta $5");
        assert_eq!(prepare_text("nonexistent", "$5"), "$5");
    }
    #[test]
    fn an_unmapped_fluid_id_is_never_gated() {
        ensure_script_supported("nonexistent", "日本語").expect("unknown id passes through");
    }

    #[test]
    fn refuses_any_dominant_script_a_latin_voice_cannot_phonemize() {
        // #492: keyed off the voice's language, an en-* voice was never checked and spoke filler.
        for text in ["नमस्ते", "مرحبا", "שלום", "สวัสดี", "Γειά σου", "你好世界"]
        {
            let err = ensure_script_supported("am_michael", text).expect_err("should be refused");
            assert_eq!(
                crate::errors::code_of(&err),
                ErrorCode::ScriptUnsupported,
                "text {text:?} -> {err}"
            );
        }
    }

    #[test]
    fn a_minority_foreign_run_still_synthesizes() {
        // #492: refusing here would reject an English sentence quoting one Chinese word.
        ensure_script_supported("am_michael", "Meet me in 你好 town").expect("mixed text speaks");
    }

    #[test]
    fn text_with_nothing_to_pronounce_is_refused_before_the_model() {
        for text in ["😀", "😀😀😀", "!!!", "…"] {
            let err = synthesize(text, "am_michael", 1.0)
                .expect_err("unpronounceable text must be refused");
            assert_eq!(
                crate::errors::code_of(&err),
                ErrorCode::ScriptUnsupported,
                "{text:?}: {err}"
            );
            assert!(format!("{err:#}").contains("am_michael"), "{text:?}: {err}");
        }
    }

    #[test]
    fn a_token_the_g2p_rejects_is_script_unsupported_naming_its_first_40_chars() {
        let token = "x".repeat(100);
        let text = format!("Token: {token}");
        let captured = format!(
            "[WARN] [FluidAudio.KokoroAneEnglishPhonemizer] G2P failed on word '{token}': G2P encoder prediction failed.\nKokoro synthesize error: encoderPredictionFailed\n"
        );
        let err = classify_bridge_failure(
            anyhow::anyhow!("FluidAudio Kokoro synthesis"),
            &captured,
            &text,
            "am_michael",
        );
        assert_eq!(crate::errors::code_of(&err), ErrorCode::ScriptUnsupported);
        let msg = format!("{err:#}");
        assert!(msg.contains(&"x".repeat(40)), "{msg}");
        assert!(
            !msg.contains(&"x".repeat(41)),
            "the token is capped at 40 chars: {msg}"
        );
        assert!(
            !msg.contains("G2P encoder prediction failed"),
            "no raw library line: {msg}"
        );
    }

    #[test]
    fn the_rejected_token_is_quoted_as_the_user_typed_it() {
        let token = "eHh4EHH4".repeat(12);
        let text = format!("Token: {token}");
        let captured = format!(
            "[WARN] [FluidAudio.KokoroAneEnglishPhonemizer] G2P failed on word '{}': G2P encoder prediction failed.\n",
            token.to_lowercase()
        );
        let err = classify_bridge_failure(
            anyhow::anyhow!("FluidAudio Kokoro synthesis"),
            &captured,
            &text,
            "am_michael",
        );
        let msg = format!("{err:#}");
        assert!(
            msg.contains(&token[..40]),
            "the user's spelling, not FluidAudio's lower-casing: {msg}"
        );
    }

    /// Reads back what a call wrote to fd 2 by pointing it at a file for the duration.
    fn with_captured_fd2<R>(f: impl FnOnce() -> R) -> (R, String) {
        use std::io::{Read, Seek};
        use std::os::fd::AsRawFd;
        let mut capture = tempfile::tempfile().expect("capture tempfile");
        // SAFETY: dup of fd 2, which this process owns; -1 is checked by the expect below.
        let saved = unsafe { libc::dup(libc::STDERR_FILENO) };
        assert!(saved >= 0, "dup fd 2");
        // SAFETY: dup2 atomically points fd 2 at the capture file this test owns.
        assert!(unsafe { libc::dup2(capture.as_raw_fd(), libc::STDERR_FILENO) } >= 0);
        let out = f();
        // SAFETY: saved is our dup of the original fd 2; dup2 keeps its own reference on it.
        unsafe { libc::dup2(saved, libc::STDERR_FILENO) };
        // SAFETY: the duplicate is ours and nothing else holds it after the restore above.
        unsafe { libc::close(saved) };
        let mut contents = String::new();
        capture.rewind().expect("rewind capture");
        capture.read_to_string(&mut contents).expect("read capture");
        (out, contents)
    }

    #[test]
    fn a_coded_bridge_failure_keeps_its_code_and_never_leaks_a_raw_line() {
        let missing = crate::errors::CodedError {
            code: ErrorCode::ModelMissing,
            message: "assets are missing".into(),
        };
        let err = classify_bridge_failure(
            anyhow::Error::new(missing),
            "E5RT encountered an STL exception\n",
            "Hello there",
            "am_michael",
        );
        assert_eq!(crate::errors::code_of(&err), ErrorCode::ModelMissing);

        let (opaque, on_stderr) = with_captured_fd2(|| {
            classify_bridge_failure(
                anyhow::anyhow!("FluidAudio Kokoro synthesis"),
                "E5RT encountered an STL exception\n",
                "Hello there",
                "am_michael",
            )
        });
        assert!(
            on_stderr.is_empty(),
            "a library line must ride in the error, never reach stderr: {on_stderr:?}"
        );
        assert_eq!(crate::errors::code_of(&opaque), ErrorCode::Internal);
        assert!(
            format!("{opaque:#}").contains("E5RT encountered an STL exception"),
            "the captured cause rides in the coded error: {opaque:#}"
        );
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
            let _g = EnvGuard::unset(&_lock, COMPUTE_UNITS_ENV);
            assert_eq!(
                compute_units_from_env().expect("unset is valid"),
                KokoroComputeUnits::Default
            );
        }

        // GHA exports a conditional `env:` as the empty string rather than omitting it.
        for blank in ["", "   "] {
            let _g = EnvGuard::set(&_lock, COMPUTE_UNITS_ENV, blank);
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
            let _g = EnvGuard::set(&_lock, COMPUTE_UNITS_ENV, value);
            let parsed = compute_units_from_env().unwrap_or_else(|e| panic!("{value:?}: {e}"));
            assert_eq!(parsed, expected);
            assert_eq!(preset_name(parsed), value.trim().to_ascii_lowercase());
        }

        // Must fail loudly instead of silently using the ANE the caller was avoiding.
        let _g = EnvGuard::set(&_lock, COMPUTE_UNITS_ENV, "ane-please");
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

    /// The hint has to name the language the user actually asked for. Telling
    /// someone who wanted `es-em_alex` to run `--tts en` sends them to re-run an
    /// install they already have, which fixes nothing.
    #[test]
    fn the_install_hint_names_the_voices_own_language() {
        for (lang, expected) in [
            ("en-us", "--tts en"),
            ("es", "--tts es"),
            ("zh", "--tts zh"),
        ] {
            let err = missing_assets_error(lang, &[]).to_string();
            assert!(err.contains(expected), "{lang}: {err}");
        }
    }

    /// A bare machine is missing the whole manifest; naming all forty paths
    /// would bury the one line that tells the user what to do.
    #[test]
    fn a_long_missing_list_is_summarised_rather_than_dumped() {
        let many: Vec<std::path::PathBuf> = (0..40)
            .map(|i| std::path::PathBuf::from(format!("/tmp/f{i}.bin")))
            .collect();
        let err = missing_assets_error("en-us", &many).to_string();
        assert!(err.contains("and 37 more"), "{err}");
        assert!(!err.contains("f39.bin"), "{err}");

        // A short list is named in full — that is the actionable case.
        let one = [std::path::PathBuf::from("/tmp/em_alex.bin")];
        let err = missing_assets_error("es", &one).to_string();
        assert!(err.contains("/tmp/em_alex.bin"), "{err}");
        assert!(!err.contains("more"), "{err}");
    }

    /// Both Kokoro paths must agree on phoneme → token id, or the same IPA
    /// renders as different audio depending on the backend. Kesha embeds its own
    /// copy for ONNX (`fixtures/tts/kokoro_vocab.json`) while the ANE chain reads
    /// FluidAudio's `vocab.json`; nothing keeps them in step but this.
    ///
    /// Equality is over the parsed mapping, not the bytes: the two files carry
    /// the same table with different JSON formatting, so a byte compare fails on
    /// whitespace alone. Self-skips until the ANE bundle is staged, since it only
    /// exists after `kesha install --tts`.
    #[test]
    fn the_ane_vocab_agrees_with_the_onnx_fixture() {
        let Ok(ane_dir) = crate::models::fluidaudio_ane_kokoro_dir() else {
            return;
        };
        let staged = ane_dir.join("vocab.json");
        let Ok(ane_json) = std::fs::read_to_string(&staged) else {
            return;
        };
        let ane: std::collections::HashMap<String, i64> =
            serde_json::from_str(&ane_json).expect("FluidAudio vocab.json must parse");
        let onnx: std::collections::HashMap<String, i64> =
            serde_json::from_str(include_str!("../../fixtures/tts/kokoro_vocab.json"))
                .expect("kesha vocab fixture must parse");
        assert_eq!(
            ane,
            onnx,
            "FluidAudio's ANE vocab at {} diverged from kesha's ONNX fixture — \
             a pin bump changed the token table, so the two backends would now \
             render the same IPA differently",
            staged.display()
        );
    }

    /// English comes back at the model's native level, not peak-normalized to
    /// 0 dBFS (#718). A peak of exactly 1.0 means the WAV wrapper's slam is back
    /// in the path — which is unrecoverable downstream, so this is the only place
    /// it can be caught. Needs the ANE bundle, so it self-reports rather than
    /// running everywhere.
    #[test]
    #[ignore = "needs `kesha install --tts en`; run locally on darwin-arm64"]
    fn synthesize_returns_samples_at_the_native_level() {
        let (samples, sample_rate) = synthesize("Hello world", "am_michael", 1.0).expect("synth");
        assert_eq!(sample_rate, SAMPLE_RATE);
        assert!(
            samples.len() > 1000,
            "expected non-trivial audio, got {} samples",
            samples.len()
        );
        let peak = samples.iter().fold(0.0_f32, |m, s| m.max(s.abs()));
        assert!(
            peak > 0.0 && (peak - 1.0).abs() > 1e-3,
            "peak {peak} — the 0 dBFS peak normalization is back in the path"
        );
    }
}
