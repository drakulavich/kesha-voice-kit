//! Output audio encoding: f32 PCM samples → wire bytes.
//!
//! Closes #223. Today the engine only spoke WAV; this module adds OGG/Opus
//! (the format Telegram, WhatsApp, Signal, and Discord render as native voice
//! messages) and keeps the door open for `mp3` / `flac` / `raw-pcm` later.
//!
//! ## Design
//! - One enum [`OutputFormat`] selects the wire format.
//! - [`encode`] takes mono f32 samples + their native sample rate and produces
//!   an in-memory byte buffer. The CLI hands those bytes straight to stdout or
//!   `--out`, so this stays allocation-honest and side-effect-free.
//! - Resampling for Opus (libopus only accepts 8/12/16/24/48 kHz) reuses the
//!   same `rubato` async sinc resampler that `crate::audio` uses for STT.
//! - WAV stays bit-exact with the previous `wav::encode_wav` output to keep
//!   existing e2e tests and `kesha say > out.wav` callers green.

use std::str::FromStr;

#[cfg(feature = "tts")]
use audioadapter_buffers::direct::SequentialSliceOfVecs;
#[cfg(feature = "tts")]
use rubato::{
    calculate_cutoff, Async, FixedAsync, Resampler, SincInterpolationParameters,
    SincInterpolationType, WindowFunction,
};

use super::wav;

/// Wire format for [`encode`]. New variants live behind `--format` on the CLI;
/// values are spelled in kebab-case to match `clap` parsing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum OutputFormat {
    /// 32-bit float mono RIFF WAV at the engine's native sample rate.
    /// This is the historical default and the no-resample path.
    #[default]
    Wav,
    /// OGG-encapsulated Opus, mono.
    ///
    /// Per RFC 7845 the only Opus-supported sample rates are 8/12/16/24/48 kHz;
    /// callers asking for anything else are resampled before encoding. The
    /// IdHeader records the engine's original native rate (e.g. 24 kHz for
    /// Kokoro, 22 050 Hz for Vosk-RU) per RFC 7845 §5.1 — players use this
    /// for display and seeking, not decoding.
    OggOpus {
        /// Encoder bitrate in bits/second. ~32 kbps gives Telegram-quality
        /// voice; 16 kbps is intelligible but tinny; 64 kbps is broadcast-grade.
        bitrate: i32,
        /// Sample rate fed to the encoder. Must be one of 8000/12000/16000/
        /// 24000/48000. Defaults to 24 kHz when [`OutputFormat::ogg_opus_default`]
        /// is used — matches Kokoro's native rate so most calls skip resampling.
        sample_rate: u32,
    },
}

impl OutputFormat {
    /// The Telegram-friendly default Opus profile: 24 kHz mono at 32 kbps.
    /// Kokoro speaks 24 kHz natively, so this avoids a resample round-trip
    /// for the common path while staying inside Telegram's voice-note window.
    pub const fn ogg_opus_default() -> Self {
        Self::OggOpus {
            bitrate: 32_000,
            sample_rate: 24_000,
        }
    }
}

/// Parse `--format` values.
///
/// Accepts: `wav`, `ogg-opus` (and the historical aliases `opus` / `ogg`).
/// Bitrate / sample rate are not encoded in the string — they come from
/// `--bitrate` / `--sample-rate` and are layered on top by the CLI.
impl FromStr for OutputFormat {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "wav" => Ok(Self::Wav),
            "ogg-opus" | "opus" | "ogg" => Ok(Self::ogg_opus_default()),
            other => Err(format!(
                "unknown --format '{other}'. supported: wav, ogg-opus"
            )),
        }
    }
}

/// Infer a default format from the `--out` extension when `--format` is absent.
/// Returns `None` for unknown extensions so the caller can fall back to `Wav`.
pub fn format_from_extension(ext: &str) -> Option<OutputFormat> {
    match ext.to_ascii_lowercase().as_str() {
        "wav" => Some(OutputFormat::Wav),
        "ogg" | "opus" | "oga" => Some(OutputFormat::ogg_opus_default()),
        _ => None,
    }
}

