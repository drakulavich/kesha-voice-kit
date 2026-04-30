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
mod util;
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
        /// Also install TTS models (Kokoro EN + Vosk RU, ~990MB).
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
        /// Voice id, e.g. `en-am_michael`
        #[arg(long)]
        voice: Option<String>,
        /// Override the voice's default BCP 47 language code, e.g. `en-gb`
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
        /// Output audio format. Defaults to `wav` (or inferred from `--out`
        /// extension when omitted). Supported: `wav`, `ogg-opus`. See #223.
        #[arg(long, value_name = "FORMAT")]
        format: Option<String>,
        /// Opus bitrate in bits/second (e.g. 16000, 32000, 64000). Only valid
        /// with `--format ogg-opus`. Default 32000 (Telegram-grade).
        #[arg(long, value_name = "BPS")]
        bitrate: Option<i32>,
        /// Encoder sample rate. Only valid with `--format ogg-opus`. Must be
        /// one of 8000/12000/16000/24000/48000. Default 24000.
        #[arg(long = "sample-rate", value_name = "HZ")]
        sample_rate: Option<u32>,
        /// Explicit model path (testing override)
        #[arg(long, hide = true)]
        model: Option<std::path::PathBuf>,
        /// Explicit voice embedding file (testing override)
        #[arg(long = "voice-file", hide = true)]
        voice_file: Option<std::path::PathBuf>,
        /// Long-lived loop: read newline-delimited JSON requests on stdin,
        /// reuse loaded engines across calls. Spike for #213.
        #[arg(long = "stdin-loop", hide = true)]
        stdin_loop: bool,
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
    format: Option<String>,
    bitrate: Option<i32>,
    sample_rate: Option<u32>,
    model: Option<std::path::PathBuf>,
    voice_file: Option<std::path::PathBuf>,
    stdin_loop: bool,
}

/// Resolve the user-supplied `--format` / `--bitrate` / `--sample-rate` /
/// `--out` combination into a single [`tts::OutputFormat`]. Mirrors the UX
/// table from #223:
///
/// 1. If `--format` is given, parse it (`wav` | `ogg-opus`).
/// 2. Otherwise, sniff the `--out` extension (`.wav` → wav, `.ogg`/`.opus`
///    → ogg-opus).
/// 3. Otherwise default to `Wav` — preserves the historical `kesha say > x`
///    behaviour where stdout was always RIFF.
///
/// `--bitrate` / `--sample-rate` only matter for opus and override the
/// defaults. When the user picked WAV but supplied either flag, we surface a
/// clear error rather than silently dropping them.
#[cfg(feature = "tts")]
fn resolve_output_format(
    format: Option<&str>,
    bitrate: Option<i32>,
    sample_rate: Option<u32>,
    out: Option<&std::path::Path>,
) -> Result<tts::OutputFormat, String> {
    use std::str::FromStr;

    let mut chosen = match (format, out) {
        (Some(f), _) => tts::OutputFormat::from_str(f)?,
        (None, Some(p)) => p
            .extension()
            .and_then(|e| e.to_str())
            .and_then(tts::encode::format_from_extension)
            .unwrap_or_default(),
        (None, None) => tts::OutputFormat::default(),
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
    } else if matches!(chosen, tts::OutputFormat::Wav)
        && (bitrate.is_some() || sample_rate.is_some())
    {
        return Err("--bitrate / --sample-rate only apply to --format ogg-opus".to_string());
    }

    Ok(chosen)
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
fn list_vosk_ru_voices(cache: &std::path::Path) -> Vec<String> {
    // Vosk-TTS Russian is a single multi-speaker model — once installed, all
    // five baked-in speakers are available. Same gate as resolve_vosk_ru, so
    // partial installs don't advertise voices that fail at synthesis time.
    if !models::is_vosk_ru_cached(&cache.join("models/vosk-ru")) {
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
        return run_say_stdin_loop();
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
        tts::voices::ResolvedVoice::Vosk {
            model_dir,
            speaker_id,
        } => tts::EngineChoice::Vosk {
            model_dir,
            speaker_id: *speaker_id,
            speed: a.rate,
        },
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        tts::voices::ResolvedVoice::AVSpeech { voice_id } => {
            tts::EngineChoice::AVSpeech { voice_id }
        }
    };

    let format = match resolve_output_format(
        a.format.as_deref(),
        a.bitrate,
        a.sample_rate,
        a.out.as_deref(),
    ) {
        Ok(f) => f,
        Err(msg) => {
            eprintln!("error: {msg}");
            return 2;
        }
    };

    let bytes = match tts::say(tts::SayOptions {
        text: &text_joined,
        lang: &espeak_lang,
        engine,
        ssml: a.ssml,
        format,
    }) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("error: {e}");
            return exit_code_for_tts_err(&e);
        }
    };

    let write_result = match a.out {
        Some(p) => std::fs::write(&p, &bytes).map_err(|e| e.to_string()),
        None => std::io::stdout()
            .write_all(&bytes)
            .map_err(|e| e.to_string()),
    };
    if let Err(msg) = write_result {
        eprintln!("error: write failed: {msg}");
        return 4;
    }
    0
}

