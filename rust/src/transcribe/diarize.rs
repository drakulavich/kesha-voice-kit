//! Speaker diarization on darwin-arm64 via the native `fluidaudio-rs`
//! `diarize_file_with_models` (FluidAudio SortformerDiarizer, pre-staged model,
//! no download). Closes #199 angle D.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::coded_bail;
use crate::errors::ErrorCode;
use std::collections::HashMap;
use std::ops::ControlFlow;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::{dtrace, dtrace_json};
use fluidaudio_rs::{
    DiarizationSegment, DiarizeCancelToken, DiarizeComputeUnits, DiarizeEvent, DiarizeOutcome,
    FluidAudio,
};

use super::TranscriptionSegment;

const MIN_DIARIZE_SEGMENT_COVERAGE: f32 = 0.95;
const MAX_DIARIZE_TAIL_GAP_SECONDS: f32 = 30.0;

/// Default budget for the model load — the span before the binding's model-ready
/// marker, which is one synchronous CoreML call and nothing else. Cold that is the
/// ANE program compile, measured at 107.3 s on an M2 (0.3 s of it
/// `MLModel.compileModel`; the rest is the e5rt bundle build Apple caches per
/// compiled-model path); warm it is 0.8–4.1 s. The budget is ~3x the measured cold
/// cost and does not depend on the audio, because this phase does not read any.
/// [`LOAD_TIMEOUT_ENV`] overrides it for a machine that is legitimately slower.
/// Nothing can interrupt this phase, so exceeding it abandons the worker thread (#443).
const MODEL_LOAD_BUDGET_SECS: u64 = 300;

/// Floor for the prepare budget — the span between the model-ready marker and the
/// first processed chunk, which is FluidAudio reading and resampling the whole file.
const PREPARE_BUDGET_FLOOR_SECS: u64 = 60;

/// Per audio-second allowance added to [`PREPARE_BUDGET_FLOOR_SECS`]. Unlike the load,
/// this phase scales with the file: measured at 0.26 s for 185 s of audio on an M2
/// (0.0014 s per audio-second), so this is ~7x headroom, and a 10-hour recording gets
/// 420 s to be read rather than the floor alone.
const PREPARE_BUDGET_PER_AUDIO_SECOND: f32 = 0.01;

/// How long diarization may run without reporting a processed chunk. Chunks land
/// ~11/s on the Neural Engine and ~2.8/s CPU-only, the widest measured gap being
/// 1.2 s, so this is ~50x headroom over the slowest healthy path. Unlike the load,
/// this phase is cancellable, so hitting the budget stops the Swift work.
const PROGRESS_STALL_BUDGET_SECS: u64 = 60;

/// Minimum wall-clock gap between progress lines on stderr. Chunk reports are far
/// too frequent to forward one-for-one (191 for 92 s of audio).
const PROGRESS_REPORT_INTERVAL: Duration = Duration::from_secs(5);

/// How long a phase may go quiet before we say what it is waiting for. Above a warm
/// load (0.8–4.2 s measured) but far below a cold one, so only the slow cases explain
/// themselves.
const SLOW_PHASE_HINT_AFTER: Duration = Duration::from_secs(15);

/// Gap between "still working" ticks once a phase is known to be a slow one.
const SLOW_PHASE_TICK_INTERVAL: Duration = Duration::from_secs(30);

/// How long a cancelled run gets to unwind before we stop waiting for it. The
/// Swift side notices between chunks, measured at 0.06 s.
const CANCEL_GRACE: Duration = Duration::from_secs(10);

/// Env var overriding which CoreML compute units the Sortformer model loads on.
const COMPUTE_UNITS_ENV: &str = "KESHA_DIARIZE_COMPUTE_UNITS";

/// Accepted [`COMPUTE_UNITS_ENV`] values, spelled as the binding's own preset names.
const COMPUTE_UNIT_PRESETS: &[(&str, DiarizeComputeUnits)] = &[
    ("all", DiarizeComputeUnits::All),
    ("cpu-and-ane", DiarizeComputeUnits::CpuAndAne),
    ("cpu-and-gpu", DiarizeComputeUnits::CpuAndGpu),
    ("cpu-only", DiarizeComputeUnits::CpuOnly),
];

/// Env var capping total diarization wall time. It can only cut a run short: the phase
/// budgets still apply, so it never widens one.
const TOTAL_TIMEOUT_ENV: &str = "KESHA_DIARIZE_TIMEOUT_SECS";

/// Env var replacing [`MODEL_LOAD_BUDGET_SECS`], the one budget a user can legitimately
/// need more of — the ANE compile is a fixed cost of the host, not of their audio.
const LOAD_TIMEOUT_ENV: &str = "KESHA_DIARIZE_LOAD_TIMEOUT_SECS";

/// One speaker span emitted by the sidecar. Cluster IDs are stable within
/// one invocation but not across calls.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub(crate) struct DiarizeSpan {
    pub start: f32,
    pub end: f32,
    pub speaker: u32,
}

/// Diarize `audio_path` with the pre-staged model; validates span coverage against
/// the ASR timeline so callers never receive silently partial speaker labels (#397).
pub(crate) fn run(
    audio_path: &Path,
    model_path: &Path,
    asr_segments: &[TranscriptionSegment],
    duration: Option<f32>,
) -> Result<Vec<DiarizeSpan>> {
    let audio_secs = duration
        .or_else(|| max_asr_end(asr_segments))
        .unwrap_or(0.0);
    let units = compute_units_from_env()?;
    let total_deadline = total_timeout_from_env()?;
    dtrace!(
        "diarize::start audio_secs={:.1} asr_segments={} compute_units={} total_deadline={:?}",
        audio_secs,
        asr_segments.len(),
        units.as_str(),
        total_deadline.map(|d| d.as_secs())
    );
    dtrace_json!(
        "diarize.start",
        {
            "audio_secs": audio_secs,
            "asr_segments": asr_segments.len(),
            "compute_units": units.as_str(),
            "total_deadline_secs": total_deadline.map(|d| d.as_secs())
        }
    );

    let job = DiarizeJob {
        audio_path: audio_path.to_path_buf(),
        model_path: model_path.to_path_buf(),
        units,
    };
    let spans: Vec<DiarizeSpan> = run_supervised(job, total_deadline, audio_secs)?;

    let coverage = validate_coverage(asr_segments, &spans)?;
    dtrace!(
        "diarize::coverage spans={} labeled={}/{} ratio={:.3} span_end={:.1}s asr_end={:.1}s",
        spans.len(),
        coverage.labeled_segments,
        coverage.total_segments,
        coverage.coverage_ratio,
        coverage.max_span_end,
        coverage.max_asr_end
    );
    dtrace_json!(
        "diarize.coverage",
        {
            "spans": spans.len(),
            "labeled_segments": coverage.labeled_segments,
            "total_segments": coverage.total_segments,
            "coverage_ratio": coverage.coverage_ratio,
            "max_span_end": coverage.max_span_end,
            "max_asr_end": coverage.max_asr_end
        }
    );
    Ok(spans)
}

