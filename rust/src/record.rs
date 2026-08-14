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
#[cfg(any(target_os = "macos", test))]
const WAV_HEADER_LEN: usize = 58;

/// Capabilities flag for `kesha record --live`; the CLI checks it before
/// forwarding the flag.
pub const RECORD_LIVE_FEATURE: &str = "record.live";
/// Capabilities flag for opt-in end-of-utterance stopping on a live recording.
pub const RECORD_LIVE_AUTO_STOP_FEATURE: &str = "record.live.auto-stop";

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

/// What a live session produced, and whether a signal ended it.
#[cfg(all(feature = "coreml", target_os = "macos"))]
pub struct LiveOutcome {
    pub transcript: String,
    /// The signal that stopped the session, when one did. The transcript is
    /// still whatever was captured up to that point (#962).
    pub interrupted_by: Option<i32>,
}

/// Captures the default microphone and transcribes it through a streaming ASR
/// session, handing the transcript to `deliver`. The audio is spilled to a
/// recovery WAV as it arrives and dropped only once `deliver` has confirmed the
/// transcript landed.
///
/// Feeding happens here, on the thread draining the sample channel — never in
/// the CPAL callback, which stays a convert-and-send as in the WAV path.
#[cfg(all(feature = "coreml", target_os = "macos"))]
pub fn record_default_input_live(
    max_duration: Duration,
    endpoint: Option<crate::vad::EndpointConfig>,
    deliver: impl FnOnce(&str) -> Result<()>,
) -> Result<LiveOutcome> {
    if max_duration.is_zero() {
        anyhow::bail!("--max-seconds must be greater than 0");
    }

    let endpoint = endpoint.map(load_live_endpoint).transpose()?;

    // Before CPAL opens the device and spawns its threads: POSIX does not
    // promise `signal` is thread-safe.
    interrupt::install();

    let input = open_default_input()?;
    let sample_rate = input.config.sample_rate.0;

    eprintln!("Preparing streaming ASR (first run compiles models for the ANE, ~20 s)...");
    let mut feed = LiveFeed {
        session: crate::streaming_asr::StreamingAsrSession::start(sample_rate)?,
        mono: Vec::new(),
        input_channels: input.config.channels,
        spill: open_recovery_spill(sample_rate),
        endpoint,
    };

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
    eprintln!(
        "Listening ({sample_rate} Hz)... transcript prints when recording stops; \
         Ctrl-C stops and still prints."
    );

    let ended_by_endpoint = feed.listen(&sample_rx, &stop_rx, max_duration)?;

    // Drain after stopping capture, or the last words spoken are never fed.
    drop(stream);
    if !ended_by_endpoint {
        feed.drain(&sample_rx)?;
    }

    warn_dropped_buffers(dropped.load(std::sync::atomic::Ordering::Relaxed));

    let interrupted_by = interrupt::caught();
    let spill = feed.spill.take();
    let transcript = deliver_and_settle(feed.finish(), interrupted_by, spill, deliver)?;
    Ok(LiveOutcome {
        transcript,
        interrupted_by,
    })
}

#[cfg(all(feature = "coreml", target_os = "macos"))]
fn load_live_endpoint(cfg: crate::vad::EndpointConfig) -> Result<crate::vad::StreamingVad> {
    let vad_dir = crate::models::model_dir(crate::models::ModelKind::Vad)?;
    if !crate::models::is_cached_in(crate::models::ModelKind::Vad, &vad_dir) {
        anyhow::bail!(
            "Error: VAD model not installed\n\n\
             Please run: kesha install --vad"
        );
    }
    crate::vad::StreamingVad::load(&vad_dir.join("silero_vad.onnx"), cfg)
        .context("load Silero VAD for live endpointing")
}

/// Hands the transcript to `deliver`, then decides the spill's fate from
/// whether it actually landed.
///
/// The spill is the only copy of the audio until the bytes have left the
/// process, and delivery is where a live session fails most quietly: the engine
/// is spawned detached, so an orphaned session never sees the terminal's
/// SIGHUP — it records to `--max-seconds`, finishes cleanly, and only then does
/// the write to the closed terminal fail with EIO. A pipe consumer that exits
/// early fails the same way with EPIPE. Settling on `finish` alone deleted the
/// audio in exactly those cases (#962).
#[cfg(any(all(feature = "coreml", target_os = "macos"), test))]
fn deliver_and_settle(
    finished: Result<String>,
    interrupted_by: Option<i32>,
    spill: Option<spill::SpillWav>,
    deliver: impl FnOnce(&str) -> Result<()>,
) -> Result<String> {
    let delivered = finished.and_then(|transcript| match deliver(transcript.trim()) {
        Ok(()) => Ok(transcript),
        Err(err) => Err(err),
    });
    settle_recovery_spill(spill, delivered.is_ok() && interrupted_by.is_none());
    delivered
}

