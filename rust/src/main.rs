use anyhow::Result;
use clap::{Parser, Subcommand};

mod audio;
mod backend;
mod capabilities;
mod debug;
mod lang_id;
mod models;
mod text_lang;
mod transcribe;
#[cfg(feature = "tts")]
mod tts;
mod vad;

#[derive(Parser)]
#[command(name = "kesha-engine", version)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Print capabilities as JSON
    #[arg(long = "capabilities-json")]
    capabilities_json: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Transcribe an audio file
    Transcribe {
        /// Path to audio file
        audio_path: String,
        /// Force Silero VAD preprocessing. Requires the VAD model to be
        /// installed (`kesha install --vad`). Mutually exclusive with
        /// `--no-vad`. Without either flag, VAD auto-engages on audio
        /// ≥ 120 s when the model is installed (#187).
        #[arg(long, conflicts_with = "no_vad")]
        vad: bool,
        /// Disable VAD preprocessing regardless of duration or install state.
        #[arg(long = "no-vad")]
        no_vad: bool,
    },
    /// Detect spoken language from audio
    DetectLang {
        /// Path to audio file
        audio_path: String,
    },
    /// Detect language of text (macOS only)
    DetectTextLang {
        /// Text to analyze
        text: String,
    },
    /// Download models
    Install {
        /// Re-download even if cached
        #[arg(long)]
        no_cache: bool,
        /// Also install TTS models (Kokoro EN + Piper RU, ~390MB). Requires `espeak-ng` on PATH.
        #[cfg(feature = "tts")]
        #[arg(long)]
        tts: bool,
        /// Also install Silero VAD (~2.3MB) for long-audio preprocessing.
        #[arg(long)]
        vad: bool,
    },
    /// Synthesize speech from text (TTS)
    #[cfg(feature = "tts")]
    Say {
        /// Text to synthesize (omit to read from stdin)
        text: Option<String>,
        /// Voice id, e.g. `en-af_heart`
        #[arg(long)]
        voice: Option<String>,
        /// Override the voice's default espeak language code, e.g. `en-gb`
        #[arg(long)]
        lang: Option<String>,
        /// Output file (default: stdout)
        #[arg(long)]
        out: Option<std::path::PathBuf>,
        /// Speaking rate (0.5–2.0)
        #[arg(long, default_value_t = 1.0)]
        rate: f32,
        /// List installed voices and exit
        #[arg(long)]
        list_voices: bool,
        /// Parse the input as SSML (supports <speak>, <break>; strips unknown tags).
        /// See issue #122 for the v1 tag matrix.
        #[arg(long)]
        ssml: bool,
        /// Explicit model path (testing override)
        #[arg(long, hide = true)]
        model: Option<std::path::PathBuf>,
        /// Explicit voice embedding file (testing override)
        #[arg(long = "voice-file", hide = true)]
        voice_file: Option<std::path::PathBuf>,
    },
}

#[cfg(feature = "tts")]
struct SayArgs {
    text: Option<String>,
    voice: Option<String>,
    lang: Option<String>,
    out: Option<std::path::PathBuf>,
    rate: f32,
    list_voices: bool,
    ssml: bool,
    model: Option<std::path::PathBuf>,
    voice_file: Option<std::path::PathBuf>,
}

#[cfg(feature = "tts")]
fn ensure_espeak_available() -> anyhow::Result<()> {
    use std::process::Command;
    let check = Command::new("espeak-ng").arg("--version").output();
    match check {
        Ok(o) if o.status.success() => Ok(()),
        _ => {
            anyhow::bail!(
                "espeak-ng not found on PATH.\n\
                 Install it and retry:\n\
                   macOS:   brew install espeak-ng\n\
                   Linux:   apt install espeak-ng  (or your distro equivalent)\n\
                   Windows: choco install espeak-ng"
            )
        }
    }
}

#[cfg(feature = "tts")]
fn list_kokoro_voices(cache: &std::path::Path) -> Vec<String> {
    let dir = cache.join("models/kokoro-82m/voices");
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

#[cfg(feature = "tts")]
fn list_piper_ru_voices(cache: &std::path::Path) -> Vec<String> {
    // Piper RU files follow `ru_RU-<name>-<quality>.onnx`; report just the <name>.
    let dir = cache.join("models/piper-ru");
    std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("onnx") {
                return None;
            }
            let stem = p.file_stem()?.to_string_lossy().into_owned();
            // stem like "ru_RU-denis-medium" → "denis"
            let name = stem.strip_prefix("ru_RU-")?.split('-').next()?;
            Some(format!("ru-{name}"))
        })
        .collect()
}

/// Map a TTS error to the documented exit code for `kesha say`.
/// 2 = bad input, 4 = synthesis failure, 5 = text too long.
/// (Voice-not-installed exits 1 directly from the resolver path.)
#[cfg(feature = "tts")]
fn exit_code_for_tts_err(e: &tts::TtsError) -> i32 {
    match e {
        tts::TtsError::EmptyText => 2,
        tts::TtsError::TextTooLong { .. } => 5,
        tts::TtsError::SynthesisFailed(_) => 4,
    }
}

