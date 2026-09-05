use std::path::PathBuf;
use std::time::Duration;

use anyhow::Result;

use crate::protocol::events;

pub fn endpoint_config(
    enabled: bool,
    trailing_silence_ms: Option<u32>,
    threshold: Option<f32>,
    min_speech_ms: Option<u32>,
) -> Result<Option<crate::vad::EndpointConfig>> {
    if !enabled {
        return Ok(None);
    }

    let defaults = crate::vad::EndpointConfig::default();
    let threshold = threshold.unwrap_or(defaults.threshold);
    let trailing_silence_ms = trailing_silence_ms.unwrap_or(defaults.trailing_silence_ms);
    let min_speech_ms = min_speech_ms.unwrap_or(defaults.min_speech_ms);
    if !(0.0..=1.0).contains(&threshold) || threshold == 0.0 {
        anyhow::bail!("--auto-stop-threshold must be greater than 0 and at most 1");
    }
    if trailing_silence_ms == 0 {
        anyhow::bail!("--auto-stop-silence-ms must be greater than 0");
    }
    if min_speech_ms == 0 {
        anyhow::bail!("--auto-stop-min-speech-ms must be greater than 0");
    }

    Ok(Some(crate::vad::EndpointConfig {
        threshold,
        trailing_silence_ms,
        min_speech_ms,
    }))
}

pub fn run(
    out: Option<PathBuf>,
    live: bool,
    max_seconds: u64,
    endpoint: Option<crate::vad::EndpointConfig>,
) -> Result<()> {
    if live {
        return run_live(Duration::from_secs(max_seconds), endpoint);
    }

    let out = out.ok_or_else(|| anyhow::anyhow!("--out is required unless --live is passed"))?;
    let summary =
        crate::record::record_default_input_to_wav(&out, Duration::from_secs(max_seconds))?;
    events::progress(
        None,
        format!(
            "Recorded {} ({} Hz, {} channel{}, {} frames)",
            summary.path.display(),
            summary.sample_rate,
            summary.channels,
            if summary.channels == 1 { "" } else { "s" },
            summary.frames,
        ),
    );
    Ok(())
}

#[cfg(all(feature = "coreml", target_os = "macos"))]
fn run_live(max_duration: Duration, endpoint: Option<crate::vad::EndpointConfig>) -> Result<()> {
    // CoreML prints on a background queue — between streaming feeds, and again at
    // model teardown after the session drops — which a scoped guard cannot cover.
    // fd 1 stays shielded for the whole session; see `fluid_stdout::StdoutShield`.
    let shield = crate::fluid_stdout::StdoutShield::new();
    // The recovery WAV is only dropped once this closure has returned Ok, so a
    // write to a closed terminal or a dead pipe keeps the audio (#962).
    let outcome = crate::record::record_default_input_live(max_duration, endpoint, |transcript| {
        if transcript.is_empty() {
            events::progress(None, "No speech detected.");
            return Ok(());
        }
        shield.write_stdout(format!("{transcript}\n").as_bytes())?;
        Ok(())
    })?;
    if let Some(signal) = outcome.interrupted_by {
        // The transcript is out; report the cancellation the way a shell reads
        // one so a caller can tell it apart from a run that reached its end.
        std::process::exit(128 + signal);
    }
    Ok(())
}

#[cfg(not(all(feature = "coreml", target_os = "macos")))]
fn run_live(_max_duration: Duration, _endpoint: Option<crate::vad::EndpointConfig>) -> Result<()> {
    use crate::coded_bail;
    use crate::errors::ErrorCode;
    coded_bail!(
        ErrorCode::UnsupportedPlatform,
        "live transcription requires a CoreML engine on Apple Silicon; \
         use `kesha record --out <path>` and transcribe the file instead"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_uses_stable_defaults_when_only_auto_stop_is_requested() {
        assert_eq!(
            endpoint_config(true, None, None, None).unwrap().map(|cfg| (
                cfg.threshold,
                cfg.trailing_silence_ms,
                cfg.min_speech_ms
            )),
            Some((0.5, 1_000, 250))
        );
    }

    #[test]
    fn endpoint_rejects_a_threshold_that_can_never_observe_silence() {
        let err = endpoint_config(true, None, Some(0.0), None).unwrap_err();
        assert!(err.to_string().contains("--auto-stop-threshold"));
    }
}
