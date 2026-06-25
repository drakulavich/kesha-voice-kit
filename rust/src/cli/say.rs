use anyhow::Result;
use std::path::PathBuf;

use crate::{models, say_loop, tts};

pub struct SayArgs {
    pub text: Option<String>,
    pub voice: Option<String>,
    pub lang: Option<String>,
    pub out: Option<PathBuf>,
    pub rate: f32,
    pub list_voices: bool,
    pub ssml: bool,
    pub format: Option<String>,
    pub bitrate: Option<i32>,
    pub sample_rate: Option<u32>,
    pub model: Option<PathBuf>,
    pub voice_file: Option<PathBuf>,
    pub stdin_loop: bool,
    pub no_expand_abbrev: bool,
}

/// Resolve `--format` / `--bitrate` / `--sample-rate` / `--out` into a
/// [`tts::OutputFormat`]. Priority: explicit flag > `--out` extension > Wav
/// default (preserves historical stdout-RIFF behaviour). See #223.
pub(crate) fn resolve_output_format(
    format: Option<&str>,
    bitrate: Option<i32>,
    sample_rate: Option<u32>,
    out: Option<&std::path::Path>,
) -> Result<tts::OutputFormat, String> {
    use std::str::FromStr;

    // #275 D10: source label fed to the dtrace probe at the bottom.
    let (mut chosen, source): (tts::OutputFormat, &'static str) = match (format, out) {
        (Some(f), _) => (tts::OutputFormat::from_str(f)?, "--format"),
        (None, Some(p)) => {
            let ext_fmt = p
                .extension()
                .and_then(|e| e.to_str())
                .and_then(tts::encode::format_from_extension);
            match ext_fmt {
                Some(fmt) => (fmt, "out-ext"),
                None => (tts::OutputFormat::default(), "default"),
            }
        }
        (None, None) => (tts::OutputFormat::default(), "default"),
    };

    if let tts::OutputFormat::OggOpus {
        bitrate: ref mut br,
        sample_rate: ref mut sr,
    } = chosen
    {
        if let Some(b) = bitrate {
            *br = b;
        }
        if let Some(r) = sample_rate {
            *sr = r;
        }
    } else if bitrate.is_some() || sample_rate.is_some() {
        return Err("--bitrate / --sample-rate only apply to --format ogg-opus".to_string());
    }

    crate::dtrace!("format::resolved chosen={chosen:?} source={source}");
    Ok(chosen)
}

fn list_kokoro_voices(_cache: &std::path::Path) -> Vec<String> {
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    {
        return tts::fluid_kokoro::available_voice_ids();
    }
    #[allow(unreachable_code)]
    {
        let dir = _cache.join("models/kokoro-82m/voices");
        std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let p = e.path();
                if p.extension().and_then(|s| s.to_str()) == Some("bin") {
                    p.file_stem().map(|s| format!("en-{}", s.to_string_lossy()))
                } else {
                    None
                }
            })
            .collect()
    }
}

fn list_vosk_ru_voices(cache: &std::path::Path) -> Vec<String> {
    // Vosk-TTS Russian is a single multi-speaker model — once installed, all
    // five baked-in speakers are available. Same gate as resolve_vosk_ru, so
    // partial installs don't advertise voices that fail at synthesis time.
    let dir = models::model_dir_at(models::ModelKind::VoskRu, cache);
    if !models::is_cached_in(models::ModelKind::VoskRu, &dir) {
        return Vec::new();
    }
    vec![
        "ru-vosk-f01".into(),
        "ru-vosk-f02".into(),
        "ru-vosk-f03".into(),
        "ru-vosk-m01".into(),
        "ru-vosk-m02".into(),
    ]
}

/// Map a TTS error to the documented exit code for `kesha say`.
/// 2 = bad input, 4 = synthesis failure, 5 = text too long.
/// (Voice-not-installed exits 1 directly from the resolver path.)
fn exit_code_for_tts_err(e: &tts::TtsError) -> i32 {
    match e {
        tts::TtsError::EmptyText => 2,
        tts::TtsError::TextTooLong { .. } => 5,
        tts::TtsError::SynthesisFailed(_) | tts::TtsError::Coded { .. } => 4,
    }
}

/// Read text from stdin, trimming surrounding whitespace.
fn read_stdin() -> Result<String, i32> {
    use std::io::Read;
    let mut buf = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut buf) {
        eprintln!("error [E_INTERNAL]: failed to read stdin: {e}");
        return Err(4);
    }
    Ok(buf.trim().to_string())
}

/// Validate text length against TTS limits; returns the validated string or an
/// exit code on failure.
fn validate_text(text: String) -> Result<String, i32> {
    if text.is_empty() {
        let err = tts::TtsError::EmptyText;
        eprintln!("error [{}]: {err}", err.code().as_str());
        return Err(exit_code_for_tts_err(&err));
    }
    let len = text.chars().count();
    if len > tts::MAX_TEXT_CHARS {
        let err = tts::TtsError::TextTooLong {
            max: tts::MAX_TEXT_CHARS,
            actual: len,
        };
        eprintln!("error [{}]: {err}", err.code().as_str());
        return Err(exit_code_for_tts_err(&err));
    }
    Ok(text)
}

