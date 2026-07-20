//! OggOpus output validation (#223).
//!
//! These tests don't need a TTS model — they exercise the encoder pipeline
//! directly with synthetic PCM. The model-backed e2e check (`kesha say --format
//! ogg-opus | sendVoice`) lives in the manual QA loop documented in #223 and
//! the smoke-test scripts under `scripts/`.

#![cfg(feature = "tts")]

use kesha_engine::tts::encode::{self, OutputFormat};

/// First 27 bytes of every Ogg page are the page header. Layout per RFC 3533 §6:
///
/// ```text
///  0..4   "OggS"
///  4      version = 0
///  5      header_type (1 = continuation, 2 = bos, 4 = eos)
///  6..14  granule_position (i64 LE)
///  14..18 bitstream_serial_number (u32 LE)
///  18..22 page_sequence_number (u32 LE)
///  22..26 CRC32
///  26     number_page_segments
/// ```
const OGG_PAGE_MAGIC: &[u8; 4] = b"OggS";

#[test]
fn ogg_opus_starts_with_ogg_page_and_opus_head() {
    // 100 ms of 440 Hz @ 24 kHz so we land inside a single Opus frame with no
    // resample. Real synthesis is much longer; this is the minimum we need to
    // exercise the muxer end-to-end.
    let sr = 24_000u32;
    let n = (sr as f32 * 0.5) as usize;
    let samples: Vec<f32> = (0..n)
        .map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 440.0 / sr as f32).sin() * 0.3)
        .collect();
    let bytes = encode::encode(&samples, sr, OutputFormat::ogg_opus_default()).unwrap();

    // First page must be the BOS page carrying OpusHead.
    assert_eq!(&bytes[..4], OGG_PAGE_MAGIC);
    assert_eq!(bytes[4], 0, "Ogg version is always 0");
    let bos_flag = bytes[5];
    assert_eq!(bos_flag & 0x02, 0x02, "first page must have BOS flag set");

    // Find OpusHead packet (first page's payload begins after the 27-byte
    // header + segment table; for a small head it's right after the segments).
    let head_at = find(&bytes, b"OpusHead").expect("OpusHead missing");
    // Channel count at offset +9 must be 1 (mono); pre-skip is non-zero.
    assert_eq!(bytes[head_at + 9], 1, "must be mono");
    let pre_skip = u16::from_le_bytes([bytes[head_at + 10], bytes[head_at + 11]]);
    assert!(
        pre_skip > 0,
        "pre_skip must be set so players strip warm-up"
    );
    let input_sr = u32::from_le_bytes([
        bytes[head_at + 12],
        bytes[head_at + 13],
        bytes[head_at + 14],
        bytes[head_at + 15],
    ]);
    assert_eq!(
        input_sr, sr,
        "OpusHead.input_sample_rate must reflect engine SR"
    );
}

#[test]
fn ogg_opus_has_eos_flag_on_final_page() {
    // Walk pages and assert exactly one EOS flag, on the last page.
    let sr = 24_000u32;
    let samples: Vec<f32> = vec![0.0; sr as usize]; // 1 s of silence
    let bytes = encode::encode(&samples, sr, OutputFormat::ogg_opus_default()).unwrap();

    let mut eos_seen = 0usize;
    let mut last_was_eos = false;
    for window_start in find_all(&bytes, OGG_PAGE_MAGIC) {
        let header_type = bytes[window_start + 5];
        let is_eos = header_type & 0x04 == 0x04;
        if is_eos {
            eos_seen += 1;
        }
        last_was_eos = is_eos;
    }
    assert_eq!(eos_seen, 1, "exactly one page must carry EOS");
    assert!(last_was_eos, "EOS must be on the final page");
}

#[test]
fn ogg_opus_is_substantially_smaller_than_wav() {
    // The 24x size win versus WAV is the whole point of this feature
    // (per #223). 5 seconds @ 32 kbps Opus ≈ 20 KB; same in 24 kHz mono f32
    // WAV ≈ 480 KB. We assert at least a 5x improvement to leave headroom for
    // libopus version drift.
    let sr = 24_000u32;
    let n = sr as usize * 5;
    // White noise so the encoder can't trivially compress a constant signal.
    let mut state: u32 = 0x1234_5678;
    let samples: Vec<f32> = (0..n)
        .map(|_| {
            state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            ((state >> 16) as f32 / 32_768.0 - 1.0) * 0.1
        })
        .collect();

    let wav = encode::encode(&samples, sr, OutputFormat::Wav).unwrap();
    let opus = encode::encode(&samples, sr, OutputFormat::ogg_opus_default()).unwrap();

    assert!(
        opus.len() * 5 < wav.len(),
        "expected opus ({} B) to be at least 5x smaller than wav ({} B)",
        opus.len(),
        wav.len()
    );
}

#[test]
fn ogg_opus_resamples_22050_to_supported_rate() {
    // Vosk-RU runs at 22.05 kHz; libopus only supports 8/12/16/24/48 kHz.
    // The encoder must transparently resample.
    let src_sr = 22_050u32;
    let n = (src_sr as f32 * 0.4) as usize;
    let samples: Vec<f32> = (0..n)
        .map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 880.0 / src_sr as f32).sin() * 0.3)
        .collect();
    let bytes = encode::encode(&samples, src_sr, OutputFormat::ogg_opus_default()).unwrap();
    assert_eq!(&bytes[..4], OGG_PAGE_MAGIC);
    // OpusHead.input_sample_rate must reflect the *original* engine SR so
    // players display the right thing — even though libopus encoded at 24 kHz.
    let head_at = find(&bytes, b"OpusHead").unwrap();
    let input_sr = u32::from_le_bytes([
        bytes[head_at + 12],
        bytes[head_at + 13],
        bytes[head_at + 14],
        bytes[head_at + 15],
    ]);
    assert_eq!(input_sr, src_sr);
}

#[test]
fn opus_bitrate_override_changes_output_size() {
    // Sanity: bumping --bitrate visibly inflates the file. Catches a future
    // regression where the CLI flag silently fails to plumb through.
    let sr = 24_000u32;
    let n = sr as usize * 3;
    let mut state: u32 = 0xdead_beef;
    let samples: Vec<f32> = (0..n)
        .map(|_| {
            state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            ((state >> 16) as f32 / 32_768.0 - 1.0) * 0.1
        })
        .collect();

    let low = encode::encode(
        &samples,
        sr,
        OutputFormat::OggOpus {
            bitrate: 16_000,
            sample_rate: 24_000,
        },
    )
    .unwrap();
    let high = encode::encode(
        &samples,
        sr,
        OutputFormat::OggOpus {
            bitrate: 64_000,
            sample_rate: 24_000,
        },
    )
    .unwrap();
    assert!(
        high.len() > low.len(),
        "64k encode ({} B) should be larger than 16k encode ({} B)",
        high.len(),
        low.len()
    );
}

// =============================================================================
// helpers
// =============================================================================

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn find_all(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + needle.len() <= haystack.len() {
        if &haystack[i..i + needle.len()] == needle {
            out.push(i);
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}