/// A missing spill must never cost the session it exists to protect, so a
/// failure here is loud but not fatal.
#[cfg(all(feature = "coreml", target_os = "macos"))]
fn open_recovery_spill(sample_rate: u32) -> Option<spill::SpillWav> {
    let dir = match spill::recovery_dir() {
        Ok(dir) => dir,
        Err(err) => {
            eprintln!("warning: this session has no recovery audio: {err:#}");
            return None;
        }
    };
    spill::prune_stale_spills(&dir, spill::RETENTION);
    match spill::SpillWav::create(&spill::spill_path(&dir), sample_rate) {
        Ok(spill) => {
            eprintln!(
                "Recovery audio: {} (removed once the transcript is delivered).",
                spill.path().display()
            );
            Some(spill)
        }
        Err(err) => {
            eprintln!("warning: this session has no recovery audio: {err:#}");
            None
        }
    }
}

#[cfg(any(all(feature = "coreml", target_os = "macos"), test))]
fn settle_recovery_spill(spill: Option<spill::SpillWav>, ended_normally: bool) {
    let Some(mut spill) = spill else { return };
    if ended_normally {
        spill.discard();
        return;
    }
    if let Err(err) = spill.flush() {
        eprintln!("warning: recovery audio may be truncated: {err:#}");
    }
    eprintln!(
        "Recovery audio kept: {0} — transcribe it with `kesha {0}`.",
        spill.path().display()
    );
}

/// `mono` is per-call scratch, not accumulated audio as in the WAV path.
#[cfg(all(feature = "coreml", target_os = "macos"))]
struct LiveFeed {
    session: crate::streaming_asr::StreamingAsrSession,
    mono: Vec<f32>,
    input_channels: u16,
    spill: Option<spill::SpillWav>,
    endpoint: Option<crate::vad::StreamingVad>,
}

#[cfg(all(feature = "coreml", target_os = "macos"))]
impl LiveFeed {
    fn feed(&mut self, interleaved: &[f32]) -> Result<bool> {
        let Self {
            session,
            mono,
            input_channels,
            spill,
            endpoint,
        } = self;
        mono.clear();
        mono.extend(
            interleaved
                .chunks_exact(usize::from(*input_channels))
                .map(|frame| mix_frame_to_mono(frame).clamp(-1.0, 1.0)),
        );
        if let Some(active) = spill.as_mut() {
            if let Err(err) = active.push(mono) {
                eprintln!("warning: recovery audio stopped early: {err:#}");
                *spill = None;
            }
        }
        let ready = session.feed(mono)?;
        match endpoint {
            Some(endpoint) => endpoint.feed(&ready),
            None => Ok(false),
        }
    }

