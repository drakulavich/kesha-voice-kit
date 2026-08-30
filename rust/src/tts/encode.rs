//! Output audio encoding: f32 PCM samples → wire bytes.
//!
//! Closes #223. Adds OGG/Opus (the format Telegram, WhatsApp, Signal, and
//! Discord render as native voice messages) and FLAC (lossless, royalty-free,
//! browser-universal incl. Safari) alongside the original WAV. Keeps the door
//! open for `mp3` / `raw-pcm` later.

use std::str::FromStr;

#[cfg(feature = "tts")]
use crate::audio::resample_mono;

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
    /// FLAC, mono, lossless.
    ///
    /// Royalty-free (Xiph, same ethos as Opus) and plays in every modern
    /// browser including Safari/iOS — the format for web-embeddable samples.
    /// FLAC accepts the engine's native rate, so unlike Opus there is no
    /// resample round-trip and no bitrate knob (lossless). f32 is quantized to
    /// 16-bit PCM, transparent for TTS. Encoded via the pure-Rust `flacenc`
    /// crate (Apache-2.0) — no C dependency.
    Flac,
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
            "flac" => Ok(Self::Flac),
            other => Err(format!(
                "unknown --format '{other}'. supported: wav, ogg-opus, flac"
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
        "flac" => Some(OutputFormat::Flac),
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
    // The one home for the full-scale bound; every format mishandles ±1.0 overflow differently (#718).
    let bounded: std::borrow::Cow<[f32]> = if samples.iter().any(|s| !(-1.0..=1.0).contains(s)) {
        std::borrow::Cow::Owned(samples.iter().map(|s| s.clamp(-1.0, 1.0)).collect())
    } else {
        std::borrow::Cow::Borrowed(samples)
    };
    let samples = &bounded[..];
    match fmt {
        OutputFormat::Wav => wav::encode_wav(samples, src_rate),
        OutputFormat::OggOpus {
            bitrate,
            sample_rate,
        } => encode_ogg_opus(samples, src_rate, sample_rate, bitrate),
        OutputFormat::Flac => encode_flac(samples, src_rate),
    }
}

/// Encode mono f32 PCM to FLAC bytes via the pure-Rust `flacenc` crate.
///
/// No resample (FLAC accepts the engine's native rate) and no bitrate (lossless).
/// f32 in `[-1.0, 1.0]` is quantized to signed 16-bit PCM — transparent for TTS
/// output and the most broadly compatible FLAC bit depth.
#[cfg(feature = "tts")]
fn encode_flac(samples: &[f32], src_rate: u32) -> anyhow::Result<Vec<u8>> {
    use flacenc::component::BitRepr;
    use flacenc::error::Verify;

    const BITS_PER_SAMPLE: usize = 16;
    const CHANNELS: usize = 1;

    // f32 [-1.0, 1.0] -> signed 16-bit PCM, held in i32 as flacenc expects.
    let pcm: Vec<i32> = samples
        .iter()
        .map(|&s| (s * f32::from(i16::MAX)).round() as i32)
        .collect();

    let config = flacenc::config::Encoder::default()
        .into_verified()
        .map_err(|e| anyhow::anyhow!("flac encoder config invalid: {e:?}"))?;

    let source = flacenc::source::MemSource::from_samples(
        &pcm,
        CHANNELS,
        BITS_PER_SAMPLE,
        src_rate as usize,
    );

    let mut stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|e| anyhow::anyhow!("flac encode failed: {e:?}"))?;

    // flacenc records STREAMINFO min_block_size as the (shorter) final block,
    // which flags the stream "variable block size" and trips strict decoders
    // like Symphonia. For a fixed-block-size encode the conventional header
    // (libFLAC, ffmpeg) sets min == max == nominal; the short final block is
    // signaled per-frame, not in STREAMINFO. Normalize for max decoder reach.
    stream
        .stream_info_mut()
        .set_block_sizes(config.block_size, config.block_size)
        .map_err(|e| anyhow::anyhow!("flac stream_info fixup failed: {e:?}"))?;

    let mut sink = flacenc::bitsink::ByteSink::new();
    stream
        .write(&mut sink)
        .map_err(|e| anyhow::anyhow!("flac serialization failed: {e:?}"))?;
    Ok(sink.as_slice().to_vec())
}

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