/// Encode `samples` (mono f32 at `src_rate` Hz) into the chosen wire format.
///
/// Errors bubble up as `anyhow` so callers can wrap them in a `TtsError`
/// without losing the underlying cause (libopus error strings, container I/O,
/// resampler init).
#[cfg(feature = "tts")]
pub fn encode(samples: &[f32], src_rate: u32, fmt: OutputFormat) -> anyhow::Result<Vec<u8>> {
    match fmt {
        OutputFormat::Wav => wav::encode_wav(samples, src_rate),
        OutputFormat::OggOpus {
            bitrate,
            sample_rate,
        } => encode_ogg_opus(samples, src_rate, sample_rate, bitrate),
    }
}

// =============================================================================
// OGG/Opus muxing
// =============================================================================

/// libopus only accepts these input sample rates.
#[cfg(feature = "tts")]
const OPUS_VALID_SR: &[u32] = &[8_000, 12_000, 16_000, 24_000, 48_000];

/// 20 ms frame — Opus's sweet spot for VBR voice. At 48 kHz that's 960 samples;
/// at 24 kHz it's 480; at 16 kHz it's 320. Keep it constant in *time* so the
/// granule position math (`absgp` in samples-at-48kHz) stays linear.
#[cfg(feature = "tts")]
const FRAME_DURATION_MS: u32 = 20;

/// libopus recommended encode buffer size — large enough for any frame at any
/// bitrate the public API exposes.
#[cfg(feature = "tts")]
const MAX_OPUS_PACKET: usize = 4_000;

/// Pre-skip in samples (at 48 kHz). 80 ms is libopus's recommended value for
/// 20 ms frames (`80 * 48 = 3840`). Players use this to discard codec warm-up
/// samples at the start of playback.
#[cfg(feature = "tts")]
const PRE_SKIP_48K: u16 = 3_840;