/// Read [`COMPUTE_UNITS_ENV`], defaulting to `all` — the units the whole model has
/// always loaded on, and the only ones that use the Neural Engine.
///
/// The override exists for hosts where the ANE is unusable or where its ~105 s
/// first-load compile is not worth paying: `cpu-and-gpu` skips it entirely at
/// roughly 2x the processing time (measured: 32.1 s vs 17.5 s for 92 s of audio).
fn compute_units_from_env() -> Result<DiarizeComputeUnits> {
    let Some(raw) = std::env::var_os(COMPUTE_UNITS_ENV) else {
        return Ok(DiarizeComputeUnits::All);
    };
    let raw = raw.to_string_lossy();
    let value = raw.trim();
    if value.is_empty() {
        return Ok(DiarizeComputeUnits::All);
    }
    let lowered = value.to_ascii_lowercase();
    if let Some((_, units)) = COMPUTE_UNIT_PRESETS
        .iter()
        .find(|(name, _)| *name == lowered)
    {
        return Ok(*units);
    }
    // Coded: an uncoded error surfaces as E_INTERNAL, blaming the engine for the user's typo.
    coded_bail!(
        ErrorCode::InvalidArg,
        "{COMPUTE_UNITS_ENV}='{value}' is not a known CoreML compute-units preset. \
         Use one of: {}. `all` is the default and the right choice on real Apple \
         Silicon; override it only where the Neural Engine is unusable.",
        COMPUTE_UNIT_PRESETS
            .iter()
            .map(|(name, _)| *name)
            .collect::<Vec<_>>()
            .join(", ")
    )
}

/// Read [`TOTAL_TIMEOUT_ENV`]. Unset means no overall cap: the per-phase budgets
/// already bound every way diarization can hang, and a wall-clock cap scaled to
/// audio length would kill healthy long runs (a 10-hour recording legitimately
/// takes ~2 h at the measured 0.19 real-time factor).
fn total_timeout_from_env() -> Result<Option<Duration>> {
    positive_secs_from_env(TOTAL_TIMEOUT_ENV)
}

/// Read [`LOAD_TIMEOUT_ENV`], falling back to [`MODEL_LOAD_BUDGET_SECS`].
fn load_budget_from_env() -> Result<Duration> {
    Ok(positive_secs_from_env(LOAD_TIMEOUT_ENV)?
        .unwrap_or_else(|| Duration::from_secs(MODEL_LOAD_BUDGET_SECS)))
}

/// Unset or empty means "not configured"; anything else must be a positive whole number
/// of seconds. Accepting `0`, `-1` or `30s` as "unset" would turn a typo into a silently
/// absent cap or a silently default budget — the fail-open that [`COMPUTE_UNITS_ENV`]
/// already refuses.
fn positive_secs_from_env(name: &str) -> Result<Option<Duration>> {
    let Ok(raw) = std::env::var(name) else {
        return Ok(None);
    };
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }
    match value.parse::<u64>() {
        Ok(secs) if secs > 0 => Ok(Some(Duration::from_secs(secs))),
        _ => coded_bail!(
            ErrorCode::InvalidArg,
            "{name}='{value}' is not a positive whole number of seconds. \
             Unset it to leave that budget at its default."
        ),
    }
}

/// How long the audio may take to read and resample before the first chunk.
fn prepare_budget(audio_secs: f32) -> Duration {
    Duration::from_secs(PREPARE_BUDGET_FLOOR_SECS)
        + Duration::from_secs_f32(audio_secs.max(0.0) * PREPARE_BUDGET_PER_AUDIO_SECOND)
}

/// What the worker thread is given to diarize, owned so it can outlive the caller's
/// borrows for as long as the thread does.
struct DiarizeJob {
    audio_path: PathBuf,
    model_path: PathBuf,
    units: DiarizeComputeUnits,
}

/// What the worker thread reports back while diarizing.
enum WorkerEvent {
    ModelReady,
    Progress {
        processed: u64,
        total: u64,
        chunks: u32,
    },
    Finished(Result<Option<Vec<DiarizeSpan>>>),
}

/// Which phase a run is in, as the binding reports it: [`Phase::Loading`] ends at the
/// model-ready marker and [`Phase::Preparing`] at the first processed chunk. Only
/// [`Phase::Processing`] responds to cancellation promptly — the Swift side checks it
/// between chunks, so a cancel during the load or the read waits for one to end.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Loading,
    Preparing,
    Processing,
}

/// Run FluidAudio diarization on a worker thread, forwarding its progress to stderr
/// and holding each phase to its own budget.
///
/// The blocking call is supervised rather than merely raced against a clock: the
/// binding marks the model as ready and then reports a chunk at a time, so the fixed
/// cost of loading CoreML is bounded separately from the audio-scaled cost of reading
/// the file, a stalled run is distinguishable from a slow one, and cancelling actually
/// stops the Swift work. The model load is the exception — it is a single
/// un-interruptible CoreML call, so exceeding its budget still abandons the worker
/// thread. That is safe here for the same reason as before: diarization only runs in a
/// one-shot CLI invocation, so the process exits right after we bail and the OS
/// reclaims the thread and the stalled model (#434).
fn run_supervised(
    job: DiarizeJob,
    total_deadline: Option<Duration>,
    audio_secs: f32,
) -> Result<Vec<DiarizeSpan>> {
    let (tx, rx) = mpsc::channel();
    let cancel = std::sync::Arc::new(DiarizeCancelToken::new());
    let units = job.units;
    spawn_worker(job, std::sync::Arc::clone(&cancel), tx);

    eprintln!("diarize: loading the CoreML model on {}", units.as_str());

    let now = Instant::now();
    let mut supervisor = PhaseSupervisor {
        phase: Phase::Loading,
        started: now,
        last_event: now,
        last_report: now,
        warned_slow_phase: false,
        last_progress: None,
        load_budget: load_budget_from_env()?,
        prepare_budget: prepare_budget(audio_secs),
        audio_secs,
        total_deadline,
    };

    loop {
        // Per iteration, not in the timeout arm: chunks arrive every ~0.1 s, so that arm never runs.
        if let Some(deadline) = supervisor.deadline_reached() {
            return stop_and_report(&supervisor, &cancel, &rx, || {
                supervisor.deadline_message(deadline)
            });
        }

        let event = rx.recv_timeout(supervisor.recv_timeout());
        if let Some(spans) = step(&mut supervisor, event, &cancel, &rx)? {
            return Ok(spans);
        }
    }
}