    fn listen(
        &mut self,
        sample_rx: &mpsc::Receiver<Vec<f32>>,
        stop_rx: &mpsc::Receiver<()>,
        max_duration: Duration,
    ) -> Result<bool> {
        let started = Instant::now();
        let mut announced = 0u64;
        let tick = io::stderr().is_terminal();
        let mut ended_by_endpoint = false;
        loop {
            if stop_rx.try_recv().is_ok()
                || started.elapsed() >= max_duration
                || interrupt::caught().is_some()
            {
                break;
            }
            match sample_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(samples) if self.feed(&samples)? => {
                    eprintln!("End of utterance detected.");
                    ended_by_endpoint = true;
                    break;
                }
                Ok(_) => {}
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
        Ok(ended_by_endpoint)
    }

    fn drain(&mut self, sample_rx: &mpsc::Receiver<Vec<f32>>) -> Result<()> {
        while let Ok(samples) = sample_rx.try_recv() {
            let _ = self.feed(&samples)?;
        }
        Ok(())
    }

    fn finish(self) -> Result<String> {
        self.session.finish()
    }
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
fn wav_header_bytes(sample_rate: u32, sample_count: usize) -> Result<Vec<u8>> {
    let (sample_count, data_size, total_size) = wav_sizes_for_sample_count(sample_count)?;
    let byte_rate = sample_rate
        .checked_mul(u32::from(OUTPUT_CHANNELS) * BYTES_PER_SAMPLE)
        .ok_or_else(|| anyhow::anyhow!("WAV byte rate overflow"))?;
    let block_align = OUTPUT_CHANNELS * (BITS_PER_SAMPLE / 8);

    let mut header = Vec::with_capacity(WAV_HEADER_LEN);
    header.extend_from_slice(b"RIFF");
    header.extend_from_slice(&total_size.to_le_bytes());
    header.extend_from_slice(b"WAVE");

    header.extend_from_slice(b"fmt ");
    header.extend_from_slice(&FMT_CHUNK_SIZE.to_le_bytes());
    header.extend_from_slice(&FORMAT_IEEE_FLOAT.to_le_bytes());
    header.extend_from_slice(&OUTPUT_CHANNELS.to_le_bytes());
    header.extend_from_slice(&sample_rate.to_le_bytes());
    header.extend_from_slice(&byte_rate.to_le_bytes());
    header.extend_from_slice(&block_align.to_le_bytes());
    header.extend_from_slice(&BITS_PER_SAMPLE.to_le_bytes());
    header.extend_from_slice(&0_u16.to_le_bytes());

    header.extend_from_slice(b"fact");
    header.extend_from_slice(&FACT_CHUNK_SIZE.to_le_bytes());
    header.extend_from_slice(&sample_count.to_le_bytes());

    header.extend_from_slice(b"data");
    header.extend_from_slice(&data_size.to_le_bytes());

    debug_assert_eq!(header.len(), WAV_HEADER_LEN);
    Ok(header)
}

#[cfg(any(target_os = "macos", test))]
fn create_parent_dir(path: &Path) -> Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    std::fs::create_dir_all(parent)
        .with_context(|| format!("failed to create output directory: {}", parent.display()))
}

#[cfg(any(target_os = "macos", test))]
fn write_plain_mono_float_wav(path: &Path, sample_rate: u32, samples: &[f32]) -> Result<()> {
    let header = wav_header_bytes(sample_rate, samples.len())?;
    create_parent_dir(path)?;

    let mut file = std::io::BufWriter::new(
        std::fs::File::create(path)
            .with_context(|| format!("failed to create WAV recording: {}", path.display()))?,
    );
    file.write_all(&header)?;
    for sample in samples {
        file.write_all(&sample.to_le_bytes())?;
    }
    file.flush()?;
    Ok(())
}

/// Audio a `--live` session leaves on disk so an interruption is recoverable.
///
/// `--live` streams the microphone through an in-memory ASR session and prints
/// the transcript only at the end, so before #962 a Ctrl-C, a SIGTERM, a crash
/// or a caller's timeout took the audio and the transcript together — nothing
/// on disk to retry against, and the more successful the dictation the more was
/// lost. The spill is written as the samples arrive.
///
/// It protects against process death, where the page cache outlives the writer.
/// Nothing here `fsync`s, so a machine that loses power can persist the rewritten
/// sizes ahead of the data they describe.
#[cfg(any(all(feature = "coreml", target_os = "macos"), test))]
mod spill {
    use std::io::{Seek, SeekFrom, Write};
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use anyhow::{Context, Result};

    use super::{create_parent_dir, wav_header_bytes};

    /// How much audio a `kill -9` can cost: the RIFF size fields are rewritten
    /// once per this many samples, and a reader only sees what they claim. The
    /// spill runs at the device rate, so this is ~0.33 s on a 48 kHz mic.
    pub(super) const SYNC_SAMPLES: usize = 16_000;
    pub(super) const RETENTION: Duration = Duration::from_secs(60 * 60 * 24 * 7);
    const PREFIX: &str = "live-";

    /// A WAV that is readable *before* it is finished, unlike
    /// [`super::write_plain_mono_float_wav`], which needs the whole recording up
    /// front to size the header.
    pub(super) struct SpillWav {
        file: std::fs::File,
        path: PathBuf,
        sample_rate: u32,
        written: usize,
        synced: usize,
    }