/// Resolve `--model` + `--voice-file` overrides or look up the voice by id.
/// Returns `(ResolvedVoice, exit_code_on_err)`.
fn resolve_voice(
    model: Option<PathBuf>,
    voice_file: Option<PathBuf>,
    voice_id: Option<&str>,
) -> Result<tts::voices::ResolvedVoice, i32> {
    match (model, voice_file) {
        (Some(model_path), Some(voice_path)) => Ok(tts::voices::ResolvedVoice::Kokoro {
            model_path,
            voice_path,
            espeak_lang: "en-us",
        }),
        (Some(_), None) | (None, Some(_)) => {
            eprintln!(
                "error [{}]: pass both --model and --voice-file or neither",
                crate::errors::ErrorCode::InvalidArg.as_str()
            );
            Err(2)
        }
        (None, None) => {
            let id = voice_id.unwrap_or(tts::voices::DEFAULT_VOICE_ID);
            tts::voices::resolve_voice(&models::cache_dir(), id).map_err(|err| {
                eprintln!("error [{}]: {err:#}", crate::errors::code_of(&err).as_str());
                1
            })
        }
    }
}

/// Build the [`tts::EngineChoice`] from the resolved voice and playback rate.
fn engine_choice<'a>(resolved: &'a tts::voices::ResolvedVoice, rate: f32) -> tts::EngineChoice<'a> {
    match resolved {
        tts::voices::ResolvedVoice::Kokoro {
            model_path,
            voice_path,
            ..
        } => tts::EngineChoice::Kokoro {
            model_path,
            voice_path,
            speed: rate,
        },
        #[cfg(all(
            feature = "system_kokoro",
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        tts::voices::ResolvedVoice::FluidKokoro { voice_id, .. } => {
            tts::EngineChoice::FluidKokoro {
                voice_id,
                speed: rate,
            }
        }
        tts::voices::ResolvedVoice::Vosk {
            model_dir,
            speaker_id,
        } => tts::EngineChoice::Vosk {
            model_dir,
            speaker_id: *speaker_id,
            speed: rate,
        },
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        tts::voices::ResolvedVoice::AVSpeech { voice_id } => tts::EngineChoice::AVSpeech {
            voice_id,
            speed: rate,
        },
    }
}

/// Write synthesized bytes to `--out` file or stdout.
fn write_output(out: Option<&std::path::Path>, bytes: &[u8]) -> Result<(), i32> {
    use std::io::Write;
    let result = match out {
        Some(p) => std::fs::write(p, bytes).map_err(|e| e.to_string()),
        None => std::io::stdout()
            .write_all(bytes)
            .map_err(|e| e.to_string()),
    };
    result.map_err(|msg| {
        eprintln!("error [E_INTERNAL]: write failed: {msg}");
        4
    })
}

pub fn run(a: SayArgs) -> i32 {
    if a.list_voices {
        let cache = models::cache_dir();
        let mut voice_ids: Vec<String> = list_kokoro_voices(&cache)
            .into_iter()
            .chain(list_vosk_ru_voices(&cache))
            .collect();
        // macos-* voices live in the OS, not the cache — enumerate them via
        // the AVSpeech helper (#141). Best-effort: if the helper is absent or
        // errors out, we still show Kokoro/Vosk voices.
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        voice_ids.extend(tts::avspeech::list_voices(None));
        voice_ids.sort();
        if voice_ids.is_empty() {
            println!("No voices installed. Run: kesha install --tts");
        } else {
            for id in voice_ids {
                println!("{id}");
            }
        }
        return 0;
    }

    if a.stdin_loop {
        return say_loop::run();
    }

    let format = match resolve_output_format(
        a.format.as_deref(),
        a.bitrate,
        a.sample_rate,
        a.out.as_deref(),
    ) {
        Ok(f) => f,
        Err(msg) => {
            eprintln!(
                "error [{}]: {msg}",
                crate::errors::ErrorCode::InvalidArg.as_str()
            );
            return 2;
        }
    };

    let raw_text = match a.text {
        Some(s) => s,
        None => match read_stdin() {
            Ok(s) => s,
            Err(code) => return code,
        },
    };

    let text = match validate_text(raw_text) {
        Ok(t) => t,
        Err(code) => return code,
    };

    let resolved = match resolve_voice(a.model, a.voice_file, a.voice.as_deref()) {
        Ok(r) => r,
        Err(code) => return code,
    };

    let espeak_lang = a
        .lang
        .clone()
        .unwrap_or_else(|| resolved.espeak_lang().to_string());
    let engine = engine_choice(&resolved, a.rate);

    let bytes = match tts::say(tts::SayOptions {
        text: &text,
        lang: &espeak_lang,
        engine,
        ssml: a.ssml,
        format,
        expand_abbrev: !a.no_expand_abbrev,
    }) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("error [{}]: {e}", e.code().as_str());
            return exit_code_for_tts_err(&e);
        }
    };

    match write_output(a.out.as_deref(), &bytes) {
        Ok(()) => 0,
        Err(code) => code,
    }
}
