// rust/examples/spike_render.rs
// Usage: spike_render <model.onnx> <voice.bin> <out_dir> < ipa.tsv
// ipa.tsv lines: "<tag>\t<ipa string>"
use kesha_engine::tts::{kokoro::Kokoro, tokenizer::Tokenizer, voices};
use std::io::BufRead;
use std::path::Path;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let (model, voice_bin, out_dir) = (&args[1], &args[2], &args[3]);
    let tok = Tokenizer::load()?;
    let mut k = Kokoro::load(Path::new(model))?;
    let voice = std::fs::read(voice_bin)?;
    let voice: Vec<f32> = voice
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        let (tag, ipa) = line.split_once('\t').expect("tag\\tipa");
        let ids = Tokenizer::pad_to_context(tok.encode(ipa));
        let style = voices::select_style(&voice, ids.len());
        let audio = k.infer(&ids, style, 1.0)?;
        let path = format!("{out_dir}/{tag}.wav");
        write_wav_24k_mono(&path, &audio)?;
        println!("{tag}: {} samples", audio.len());
    }
    Ok(())
}

fn write_wav_24k_mono(path: &str, samples: &[f32]) -> anyhow::Result<()> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 24_000,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let mut w = hound::WavWriter::create(path, spec)?;
    for s in samples {
        w.write_sample(*s)?;
    }
    w.finalize()?;
    Ok(())
}