    impl SpillWav {
        pub(super) fn create(path: &Path, sample_rate: u32) -> Result<Self> {
            create_parent_dir(path)?;
            let mut file = std::fs::File::create(path)
                .with_context(|| format!("failed to create recovery WAV: {}", path.display()))?;
            file.write_all(&wav_header_bytes(sample_rate, 0)?)
                .with_context(|| format!("failed to start recovery WAV: {}", path.display()))?;
            Ok(Self {
                file,
                path: path.to_path_buf(),
                sample_rate,
                written: 0,
                synced: 0,
            })
        }

        pub(super) fn path(&self) -> &Path {
            &self.path
        }

        pub(super) fn push(&mut self, samples: &[f32]) -> Result<()> {
            let mut bytes = Vec::with_capacity(samples.len() * 4);
            for sample in samples {
                bytes.extend_from_slice(&sample.to_le_bytes());
            }
            self.file.write_all(&bytes).with_context(|| {
                format!("failed to append to recovery WAV: {}", self.path.display())
            })?;
            self.written += samples.len();
            if self.written - self.synced >= SYNC_SAMPLES {
                self.flush()?;
            }
            Ok(())
        }

        /// Rewrites the RIFF sizes so anything opening the file right now reads
        /// every sample written so far.
        pub(super) fn flush(&mut self) -> Result<()> {
            let header = wav_header_bytes(self.sample_rate, self.written)?;
            let mut rewrite = || -> std::io::Result<()> {
                self.file.seek(SeekFrom::Start(0))?;
                self.file.write_all(&header)?;
                self.file.seek(SeekFrom::End(0))?;
                self.file.flush()
            };
            rewrite().with_context(|| {
                format!(
                    "failed to update recovery WAV header: {}",
                    self.path.display()
                )
            })?;
            self.synced = self.written;
            Ok(())
        }

        pub(super) fn discard(self) {
            let _ = std::fs::remove_file(&self.path);
        }
    }

    /// Under the Kesha cache, so `KESHA_CACHE_DIR` relocates recovery audio with
    /// everything else the tool owns.
    pub(super) fn recovery_dir() -> Result<PathBuf> {
        Ok(crate::models::cache_dir()?.join("recordings"))
    }

    pub(super) fn spill_path(dir: &Path) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_secs())
            .unwrap_or_default();
        dir.join(format!("{PREFIX}{stamp}-{}.wav", std::process::id()))
    }

    /// Recovery audio is only useful until the user has moved on, and a spill is
    /// megabytes per minute; anything older than `max_age` goes at session start.
    pub(super) fn prune_stale_spills(dir: &Path, max_age: Duration) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let now = SystemTime::now();
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if !name.starts_with(PREFIX) || !name.ends_with(".wav") {
                continue;
            }
            let Ok(modified) = entry.metadata().and_then(|meta| meta.modified()) else {
                continue;
            };
            if now.duration_since(modified).is_ok_and(|age| age > max_age) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

/// Catches SIGINT/SIGTERM so `--live` can finish the session it is holding
/// rather than die with the transcript still in memory (#962). Raycast (#947)
/// cancels with exactly this ladder.
#[cfg(any(all(feature = "coreml", target_os = "macos"), all(unix, test)))]
mod interrupt {
    use std::sync::atomic::{AtomicI32, Ordering};

    static CAUGHT: AtomicI32 = AtomicI32::new(0);

    /// Restores the default disposition on the way out, so a second Ctrl-C
    /// kills a session whose `finish` has wedged instead of being swallowed.
    extern "C" fn on_signal(sig: libc::c_int) {
        CAUGHT.store(sig, Ordering::Relaxed);
        // SAFETY: `signal` is on POSIX's async-signal-safe list, and SIG_DFL
        // installs no handler of ours to run.
        unsafe { libc::signal(sig, libc::SIG_DFL) };
    }

    pub(super) fn install() {
        CAUGHT.store(0, Ordering::Relaxed);
        for sig in [libc::SIGINT, libc::SIGTERM] {
            // SAFETY: the handler stores to an atomic and re-arms the default
            // disposition, both async-signal-safe; nothing else runs there.
            unsafe { libc::signal(sig, on_signal as *const () as libc::sighandler_t) };
        }
    }

