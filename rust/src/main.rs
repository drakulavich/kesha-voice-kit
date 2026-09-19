use anyhow::Result;
use clap::{error::ErrorKind, Parser};

use kesha_engine::cli::args::{Cli, Commands};
use kesha_engine::errors::ErrorCode;
use kesha_engine::protocol::events;
use kesha_engine::{cli, debug, errors};

fn main() {
    // Anchor the `KESHA_DEBUG=1` `+Nms` timeline before `Cli::try_parse()` so
    // clap parsing + env probes are counted toward the first `dtrace!`'s
    // prefix (Greptile P2 on #293). No-op when debug is off.
    debug::init();
    errors::install_panic_hook();
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) if matches!(e.kind(), ErrorKind::DisplayHelp | ErrorKind::DisplayVersion) => {
            let _ = e.print();
            return;
        }
        Err(e) => {
            events::error(ErrorCode::InvalidArg, e.to_string().trim_end(), None);
            std::process::exit(2);
        }
    };

    // The hook has already reported a panic as E_INTERNAL; 1 keeps the exit status inside the contract.
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run_command(cli.command))) {
        Ok(Ok(())) => {}
        Ok(Err(err)) => std::process::exit(errors::report(&err)),
        Err(_) => std::process::exit(1),
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
            auto_stop,
            auto_stop_silence_ms,
            auto_stop_threshold,
            auto_stop_min_speech_ms,
        }) => {
            let recorded = cli::record::endpoint_config(
                auto_stop,
                auto_stop_silence_ms,
                auto_stop_threshold,
                auto_stop_min_speech_ms,
            )
            .and_then(|endpoint| cli::record::run(out, live, max_seconds, endpoint));
            if let Err(err) = recorded {
                std::process::exit(cli::record::exit_code(&err));
            }
        }
        Some(Commands::Describe) => {
            let s = kesha_engine::protocol::describe::render()?;
            kesha_engine::dtrace!("describe: rendered {} bytes", s.len());
            println!("{s}");
        }
        Some(Commands::Install(args)) => cli::install::run(args)?,
        #[cfg(feature = "tts")]
        Some(Commands::Say(args)) => {
            std::process::exit(cli::say::run(args));
        }
        None => {
            events::error(
                ErrorCode::InvalidArg,
                "Usage: kesha-engine <command>\nRun --help for usage information",
                None,
            );
            std::process::exit(2);
        }
    }

    Ok(())
}
