use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "kesha-engine", version)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<Commands>,

    /// Print capabilities as JSON
    #[arg(long = "capabilities-json")]
    pub capabilities_json: bool,

    /// Print the error-code taxonomy as JSON and exit.
    #[arg(long = "error-codes-json")]
    pub error_codes_json: bool,
}

#[derive(Subcommand)]
pub enum Commands {
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
        /// Stop a live transcription after trailing silence. Requires the
        /// explicitly installed Silero VAD model (`kesha install --vad`).
        #[arg(long, requires = "live")]
        auto_stop: bool,
        /// Trailing silence before --auto-stop ends the recording.
        #[arg(long = "auto-stop-silence-ms", requires = "auto_stop")]
        auto_stop_silence_ms: Option<u32>,
        /// Silero speech-probability threshold for --auto-stop.
        #[arg(long = "auto-stop-threshold", requires = "auto_stop")]
        auto_stop_threshold: Option<f32>,
        /// Minimum detected speech before --auto-stop may end a recording.
        #[arg(long = "auto-stop-min-speech-ms", requires = "auto_stop")]
        auto_stop_min_speech_ms: Option<u32>,
    },
    /// Print the protocol schema as JSON
    Describe,
    /// Download models
    Install(crate::cli::install::InstallArgs),
    /// Synthesize speech from text (TTS)
    #[cfg(feature = "tts")]
    Say(crate::cli::say::SayArgs),
}
