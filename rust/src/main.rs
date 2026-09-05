use anyhow::Result;
use clap::Parser;

use kesha_engine::cli::args::{Cli, Commands};
use kesha_engine::{capabilities, cli, debug, errors};

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
        Some(Commands::Describe) => println!("{}", kesha_engine::protocol::describe::render()?),
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