/// Fold one worker event into `supervisor`, yielding the spans once the run is over.
fn step(
    supervisor: &mut PhaseSupervisor,
    event: Result<WorkerEvent, mpsc::RecvTimeoutError>,
    cancel: &DiarizeCancelToken,
    rx: &mpsc::Receiver<WorkerEvent>,
) -> Result<Option<Vec<DiarizeSpan>>> {
    match event {
        Ok(WorkerEvent::ModelReady) => supervisor.on_model_ready(),
        Ok(WorkerEvent::Progress {
            processed,
            total,
            chunks,
        }) => supervisor.on_progress(processed, total, chunks),
        Ok(WorkerEvent::Finished(result)) => {
            let Some(spans) = result? else {
                // Only `stop_worker` cancels and it consumes that outcome itself, so one
                // arriving here raced past it — report the cancel rather than a stall that
                // did not happen.
                coded_bail!(
                    ErrorCode::DiarizeTimeout,
                    "speaker diarization was cancelled after {:.0}s",
                    supervisor.started.elapsed().as_secs_f32()
                )
            };
            return Ok(Some(supervisor.report_done(spans)));
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            if supervisor.on_quiet_tick().is_break() {
                return stop_and_report(supervisor, cancel, rx, || supervisor.stall_message())
                    .map(Some);
            }
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            coded_bail!(
                ErrorCode::Internal,
                "speaker diarization worker terminated unexpectedly"
            )
        }
    }
    Ok(None)
}

/// Stop the worker, then report what it left: its spans if the run beat the cancel,
/// otherwise `message` as a timeout. The message is built after the wait so it can
/// report the elapsed time the caller actually spent.
fn stop_and_report(
    supervisor: &PhaseSupervisor,
    cancel: &DiarizeCancelToken,
    rx: &mpsc::Receiver<WorkerEvent>,
    message: impl FnOnce() -> String,
) -> Result<Vec<DiarizeSpan>> {
    let grace = supervisor.cancel_grace();
    if grace > CANCEL_GRACE {
        let waiting_on = match supervisor.phase {
            Phase::Loading => "the model load",
            _ => "reading the audio",
        };
        eprintln!(
            "diarize: stopping, but {waiting_on} cannot be interrupted — waiting up to {:.0}s \
             for it to return",
            grace.as_secs_f32()
        );
    }
    if let Some(spans) = stop_worker(cancel, rx, grace) {
        return Ok(supervisor.report_done(spans));
    }
    coded_bail!(ErrorCode::DiarizeTimeout, "{}", message())
}

/// Run the blocking FluidAudio call on its own thread, reporting every event it emits
/// over `tx` and finishing with exactly one [`WorkerEvent::Finished`].
fn spawn_worker(
    job: DiarizeJob,
    cancel: std::sync::Arc<DiarizeCancelToken>,
    tx: mpsc::Sender<WorkerEvent>,
) {
    let DiarizeJob {
        audio_path,
        model_path,
        units,
    } = job;
    let progress_tx = tx.clone();

    std::thread::spawn(move || {
        // Oneshot guard silences sync CoreML stdout; async E5RT teardown print is
        // handled by `StdoutShield` at the CLI layer (fd 1 stays redirected past exit). (#259/#397/#434)
        let result = crate::fluid_stdout::with_silenced_stdout_oneshot(
            || -> Result<Option<Vec<DiarizeSpan>>> {
                let audio = FluidAudio::new().context("failed to initialize FluidAudio bridge")?;
                let mut on_event = |event: DiarizeEvent| {
                    let _ = progress_tx.send(match event {
                        DiarizeEvent::ModelReady => WorkerEvent::ModelReady,
                        DiarizeEvent::Progress(p) => WorkerEvent::Progress {
                            processed: p.processed_samples,
                            total: p.total_samples,
                            chunks: p.chunks,
                        },
                    });
                };
                let outcome = audio
                    .diarize_file_with_models_controlled(
                        &audio_path,
                        &model_path,
                        units,
                        Some(&cancel),
                        Some(&mut on_event),
                    )
                    .context("FluidAudio diarization failed")?;
                Ok(match outcome {
                    DiarizeOutcome::Completed(segments) => Some(to_spans(segments)),
                    DiarizeOutcome::Cancelled => None,
                })
            },
        );
        // The receiver is gone if we already bailed; dropping `result` is fine.
        let _ = tx.send(WorkerEvent::Finished(result));
    });
}

fn to_spans(segments: Vec<DiarizationSegment>) -> Vec<DiarizeSpan> {
    let mut seen: HashMap<String, u32> = HashMap::new();
    segments
        .into_iter()
        .map(|seg| DiarizeSpan {
            start: seg.start_time,
            end: seg.end_time,
            speaker: speaker_id_to_index(&mut seen, &seg.speaker_id),
        })
        .collect()
}

/// Which phase the run is in and what it may spend there, so the receive loop only has
/// to dispatch events.
struct PhaseSupervisor {
    phase: Phase,
    started: Instant,
    last_event: Instant,
    last_report: Instant,
    warned_slow_phase: bool,
    last_progress: Option<(u64, u64, u32)>,
    load_budget: Duration,
    prepare_budget: Duration,
    audio_secs: f32,
    total_deadline: Option<Duration>,
}

impl PhaseSupervisor {
    /// How long the current phase may go without an event before it counts as stalled.
    fn budget(&self) -> Duration {
        match self.phase {
            Phase::Loading => self.load_budget,
            Phase::Preparing => self.prepare_budget,
            Phase::Processing => Duration::from_secs(PROGRESS_STALL_BUDGET_SECS),
        }
    }

    /// How long to wait for the worker to acknowledge a cancel. Processing checks the
    /// token between chunks and answers in ~0.06s, but the load and the read are each a
    /// single call that only notices the cancel once it returns — so the wait there has
    /// to be the rest of the budget that phase was already granted. Cutting it to
    /// [`CANCEL_GRACE`] would return under a live CoreML call, which is the SIGSEGV this
    /// supervision exists to prevent, merely moved off the processing path (#443).
    fn cancel_grace(&self) -> Duration {
        match self.phase {
            Phase::Processing => CANCEL_GRACE,
            _ => self
                .budget()
                .saturating_sub(self.last_event.elapsed())
                .max(CANCEL_GRACE),
        }
    }

