use anyhow::Result;
use clap::{error::ErrorKind, Parser};

use kesha_engine::cli::args::{Cli, Commands};
use kesha_engine::errors::ErrorCode;
use kesha_engine::protocol::events;
use kesha_engine::{capabilities, cli, debug, errors};

fn main() {
    // Anchor the `KESHA_DEBUG=1` `+Nms` timeline before `Cli::try_parse()` so
    // clap parsing + env probes are counted toward the first `dtrace!`'s
    // prefix (Greptile P2 on #293). No-op when debug is off.
    debug::init();
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
            auto_stop,
            auto_stop_silence_ms,
            auto_stop_threshold,
            auto_stop_min_speech_ms,
        }) => {
            let endpoint = cli::record::endpoint_config(
                auto_stop,
                auto_stop_silence_ms,
                auto_stop_threshold,
                auto_stop_min_speech_ms,
            )?;
            cli::record::run(out, live, max_seconds, endpoint)?
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
