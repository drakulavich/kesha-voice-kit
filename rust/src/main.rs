use clap::{Parser, Subcommand};
use anyhow::Result;

mod audio;
mod backend;
mod capabilities;

#[derive(Parser)]
#[command(name = "parakeet-engine", version)]
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
            eprintln!("TODO: transcribe {}", audio_path);
        }
        Some(Commands::DetectLang { audio_path }) => {
            eprintln!("TODO: detect-lang {}", audio_path);
        }
        Some(Commands::DetectTextLang { text }) => {
            eprintln!("TODO: detect-text-lang {}", text);
        }
        Some(Commands::Install { no_cache }) => {
            eprintln!("TODO: install (no_cache={})", no_cache);
        }
        None => {
            eprintln!("Usage: parakeet-engine <command>");
            eprintln!("Run --help for usage information");
            std::process::exit(1);
        }
    }

    Ok(())
}
