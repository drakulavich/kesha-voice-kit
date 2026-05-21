use anyhow::Result;

use crate::transcribe::{self, TranscribeOptionsBuilder, VadMode};

pub fn run(audio_path: String, json: bool, vad: bool, no_vad: bool, speakers: bool) -> Result<()> {
    if speakers && !json {
        anyhow::bail!("--speakers requires --json");
    }
    let mode = VadMode::from_flags(vad, no_vad);
    let opts = if json {
        let mut b = TranscribeOptionsBuilder::new().vad(mode).with_segments();
        if speakers {
            b = b.with_speakers();
        }
        b.build()
    } else {
        TranscribeOptionsBuilder::new().vad(mode).build()
    };
    // The diarization path (`--speakers`, CoreML only) triggers FluidAudio's
    // Espresso runtime to print an `E5RT ... STL exception` to stdout during
    // asynchronous model teardown — after the synchronous call returns, so the
    // scoped guard inside `diarize` can't catch it. Shield fd 1 for the rest of
    // the process and emit the JSON through the saved original stdout. See
    // `fluid_stdout::StdoutShield`. `--speakers` always implies `--json`, so the
    // only stdout write on this path is the single JSON blob.
    #[cfg(all(feature = "system_diarize", target_os = "macos"))]
    if speakers {
        let shield = crate::fluid_stdout::StdoutShield::new();
        let output = transcribe::transcribe_with_options(&audio_path, &opts)?;
        let payload = format!("{}\n", serde_json::to_string(&output)?);
        shield.write_stdout(payload.as_bytes())?;
        return Ok(());
    }

    let output = transcribe::transcribe_with_options(&audio_path, &opts)?;
    if json {
        println!("{}", serde_json::to_string(&output)?);
    } else {
        println!("{}", output.text);
    }
    Ok(())
}