    /// The caller's total cap, once it has run out.
    fn deadline_reached(&self) -> Option<Duration> {
        let deadline = self.total_deadline?;
        deadline
            .saturating_sub(self.started.elapsed())
            .is_zero()
            .then_some(deadline)
    }

    fn recv_timeout(&self) -> Duration {
        match self.total_deadline {
            Some(deadline) => {
                PROGRESS_REPORT_INTERVAL.min(deadline.saturating_sub(self.started.elapsed()))
            }
            None => PROGRESS_REPORT_INTERVAL,
        }
    }

    fn on_model_ready(&mut self) {
        self.phase = Phase::Preparing;
        let load_secs = self.started.elapsed().as_secs_f32();
        eprintln!("diarize: model ready in {load_secs:.1}s; reading the audio");
        dtrace!("diarize::model_loaded dt={:.1}s", load_secs);
        dtrace_json!("diarize.model_loaded", { "load_secs": load_secs });
        let now = Instant::now();
        self.last_event = now;
        self.last_report = now;
        self.warned_slow_phase = false;
    }

    fn on_progress(&mut self, processed: u64, total: u64, chunks: u32) {
        if self.phase != Phase::Processing {
            self.phase = Phase::Processing;
            self.last_report = Instant::now();
            self.warned_slow_phase = false;
        }
        self.last_event = Instant::now();
        self.last_progress = Some((processed, total, chunks));
        if self.last_report.elapsed() >= PROGRESS_REPORT_INTERVAL {
            self.last_report = Instant::now();
            eprintln!(
                "diarize: {:.0}% ({} chunks, {:.0}s elapsed)",
                progress_ratio(processed, total) * 100.0,
                chunks,
                self.started.elapsed().as_secs_f32()
            );
        }
    }

    /// Breaks once the phase has outrun its budget; otherwise says what a phase that has
    /// gone quiet is waiting for.
    fn on_quiet_tick(&mut self) -> ControlFlow<()> {
        let stalled_for = self.last_event.elapsed();
        if stalled_for >= self.budget() {
            return ControlFlow::Break(());
        }
        if self.phase != Phase::Processing && stalled_for >= SLOW_PHASE_HINT_AFTER {
            self.report_slow_phase(stalled_for);
        }
        ControlFlow::Continue(())
    }

    fn report_slow_phase(&mut self, stalled_for: Duration) {
        if !self.warned_slow_phase {
            self.warned_slow_phase = true;
            eprintln!(
                "diarize: {}",
                slow_phase_hint(self.phase, stalled_for, self.audio_secs)
            );
            self.last_report = Instant::now();
        } else if self.last_report.elapsed() >= SLOW_PHASE_TICK_INTERVAL {
            self.last_report = Instant::now();
            eprintln!(
                "diarize: still {} ({:.0}s)",
                match self.phase {
                    Phase::Loading => "loading",
                    _ => "reading the audio",
                },
                stalled_for.as_secs_f32()
            );
        }
    }

    fn stall_message(&self) -> String {
        stall_error(
            self.phase,
            self.started.elapsed(),
            self.audio_secs,
            self.last_progress,
        )
    }

    fn deadline_message(&self, deadline: Duration) -> String {
        deadline_error(deadline, self.phase, self.audio_secs, self.last_progress)
    }

    /// Announce a completed run on stderr and hand the spans back.
    fn report_done(&self, spans: Vec<DiarizeSpan>) -> Vec<DiarizeSpan> {
        let elapsed = self.started.elapsed().as_secs_f32();
        eprintln!("diarize: done in {elapsed:.1}s ({} spans)", spans.len());
        dtrace!("diarize::finished dt={:.1}s spans={}", elapsed, spans.len());
        dtrace_json!(
            "diarize.finished",
            { "elapsed_secs": elapsed, "spans": spans.len() }
        );
        spans
    }
}

/// Say what a phase that has gone quiet is actually waiting for, so the wait reads as
/// diagnosis rather than a hang.
fn slow_phase_hint(phase: Phase, stalled_for: Duration, audio_secs: f32) -> String {
    match phase {
        Phase::Loading => format!(
            "the model is still loading after {:.0}s — a cold Neural Engine cache makes this \
             take ~105s, once (#443)",
            stalled_for.as_secs_f32()
        ),
        _ => format!(
            "the model is loaded; still reading and resampling {audio_secs:.0}s of audio after \
             {:.0}s",
            stalled_for.as_secs_f32()
        ),
    }
}

/// Cancel the run and wait for the worker to acknowledge before the caller bails.
/// Returns the spans if the run turned out to have finished successfully inside the
/// grace window — a cancel that loses that race has nothing to report, and throwing
/// away a complete answer to report a timeout would be a lie.
///
/// Returning while the Swift task is still unwinding crashes the process on exit
/// (observed as SIGSEGV), so the grace period is what makes cancellation a clean
/// stop rather than a faster abandonment. If the wait expires the work was not
/// interruptible — the model load, in practice — and we fall back to the old
/// behaviour of leaving the thread for process exit to reap (#434).
fn stop_worker(
    cancel: &DiarizeCancelToken,
    rx: &mpsc::Receiver<WorkerEvent>,
    grace: Duration,
) -> Option<Vec<DiarizeSpan>> {
    cancel.cancel();
    await_worker_stop(rx, grace)
}

/// Wait out the acknowledgement, discarding the events that arrive while the worker
/// unwinds. Split from [`stop_worker`] so the wait can be driven by a plain channel.
fn await_worker_stop(
    rx: &mpsc::Receiver<WorkerEvent>,
    grace: Duration,
) -> Option<Vec<DiarizeSpan>> {
    let deadline = Instant::now() + grace;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return None;
        }
        match rx.recv_timeout(left) {
            Ok(WorkerEvent::Progress { .. }) | Ok(WorkerEvent::ModelReady) => continue,
            Ok(WorkerEvent::Finished(result)) => return result.ok().flatten(),
            Err(_) => return None,
        }
    }
}

/// Fraction of the audio consumed. Whole chunks only, so a healthy run tops out
/// around 99% rather than 100% — never report it as completion.
fn progress_ratio(processed: u64, total: u64) -> f32 {
    if total == 0 {
        return 0.0;
    }
    (processed as f32 / total as f32).clamp(0.0, 1.0)
}

