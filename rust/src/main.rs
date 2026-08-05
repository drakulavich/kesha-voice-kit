use anyhow::Result;
use clap::{Parser, Subcommand};

use kesha_engine::{capabilities, cli, debug, errors};

#[derive(Parser)]
#[command(name = "kesha-engine", version)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Print capabilities as JSON
    #[arg(long = "capabilities-json")]
    capabilities_json: bool,

    /// Print the error-code taxonomy as JSON and exit.
    #[arg(long = "error-codes-json")]
    error_codes_json: bool,
}

#[derive(Subcommand)]
enum Commands {
    /// Transcribe an audio file
    Transcribe {
        /// Path to audio file
        audio_path: String,
        /// Output structured JSON with text and timestamped segments.
        #[arg(long)]
        json: bool,
        /// Force Silero VAD preprocessing. Requires the VAD model to be
        /// installed (`kesha install --vad`). Mutually exclusive with
        /// `--no-vad`. Without either flag, VAD auto-engages on audio
        /// ≥ 120 s when the model is installed (#187).
        #[arg(long, conflicts_with = "no_vad")]
        vad: bool,
        /// Disable VAD preprocessing regardless of duration or install state.
        #[arg(long = "no-vad")]
        no_vad: bool,
        /// Include speaker labels in transcript segments. Requires --json.
        /// Engages VAD windowing automatically at any duration (labels attach
        /// to speech segments), so it cannot be combined with `--no-vad`.
        /// Currently darwin-arm64 only (#199).
        #[arg(long)]
        speakers: bool,
        /// Rewrite spoken-form numbers, money, dates and times to written form
        /// ("two hundred thirty two" → "232"). English-only in practice; other
        /// languages pass through unchanged (#710).
        #[arg(long)]
        itn: bool,
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
    /// Record microphone audio to a WAV file
    Record {
        /// Output WAV file. Required unless --live is passed.
        #[arg(long, conflicts_with = "live")]
        out: Option<std::path::PathBuf>,
        /// Transcribe the microphone live and print the transcript to stdout
        /// instead of writing a WAV. CoreML builds on macOS only.
        #[arg(long)]
        live: bool,
        /// Maximum recording duration in seconds
        #[arg(long = "max-seconds", default_value_t = 120)]
        max_seconds: u64,
    },
    /// Download models
    Install(cli::install::InstallArgs),
    /// Synthesize speech from text (TTS)
    #[cfg(feature = "tts")]
    Say(cli::say::SayArgs),
}

fn main() {
    // Anchor the `KESHA_DEBUG=1` `+Nms` timeline before `Cli::parse()` so
    // clap parsing + env probes are counted toward the first `dtrace!`'s
    // prefix (Greptile P2 on #293). No-op when debug is off.
    debug::init();
    let cli = Cli::parse();

    if cli.capabilities_json {
        let caps = capabilities::get_capabilities();
        match serde_json::to_string(&caps) {
            Ok(s) => println!("{s}"),
            Err(e) => std::process::exit(errors::report(&anyhow::Error::new(e))),
        }
        return;
    }

    if cli.error_codes_json {
        println!("{}", errors::error_codes_json());
        return;
    }

    if let Err(err) = run_command(cli.command) {
        std::process::exit(errors::report(&err));
    }
}

fn run_command(command: Option<Commands>) -> Result<()> {
    match command {
        Some(Commands::Transcribe {
            audio_path,
            json,
            vad,
            no_vad,
            speakers,
            itn,
        }) => cli::transcribe::run(audio_path, json, vad, no_vad, speakers, itn)?,
        Some(Commands::DetectLang { audio_path }) => cli::detect_lang::run(audio_path)?,
        Some(Commands::DetectTextLang { text }) => cli::detect_text_lang::run(text)?,
        Some(Commands::Record {
            out,
            live,
            max_seconds,
        }) => cli::record::run(out, live, max_seconds)?,
        Some(Commands::Install(args)) => cli::install::run(args)?,
        #[cfg(feature = "tts")]
        Some(Commands::Say(args)) => {
            std::process::exit(cli::say::run(args));
        }
        None => {
            eprintln!("Usage: kesha-engine <command>");
            eprintln!("Run --help for usage information");
            std::process::exit(1);
        }
    }

    Ok(())
}