#[cfg(feature = "tts")]
fn encode_ogg_opus(
    samples: &[f32],
    src_rate: u32,
    target_sr: u32,
    bitrate: i32,
) -> anyhow::Result<Vec<u8>> {
    use opus::{Application, Channels, Encoder};

    if !OPUS_VALID_SR.contains(&target_sr) {
        anyhow::bail!(
            "ogg-opus: --sample-rate must be one of {:?}, got {target_sr}",
            OPUS_VALID_SR
        );
    }
    if !(6_000..=510_000).contains(&bitrate) {
        anyhow::bail!("ogg-opus: --bitrate must be 6000..=510000 bps, got {bitrate}");
    }

    // Resample to `target_sr` if the engine's native rate doesn't match. We
    // re-use the rubato sinc machinery from `crate::audio` rather than pulling
    // in a third resampler dep.
    use std::borrow::Cow;
    let resampled: Cow<[f32]> = if src_rate == target_sr {
        Cow::Borrowed(samples)
    } else {
        Cow::Owned(resample_mono(samples, src_rate, target_sr)?)
    };

    // Build the encoder. `Application::Voip` matches what the issue wants:
    // best perceptual quality at low bitrates for speech.
    let mut enc = Encoder::new(target_sr, Channels::Mono, Application::Voip)
        .map_err(|e| anyhow::anyhow!("opus encoder: {e}"))?;
    enc.set_bitrate(opus::Bitrate::Bits(bitrate))
        .map_err(|e| anyhow::anyhow!("opus set_bitrate: {e}"))?;
    // Tell libopus this is voice — affects internal mode selection.
    enc.set_signal(opus::Signal::Voice)
        .map_err(|e| anyhow::anyhow!("opus set_signal: {e}"))?;

    let frame_size = (target_sr * FRAME_DURATION_MS / 1_000) as usize;

    // Build the OggOpus stream:
    //   page 0: OpusHead (BOS, sequence 0, granule 0)
    //   page 1: OpusTags (sequence 1, granule 0)
    //   page 2..: audio packets, with EOS on the last
    let mut buf: Vec<u8> = Vec::with_capacity(samples.len());
    let cursor = std::io::Cursor::new(&mut buf);
    let mut writer = ogg::PacketWriter::new(cursor);

    // Stable per-stream serial — reproducible test fixtures, not random.
    // Real codecs randomise this so muxed streams can't collide; for a
    // single-stream Opus file the value is irrelevant to decoders.
    let serial: u32 = 0x4b_45_53_48; // 'KESH'

    // ---- OpusHead (RFC 7845 §5.1) -------------------------------------------
    let opus_head = build_opus_head(src_rate);
    writer
        .write_packet(opus_head, serial, ogg::PacketWriteEndInfo::EndPage, 0)
        .map_err(|e| anyhow::anyhow!("ogg write OpusHead: {e}"))?;

    // ---- OpusTags (RFC 7845 §5.2) -------------------------------------------
    let opus_tags = build_opus_tags();
    writer
        .write_packet(opus_tags, serial, ogg::PacketWriteEndInfo::EndPage, 0)
        .map_err(|e| anyhow::anyhow!("ogg write OpusTags: {e}"))?;

    // ---- Audio packets ------------------------------------------------------
    // Granule position = number of decoded samples produced *so far* at 48 kHz.
    // It includes the pre-skip, which players subtract before playback. We
    // accumulate sample count in target_sr and convert once per page boundary.
    let total_samples = resampled.len();
    let n_full_packets = total_samples / frame_size;
    let mut sample_pos_48k: u64 = u64::from(PRE_SKIP_48K);

    let mut pcm_buf = vec![0.0f32; frame_size];
    let mut packet = vec![0u8; MAX_OPUS_PACKET];

    for i in 0..n_full_packets {
        let start = i * frame_size;
        pcm_buf.copy_from_slice(&resampled[start..start + frame_size]);
        let nbytes = enc
            .encode_float(&pcm_buf, &mut packet)
            .map_err(|e| anyhow::anyhow!("opus encode (frame {i}): {e}"))?;

        sample_pos_48k += target_to_48k(frame_size as u32, target_sr);

        let is_last = i + 1 == n_full_packets && total_samples.is_multiple_of(frame_size);
        let info = if is_last {
            ogg::PacketWriteEndInfo::EndStream
        } else {
            ogg::PacketWriteEndInfo::NormalPacket
        };
        writer
            .write_packet(packet[..nbytes].to_vec(), serial, info, sample_pos_48k)
            .map_err(|e| anyhow::anyhow!("ogg write audio (frame {i}): {e}"))?;
    }

    // Tail frame: zero-pad the last partial frame so libopus can encode it.
    // The granule position records *real* samples only — pad samples don't
    // increment absgp, so players truncate cleanly at the original duration.
    let leftover = total_samples - n_full_packets * frame_size;
    if leftover > 0 {
        for (slot, src) in pcm_buf
            .iter_mut()
            .zip(&resampled[n_full_packets * frame_size..])
        {
            *slot = *src;
        }
        for slot in pcm_buf.iter_mut().skip(leftover) {
            *slot = 0.0;
        }
        let nbytes = enc
            .encode_float(&pcm_buf, &mut packet)
            .map_err(|e| anyhow::anyhow!("opus encode (tail): {e}"))?;
        sample_pos_48k += target_to_48k(leftover as u32, target_sr);
        writer
            .write_packet(
                packet[..nbytes].to_vec(),
                serial,
                ogg::PacketWriteEndInfo::EndStream,
                sample_pos_48k,
            )
            .map_err(|e| anyhow::anyhow!("ogg write audio (tail): {e}"))?;
    } else if n_full_packets == 0 {
        // Edge case: empty / sub-frame input. Emit a single silent EOS packet
        // so we still produce a well-formed OggOpus file.
        for slot in pcm_buf.iter_mut() {
            *slot = 0.0;
        }
        let nbytes = enc
            .encode_float(&pcm_buf, &mut packet)
            .map_err(|e| anyhow::anyhow!("opus encode (empty): {e}"))?;
        writer
            .write_packet(
                packet[..nbytes].to_vec(),
                serial,
                ogg::PacketWriteEndInfo::EndStream,
                sample_pos_48k,
            )
            .map_err(|e| anyhow::anyhow!("ogg write audio (empty): {e}"))?;
    }

    drop(writer);
    Ok(buf)
}

/// Convert a sample count at `target_sr` to its equivalent at 48 kHz, used for
/// OggOpus granule positions per RFC 7845 §4. Integer-only so granule values
/// stay reproducible across architectures.
#[cfg(feature = "tts")]
fn target_to_48k(samples: u32, target_sr: u32) -> u64 {
    (u64::from(samples) * 48_000) / u64::from(target_sr)
}