#[cfg(feature = "tts")]
fn run_say(a: SayArgs) -> i32 {
    use std::io::{Read, Write};

    if a.list_voices {
        let cache = models::cache_dir();
        let mut voice_ids: Vec<String> = list_kokoro_voices(&cache)
            .into_iter()
            .chain(list_piper_ru_voices(&cache))
            .collect();
        // macos-* voices live in the OS, not the cache — enumerate them via
        // the AVSpeech helper (#141). Best-effort: if the helper is absent or
        // errors out, we still show Kokoro/Piper voices.
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

    let text_joined = match a.text {
        Some(s) => s,
        None => {
            let mut buf = String::new();
            if let Err(e) = std::io::stdin().read_to_string(&mut buf) {
                eprintln!("error: failed to read stdin: {e}");
                return 4;
            }
            buf.trim().to_string()
        }
    };

    // `--model` + `--voice-file` are Kokoro-specific testing overrides.
    // Pinned model/voice paths bypass the cache lookup.
    let resolved = match (a.model, a.voice_file) {
        (Some(model_path), Some(voice_path)) => tts::voices::ResolvedVoice::Kokoro {
            model_path,
            voice_path,
            espeak_lang: "en-us",
        },
        (Some(_), None) | (None, Some(_)) => {
            eprintln!("error: pass both --model and --voice-file or neither");
            return 2;
        }
        (None, None) => {
            let id = a.voice.as_deref().unwrap_or(tts::voices::DEFAULT_VOICE_ID);
            match tts::voices::resolve_voice(&models::cache_dir(), id) {
                Ok(r) => r,
                Err(e) => {
                    eprintln!("error: {e}");
                    return 1;
                }
            }
        }
    };

    let espeak_lang = a
        .lang
        .clone()
        .unwrap_or_else(|| resolved.espeak_lang().to_string());
    let engine = match &resolved {
        tts::voices::ResolvedVoice::Kokoro {
            model_path,
            voice_path,
            ..
        } => tts::EngineChoice::Kokoro {
            model_path,
            voice_path,
            speed: a.rate,
        },
        tts::voices::ResolvedVoice::Piper {
            model_path,
            config_path,
            ..
        } => tts::EngineChoice::Piper {
            model_path,
            config_path,
            speed: a.rate,
        },
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        tts::voices::ResolvedVoice::AVSpeech { voice_id } => {
            tts::EngineChoice::AVSpeech { voice_id }
        }
    };

    let wav = match tts::say(tts::SayOptions {
        text: &text_joined,
        lang: &espeak_lang,
        engine,
        ssml: a.ssml,
    }) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("error: {e}");
            return exit_code_for_tts_err(&e);
        }
    };

    let write_result = match a.out {
        Some(p) => std::fs::write(&p, &wav).map_err(|e| e.to_string()),
        None => std::io::stdout().write_all(&wav).map_err(|e| e.to_string()),
    };
    if let Err(msg) = write_result {
        eprintln!("error: write failed: {msg}");
        return 4;
    }
    0
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    if cli.capabilities_json {
        let caps = capabilities::get_capabilities();
        println!("{}", serde_json::to_string(&caps)?);
        return Ok(());
    }

    match cli.command {
        Some(Commands::Transcribe {
            audio_path,
            vad,
            no_vad,
        }) => {
            let mode = transcribe::VadMode::from_flags(vad, no_vad);
            let text = transcribe::transcribe(&audio_path, mode)?;
            println!("{}", text);
        }
        Some(Commands::DetectLang { audio_path }) => {
            let result = lang_id::detect_audio_language(&audio_path)?;
            println!("{}", serde_json::to_string(&result)?);
        }
        Some(Commands::DetectTextLang { text }) => {
            let result = text_lang::detect_text_language(&text)?;
            println!("{}", serde_json::to_string(&result)?);
        }
        Some(Commands::Install {
            no_cache,
            #[cfg(feature = "tts")]
            tts,
            vad,
        }) => {
            models::install(no_cache)?;
            #[cfg(feature = "tts")]
            if tts {
                ensure_espeak_available()?;
                models::download_tts(no_cache)?;
                eprintln!("TTS models installed.");
            }
            if vad {
                models::download_vad(no_cache)?;
                eprintln!("VAD model installed.");
            }
            eprintln!("Install complete.");
        }
        #[cfg(feature = "tts")]
        Some(Commands::Say {
            text,
            voice,
            lang,
            out,
            rate,
            list_voices,
            ssml,
            model,
            voice_file,
        }) => {
            std::process::exit(run_say(SayArgs {
                text,
                voice,
                lang,
                out,
                rate,
                list_voices,
                ssml,
                model,
                voice_file,
            }));
        }
        None => {
            eprintln!("Usage: kesha-engine <command>");
            eprintln!("Run --help for usage information");
            std::process::exit(1);
        }
    }

    Ok(())
}