/// RAII wrapper over libopus' encoder FFI (`opusic-sys`).
///
/// We bind encode here instead of pulling the safe `opus` crate: that crate's
/// `audiopus_sys` static-linked a SECOND copy of libopus, whose C symbols
/// collided with the copy `symphonia-adapter-libopus` (`opusic-sys`) links for
/// decode. The MSVC linker bound all calls to one copy — an ODR violation that
/// crashed Windows CI with `0xc0000005` (#585). Driving encode through the same
/// `opusic-sys` keeps exactly one libopus in the binary.
#[cfg(feature = "tts")]
struct OpusEncoder {
    raw: *mut opusic_sys::OpusEncoder,
}

#[cfg(feature = "tts")]
impl OpusEncoder {
    fn new(sample_rate: u32, bitrate: i32) -> anyhow::Result<Self> {
        use opusic_sys::{
            opus_encoder_create, OPUS_APPLICATION_VOIP, OPUS_OK, OPUS_SET_BITRATE_REQUEST,
            OPUS_SET_SIGNAL_REQUEST, OPUS_SIGNAL_VOICE,
        };
        let mut err: core::ffi::c_int = OPUS_OK;
        // SAFETY: FFI call; on failure `raw` is null and/or `err` is non-OK, both checked below.
        let raw =
            unsafe { opus_encoder_create(sample_rate as i32, 1, OPUS_APPLICATION_VOIP, &mut err) };
        if raw.is_null() || err != OPUS_OK {
            anyhow::bail!("opus encoder create: {}", opus_err_str(err));
        }
        let enc = Self { raw };
        enc.set_ctl(OPUS_SET_BITRATE_REQUEST, bitrate)
            .map_err(|e| anyhow::anyhow!("opus set_bitrate: {e}"))?;
        // Tell libopus this is voice — affects internal mode selection.
        enc.set_ctl(OPUS_SET_SIGNAL_REQUEST, OPUS_SIGNAL_VOICE)
            .map_err(|e| anyhow::anyhow!("opus set_signal: {e}"))?;
        Ok(enc)
    }

    fn set_ctl(&self, request: core::ffi::c_int, value: i32) -> anyhow::Result<()> {
        use opusic_sys::{opus_encoder_ctl, OPUS_OK};
        // SAFETY: variadic ctl setter; every request we issue takes a single opus_int32 argument.
        let rc = unsafe { opus_encoder_ctl(self.raw, request, value) };
        if rc != OPUS_OK {
            anyhow::bail!("{}", opus_err_str(rc));
        }
        Ok(())
    }

    fn encode_float(&mut self, pcm: &[f32], out: &mut [u8]) -> anyhow::Result<usize> {
        // SAFETY: `pcm`/`out` are valid slices for their lengths; mono, so frame_size == pcm.len().
        let n = unsafe {
            opusic_sys::opus_encode_float(
                self.raw,
                pcm.as_ptr(),
                pcm.len() as i32,
                out.as_mut_ptr(),
                out.len() as i32,
            )
        };
        if n < 0 {
            anyhow::bail!("{}", opus_err_str(n));
        }
        Ok(n as usize)
    }
}

#[cfg(feature = "tts")]
impl Drop for OpusEncoder {
    fn drop(&mut self) {
        // SAFETY: `raw` came from opus_encoder_create and is destroyed exactly once here.
        unsafe { opusic_sys::opus_encoder_destroy(self.raw) };
    }
}

/// Resolve a libopus error code to its static message string.
#[cfg(feature = "tts")]
fn opus_err_str(code: core::ffi::c_int) -> String {
    // SAFETY: opus_strerror accepts any c_int, returning a message for unknown codes.
    let msg = unsafe { opusic_sys::opus_strerror(code) };
    // SAFETY: that pointer is non-null and points at a static NUL-terminated C string.
    unsafe { core::ffi::CStr::from_ptr(msg) }
        .to_string_lossy()
        .into_owned()
}

