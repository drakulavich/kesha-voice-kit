#[cfg(any(target_os = "macos", test))]
use std::io::Write;
#[cfg(target_os = "macos")]
use std::io::{self, IsTerminal, Read};
use std::path::Path;
#[cfg(target_os = "macos")]
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;
#[cfg(target_os = "macos")]
use std::time::Instant;

#[cfg(any(target_os = "macos", test))]
use anyhow::Context;
use anyhow::Result;
#[cfg(target_os = "macos")]
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
#[cfg(target_os = "macos")]
use cpal::{SampleFormat, StreamConfig};

#[cfg(any(target_os = "macos", test))]
const OUTPUT_CHANNELS: u16 = 1;
#[cfg(any(target_os = "macos", test))]
const FORMAT_IEEE_FLOAT: u16 = 0x0003;
#[cfg(any(target_os = "macos", test))]
const BITS_PER_SAMPLE: u16 = 32;
#[cfg(any(target_os = "macos", test))]
const BYTES_PER_SAMPLE: u32 = (BITS_PER_SAMPLE as u32) / 8;
#[cfg(any(target_os = "macos", test))]
const RIFF_HEADER_SIZE: u32 = 4;
#[cfg(any(target_os = "macos", test))]
const FMT_CHUNK_HEADER: u32 = 8;
#[cfg(any(target_os = "macos", test))]
const FMT_CHUNK_SIZE: u32 = 18;
#[cfg(any(target_os = "macos", test))]
const FACT_CHUNK_HEADER: u32 = 8;
#[cfg(any(target_os = "macos", test))]
const FACT_CHUNK_SIZE: u32 = 4;
#[cfg(any(target_os = "macos", test))]
const DATA_CHUNK_HEADER: u32 = 8;

/// Capabilities flag for `kesha record --live`; the CLI checks it before
/// forwarding the flag.
pub const RECORD_LIVE_FEATURE: &str = "record.live";

pub struct RecordSummary {
    pub path: std::path::PathBuf,
    pub sample_rate: u32,
    pub channels: u16,
    pub frames: u64,
}

#[cfg(not(target_os = "macos"))]
pub fn record_default_input_to_wav(_path: &Path, _max_duration: Duration) -> Result<RecordSummary> {
    use crate::coded_bail;
    use crate::errors::ErrorCode;
    coded_bail!(
        ErrorCode::UnsupportedPlatform,
        "microphone recording is currently supported on macOS only"
    );
}