/// Build the 19-byte OpusHead identification packet. Layout per RFC 7845 §5.1:
///
/// ```text
///  0..8   "OpusHead"
///  8      version = 1
///  9      channel_count = 1 (mono)
///  10..12 pre_skip (u16 LE)
///  12..16 input_sample_rate (u32 LE)  ← engine's native rate; players use
///                                       this for display/seeking, not decoding
///  16..18 output_gain Q7.8 = 0
///  18     channel_mapping_family = 0 (mono/stereo, no per-stream mapping)
/// ```
#[cfg(feature = "tts")]
fn build_opus_head(input_sample_rate: u32) -> Vec<u8> {
    let mut head = Vec::with_capacity(19);
    head.extend_from_slice(b"OpusHead");
    head.push(1); // version
    head.push(1); // channel count
    head.extend_from_slice(&PRE_SKIP_48K.to_le_bytes());
    head.extend_from_slice(&input_sample_rate.to_le_bytes());
    head.extend_from_slice(&0i16.to_le_bytes()); // output gain Q7.8
    head.push(0); // channel mapping family
    head
}

/// Build the OpusTags comment packet (RFC 7845 §5.2). Telegram doesn't read
/// these but a well-formed packet here is required by the spec; mediaplayers
/// (`ffprobe`, VLC) will surface them.
#[cfg(feature = "tts")]
fn build_opus_tags() -> Vec<u8> {
    let vendor = format!("kesha-voice-kit {}", env!("CARGO_PKG_VERSION"));
    let vendor_bytes = vendor.as_bytes();

    let mut tags = Vec::with_capacity(8 + 4 + vendor_bytes.len() + 4);
    tags.extend_from_slice(b"OpusTags");
    tags.extend_from_slice(&(vendor_bytes.len() as u32).to_le_bytes());
    tags.extend_from_slice(vendor_bytes);
    tags.extend_from_slice(&0u32.to_le_bytes()); // user comment count
    tags
}