#[cfg(feature = "tts")]
fn encode_ogg_opus(
    samples: &[f32],
    src_rate: u32,
    target_sr: u32,
    bitrate: i32,
) -> anyhow::Result<Vec<u8>> {
    if !OPUS_VALID_SR.contains(&target_sr) {
        anyhow::bail!(
            "ogg-opus: --sample-rate must be one of {:?}, got {target_sr}",
            OPUS_VALID_SR
        );
    }
    if !(6_000..=510_000).contains(&bitrate) {
        anyhow::bail!("ogg-opus: --bitrate must be 6000..=510000 bps, got {bitrate}");
    }

    // Reuse rubato from `crate::audio` rather than pulling in a third resampler dep.
    use std::borrow::Cow;
    let resampled: Cow<[f32]> = if src_rate == target_sr {
        Cow::Borrowed(samples)
    } else {
        Cow::Owned(resample_mono(samples, src_rate, target_sr)?)
    };

    // `OPUS_APPLICATION_VOIP` + voice signal: best perceptual quality at low
    // bitrates for speech.
    let mut enc = OpusEncoder::new(target_sr, bitrate)?;

    let frame_size = (target_sr * FRAME_DURATION_MS / 1_000) as usize;

    let cap = (samples.len() as u64 * bitrate as u64 / (8 * src_rate as u64)) as usize + 4 * 1024;
    let mut buf: Vec<u8> = Vec::with_capacity(cap);
    let cursor = std::io::Cursor::new(&mut buf);
    let mut writer = ogg::PacketWriter::new(cursor);

    // Stable per-stream serial — reproducible test fixtures, not random.
    // Real codecs randomise this so muxed streams can't collide; for a
    // single-stream Opus file the value is irrelevant to decoders.
    let serial: u32 = 0x4b_45_53_48; // 'KESH'

    // OpusHead (RFC 7845 §5.1)
    let opus_head = build_opus_head(src_rate);
    writer
        .write_packet(opus_head, serial, ogg::PacketWriteEndInfo::EndPage, 0)
        .map_err(|e| anyhow::anyhow!("ogg write OpusHead: {e}"))?;

    // OpusTags (RFC 7845 §5.2)
    let opus_tags = build_opus_tags();
    writer
        .write_packet(opus_tags, serial, ogg::PacketWriteEndInfo::EndPage, 0)
        .map_err(|e| anyhow::anyhow!("ogg write OpusTags: {e}"))?;

    // Granule position = number of decoded samples produced *so far* at 48 kHz.
    // It includes the pre-skip, which players subtract before playback. We
    // accumulate sample count in target_sr and convert once per page boundary.
    let total_samples = resampled.len();
    let (packet_granules, tail_granule) = granule_plan(total_samples, frame_size, target_sr);
    let n_full_packets = packet_granules.len();

    let mut pcm_buf = vec![0.0f32; frame_size];
    let mut packet = vec![0u8; MAX_OPUS_PACKET];

    for (i, &granule) in packet_granules.iter().enumerate() {
        let start = i * frame_size;
        let nbytes = enc
            .encode_float(&resampled[start..start + frame_size], &mut packet)
            .map_err(|e| anyhow::anyhow!("opus encode (frame {i}): {e}"))?;

        let is_last = i + 1 == n_full_packets && tail_granule.is_none();
        let info = if is_last {
            ogg::PacketWriteEndInfo::EndStream
        } else {
            ogg::PacketWriteEndInfo::NormalPacket
        };
        writer
            .write_packet(packet[..nbytes].to_vec(), serial, info, granule)
            .map_err(|e| anyhow::anyhow!("ogg write audio (frame {i}): {e}"))?;
    }

    // Tail frame: zero-pad the last partial frame so libopus can encode it.
    // The granule position records *real* samples only — pad samples don't
    // increment absgp, so players truncate cleanly at the original duration.
    let leftover = total_samples - n_full_packets * frame_size;
    if let Some(granule) = tail_granule {
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
        writer
            .write_packet(
                packet[..nbytes].to_vec(),
                serial,
                ogg::PacketWriteEndInfo::EndStream,
                granule,
            )
            .map_err(|e| anyhow::anyhow!("ogg write audio (tail): {e}"))?;
    } else if n_full_packets == 0 {
        // Edge case: empty input (sub-frame audio takes the tail path). Emit a silent EOS packet
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
                u64::from(PRE_SKIP_48K),
            )
            .map_err(|e| anyhow::anyhow!("ogg write audio (empty): {e}"))?;
    }

    drop(writer);
    Ok(buf)
}