/// Explain a run cut short by the caller's own cap, which is not a malfunction and
/// must not read like one.
fn deadline_error(
    deadline: Duration,
    phase: Phase,
    audio_secs: f32,
    last_progress: Option<(u64, u64, u32)>,
) -> String {
    let where_at = match (phase, last_progress) {
        (Phase::Loading, _) => "while the CoreML model was still loading".to_string(),
        (Phase::Preparing, _) => "while the audio was still being read".to_string(),
        (Phase::Processing, Some((processed, total, chunks))) => format!(
            "at {:.0}% ({chunks} chunks processed)",
            progress_ratio(processed, total) * 100.0
        ),
        (Phase::Processing, None) => "before the first chunk was reported".to_string(),
    };
    format!(
        "speaker diarization was cancelled {where_at} because {TOTAL_TIMEOUT_ENV}={}s was \
         reached, on {audio_secs:.0}s of audio. Raise or unset it to let the run finish",
        deadline.as_secs(),
    )
}

/// Explain a stall in terms of the phase it happened in, naming only remedies that can
/// act on that phase — so #443's "slow once" is readable off stderr instead of inferred.
fn stall_error(
    phase: Phase,
    elapsed: Duration,
    audio_secs: f32,
    last_progress: Option<(u64, u64, u32)>,
) -> String {
    match phase {
        Phase::Loading => format!(
            "speaker diarization gave up after {}s waiting for the CoreML model to load, \
             before reading any audio. A cold Apple ANE cache makes this load take ~105s; \
             longer than that means it is stuck, not slow. Re-run `kesha install --diarize` \
             to warm the cache, or set {COMPUTE_UNITS_ENV}=cpu-and-gpu to skip the Neural \
             Engine entirely. If this machine is simply slower, raise the budget with \
             {LOAD_TIMEOUT_ENV} (default {MODEL_LOAD_BUDGET_SECS}s)",
            elapsed.as_secs(),
        ),
        Phase::Preparing => format!(
            "speaker diarization gave up after {}s: the CoreML model loaded, but reading and \
             resampling {audio_secs:.0}s of audio never produced a first chunk. Reading is \
             normally far faster than the audio is long (measured 0.26s for 185s), so this is \
             a bug rather than a slow machine — please report it at \
             https://github.com/drakulavich/kesha-voice-kit/issues",
            elapsed.as_secs(),
        ),
        Phase::Processing => {
            let where_at = match last_progress {
                Some((processed, total, chunks)) => format!(
                    "at {:.0}% ({chunks} chunks processed)",
                    progress_ratio(processed, total) * 100.0
                ),
                None => "before reporting any progress".to_string(),
            };
            format!(
                "speaker diarization stalled {where_at} and was cancelled after {}s on {:.0}s \
                 of audio; it normally processes ~10 chunks per second. This is a bug in the \
                 CoreML pipeline rather than a slow machine — please report it at \
                 https://github.com/drakulavich/kesha-voice-kit/issues",
                elapsed.as_secs(),
                audio_secs,
            )
        }
    }
}

