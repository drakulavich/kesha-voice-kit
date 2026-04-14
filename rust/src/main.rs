use anyhow::Result;
use clap::{Parser, Subcommand};

mod audio;
mod backend;
mod capabilities;
mod lang_id;
mod models;
mod text_lang;
mod transcribe;

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
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    if cli.capabilities_json {
        let caps = capabilities::get_capabilities();
        println!("{}", serde_json::to_string(&caps)?);
        return Ok(());
    }

    match cli.command {
        Some(Commands::Transcribe { audio_path }) => {
            let text = transcribe::transcribe(&audio_path)?;
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
        Some(Commands::Install { no_cache }) => {
            models::install(no_cache)?;
            eprintln!("Install complete.");
        }
        None => {
            eprintln!("Usage: kesha-engine <command>");
            eprintln!("Run --help for usage information");
            std::process::exit(1);
        }
    }

    Ok(())
}
