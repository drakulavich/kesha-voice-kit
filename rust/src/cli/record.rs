use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;

pub fn run(out: Option<PathBuf>, live: bool, max_seconds: u64) -> Result<()> {
    if live {
        return run_live(Duration::from_secs(max_seconds));
    }

    let out = out.ok_or_else(|| anyhow::anyhow!("--out is required unless --live is passed"))?;
    let summary =
        crate::record::record_default_input_to_wav(&out, Duration::from_secs(max_seconds))?;
    eprintln!(
        "Recorded {} ({} Hz, {} channel{}, {} frames)",
        summary.path.display(),
        summary.sample_rate,
        summary.channels,
        if summary.channels == 1 { "" } else { "s" },
        summary.frames,
    );
    Ok(())
}

#[cfg(all(feature = "coreml", target_os = "macos"))]
fn run_live(max_duration: Duration) -> Result<()> {
    // CoreML prints on a background queue — between streaming feeds, and again at
    // model teardown after the session drops — which a scoped guard cannot cover.
    // fd 1 stays shielded for the whole session; see `fluid_stdout::StdoutShield`.
    let shield = crate::fluid_stdout::StdoutShield::new();
    let outcome = crate::record::record_default_input_live(max_duration)?;
    let transcript = outcome.transcript.trim();
    if transcript.is_empty() {
        eprintln!("No speech detected.");
    } else {
        shield.write_stdout(format!("{transcript}\n").as_bytes())?;
    }
    if let Some(signal) = outcome.interrupted_by {
        // The transcript is out; report the cancellation the way a shell reads
        // one so a caller can tell it apart from a run that reached its end.
        std::process::exit(128 + signal);
    }
    Ok(())
}

#[cfg(not(all(feature = "coreml", target_os = "macos")))]
fn run_live(_max_duration: Duration) -> Result<()> {
    use crate::coded_bail;
    use crate::errors::ErrorCode;
    coded_bail!(
        ErrorCode::UnsupportedPlatform,
        "live transcription requires a CoreML engine on Apple Silicon; \
         use `kesha record --out <path>` and transcribe the file instead"
    );
}