/// Map FluidAudio's speaker labels to stable numeric ids by first-seen order.
/// Unlike parsing the `SPEAKER_NN` suffix, distinct labels never collide onto the
/// same id (#434) — the merge contract only needs ids stable within a single call.
fn speaker_id_to_index(seen: &mut HashMap<String, u32>, label: &str) -> u32 {
    if let Some(&idx) = seen.get(label) {
        return idx;
    }
    let idx = seen.len() as u32;
    seen.insert(label.to_string(), idx);
    idx
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct DiarizeCoverage {
    pub total_segments: usize,
    pub labeled_segments: usize,
    pub coverage_ratio: f32,
    pub max_asr_end: f32,
    pub max_span_end: f32,
}

pub(crate) fn validate_coverage(
    asr_segments: &[TranscriptionSegment],
    diarize_spans: &[DiarizeSpan],
) -> Result<DiarizeCoverage> {
    if asr_segments.is_empty() {
        return Ok(DiarizeCoverage {
            total_segments: 0,
            labeled_segments: 0,
            coverage_ratio: 1.0,
            max_asr_end: 0.0,
            max_span_end: 0.0,
        });
    }

    let max_asr_end = max_asr_end(asr_segments).unwrap_or(0.0);
    let max_span_end = diarize_spans
        .iter()
        .map(|span| span.end)
        .fold(0.0_f32, f32::max);
    let labeled_segments = asr_segments
        .iter()
        .filter(|seg| {
            let midpoint = (seg.start + seg.end) / 2.0;
            diarize_spans
                .iter()
                .any(|span| span.start <= midpoint && midpoint < span.end)
        })
        .count();
    let total_segments = asr_segments.len();
    let coverage_ratio = labeled_segments as f32 / total_segments as f32;
    let coverage = DiarizeCoverage {
        total_segments,
        labeled_segments,
        coverage_ratio,
        max_asr_end,
        max_span_end,
    };

    if coverage_is_incomplete(&coverage, diarize_spans.is_empty()) {
        bail!(
            "speaker diarization coverage incomplete: labeled {}/{} segments ({:.1}%), \
             spans end at {:.1}s while transcript ends at {:.1}s",
            labeled_segments,
            total_segments,
            coverage_ratio * 100.0,
            max_span_end,
            max_asr_end
        );
    }

    Ok(coverage)
}

fn coverage_is_incomplete(coverage: &DiarizeCoverage, spans_absent: bool) -> bool {
    if spans_absent {
        return true;
    }
    if coverage.max_span_end + MAX_DIARIZE_TAIL_GAP_SECONDS < coverage.max_asr_end {
        return true;
    }
    // A lone ASR segment makes the ratio a coin flip (0.0 or 1.0) decided by whether the
    // midpoint lands in a speaker-change gap: that is absent segmentation, not partial
    // labeling, so the percentage cannot decide it (#768).
    coverage.total_segments > 1 && coverage.coverage_ratio < MIN_DIARIZE_SEGMENT_COVERAGE
}

fn max_asr_end(asr_segments: &[TranscriptionSegment]) -> Option<f32> {
    asr_segments.iter().map(|seg| seg.end).reduce(f32::max)
}

pub(crate) fn merge_into(
    asr_segs: Vec<TranscriptionSegment>,
    diarize_spans: &[DiarizeSpan],
) -> Vec<TranscriptionSegment> {
    asr_segs
        .into_iter()
        .map(|mut seg| {
            let midpoint = (seg.start + seg.end) / 2.0;
            seg.speaker = diarize_spans
                .iter()
                .find(|s| s.start <= midpoint && midpoint < s.end)
                .map(|s| s.speaker);
            seg
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(start: f32, end: f32, text: &str) -> TranscriptionSegment {
        TranscriptionSegment {
            start,
            end,
            text: text.into(),
            speaker: None,
        }
    }
    fn span(start: f32, end: f32, speaker: u32) -> DiarizeSpan {
        DiarizeSpan {
            start,
            end,
            speaker,
        }
    }

    #[test]
    fn one_to_one_overlap_assigns_speaker() {
        let segs = vec![seg(1.0, 3.0, "hi")];
        let spans = vec![span(0.0, 5.0, 7)];
        let out = merge_into(segs, &spans);
        assert_eq!(out[0].speaker, Some(7));
    }

    #[test]
    fn no_overlap_yields_none() {
        let segs = vec![seg(10.0, 11.0, "hi")];
        let spans = vec![span(0.0, 5.0, 0)];
        let out = merge_into(segs, &spans);
        assert_eq!(out[0].speaker, None);
    }

    #[test]
    fn span_split_assigns_via_midpoint() {
        // ASR seg 1.0-3.0, midpoint 2.0. Spans: 0..1.5 (speaker 0), 1.5..5 (speaker 1).
        // 2.0 ∈ [1.5, 5) → speaker 1.
        let segs = vec![seg(1.0, 3.0, "hi")];
        let spans = vec![span(0.0, 1.5, 0), span(1.5, 5.0, 1)];
        let out = merge_into(segs, &spans);
        assert_eq!(out[0].speaker, Some(1));
    }

    #[test]
    fn empty_diarize_spans_yield_all_none() {
        let segs = vec![seg(0.0, 1.0, "a"), seg(1.0, 2.0, "b")];
        let out = merge_into(segs, &[]);
        assert!(out.iter().all(|s| s.speaker.is_none()));
    }

    #[test]
    fn empty_asr_segs_returns_empty() {
        let out = merge_into(vec![], &[span(0.0, 5.0, 0)]);
        assert!(out.is_empty());
    }

    #[test]
    fn four_speaker_meeting_assigns_distinct_ids() {
        let segs = vec![
            seg(0.5, 1.5, "a"),
            seg(2.0, 3.0, "b"),
            seg(4.0, 5.0, "c"),
            seg(6.0, 7.0, "d"),
        ];
        let spans = vec![
            span(0.0, 1.7, 0),
            span(1.7, 3.5, 1),
            span(3.5, 5.5, 2),
            span(5.5, 8.0, 3),
        ];
        let out = merge_into(segs, &spans);
        assert_eq!(
            out.iter().map(|s| s.speaker).collect::<Vec<_>>(),
            vec![Some(0), Some(1), Some(2), Some(3)]
        );
    }

    #[test]
    fn coverage_validation_accepts_full_timeline() {
        let segs = vec![seg(0.0, 1.0, "a"), seg(1.0, 2.0, "b")];
        let spans = vec![span(0.0, 1.0, 0), span(1.0, 2.0, 1)];

        let coverage = validate_coverage(&segs, &spans).expect("full coverage should pass");

        assert_eq!(coverage.total_segments, 2);
        assert_eq!(coverage.labeled_segments, 2);
        assert_eq!(coverage.coverage_ratio, 1.0);
        assert_eq!(coverage.max_asr_end, 2.0);
        assert_eq!(coverage.max_span_end, 2.0);
    }

    #[test]
    fn coverage_validation_rejects_spans_that_end_mid_transcript() {
        let segs = vec![seg(0.0, 10.0, "a"), seg(100.0, 110.0, "b")];
        let spans = vec![span(0.0, 10.0, 0)];

        let err = validate_coverage(&segs, &spans)
            .expect_err("mid-run diarization stop should fail closed");
        let msg = format!("{err}");

        assert!(msg.contains("speaker diarization coverage incomplete"));
        assert!(msg.contains("labeled 1/2 segments"));
        assert!(msg.contains("spans end at 10.0s while transcript ends at 110.0s"));
    }

    #[test]
    fn coverage_validation_rejects_low_midpoint_coverage() {
        let segs = vec![
            seg(0.0, 1.0, "a"),
            seg(1.0, 2.0, "b"),
            seg(2.0, 3.0, "c"),
            seg(3.0, 4.0, "d"),
        ];
        let spans = vec![span(0.0, 4.0, 0), span(10.0, 20.0, 1)];
        let sparse_spans = vec![span(0.0, 1.0, 0), span(10.0, 20.0, 1)];

        validate_coverage(&segs, &spans).expect("full midpoint coverage should pass");
        let err =
            validate_coverage(&segs, &sparse_spans).expect_err("low midpoint coverage should fail");
        let msg = format!("{err}");

        assert!(msg.contains("labeled 1/4 segments"));
        assert!(msg.contains("(25.0%)"));
    }

    #[test]
    fn coverage_validation_rejects_empty_spans_when_asr_has_segments() {
        let segs = vec![seg(0.0, 1.0, "a")];

        let err = validate_coverage(&segs, &[]).expect_err("empty spans should fail");
        let msg = format!("{err}");

        assert!(msg.contains("labeled 0/1 segments"));
        assert!(msg.contains("spans end at 0.0s while transcript ends at 1.0s"));
    }

    #[test]
    fn coverage_validation_does_not_coin_flip_on_a_lone_whole_file_segment() {
        // #768: no VAD windowing → one whole-file segment whose midpoint lands in the
        // silence between two speakers. 0/1 labeled must not read as 0% coverage.
        let segs = vec![seg(0.0, 6.6, "hello there hi back")];
        let spans = vec![span(0.0, 3.0, 0), span(3.5, 6.2, 1)];

        let coverage =
            validate_coverage(&segs, &spans).expect("absent segmentation is not partial coverage");

        assert_eq!(coverage.labeled_segments, 0);
        assert_eq!(coverage.coverage_ratio, 0.0);
        assert_eq!(coverage.max_span_end, 6.2);
    }

    #[test]
    fn coverage_validation_still_rejects_a_lone_segment_with_a_stalled_tail() {
        let segs = vec![seg(0.0, 600.0, "long")];
        let spans = vec![span(0.0, 120.0, 0)];

        let err = validate_coverage(&segs, &spans)
            .expect_err("spans stopping 480s before the transcript end should fail closed");

        assert!(format!("{err}").contains("speaker diarization coverage incomplete"));
    }

    #[test]
    fn coverage_validation_allows_empty_asr_segments() {
        let coverage =
            validate_coverage(&[], &[]).expect("no ASR segments means no missing labels");

        assert_eq!(coverage.total_segments, 0);
        assert_eq!(coverage.labeled_segments, 0);
        assert_eq!(coverage.coverage_ratio, 1.0);
    }

    #[test]
    fn speaker_ids_map_by_first_seen_order_without_collision() {
        let mut seen = HashMap::new();
        assert_eq!(speaker_id_to_index(&mut seen, "SPEAKER_00"), 0);
        assert_eq!(speaker_id_to_index(&mut seen, "SPEAKER_01"), 1);
        // Stable within a call.
        assert_eq!(speaker_id_to_index(&mut seen, "SPEAKER_00"), 0);
        // The #433 P2 bug: distinct labels sharing a numeric suffix must NOT
        // collapse onto the same id (the old `rsplit('_')` parse mapped both to 0).
        assert_eq!(speaker_id_to_index(&mut seen, "A_0"), 2);
        assert_eq!(speaker_id_to_index(&mut seen, "B_0"), 3);
    }

    #[test]
    fn load_stall_error_explains_the_cold_ane_compile() {
        let msg = stall_error(Phase::Loading, Duration::from_secs(300), 4.0, None);

        assert!(msg.contains("gave up after 300s waiting for the CoreML model to load"));
        assert!(msg.contains("before reading any audio"));
        assert!(msg.contains("~105s"));
        assert!(msg.contains("kesha install --diarize"));
        assert!(msg.contains(COMPUTE_UNITS_ENV));
        // The load budget is the one this phase answers to; the total cap can only
        // shorten a run, so offering it as a remedy would send the user nowhere.
        assert!(msg.contains(LOAD_TIMEOUT_ENV));
        assert!(!msg.contains(&format!("raise {TOTAL_TIMEOUT_ENV}")));
    }

    #[test]
    fn prepare_stall_error_does_not_blame_the_model_load() {
        let msg = stall_error(Phase::Preparing, Duration::from_secs(60), 185.0, None);

        assert!(msg.contains("the CoreML model loaded"));
        assert!(msg.contains("reading and resampling 185s of audio"));
        // Past the load the ANE cache is demonstrably warm; don't send them to rewarm it (#443).
        assert!(!msg.contains("kesha install --diarize"));
        assert!(!msg.contains("~105s"));
    }

    #[test]
    fn processing_stall_error_names_where_it_stopped() {
        let msg = stall_error(
            Phase::Processing,
            Duration::from_secs(60),
            92.0,
            Some((300, 1_000, 42)),
        );

        assert!(msg.contains("stalled at 30% (42 chunks processed)"));
        assert!(msg.contains("cancelled after 60s on 92s of audio"));
        // Past the chunk loop the ANE cache is demonstrably warm; don't send them to rewarm it (#443).
        assert!(!msg.contains("kesha install --diarize"));
    }

    #[test]
    fn deadline_error_blames_the_cap_not_the_engine() {
        let msg = deadline_error(
            Duration::from_secs(12),
            Phase::Processing,
            185.0,
            Some((250, 1_000, 30)),
        );

        assert!(msg.contains("cancelled at 25% (30 chunks processed)"));
        assert!(msg.contains(&format!("{TOTAL_TIMEOUT_ENV}=12s was reached")));
        assert!(msg.contains("on 185s of audio"));
        assert!(!msg.contains("stalled"));
    }

    #[test]
    fn deadline_error_names_the_phase_it_interrupted() {
        let loading = deadline_error(Duration::from_secs(1), Phase::Loading, 185.0, None);
        let preparing = deadline_error(Duration::from_secs(1), Phase::Preparing, 185.0, None);

        assert!(loading.contains("while the CoreML model was still loading"));
        assert!(preparing.contains("while the audio was still being read"));
        assert!(!preparing.contains("loading"));
    }

    #[test]
    fn prepare_budget_scales_with_the_audio() {
        // The floor covers everything short; only a very long file needs more.
        assert_eq!(
            prepare_budget(0.0),
            Duration::from_secs(PREPARE_BUDGET_FLOOR_SECS)
        );
        assert!((prepare_budget(185.0).as_secs_f32() - 61.85).abs() < 0.01);
        // 10 hours: measured reading cost ~50s, budget 420s.
        assert_eq!(prepare_budget(36_000.0).as_secs(), 420);
    }

    #[test]
    fn progress_ratio_never_exceeds_one_or_divides_by_zero() {
        assert_eq!(progress_ratio(0, 0), 0.0);
        assert_eq!(progress_ratio(500, 1_000), 0.5);
        assert_eq!(progress_ratio(2_000, 1_000), 1.0);
    }

    #[test]
    fn compute_units_default_to_all_and_reject_junk() {
        let _guard = crate::util::test_env::lock();

        unsafe {
            std::env::remove_var(COMPUTE_UNITS_ENV);
        }
        assert_eq!(compute_units_from_env().unwrap(), DiarizeComputeUnits::All);

        let _env = crate::util::test_env::EnvGuard::set(COMPUTE_UNITS_ENV, "CPU-Only");
        assert_eq!(
            compute_units_from_env().unwrap(),
            DiarizeComputeUnits::CpuOnly
        );

        let _env = crate::util::test_env::EnvGuard::set(COMPUTE_UNITS_ENV, "tpu");
        let err = compute_units_from_env().unwrap_err().to_string();
        assert!(err.contains("is not a known CoreML compute-units preset"));
        assert!(err.contains("cpu-and-gpu"));
    }

    #[test]
    fn total_timeout_is_opt_in() {
        let _guard = crate::util::test_env::lock();

        unsafe {
            std::env::remove_var(TOTAL_TIMEOUT_ENV);
        }
        assert_eq!(total_timeout_from_env().unwrap(), None);

        let _env = crate::util::test_env::EnvGuard::set(TOTAL_TIMEOUT_ENV, "3600");
        assert_eq!(
            total_timeout_from_env().unwrap(),
            Some(Duration::from_secs(3_600))
        );

        // Empty reads as "not configured"; a wrapper exporting an unset variable is not
        // making a claim about the cap.
        let _env = crate::util::test_env::EnvGuard::set(TOTAL_TIMEOUT_ENV, "  ");
        assert_eq!(total_timeout_from_env().unwrap(), None);
    }

    #[test]
    fn a_cap_that_cannot_be_honoured_is_refused_not_ignored() {
        let _guard = crate::util::test_env::lock();

        // Silently reading as "no cap" is how a typo removes the only bound the user
        // asked for; `0` gets the same treatment because unsetting already means no cap.
        for bad in ["0", "-1", "1.5", "300s", "nope"] {
            let _env = crate::util::test_env::EnvGuard::set(TOTAL_TIMEOUT_ENV, bad);
            let err = total_timeout_from_env().unwrap_err().to_string();
            assert!(err.contains(TOTAL_TIMEOUT_ENV), "{bad}: {err}");
            assert!(
                err.contains("positive whole number of seconds"),
                "{bad}: {err}"
            );
        }
    }

    #[test]
    fn load_budget_is_overridable_but_never_zero() {
        let _guard = crate::util::test_env::lock();

        unsafe {
            std::env::remove_var(LOAD_TIMEOUT_ENV);
        }
        assert_eq!(
            load_budget_from_env().unwrap(),
            Duration::from_secs(MODEL_LOAD_BUDGET_SECS)
        );

        let _env = crate::util::test_env::EnvGuard::set(LOAD_TIMEOUT_ENV, "900");
        assert_eq!(load_budget_from_env().unwrap(), Duration::from_secs(900));

        // A typo here used to hand back the default budget without a word.
        let _env = crate::util::test_env::EnvGuard::set(LOAD_TIMEOUT_ENV, "nope");
        let err = load_budget_from_env().unwrap_err().to_string();
        assert!(err.contains(LOAD_TIMEOUT_ENV), "{err}");
    }

    fn supervisor_in(phase: Phase, load_budget: Duration) -> PhaseSupervisor {
        let now = Instant::now();
        PhaseSupervisor {
            phase,
            started: now,
            last_event: now,
            last_report: now,
            warned_slow_phase: false,
            last_progress: None,
            load_budget,
            prepare_budget: Duration::from_secs(PREPARE_BUDGET_FLOOR_SECS),
            audio_secs: 90.0,
            total_deadline: None,
        }
    }

    #[test]
    fn cancel_grace_during_the_load_outlasts_the_uninterruptible_call() {
        let supervisor = supervisor_in(Phase::Loading, Duration::from_secs(300));

        // A cold ANE compile runs ~105s and cannot be interrupted, so a cap that fires
        // early must still wait it out: returning first leaves CoreML running under a
        // process about to exit, which is the SIGSEGV this supervision exists to stop.
        assert!(
            supervisor.cancel_grace() >= Duration::from_secs(240),
            "load grace was {:?}",
            supervisor.cancel_grace()
        );
    }

    #[test]
    fn cancel_grace_during_the_read_outlasts_it_too() {
        let mut supervisor = supervisor_in(Phase::Loading, Duration::from_secs(300));
        supervisor.on_model_ready();

        assert!(supervisor.cancel_grace() > CANCEL_GRACE);
    }

    #[test]
    fn cancel_grace_stays_short_once_chunks_are_flowing() {
        let mut supervisor = supervisor_in(Phase::Loading, Duration::from_secs(300));
        supervisor.on_progress(1, 10, 1);

        // Processing checks the token between chunks, so it acknowledges in ~0.06s.
        assert_eq!(supervisor.cancel_grace(), CANCEL_GRACE);
    }

    #[test]
    fn an_exhausted_phase_still_gets_a_grace_window() {
        let supervisor = supervisor_in(Phase::Loading, Duration::ZERO);

        assert_eq!(supervisor.cancel_grace(), CANCEL_GRACE);
    }

    #[test]
    fn phases_advance_from_load_through_read_to_processing() {
        let mut supervisor = supervisor_in(Phase::Loading, Duration::from_secs(300));
        assert_eq!(supervisor.budget(), Duration::from_secs(300));

        supervisor.on_model_ready();
        assert_eq!(supervisor.phase, Phase::Preparing);
        assert_eq!(
            supervisor.budget(),
            Duration::from_secs(PREPARE_BUDGET_FLOOR_SECS)
        );

        supervisor.on_progress(1, 10, 1);
        assert_eq!(supervisor.phase, Phase::Processing);
        assert_eq!(
            supervisor.budget(),
            Duration::from_secs(PROGRESS_STALL_BUDGET_SECS)
        );
    }

    #[test]
    fn a_phase_that_outruns_its_budget_breaks_the_loop() {
        let mut supervisor = supervisor_in(Phase::Loading, Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(5));

        assert!(supervisor.on_quiet_tick().is_break());
    }

    #[test]
    fn a_phase_inside_its_budget_keeps_waiting() {
        let mut supervisor = supervisor_in(Phase::Loading, Duration::from_secs(300));

        assert!(supervisor.on_quiet_tick().is_continue());
    }

    #[test]
    fn the_total_cap_is_reached_before_the_next_receive() {
        let mut supervisor = supervisor_in(Phase::Loading, Duration::from_secs(300));
        supervisor.total_deadline = Some(Duration::from_millis(1));
        std::thread::sleep(Duration::from_millis(5));

        assert_eq!(
            supervisor.deadline_reached(),
            Some(Duration::from_millis(1))
        );
    }

    #[test]
    fn without_a_total_cap_no_deadline_is_ever_reached() {
        let supervisor = supervisor_in(Phase::Loading, Duration::from_secs(300));

        assert_eq!(supervisor.deadline_reached(), None);
    }

    #[test]
    fn a_run_that_beats_the_cancel_keeps_its_spans() {
        let (tx, rx) = mpsc::channel();
        tx.send(WorkerEvent::Finished(Ok(Some(vec![span(0.0, 1.0, 3)]))))
            .unwrap();

        let kept = await_worker_stop(&rx, Duration::from_secs(5)).expect("spans");
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].speaker, 3);
    }

    #[test]
    fn events_arriving_while_the_worker_unwinds_are_drained() {
        let (tx, rx) = mpsc::channel();
        tx.send(WorkerEvent::Progress {
            processed: 1,
            total: 2,
            chunks: 1,
        })
        .unwrap();
        tx.send(WorkerEvent::ModelReady).unwrap();
        tx.send(WorkerEvent::Finished(Ok(None))).unwrap();

        assert!(await_worker_stop(&rx, Duration::from_secs(5)).is_none());
    }

    #[test]
    fn a_worker_that_never_answers_is_abandoned_after_the_grace() {
        let (_tx, rx) = mpsc::channel::<WorkerEvent>();
        let started = Instant::now();

        assert!(await_worker_stop(&rx, Duration::from_millis(50)).is_none());
        assert!(started.elapsed() >= Duration::from_millis(50));
    }

    #[test]
    fn a_dead_worker_is_not_waited_out() {
        let (tx, rx) = mpsc::channel::<WorkerEvent>();
        drop(tx);

        assert!(await_worker_stop(&rx, Duration::from_secs(30)).is_none());
    }
}