#[cfg(target_os = "macos")]
pub fn record_default_input_to_wav(path: &Path, max_duration: Duration) -> Result<RecordSummary> {
    if max_duration.is_zero() {
        anyhow::bail!("--max-seconds must be greater than 0");
    }

    let input = open_default_input()?;
    let input_channels = input.config.channels;
    let sample_rate = input.config.sample_rate.0;

    let (sample_tx, sample_rx) = mpsc::channel::<Vec<f32>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    spawn_stdin_stop_thread(stop_tx);

    let sink = move |samples| {
        let _ = sample_tx.send(samples);
    };
    let stream = build_input_stream_for_format(&input, sink)?;

    stream
        .play()
        .context("failed to start microphone recording")?;

    let started = Instant::now();
    let mut mono_samples = Vec::new();
    'recording: loop {
        if stop_rx.try_recv().is_ok() || started.elapsed() >= max_duration {
            break;
        }
        match sample_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(samples) => {
                for (index, frame) in samples
                    .chunks_exact(usize::from(input_channels))
                    .enumerate()
                {
                    if index % 1024 == 0
                        && (stop_rx.try_recv().is_ok() || started.elapsed() >= max_duration)
                    {
                        break 'recording;
                    }
                    mono_samples.push(mix_frame_to_mono(frame).clamp(-1.0, 1.0));
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    // Drain after stopping capture, or the last words spoken never reach the file.
    drop(stream);
    while let Ok(samples) = sample_rx.try_recv() {
        for frame in samples.chunks_exact(usize::from(input_channels)) {
            mono_samples.push(mix_frame_to_mono(frame).clamp(-1.0, 1.0));
        }
    }

    write_plain_mono_float_wav(path, sample_rate, &mono_samples)
        .context("failed to write WAV recording")?;

    Ok(RecordSummary {
        path: path.to_path_buf(),
        sample_rate,
        channels: OUTPUT_CHANNELS,
        frames: mono_samples.len() as u64,
    })
}

/// Captures the default microphone and transcribes it through a streaming ASR
/// session, returning the transcript. Nothing is written to disk.
///
/// Feeding happens here, on the thread draining the sample channel — never in
/// the CPAL callback, which stays a convert-and-send as in the WAV path.
#[cfg(all(feature = "coreml", target_os = "macos"))]
pub fn record_default_input_live(max_duration: Duration) -> Result<String> {
    use crate::streaming_asr::StreamingAsrSession;

    if max_duration.is_zero() {
        anyhow::bail!("--max-seconds must be greater than 0");
    }

    let input = open_default_input()?;
    let input_channels = input.config.channels;
    let sample_rate = input.config.sample_rate.0;

    eprintln!("Preparing streaming ASR (first run compiles models for the ANE, ~20 s)...");
    let mut session = StreamingAsrSession::start(sample_rate)?;

    let (sample_tx, sample_rx) = mpsc::sync_channel::<Vec<f32>>(LIVE_QUEUE_BUFFERS);
    let dropped = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    spawn_stdin_stop_thread(stop_tx);

    let sink = {
        let dropped = std::sync::Arc::clone(&dropped);
        move |samples| {
            // Never block the CPAL callback; overflow is reported, not absorbed.
            if sample_tx.try_send(samples).is_err() {
                dropped.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
    };
    let stream = build_input_stream_for_format(&input, sink)?;

    stream
        .play()
        .context("failed to start microphone recording")?;
    eprintln!("Listening ({sample_rate} Hz)... transcript prints when recording stops.");

    feed_until_stopped(
        &mut session,
        &sample_rx,
        &stop_rx,
        input_channels,
        max_duration,
    )?;

    // Drain after stopping capture, or the last words spoken are never fed.
    drop(stream);
    feed_backlog(&mut session, &sample_rx, input_channels)?;

    warn_dropped_buffers(dropped.load(std::sync::atomic::Ordering::Relaxed));
    session.finish()
}

#[cfg(all(feature = "coreml", target_os = "macos"))]
fn feed_until_stopped(
    session: &mut crate::streaming_asr::StreamingAsrSession,
    sample_rx: &mpsc::Receiver<Vec<f32>>,
    stop_rx: &mpsc::Receiver<()>,
    input_channels: u16,
    max_duration: Duration,
) -> Result<()> {
    let started = Instant::now();
    let mut mono = Vec::new();
    let mut announced = 0u64;
    let tick = io::stderr().is_terminal();
    loop {
        if stop_rx.try_recv().is_ok() || started.elapsed() >= max_duration {
            break;
        }
        match sample_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(samples) => feed_mono(session, &mut mono, &samples, input_channels)?,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        let elapsed = started.elapsed().as_secs();
        if tick && elapsed > announced {
            announced = elapsed;
            eprint!("\rListening... {elapsed}s");
        }
    }
    if announced > 0 {
        eprintln!();
    }
    Ok(())
}

#[cfg(all(feature = "coreml", target_os = "macos"))]
fn feed_backlog(
    session: &mut crate::streaming_asr::StreamingAsrSession,
    sample_rx: &mpsc::Receiver<Vec<f32>>,
    input_channels: u16,
) -> Result<()> {
    let mut mono = Vec::new();
    while let Ok(samples) = sample_rx.try_recv() {
        feed_mono(session, &mut mono, &samples, input_channels)?;
    }
    Ok(())
}

#[cfg(all(feature = "coreml", target_os = "macos"))]
fn warn_dropped_buffers(dropped: usize) {
    if dropped > 0 {
        eprintln!(
            "warning: dropped {dropped} microphone buffer(s) — transcription could not keep up, \
             so the transcript may have gaps"
        );
    }
}

/// Backlog the capture callback may run ahead by — ~5.5 s at the 512-frame,
/// 48 kHz callback measured on an M-series Mac, far beyond the fraction of real
/// time the ANE needs. Reaching it means something is wrong, which is why
/// overflow is reported rather than absorbed.
#[cfg(all(feature = "coreml", target_os = "macos"))]
const LIVE_QUEUE_BUFFERS: usize = 512;

#[cfg(all(feature = "coreml", target_os = "macos"))]
fn feed_mono(
    session: &mut crate::streaming_asr::StreamingAsrSession,
    mono: &mut Vec<f32>,
    interleaved: &[f32],
    channels: u16,
) -> Result<()> {
    mono.clear();
    mono.extend(
        interleaved
            .chunks_exact(usize::from(channels))
            .map(|frame| mix_frame_to_mono(frame).clamp(-1.0, 1.0)),
    );
    session.feed(mono)
}

#[cfg(target_os = "macos")]
fn spawn_stdin_stop_thread(stop_tx: mpsc::Sender<()>) {
    if io::stdin().is_terminal() {
        return;
    }
    std::thread::spawn(move || {
        let mut buf = [0u8; 1];
        let _ = io::stdin().read(&mut buf);
        let _ = stop_tx.send(());
    });
}

#[cfg(target_os = "macos")]
struct DefaultInput {
    device: cpal::Device,
    config: StreamConfig,
    sample_format: SampleFormat,
}

#[cfg(target_os = "macos")]
fn open_default_input() -> Result<DefaultInput> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .context("no default microphone input device found")?;
    let supported = device
        .default_input_config()
        .context("failed to read default microphone format")?;
    let sample_format = supported.sample_format();
    let config: StreamConfig = supported.into();
    ensure_input_channels(config.channels)?;
    Ok(DefaultInput {
        device,
        config,
        sample_format,
    })
}

#[cfg(target_os = "macos")]
fn build_input_stream_for_format(
    input: &DefaultInput,
    sink: impl FnMut(Vec<f32>) + Send + 'static,
) -> Result<cpal::Stream> {
    let err_fn = |err| eprintln!("recording stream error: {err}");
    match input.sample_format {
        SampleFormat::F32 => build_input_stream::<f32>(&input.device, &input.config, sink, err_fn),
        SampleFormat::I16 => build_input_stream::<i16>(&input.device, &input.config, sink, err_fn),
        SampleFormat::U16 => build_input_stream::<u16>(&input.device, &input.config, sink, err_fn),
        other => anyhow::bail!("unsupported microphone sample format: {other:?}"),
    }
}

#[cfg(target_os = "macos")]
fn build_input_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    mut sink: impl FnMut(Vec<f32>) + Send + 'static,
    err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<cpal::Stream>
where
    T: cpal::Sample + cpal::SizedSample + Copy + Send + 'static,
    f32: FromInputSample<T>,
{
    let channels = usize::from(config.channels);
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                let mut samples = Vec::with_capacity(data.len());
                for frame in data.chunks(channels) {
                    for sample in frame {
                        samples.push(f32::from_input_sample(*sample));
                    }
                }
                sink(samples);
            },
            err_fn,
            None,
        )
        .context("failed to build microphone input stream")
}

#[cfg(target_os = "macos")]
trait FromInputSample<T> {
    fn from_input_sample(sample: T) -> f32;
}

#[cfg(target_os = "macos")]
impl FromInputSample<f32> for f32 {
    fn from_input_sample(sample: f32) -> f32 {
        sample
    }
}

#[cfg(target_os = "macos")]
impl FromInputSample<i16> for f32 {
    fn from_input_sample(sample: i16) -> f32 {
        sample as f32 / i16::MAX as f32
    }
}

#[cfg(target_os = "macos")]
impl FromInputSample<u16> for f32 {
    fn from_input_sample(sample: u16) -> f32 {
        (sample as f32 - 32768.0) / 32768.0
    }
}

#[cfg(target_os = "macos")]
fn ensure_input_channels(channels: u16) -> Result<()> {
    if channels == 0 {
        anyhow::bail!("microphone reported zero channels");
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn mix_frame_to_mono(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    frame.iter().sum::<f32>() / frame.len() as f32
}

#[cfg(any(target_os = "macos", test))]
fn wav_sizes_for_sample_count(sample_count: usize) -> Result<(u32, u32, u32)> {
    let sample_count = u32::try_from(sample_count).context("recording too long to write as WAV")?;
    let data_size = sample_count
        .checked_mul(BYTES_PER_SAMPLE)
        .ok_or_else(|| anyhow::anyhow!("WAV data chunk overflow ({sample_count} samples)"))?;
    let overhead = RIFF_HEADER_SIZE
        + FMT_CHUNK_HEADER
        + FMT_CHUNK_SIZE
        + FACT_CHUNK_HEADER
        + FACT_CHUNK_SIZE
        + DATA_CHUNK_HEADER;
    let total_size = overhead
        .checked_add(data_size)
        .ok_or_else(|| anyhow::anyhow!("WAV total size overflow"))?;

    Ok((sample_count, data_size, total_size))
}

#[cfg(any(target_os = "macos", test))]
fn write_plain_mono_float_wav(path: &Path, sample_rate: u32, samples: &[f32]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("failed to create output directory: {}", parent.display()))?;
    }

    let (sample_count, data_size, total_size) = wav_sizes_for_sample_count(samples.len())?;

    let mut file = std::io::BufWriter::new(
        std::fs::File::create(path)
            .with_context(|| format!("failed to create WAV recording: {}", path.display()))?,
    );

    file.write_all(b"RIFF")?;
    file.write_all(&total_size.to_le_bytes())?;
    file.write_all(b"WAVE")?;

    file.write_all(b"fmt ")?;
    file.write_all(&FMT_CHUNK_SIZE.to_le_bytes())?;
    file.write_all(&FORMAT_IEEE_FLOAT.to_le_bytes())?;
    file.write_all(&OUTPUT_CHANNELS.to_le_bytes())?;
    file.write_all(&sample_rate.to_le_bytes())?;
    let byte_rate = sample_rate
        .checked_mul(u32::from(OUTPUT_CHANNELS) * BYTES_PER_SAMPLE)
        .ok_or_else(|| anyhow::anyhow!("WAV byte rate overflow"))?;
    file.write_all(&byte_rate.to_le_bytes())?;
    let block_align = OUTPUT_CHANNELS * (BITS_PER_SAMPLE / 8);
    file.write_all(&block_align.to_le_bytes())?;
    file.write_all(&BITS_PER_SAMPLE.to_le_bytes())?;
    file.write_all(&0_u16.to_le_bytes())?;

    file.write_all(b"fact")?;
    file.write_all(&FACT_CHUNK_SIZE.to_le_bytes())?;
    file.write_all(&sample_count.to_le_bytes())?;

    file.write_all(b"data")?;
    file.write_all(&data_size.to_le_bytes())?;
    for sample in samples {
        file.write_all(&sample.to_le_bytes())?;
    }
    file.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_writer_finalizes_readable_mono_float_wav() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mic.wav");
        write_plain_mono_float_wav(&path, 16_000, &[0.0, 0.5, -0.5]).unwrap();

        let reader = hound::WavReader::open(&path).unwrap();
        let spec = reader.spec();
        assert_eq!(spec.channels, OUTPUT_CHANNELS);
        assert_eq!(spec.sample_rate, 16_000);
        assert_eq!(spec.bits_per_sample, 32);
        assert_eq!(spec.sample_format, hound::SampleFormat::Float);
        let samples = reader
            .into_samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(samples, vec![0.0, 0.5, -0.5]);
    }

    #[test]
    fn wav_writer_uses_plain_ieee_float_without_channel_mask() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mic.wav");
        write_plain_mono_float_wav(&path, 16_000, &[0.0; 8]).unwrap();
        let wav = std::fs::read(path).unwrap();
        let fmt_chunk_offset = (0..wav.len() - 8)
            .find(|i| &wav[*i..*i + 4] == b"fmt ")
            .expect("fmt chunk not found");
        let fmt_size = u32::from_le_bytes([
            wav[fmt_chunk_offset + 4],
            wav[fmt_chunk_offset + 5],
            wav[fmt_chunk_offset + 6],
            wav[fmt_chunk_offset + 7],
        ]);
        let format_tag = u16::from_le_bytes([wav[fmt_chunk_offset + 8], wav[fmt_chunk_offset + 9]]);

        assert_eq!(fmt_size, FMT_CHUNK_SIZE);
        assert_eq!(
            format_tag, FORMAT_IEEE_FLOAT,
            "record WAV must not use WAVE_FORMAT_EXTENSIBLE, which can be \
             interpreted as front-left-only by CoreAudio"
        );
    }

    #[test]
    fn mix_frame_to_mono_averages_input_channels() {
        assert_eq!(mix_frame_to_mono(&[1.0, -1.0]), 0.0);
        assert_eq!(mix_frame_to_mono(&[0.25, 0.5, 1.0]), 0.5833333);
    }

    #[test]
    #[cfg(target_pointer_width = "64")]
    fn wav_size_rejects_sample_count_that_would_truncate_to_u32() {
        let err = wav_sizes_for_sample_count(u32::MAX as usize + 1).unwrap_err();
        assert!(
            err.to_string().contains("recording too long"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn wav_size_rejects_total_size_overflow() {
        let max_sample_count_before_data_size_overflow = u32::MAX / BYTES_PER_SAMPLE;
        let err = wav_sizes_for_sample_count(max_sample_count_before_data_size_overflow as usize)
            .unwrap_err();
        assert!(
            err.to_string().contains("WAV total size overflow"),
            "unexpected error: {err}"
        );
    }
}