    /// Sticky until the next [`install`]: the capture loop polls it, and the
    /// caller reads it again after the session has been drained and finished.
    pub(super) fn caught() -> Option<i32> {
        match CAUGHT.load(Ordering::Relaxed) {
            0 => None,
            sig => Some(sig),
        }
    }

    /// Leaves neither a handler nor a set flag behind, so a plain `cargo test`
    /// run — which shares one process across tests, unlike nextest — is not
    /// poisoned by the test that raises a signal.
    #[cfg(test)]
    pub(super) fn reset() {
        CAUGHT.store(0, Ordering::Relaxed);
        for sig in [libc::SIGINT, libc::SIGTERM] {
            // SAFETY: SIG_DFL installs no handler; see `install`.
            unsafe { libc::signal(sig, libc::SIG_DFL) };
        }
    }
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

    /// The whole point of the spill: a session killed outright (SIGKILL, panic)
    /// never runs `finish`, and the file left behind must still be audio
    /// somebody can transcribe — not a header claiming zero samples.
    #[test]
    fn a_spill_that_was_never_finished_still_decodes_as_a_wav() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("live-crashed.wav");
        let mut spill = spill::SpillWav::create(&path, 16_000).unwrap();
        spill.push(&vec![0.25f32; spill::SYNC_SAMPLES]).unwrap();
        spill.push(&vec![0.5f32; 100]).unwrap();
        drop(spill);

