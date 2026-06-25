//! WAV muxing: f32 samples → RIFF WAV byte buffer.
//!
//! Hand-rolled writer that emits plain WAVE_FORMAT_IEEE_FLOAT (0x0003)
//! without the WAVE_FORMAT_EXTENSIBLE extension. The previous hound-based
//! implementation wrote 0xFFFE with dwChannelMask=0x4, which Apple's
//! CoreAudio interprets as Front Left for mono streams — playback ended
//! up in the left ear only on AirPods / left speaker only on stereo.
//! See #245 for the diagnosis.

use std::io::Write;

const RIFF_HEADER_SIZE: u32 = 4; // "WAVE"
const FMT_CHUNK_SIZE: u32 = 18; // 16 base + 2 cbSize (set to 0)
const FACT_CHUNK_SIZE: u32 = 4; // num_samples_per_channel
const DATA_CHUNK_HEADER: u32 = 8; // "data" + size
const FMT_CHUNK_HEADER: u32 = 8; // "fmt " + size
const FACT_CHUNK_HEADER: u32 = 8; // "fact" + size

const FORMAT_IEEE_FLOAT: u16 = 0x0003;
const NUM_CHANNELS: u16 = 1; // mono throughout the kesha pipeline
const BITS_PER_SAMPLE: u16 = 32;
const BYTES_PER_SAMPLE: u32 = (BITS_PER_SAMPLE as u32) / 8;

/// Encode mono float32 samples as a RIFF WAV byte buffer at the given
/// sample rate. Output uses plain WAVE_FORMAT_IEEE_FLOAT — no EXTENSIBLE
/// extension, no `dwChannelMask` — so players treat it as a true mono
/// stream and up-mix to all output channels.
pub fn encode_wav(samples: &[f32], sample_rate: u32) -> anyhow::Result<Vec<u8>> {
    let data_size = (samples.len() as u32)
        .checked_mul(BYTES_PER_SAMPLE)
        .ok_or_else(|| anyhow::anyhow!("WAV data chunk overflow ({} samples)", samples.len()))?;
    let total_size = RIFF_HEADER_SIZE
        + FMT_CHUNK_HEADER
        + FMT_CHUNK_SIZE
        + FACT_CHUNK_HEADER
        + FACT_CHUNK_SIZE
        + DATA_CHUNK_HEADER
        + data_size;

    let mut buf: Vec<u8> = Vec::with_capacity((total_size + 8) as usize);

    buf.extend_from_slice(b"RIFF");
    buf.extend_from_slice(&total_size.to_le_bytes());
    buf.extend_from_slice(b"WAVE");

    buf.extend_from_slice(b"fmt ");
    buf.extend_from_slice(&FMT_CHUNK_SIZE.to_le_bytes());
    buf.extend_from_slice(&FORMAT_IEEE_FLOAT.to_le_bytes());
    buf.extend_from_slice(&NUM_CHANNELS.to_le_bytes());
    buf.extend_from_slice(&sample_rate.to_le_bytes());
    let byte_rate = sample_rate
        .checked_mul((NUM_CHANNELS as u32) * BYTES_PER_SAMPLE)
        .ok_or_else(|| anyhow::anyhow!("WAV byte rate overflow"))?;
    buf.extend_from_slice(&byte_rate.to_le_bytes());
    let block_align = (NUM_CHANNELS as u32) * BYTES_PER_SAMPLE;
    buf.extend_from_slice(&(block_align as u16).to_le_bytes());
    buf.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    buf.extend_from_slice(&0_u16.to_le_bytes()); // cbSize = 0 (no extension)

    // fact chunk: required for non-PCM per Microsoft spec.
    buf.extend_from_slice(b"fact");
    buf.extend_from_slice(&FACT_CHUNK_SIZE.to_le_bytes());
    buf.extend_from_slice(&(samples.len() as u32).to_le_bytes());

    buf.extend_from_slice(b"data");
    buf.extend_from_slice(&data_size.to_le_bytes());
    for s in samples {
        buf.write_all(&s.to_le_bytes())?;
    }

    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_riff_header() {
        let samples = vec![0.0f32; 24_000];
        let wav = encode_wav(&samples, 24_000).unwrap();
        assert_eq!(&wav[..4], b"RIFF", "not a RIFF: {:?}", &wav[..4]);
        assert_eq!(&wav[8..12], b"WAVE");
    }

    #[test]
    fn round_trips_through_hound() {
        let samples: Vec<f32> = (0..2400).map(|i| (i as f32 * 0.1).sin()).collect();
        let wav = encode_wav(&samples, 24_000).unwrap();
        let reader = hound::WavReader::new(std::io::Cursor::new(&wav)).unwrap();
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.spec().sample_rate, 24_000);
        assert_eq!(reader.spec().sample_format, hound::SampleFormat::Float);
        let read_back: Vec<f32> = reader
            .into_samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(read_back.len(), samples.len());
    }

    #[test]
    fn writes_plain_ieee_float_not_extensible() {
        // #245: hound wrote WAVE_FORMAT_EXTENSIBLE (0xFFFE) with dwChannelMask=0x4 → CoreAudio left-ear-only bug.
        let samples = vec![0.0_f32; 256];
        let wav = encode_wav(&samples, 24_000).unwrap();
        let fmt_chunk_offset = (0..wav.len() - 8)
            .find(|i| &wav[*i..*i + 4] == b"fmt ")
            .expect("fmt chunk not found");
        let format_tag = u16::from_le_bytes([wav[fmt_chunk_offset + 8], wav[fmt_chunk_offset + 9]]);
        assert_eq!(
            format_tag, 0x0003,
            "expected WAVE_FORMAT_IEEE_FLOAT (0x0003), got 0x{format_tag:04x} \
             — anything else (especially 0xFFFE WAVE_FORMAT_EXTENSIBLE) \
             reintroduces the channel-mask bug from #245"
        );
    }

    #[test]
    fn data_chunk_size_matches_sample_count() {
        let samples = vec![0.0_f32; 1000];
        let wav = encode_wav(&samples, 16_000).unwrap();
        let data_offset = (0..wav.len() - 8)
            .find(|i| &wav[*i..*i + 4] == b"data")
            .expect("data chunk not found");
        let data_size = u32::from_le_bytes([
            wav[data_offset + 4],
            wav[data_offset + 5],
            wav[data_offset + 6],
            wav[data_offset + 7],
        ]);
        assert_eq!(data_size, (samples.len() * 4) as u32);
    }
}