// =============================================================================
// --stdin-loop spike for #213
//
// Long-lived TTS process. Stdin: newline-delimited JSON requests. Stdout:
// framed binary responses (1-byte status + 4-byte LE u32 length + payload).
// Loaded engines (Kokoro, Vosk, voice files, tokenizer) are cached across
// requests, amortising the ~21 s/call Vosk model load and ~1 s/call Kokoro
// load measured on this machine.
//
// Protocol is intentionally simple — clients are co-located (Bun spawning the
// engine), no auth, no auth surface, no daemon lifecycle. SSML is not yet
// supported in the loop. Plain text + Kokoro/Vosk/AVSpeech only.
// =============================================================================

#[cfg(feature = "tts")]
#[derive(serde::Deserialize)]
struct LoopRequest {
    text: String,
    voice: String,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    bitrate: Option<i32>,
    #[serde(default)]
    sample_rate: Option<u32>,
    #[serde(default)]
    lang: Option<String>,
    #[serde(default = "default_rate")]
    rate: f32,
}

#[cfg(feature = "tts")]
fn default_rate() -> f32 {
    1.0
}

#[cfg(feature = "tts")]
#[derive(Default)]
struct LoopCache {
    tokenizer: Option<tts::tokenizer::Tokenizer>,
    kokoro: Option<(std::path::PathBuf, tts::kokoro::Kokoro)>,
    voice_files: std::collections::HashMap<std::path::PathBuf, Vec<f32>>,
    vosk: std::collections::HashMap<std::path::PathBuf, tts::vosk::Vosk>,
}

#[cfg(feature = "tts")]
fn run_say_stdin_loop() -> i32 {
    use std::io::BufRead;

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    let cache_dir = models::cache_dir();
    let mut cache = LoopCache::default();

    for line_res in stdin.lock().lines() {
        let line = match line_res {
            Ok(l) => l,
            Err(e) => {
                let _ = write_loop_err(&mut stdout, &format!("read: {e}"));
                return 4;
            }
        };
        if line.trim().is_empty() {
            continue;
        }
        let req: LoopRequest = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let _ = write_loop_err(&mut stdout, &format!("json: {e}"));
                continue;
            }
        };
        match handle_loop_request(&req, &cache_dir, &mut cache) {
            Ok(bytes) => {
                let _ = write_loop_ok(&mut stdout, &bytes);
            }
            Err(msg) => {
                let _ = write_loop_err(&mut stdout, &msg);
            }
        }
    }
    0
}