        let reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.spec().sample_rate, 16_000);
        let samples = reader
            .into_samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(samples.len(), spill::SYNC_SAMPLES);
        assert!(samples.iter().all(|s| *s == 0.25));
    }

    #[test]
    fn a_finished_spill_contains_every_pushed_sample() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("live-done.wav");
        let mut spill = spill::SpillWav::create(&path, 48_000).unwrap();
        spill.push(&[0.1, 0.2]).unwrap();
        spill.push(&[0.3]).unwrap();
        spill.flush().unwrap();

        let reader = hound::WavReader::open(&path).unwrap();
        assert_eq!(reader.spec().sample_rate, 48_000);
        let samples = reader
            .into_samples::<f32>()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(samples, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn discarding_a_spill_removes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("live-discard.wav");
        let mut spill = spill::SpillWav::create(&path, 16_000).unwrap();
        spill.push(&[0.0; 4]).unwrap();
        spill.discard();
        assert!(
            !path.exists(),
            "a completed session must not leave a spill behind"
        );
    }

    /// Recovery audio has to be somewhere a user can be told about and a
    /// relocated cache has to take it along.
    #[test]
    fn recovery_audio_lives_under_the_kesha_cache() {
        let _lock = crate::util::test_env::lock();
        let _guard =
            crate::util::test_env::EnvGuard::set(&_lock, "KESHA_CACHE_DIR", "/tmp/kesha-962-cache");
        assert_eq!(
            spill::recovery_dir().unwrap(),
            std::path::PathBuf::from("/tmp/kesha-962-cache/recordings")
        );
    }

    /// The names a session writes and the names pruning recognises are two
    /// halves of one contract; drift between them leaks spills forever.
    #[test]
    fn a_spill_is_named_where_pruning_will_find_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = spill::spill_path(dir.path());
        let mut spill = spill::SpillWav::create(&path, 16_000).unwrap();
        spill.push(&[0.0; 4]).unwrap();
        assert_eq!(spill.path(), path);
        drop(spill);

        let long_ago = std::time::SystemTime::now() - Duration::from_secs(60 * 60 * 24 * 30);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();
        spill::prune_stale_spills(dir.path(), spill::RETENTION);

        assert!(!path.exists(), "pruning did not recognise a name it wrote");
    }

    #[test]
    fn pruning_removes_stale_spills_and_keeps_fresh_ones() {
        let dir = tempfile::tempdir().unwrap();
        let stale = dir.path().join("live-1000-1.wav");
        let fresh = dir.path().join("live-2000-2.wav");
        let unrelated = dir.path().join("keepme.wav");
        for path in [&stale, &fresh, &unrelated] {
            std::fs::write(path, b"x").unwrap();
        }
        let long_ago = std::time::SystemTime::now() - Duration::from_secs(60 * 60 * 24 * 30);
        std::fs::File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();

        spill::prune_stale_spills(dir.path(), spill::RETENTION);

        assert!(
            !stale.exists(),
            "a spill past the retention window must be pruned"
        );
        assert!(
            fresh.exists(),
            "a spill inside the retention window must survive"
        );
        assert!(unrelated.exists(), "pruning must only touch files it wrote");
    }

    fn spill_holding_audio(dir: &std::path::Path) -> (spill::SpillWav, std::path::PathBuf) {
        let path = spill::spill_path(dir);
        let mut spill = spill::SpillWav::create(&path, 16_000).unwrap();
        spill.push(&[0.25; 8]).unwrap();
        (spill, path)
    }

    fn broken_pipe() -> anyhow::Error {
        std::io::Error::from(std::io::ErrorKind::BrokenPipe).into()
    }

    /// The killer path: the engine is spawned detached, so an orphaned session
    /// never sees the terminal's SIGHUP. It records to `--max-seconds`, finishes
    /// cleanly, sees no signal — and only then does the write to the dead
    /// terminal fail. Deleting the spill any earlier loses both artifacts in
    /// exactly the case the recovery WAV exists for (#962).
    #[test]
    fn a_spill_survives_a_transcript_that_could_not_be_written() {
        let dir = tempfile::tempdir().unwrap();
        let (spill, path) = spill_holding_audio(dir.path());

        let err = deliver_and_settle(Ok("hello".to_string()), None, Some(spill), |_| {
            Err(broken_pipe())
        })
        .unwrap_err();

        assert!(
            err.to_string().contains("broken pipe"),
            "unexpected error: {err}"
        );
        assert!(
            path.exists(),
            "the only copy of the audio was deleted before the transcript was delivered"
        );
    }

    #[test]
    fn a_delivered_transcript_takes_the_spill_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let (spill, path) = spill_holding_audio(dir.path());

        let transcript =
            deliver_and_settle(Ok("hello".to_string()), None, Some(spill), |_| Ok(())).unwrap();

        assert_eq!(transcript, "hello");
        assert!(
            !path.exists(),
            "a delivered session must leave nothing behind"
        );
    }

    #[test]
    fn an_interrupted_session_keeps_its_spill_even_once_delivered() {
        let dir = tempfile::tempdir().unwrap();
        let (spill, path) = spill_holding_audio(dir.path());

        deliver_and_settle(Ok("hello".to_string()), Some(2), Some(spill), |_| Ok(())).unwrap();

        assert!(path.exists(), "a cancelled session keeps its audio");
    }

    /// Without a handler these signals kill the process outright, taking the
    /// in-memory transcript with them (#962). The handler must also stand down
    /// afterwards, or a session whose `finish` wedged would swallow every
    /// further Ctrl-C.
    #[test]
    #[cfg(unix)]
    fn a_caught_sigint_is_recorded_and_re_arms_the_default() {
        struct Restore;
        impl Drop for Restore {
            fn drop(&mut self) {
                interrupt::reset();
            }
        }
        let _restore = Restore;

        interrupt::install();
        assert_eq!(interrupt::caught(), None);
        // SAFETY: raise delivers SIGINT to this process, where the handler
        // installed above stores it in an atomic and returns.
        assert_eq!(unsafe { libc::raise(libc::SIGINT) }, 0);
        assert_eq!(interrupt::caught(), Some(libc::SIGINT));

        // SAFETY: reads back the disposition the handler left; SIG_DFL installs
        // no handler of ours.
        let previous = unsafe { libc::signal(libc::SIGINT, libc::SIG_DFL) };
        assert_eq!(
            previous,
            libc::SIG_DFL,
            "a second Ctrl-C must reach a wedged session, not be swallowed"
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

    #[test]
    #[cfg(all(feature = "coreml", target_os = "macos"))]
    fn live_endpointing_requires_an_explicitly_installed_vad_model() {
        let _lock = crate::util::test_env::lock();
        let cache = tempfile::tempdir().unwrap();
        let cache_path = cache.path().to_string_lossy().into_owned();
        let _guard = crate::util::test_env::EnvGuard::set(&_lock, "KESHA_CACHE_DIR", &cache_path);

        let err = match load_live_endpoint(crate::vad::EndpointConfig::default()) {
            Ok(_) => panic!("a missing VAD model must not start endpointing"),
            Err(err) => err,
        };

        assert!(
            err.to_string().contains("kesha install --vad"),
            "missing-model hint was not actionable: {err:#}"
        );
    }
}