/// Mono f32 resampler. Mirrors the design in `crate::audio::resample` (same
/// rubato params; we don't share the function because that one targets the
/// transcribe pipeline's hard-coded 16 kHz).
#[cfg(feature = "tts")]
fn resample_mono(samples: &[f32], src_rate: u32, dst_rate: u32) -> anyhow::Result<Vec<f32>> {
    if src_rate == dst_rate {
        return Ok(samples.to_vec());
    }
    let ratio = f64::from(dst_rate) / f64::from(src_rate);

    let sinc_len = 128;
    let window = WindowFunction::BlackmanHarris2;
    let params = SincInterpolationParameters {
        sinc_len,
        f_cutoff: calculate_cutoff(sinc_len, window),
        interpolation: SincInterpolationType::Cubic,
        oversampling_factor: 256,
        window,
    };

    let chunk_size = 1024usize;
    let channels = 1usize;
    let mut resampler =
        Async::<f32>::new_sinc(ratio, 1.1, &params, chunk_size, channels, FixedAsync::Input)
            .map_err(|e| anyhow::anyhow!("resampler init: {e}"))?;

    let total_frames = samples.len();
    let mut out: Vec<f32> = Vec::with_capacity((total_frames as f64 * ratio * 1.1) as usize);
    let mut frame_offset = 0usize;

    while frame_offset + chunk_size <= total_frames {
        let frames_needed = resampler.input_frames_next();
        if frame_offset + frames_needed > total_frames {
            break;
        }
        let chunk: Vec<Vec<f32>> =
            vec![samples[frame_offset..frame_offset + frames_needed].to_vec()];
        let in_adapter = SequentialSliceOfVecs::new(&chunk, channels, frames_needed)
            .map_err(|e| anyhow::anyhow!("resample input: {e}"))?;

        let out_max = resampler.output_frames_max();
        let mut out_data: Vec<Vec<f32>> = vec![vec![0.0f32; out_max]; channels];
        let mut out_adapter = SequentialSliceOfVecs::new_mut(&mut out_data, channels, out_max)
            .map_err(|e| anyhow::anyhow!("resample output: {e}"))?;

        let (_in, n_out) = resampler
            .process_into_buffer(&in_adapter, &mut out_adapter, None)
            .map_err(|e| anyhow::anyhow!("resample step: {e}"))?;
        out.extend_from_slice(&out_data[0][..n_out]);
        frame_offset += frames_needed;
    }

    if frame_offset < total_frames {
        let remaining = total_frames - frame_offset;
        let frames_needed = resampler.input_frames_next();
        let mut last_chunk: Vec<f32> = samples[frame_offset..].to_vec();
        last_chunk.resize(frames_needed, 0.0);
        let chunk: Vec<Vec<f32>> = vec![last_chunk];
        let in_adapter = SequentialSliceOfVecs::new(&chunk, channels, frames_needed)
            .map_err(|e| anyhow::anyhow!("resample tail input: {e}"))?;

        let out_max = resampler.output_frames_max();
        let mut out_data: Vec<Vec<f32>> = vec![vec![0.0f32; out_max]; channels];
        let mut out_adapter = SequentialSliceOfVecs::new_mut(&mut out_data, channels, out_max)
            .map_err(|e| anyhow::anyhow!("resample tail output: {e}"))?;

        let (_in, n_out) = resampler
            .process_into_buffer(&in_adapter, &mut out_adapter, None)
            .map_err(|e| anyhow::anyhow!("resample tail: {e}"))?;
        let real_out = ((remaining as f64 * ratio) as usize).min(n_out);
        out.extend_from_slice(&out_data[0][..real_out]);
    }

    Ok(out)
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_format_strings() {
        assert_eq!(OutputFormat::from_str("wav").unwrap(), OutputFormat::Wav);
        assert_eq!(
            OutputFormat::from_str("WAV").unwrap(),
            OutputFormat::Wav,
            "case-insensitive"
        );
        assert_eq!(
            OutputFormat::from_str("ogg-opus").unwrap(),
            OutputFormat::ogg_opus_default()
        );
        // Aliases that users will reach for naturally.
        assert!(matches!(
            OutputFormat::from_str("opus").unwrap(),
            OutputFormat::OggOpus { .. }
        ));
        assert!(matches!(
            OutputFormat::from_str("ogg").unwrap(),
            OutputFormat::OggOpus { .. }
        ));
        // Bogus values must be rejected with a useful message — clap surfaces it.
        let err = OutputFormat::from_str("mp3").unwrap_err();
        assert!(err.contains("mp3") && err.contains("supported"));
    }

    #[test]
    fn extension_inference_covers_common_cases() {
        assert_eq!(format_from_extension("wav"), Some(OutputFormat::Wav));
        assert_eq!(format_from_extension("WAV"), Some(OutputFormat::Wav));
        assert!(matches!(
            format_from_extension("ogg"),
            Some(OutputFormat::OggOpus { .. })
        ));
        assert!(matches!(
            format_from_extension("opus"),
            Some(OutputFormat::OggOpus { .. })
        ));
        assert_eq!(format_from_extension("mp3"), None);
        assert_eq!(format_from_extension(""), None);
    }

    #[test]
    fn ogg_opus_default_is_telegram_friendly() {
        // 24 kHz @ 32 kbps is the issue's stated v1 target. Locking it down so
        // a refactor doesn't silently change file sizes for downstream users.
        let f = OutputFormat::ogg_opus_default();
        assert_eq!(
            f,
            OutputFormat::OggOpus {
                bitrate: 32_000,
                sample_rate: 24_000,
            }
        );
    }

    #[test]
    fn opus_head_layout() {
        let head = build_opus_head(24_000);
        assert_eq!(head.len(), 19, "OpusHead must be exactly 19 bytes");
        assert_eq!(&head[..8], b"OpusHead");
        assert_eq!(head[8], 1, "version");
        assert_eq!(head[9], 1, "channels (mono)");
        // pre-skip
        assert_eq!(u16::from_le_bytes([head[10], head[11]]), PRE_SKIP_48K);
        // input sample rate
        assert_eq!(
            u32::from_le_bytes([head[12], head[13], head[14], head[15]]),
            24_000
        );
        assert_eq!(head[18], 0, "channel mapping family");
    }

    #[test]
    fn opus_tags_layout() {
        let tags = build_opus_tags();
        assert_eq!(&tags[..8], b"OpusTags");
        // vendor length is u32 LE at offset 8
        let vlen = u32::from_le_bytes([tags[8], tags[9], tags[10], tags[11]]) as usize;
        let vendor = std::str::from_utf8(&tags[12..12 + vlen]).unwrap();
        assert!(vendor.starts_with("kesha-voice-kit "));
        // Trailing user-comment count = 0
        let cnt = u32::from_le_bytes(tags[12 + vlen..12 + vlen + 4].try_into().unwrap());
        assert_eq!(cnt, 0);
    }

    #[test]
    fn encode_wav_round_trip_matches_legacy_path() {
        // Backwards compat: `encode(.., Wav)` must produce the *same* bytes the
        // old `wav::encode_wav` produced — that's how we keep existing tests
        // and downstream `--out foo.wav` callers green.
        let samples: Vec<f32> = (0..2_400).map(|i| (i as f32 * 0.05).sin()).collect();
        let from_encode = encode(&samples, 24_000, OutputFormat::Wav).unwrap();
        let from_wav = wav::encode_wav(&samples, 24_000).unwrap();
        assert_eq!(from_encode, from_wav);
    }

    #[test]
    fn ogg_opus_produces_valid_oggs_magic() {
        // 1 second of a 440 Hz tone at 24 kHz mono.
        let sr = 24_000u32;
        let samples: Vec<f32> = (0..sr)
            .map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 440.0 / sr as f32).sin() * 0.3)
            .collect();
        let bytes = encode(&samples, sr, OutputFormat::ogg_opus_default()).unwrap();
        // Every Ogg page starts with "OggS" — minimum check that we wrote
        // *something* well-formed enough for clients to demux.
        assert_eq!(&bytes[..4], b"OggS");
        // OpusHead lives in the first page payload, after the page header. We
        // don't reparse pages here (the dedicated tts_opus.rs test does), but
        // the magic must appear somewhere in the buffer.
        assert!(
            bytes.windows(8).any(|w| w == b"OpusHead"),
            "OpusHead packet not found in OggOpus output"
        );
        assert!(
            bytes.windows(8).any(|w| w == b"OpusTags"),
            "OpusTags packet not found in OggOpus output"
        );
        // 1 second @ 32 kbps ≈ 4 KB. Allow generous slack — we just want to
        // know we didn't accidentally ship megabytes of WAV-shaped bytes.
        assert!(
            bytes.len() < 12_000,
            "ogg-opus payload way bigger than expected: {} bytes",
            bytes.len()
        );
    }

    #[test]
    fn ogg_opus_rejects_invalid_sample_rate() {
        let samples = vec![0.0f32; 1024];
        let res = encode(
            &samples,
            22_050,
            OutputFormat::OggOpus {
                bitrate: 32_000,
                sample_rate: 22_050, // not in OPUS_VALID_SR
            },
        );
        let err = res.unwrap_err().to_string();
        assert!(err.contains("--sample-rate"), "unexpected error: {err}");
    }

    #[test]
    fn ogg_opus_rejects_out_of_range_bitrate() {
        let samples = vec![0.0f32; 1024];
        let res = encode(
            &samples,
            24_000,
            OutputFormat::OggOpus {
                bitrate: 1_000, // below 6 kbps libopus minimum
                sample_rate: 24_000,
            },
        );
        let err = res.unwrap_err().to_string();
        assert!(err.contains("--bitrate"), "unexpected error: {err}");
    }

    #[test]
    fn ogg_opus_resamples_when_engine_sr_mismatches() {
        // Vosk-RU runs at 22.05 kHz natively. We can't feed that to libopus
        // directly, so the encoder must resample to a supported rate first.
        let src_sr = 22_050u32;
        let samples: Vec<f32> = (0..src_sr)
            .map(|i| (i as f32 * 0.001).sin() * 0.2)
            .collect();
        let bytes = encode(&samples, src_sr, OutputFormat::ogg_opus_default()).unwrap();
        assert_eq!(&bytes[..4], b"OggS", "resampled output is still valid Ogg");
    }
}