#[cfg(feature = "tts")]
fn write_loop_ok(w: &mut impl std::io::Write, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&[0u8])?;
    w.write_all(&(payload.len() as u32).to_le_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

#[cfg(feature = "tts")]
fn write_loop_err(w: &mut impl std::io::Write, msg: &str) -> std::io::Result<()> {
    let bytes = msg.as_bytes();
    w.write_all(&[1u8])?;
    w.write_all(&(bytes.len() as u32).to_le_bytes())?;
    w.write_all(bytes)?;
    w.flush()
}

#[cfg(feature = "tts")]
fn handle_loop_request(
    req: &LoopRequest,
    cache_dir: &std::path::Path,
    c: &mut LoopCache,
) -> Result<Vec<u8>, String> {
    let format = resolve_output_format(req.format.as_deref(), req.bitrate, req.sample_rate, None)?;
    let resolved = tts::voices::resolve_voice(cache_dir, &req.voice).map_err(|e| e.to_string())?;
    let espeak_lang = req
        .lang
        .clone()
        .unwrap_or_else(|| resolved.espeak_lang().to_string());

    match resolved {
        tts::voices::ResolvedVoice::Kokoro {
            model_path,
            voice_path,
            ..
        } => {
            if c.tokenizer.is_none() {
                c.tokenizer = Some(
                    tts::tokenizer::Tokenizer::load()
                        .map_err(|e| format!("tokenizer load: {e}"))?,
                );
            }
            if c.kokoro.as_ref().is_none_or(|(p, _)| p != &model_path) {
                let k = tts::kokoro::Kokoro::load(&model_path)
                    .map_err(|e| format!("kokoro load: {e}"))?;
                c.kokoro = Some((model_path.clone(), k));
            }
            if !c.voice_files.contains_key(&voice_path) {
                let v =
                    tts::voices::load_voice(&voice_path).map_err(|e| format!("voice load: {e}"))?;
                c.voice_files.insert(voice_path.clone(), v);
            }
            let tok = c.tokenizer.as_ref().expect("tokenizer just loaded");
            let voice = c.voice_files.get(&voice_path).expect("voice just loaded");
            let k = &mut c.kokoro.as_mut().expect("kokoro just loaded").1;

            let ipa =
                tts::g2p::text_to_ipa(&req.text, &espeak_lang).map_err(|e| format!("g2p: {e}"))?;
            let ids = tok.encode(&ipa);
            if ids.is_empty() {
                return Err("no recognizable phonemes in input".into());
            }
            let active = ids.len();
            let padded = tts::tokenizer::Tokenizer::pad_to_context(ids);
            let style = tts::voices::select_style(voice, active);
            let audio = k
                .infer(&padded, style, req.rate)
                .map_err(|e| format!("infer: {e}"))?;
            tts::encode::encode(&audio, tts::kokoro::SAMPLE_RATE, format)
                .map_err(|e| format!("encode: {e}"))
        }
        tts::voices::ResolvedVoice::Vosk {
            model_dir,
            speaker_id,
        } => {
            if !c.vosk.contains_key(&model_dir) {
                let v = tts::vosk::Vosk::load(&model_dir).map_err(|e| format!("vosk load: {e}"))?;
                c.vosk.insert(model_dir.clone(), v);
            }
            let v = c.vosk.get_mut(&model_dir).expect("vosk just loaded");
            let sample_rate = v.sample_rate();
            let audio = v
                .infer(&req.text, speaker_id, req.rate)
                .map_err(|e| format!("vosk infer: {e}"))?;
            tts::encode::encode(&audio, sample_rate, format).map_err(|e| format!("encode: {e}"))
        }
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        tts::voices::ResolvedVoice::AVSpeech { voice_id } => tts::say(tts::SayOptions {
            text: &req.text,
            lang: &espeak_lang,
            engine: tts::EngineChoice::AVSpeech {
                voice_id: &voice_id,
            },
            ssml: false,
            format,
        })
        .map_err(|e| e.to_string()),
    }
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
            format,
            bitrate,
            sample_rate,
            model,
            voice_file,
            stdin_loop,
        }) => {
            std::process::exit(run_say(SayArgs {
                text,
                voice,
                lang,
                out,
                rate,
                list_voices,
                ssml,
                format,
                bitrate,
                sample_rate,
                model,
                voice_file,
                stdin_loop,
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