/// Absolute granule positions (RFC 7845 §4) for an OggOpus stream: one entry
/// per full 20 ms frame, plus the final position of the zero-padded tail when
/// the input isn't an exact frame multiple. Positions start from the pre-skip
/// and count *real* samples only, so the final value fixes the duration
/// players display.
#[cfg(feature = "tts")]
fn granule_plan(
    total_samples: usize,
    frame_size: usize,
    target_sr: u32,
) -> (Vec<u64>, Option<u64>) {
    let n_full = total_samples / frame_size;
    let mut pos = u64::from(PRE_SKIP_48K);
    let mut packets = Vec::with_capacity(n_full);
    for _ in 0..n_full {
        pos += target_to_48k(frame_size as u32, target_sr);
        packets.push(pos);
    }
    let leftover = (total_samples - n_full * frame_size) as u32;
    let tail = (leftover > 0).then(|| pos + target_to_48k(leftover, target_sr));
    (packets, tail)
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Every format bounds its input to full scale, so `encode` cannot tell an
    /// out-of-range sample from its clamped equivalent — asserted as byte
    /// equality rather than by decoding, which keeps it true for the lossy arm
    /// too (the Ogg serial is fixed for exactly this reason).
    ///
    /// Since #718 the ANE Kokoro path ships the model's native level, which
    /// upstream's 1.5× COLA tail can push past ±1.0. WAV wraps in anything
    /// converting to fixed point; FLAC quantizes to i16; and libopus documents
    /// that beyond ±1.0 "will be clipped by decoders using the integer API"
    /// (`opus.h:312`) — so the bound belongs above all three, not in one of them.
    #[cfg(feature = "tts")]
    #[test]
    fn every_format_bounds_samples_to_full_scale() {
        let hot: Vec<f32> = (0..2400)
            .map(|i| (i as f32 * 0.1).sin() * 2.5)
            .chain([-7.0, f32::MAX, 7.0])
            .collect();
        let bounded: Vec<f32> = hot.iter().map(|s| s.clamp(-1.0, 1.0)).collect();

        for fmt in [
            OutputFormat::Wav,
            OutputFormat::Flac,
            OutputFormat::ogg_opus_default(),
        ] {
            let from_hot = encode(&hot, 24_000, fmt).unwrap_or_else(|e| panic!("{fmt:?}: {e}"));
            let from_bounded =
                encode(&bounded, 24_000, fmt).unwrap_or_else(|e| panic!("{fmt:?}: {e}"));
            assert_eq!(
                from_hot, from_bounded,
                "{fmt:?} encoded out-of-range samples differently from their clamped \
                 equivalent, so they reached the encoder unbounded"
            );
        }
    }

    #[cfg(feature = "tts")]
    #[test]
    fn target_to_48k_scales_supported_rates() {
        // Opus-supported rates divide 48k exactly (RFC 7845): no truncation.
        for (sr, frame) in [
            (8_000u32, 160u32),
            (12_000, 240),
            (16_000, 320),
            (24_000, 480),
        ] {
            assert_eq!(target_to_48k(frame, sr), 960, "{sr} Hz frame");
        }
        assert_eq!(target_to_48k(960, 48_000), 960);
        // Non-Opus rates truncate: 100 samples @ 22 050 Hz = 217.68… → 217.
        assert_eq!(target_to_48k(100, 22_050), 217);
    }

    #[cfg(feature = "tts")]
    #[test]
    fn granule_plan_exact_multiple_has_no_tail() {
        let frame = 480; // 20 ms @ 24 kHz
        let (packets, tail) = granule_plan(3 * frame, frame, 24_000);
        assert_eq!(tail, None);
        let base = u64::from(PRE_SKIP_48K);
        assert_eq!(packets, vec![base + 960, base + 1920, base + 2880]);
    }

    #[cfg(feature = "tts")]
    #[test]
    fn granule_plan_tail_counts_real_samples_only() {
        let frame = 480;
        let total = frame + 123; // one full frame + partial tail
        let (packets, tail) = granule_plan(total, frame, 24_000);
        let base = u64::from(PRE_SKIP_48K);
        assert_eq!(packets, vec![base + 960]);
        // Tail granule advances by the 123 real samples (246 @ 48k), not by
        // the zero-padded frame — this is the value players read as duration.
        assert_eq!(tail, Some(base + 960 + 246));
    }

    #[cfg(feature = "tts")]
    #[test]
    fn granule_plan_sub_frame_input_is_tail_only() {
        let (packets, tail) = granule_plan(5, 480, 24_000);
        assert!(packets.is_empty());
        assert_eq!(tail, Some(u64::from(PRE_SKIP_48K) + 10));
    }

    #[cfg(feature = "tts")]
    #[test]
    fn granule_plan_empty_input_has_neither() {
        assert_eq!(granule_plan(0, 480, 24_000), (Vec::new(), None));
    }

    #[cfg(feature = "tts")]
    #[test]
    fn granule_plan_final_position_matches_total_duration() {
        // The whole point of the plan: last absgp - pre-skip == total samples
        // at 48 kHz, for exact-rate inputs of any length.
        let frame = 480;
        for total in [1usize, 479, 480, 481, 999, 4800, 12_345] {
            let (packets, tail) = granule_plan(total, frame, 24_000);
            let last = tail.or_else(|| packets.last().copied()).unwrap();
            assert_eq!(
                last - u64::from(PRE_SKIP_48K),
                (total as u64) * 2,
                "total={total}"
            );
        }
    }

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
        assert!(matches!(
            OutputFormat::from_str("opus").unwrap(),
            OutputFormat::OggOpus { .. }
        ));
        assert!(matches!(
            OutputFormat::from_str("ogg").unwrap(),
            OutputFormat::OggOpus { .. }
        ));
        assert_eq!(OutputFormat::from_str("flac").unwrap(), OutputFormat::Flac);
        assert_eq!(
            OutputFormat::from_str("FLAC").unwrap(),
            OutputFormat::Flac,
            "case-insensitive"
        );
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
        assert_eq!(format_from_extension("flac"), Some(OutputFormat::Flac));
        assert_eq!(format_from_extension("FLAC"), Some(OutputFormat::Flac));
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
        assert_eq!(u16::from_le_bytes([head[10], head[11]]), PRE_SKIP_48K);
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
        let vlen = u32::from_le_bytes([tags[8], tags[9], tags[10], tags[11]]) as usize;
        let vendor = std::str::from_utf8(&tags[12..12 + vlen]).unwrap();
        assert!(vendor.starts_with("kesha-voice-kit "));
        let cnt = u32::from_le_bytes(tags[12 + vlen..12 + vlen + 4].try_into().unwrap());
        assert_eq!(cnt, 0);
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
    fn flac_produces_valid_magic_and_decodes_round_trip() {
        // 1 second of a 440 Hz tone at 24 kHz mono (Kokoro's native rate).
        let sr = 24_000u32;
        let samples: Vec<f32> = (0..sr)
            .map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 440.0 / sr as f32).sin() * 0.3)
            .collect();
        let bytes = encode(&samples, sr, OutputFormat::Flac).unwrap();

        assert_eq!(&bytes[..4], b"fLaC", "missing FLAC stream marker");
        // Lossless, but still smaller than the raw 16-bit WAV it came from.
        let wav_bytes = encode(&samples, sr, OutputFormat::Wav).unwrap();
        assert!(
            bytes.len() < wav_bytes.len(),
            "flac ({}) should be smaller than wav ({})",
            bytes.len(),
            wav_bytes.len()
        );

        // Strongest check: it actually decodes via Symphonia (the same decoder
        // the STT path uses). Round-trip through a temp file and confirm we get
        // a non-silent signal of roughly the right duration back.
        let path = std::env::temp_dir().join(format!("kesha-flac-rt-{}.flac", std::process::id()));
        std::fs::write(&path, &bytes).unwrap();
        let decoded = crate::audio::load_audio(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert!(!decoded.is_empty(), "decoded FLAC was empty");
        let rms = (decoded.iter().map(|s| s * s).sum::<f32>() / decoded.len() as f32).sqrt();
        assert!(rms > 0.01, "decoded FLAC is silent (rms={rms})");
    }

    #[test]
    fn flac_uses_engine_native_rate_without_resample() {
        // Vosk-RU runs at 22.05 kHz. Unlike Opus (which only accepts a fixed set
        // of rates and must resample), FLAC takes the native rate directly — so
        // this must succeed and stay valid with no resample round-trip.
        let src_sr = 22_050u32;
        let samples: Vec<f32> = (0..src_sr)
            .map(|i| (i as f32 * 2.0 * std::f32::consts::PI * 220.0 / src_sr as f32).sin() * 0.25)
            .collect();
        let bytes = encode(&samples, src_sr, OutputFormat::Flac).unwrap();
        assert_eq!(&bytes[..4], b"fLaC");
    }
}
