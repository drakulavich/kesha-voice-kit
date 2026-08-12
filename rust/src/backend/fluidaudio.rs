use std::os::fd::OwnedFd;

use anyhow::{Context, Result};
use fluidaudio_rs::{AsrWordTiming, FluidAudio};

use crate::fluid_stdout::with_silenced_stdout;
use crate::transcribe::WordTiming;

use super::{TranscribeBackend, TranscriptionChunk};

/// FluidAudio's CoreML ASR rejects clips shorter than ~1s (returns
/// `invalidAudioData` and prints the error to stdout — see #259).
/// VAD spans frequently produce sub-second segments at speech onsets /
/// offsets, so we pad them with trailing silence before handing to
/// `transcribe_file`. 1.5 s @ 16 kHz = 24 000 samples; well above the
/// observed failure threshold and small enough that the extra silence
/// doesn't cost meaningful ASR latency.
const MIN_SAMPLES: usize = 16_000 + 16_000 / 2; // 1.5 s @ 16 kHz

pub struct FluidAudioBackend {
    audio: FluidAudio,
    /// Pre-opened sink reused across `transcribe_samples` calls to skip the open
    /// syscall on the per-segment hot path (~10K saved on a 1 h meeting).
    sink: Option<OwnedFd>,
}

impl FluidAudioBackend {
    pub fn new() -> Result<Self> {
        let audio = crate::models::fluidaudio_bridge(&crate::models::fluidaudio_asr_location())
            .context("failed to initialize FluidAudio bridge")?;
        audio
            .init_asr()
            .context("failed to initialize FluidAudio ASR (first run compiles models for ANE)")?;
        Ok(Self {
            audio,
            sink: crate::fluid_stdout::oneshot_sink(),
        })
    }
}

impl TranscribeBackend for FluidAudioBackend {
    fn transcribe(&mut self, audio_path: &str) -> Result<TranscriptionChunk> {
        let (result, words) = self
            .audio
            .transcribe_file_with_words(audio_path)
            .context("FluidAudio transcription failed")?;
        Ok(chunk_from(result.text, words))
    }

    /// stdout is silenced for the call: even with padding, upstream prints
    /// would corrupt `--json` output (#259).
    fn transcribe_samples(&mut self, samples: &[f32]) -> Result<TranscriptionChunk> {
        let padded = pad_to_min(samples, MIN_SAMPLES);
        let (result, words) = with_silenced_stdout(self.sink.as_ref(), || {
            self.audio.transcribe_samples_with_words(&padded)
        })
        .context("FluidAudio sample transcription failed")?;
        Ok(chunk_from(result.text, words))
    }
}

/// Pair a transcript with the timings FluidAudio grouped for it, keeping them
/// only when they *are* the transcript's words — one entry per whitespace-
/// separated word, same spelling, same order.
///
/// Both sides come from one decode, so they agree in practice; the check is here
/// because nothing downstream re-verifies it. The segmenting paths address words
/// positionally (the fixed-window seam drops them by count), so a grouping that
/// ever disagreed would silently name words the text does not have. Absent beats
/// misaligned — that is also why no timings at all reads as `None` rather than
/// an empty list, which is reserved for nothing (#720).
fn chunk_from(text: String, words: Vec<AsrWordTiming>) -> TranscriptionChunk {
    let aligned = !words.is_empty()
        && words
            .iter()
            .map(|w| w.word.as_str())
            .eq(text.split_whitespace());
    let words = aligned.then(|| {
        words
            .into_iter()
            .map(|w| WordTiming {
                word: w.word,
                start: w.start,
                end: w.end,
            })
            .collect()
    });
    TranscriptionChunk { text, words }
}

/// Returns a borrowed `Cow` so already-long-enough inputs don't allocate.
fn pad_to_min(samples: &[f32], min_len: usize) -> std::borrow::Cow<'_, [f32]> {
    if samples.len() >= min_len {
        std::borrow::Cow::Borrowed(samples)
    } else {
        let mut padded = Vec::with_capacity(min_len);
        padded.extend_from_slice(samples);
        padded.resize(min_len, 0.0);
        std::borrow::Cow::Owned(padded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fmt::Write as _;
    use std::path::Path;

    /// #841: the warm-cache flake fails ~20 s in with a bare "Transcription
    /// failed" on a cleanly restored bundle, and a same-SHA rerun goes green —
    /// so the failing attempt is the only place the evidence will ever exist.
    /// Renders on panic; the retry below renders it by hand, so an attempt that
    /// fails and then recovers still files its dump.
    struct FailureDump {
        first_call: Option<String>,
    }

    impl Drop for FailureDump {
        fn drop(&mut self) {
            if std::thread::panicking() {
                eprintln!("{}", render_diagnostics(self.first_call.as_deref()));
            }
        }
    }

    fn render_diagnostics(first_call: Option<&str>) -> String {
        let loc = crate::models::fluidaudio_asr_location();
        let mut out = String::from("\n──── #841 coreml-regression diagnostics ────\n");
        let _ = writeln!(out, "bundle dir : {}", loc.dir.display());
        let _ = writeln!(
            out,
            "bundle root: {}",
            loc.root.as_deref().map_or_else(
                || "<FluidAudio default>".into(),
                |r| r.display().to_string()
            )
        );
        let _ = writeln!(
            out,
            "first call : {}",
            match first_call {
                Some(text) => format!("ok, {} chars {text:?}", text.chars().count()),
                None => "never completed".into(),
            }
        );
        let _ = writeln!(out, "host       : {}", probe("sysctl", &["-n", "hw.model"]));
        let _ = writeln!(
            out,
            "virtualized: kern.hv_vmm_present={}",
            probe("sysctl", &["-n", "kern.hv_vmm_present"])
        );
        let _ = writeln!(out, "os         : {}", one_line(&probe("sw_vers", &[])));
        // Hosted macOS runners are `Apple M1 (Virtual)` VMs with no Neural
        // Engine, so this reads 0 there and CoreML falls back to BNNS on the
        // CPU (#742 measured it against 32 on a real M2).
        let _ = writeln!(
            out,
            "ane        : AppleARMIODevice /ane/i lines = {}",
            ane_lines()
        );
        let _ = writeln!(
            out,
            "thermal    : {}",
            one_line(&probe("pmset", &["-g", "therm"]))
        );
        let _ = writeln!(out, "memory     : {}", one_line(&probe("vm_stat", &[])));
        out.push_str(&fingerprint(&loc.dir));
        out.push_str("──── end #841 diagnostics ────");
        out
    }

    /// Whether a failed `transcribe_samples` earns one more attempt. Matched on
    /// `E5RT` plus the timeout wording rather than on the op name all five #841
    /// dumps carry (`Encoder_main__Op3_Cast`): op names are regenerated when the
    /// model is, while an Espresso async task timing out is the class the
    /// evidence names, and no other CoreML failure here carries one — the
    /// diarization teardown print is `E5RT encountered an STL exception`.
    fn is_transient_e5rt_timeout(bridge_output: &str) -> bool {
        bridge_output.contains("E5RT") && bridge_output.contains("has timed out")
    }

    /// The Swift bridge collapses every `transcribeSamples` throw to a bare
    /// "Transcription failed" and prints CoreML's real error with `print`, so the
    /// only place a failure names its own cause is the stdout `transcribe_samples`
    /// silences. Swapping the backend's sink for a temp file is what puts that
    /// text within reach of the retry gate; it is echoed to stderr either way, so
    /// the log still gets what `KESHA_DEBUG` used to route there.
    fn transcribe_capturing_bridge_output(
        be: &mut FluidAudioBackend,
        samples: &[f32],
    ) -> (Result<TranscriptionChunk>, String) {
        use std::io::{Read as _, Seek as _};

        let mut capture = tempfile::tempfile().expect("capture tempfile");
        let sink = capture.try_clone().ok().map(OwnedFd::from);
        let restore = std::mem::replace(&mut be.sink, sink);
        let result = be.transcribe_samples(samples);
        be.sink = restore;

        let mut bridge_output = String::new();
        let _ = capture.rewind();
        let _ = capture.read_to_string(&mut bridge_output);
        if !bridge_output.is_empty() {
            eprint!("{bridge_output}");
        }
        (result, bridge_output)
    }

    /// Hashing all 446 MB every run is too dear; the manifests, vocab and
    /// `coremldata.bin` blobs are where a poisoned restore would show, and for
    /// the weights the size alone separates a truncated restore from a whole one.
    const HASH_MAX_BYTES: u64 = 1 << 20;

    fn fingerprint(dir: &Path) -> String {
        let mut rels = Vec::new();
        collect_files(dir, dir, &mut rels);
        rels.sort();

        let mut out = format!("bundle contents ({} files):\n", rels.len());
        let mut total = 0_u64;
        for rel in &rels {
            let path = dir.join(rel);
            let Ok(meta) = std::fs::metadata(&path) else {
                let _ = writeln!(out, "  {rel}  <stat failed>");
                continue;
            };
            total += meta.len();
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            let digest = if meta.len() <= HASH_MAX_BYTES {
                sha256_prefix(&path)
            } else {
                "-".into()
            };
            let _ = writeln!(out, "  {rel}  {}  mtime={mtime}  {digest}", meta.len());
        }
        let _ = writeln!(out, "  total: {total} bytes");
        out
    }

    fn collect_files(root: &Path, dir: &Path, out: &mut Vec<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect_files(root, &path, out);
            } else if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.display().to_string());
            }
        }
    }

    fn sha256_prefix(path: &Path) -> String {
        use sha2::{Digest, Sha256};
        match std::fs::read(path) {
            Ok(bytes) => {
                let mut hex = format!("{:x}", Sha256::digest(&bytes));
                hex.truncate(16);
                hex
            }
            Err(err) => format!("<read failed: {err}>"),
        }
    }

    fn probe(cmd: &str, args: &[&str]) -> String {
        match std::process::Command::new(cmd).args(args).output() {
            Ok(out) => {
                let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if stdout.is_empty() {
                    String::from_utf8_lossy(&out.stderr).trim().to_string()
                } else {
                    stdout
                }
            }
            Err(err) => format!("<{cmd} unavailable: {err}>"),
        }
    }

    /// Mirrors #742's `ioreg -c AppleARMIODevice | grep -ci ane` so the numbers
    /// in that thread and this dump are comparable.
    fn ane_lines() -> usize {
        probe("ioreg", &["-c", "AppleARMIODevice"])
            .lines()
            .filter(|line| line.to_ascii_lowercase().contains("ane"))
            .count()
    }

    fn one_line(text: &str) -> String {
        text.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .collect::<Vec<_>>()
            .join(" | ")
    }

    fn timing(word: &str, start: f32, end: f32) -> AsrWordTiming {
        AsrWordTiming {
            word: word.to_string(),
            start,
            end,
        }
    }

    #[test]
    fn words_reach_the_chunk_on_the_slice_clock() {
        let chunk = chunk_from(
            "Hello world.".into(),
            vec![timing("Hello", 0.0, 0.4), timing("world.", 0.4, 0.88)],
        );
        assert_eq!(
            chunk.words.expect("words survive"),
            vec![
                WordTiming {
                    word: "Hello".into(),
                    start: 0.0,
                    end: 0.4
                },
                WordTiming {
                    word: "world.".into(),
                    start: 0.4,
                    end: 0.88
                },
            ]
        );
    }

    /// The segmenting paths trust word *n* to be text word *n* — the fixed-window
    /// seam drops timings by count, and nothing downstream re-checks. So a
    /// grouping that disagrees with the transcript has to lose its words here
    /// rather than ship spans naming words the text doesn't have (#720).
    #[test]
    fn words_that_disagree_with_the_transcript_are_dropped() {
        let chunk = chunk_from(
            "Hello there world.".into(),
            vec![timing("Hello", 0.0, 0.4), timing("world.", 0.4, 0.88)],
        );
        assert!(chunk.words.is_none(), "{chunk:?}");
    }

    /// A model that returned no timings at all must read as "none", not as an
    /// empty list — the `transcribe.words` capability is what says whether the
    /// build can produce them, and `Some(vec![])` would muddy that.
    #[test]
    fn no_timings_at_all_is_absent_rather_than_empty() {
        let chunk = chunk_from("Hello world.".into(), vec![]);
        assert!(chunk.words.is_none(), "{chunk:?}");
    }

    /// Silence transcribes to an empty string with no timings; that pairing is
    /// consistent, but there is no segment to hang words on either way.
    #[test]
    fn empty_transcript_carries_no_words() {
        let chunk = chunk_from(String::new(), vec![]);
        assert!(chunk.words.is_none(), "{chunk:?}");
    }

    #[test]
    fn pad_to_min_borrows_when_already_long_enough() {
        let s = vec![0.5_f32; MIN_SAMPLES];
        let out = pad_to_min(&s, MIN_SAMPLES);
        assert!(matches!(out, std::borrow::Cow::Borrowed(_)));
        assert_eq!(out.len(), MIN_SAMPLES);
    }

    #[test]
    fn pad_to_min_pads_short_clip_with_trailing_silence() {
        let original = vec![0.5_f32; 6_400]; // 0.4 s @ 16 kHz — the failing case from #259
        let out = pad_to_min(&original, MIN_SAMPLES);
        assert_eq!(out.len(), MIN_SAMPLES);
        assert_eq!(&out[..6_400], original.as_slice());
        assert!(out[6_400..].iter().all(|&v| v == 0.0));
    }

    #[test]
    fn pad_to_min_handles_empty_input() {
        let out = pad_to_min(&[], MIN_SAMPLES);
        assert_eq!(out.len(), MIN_SAMPLES);
        assert!(out.iter().all(|&v| v == 0.0));
    }

    /// #841's retry gate: only CoreML's async-task timeout earns a second
    /// attempt. Every other bridge failure — including the other `E5RT` class
    /// this codebase already documents — must still fail on the first one.
    #[test]
    fn only_the_coreml_async_timeout_reads_as_transient() {
        assert!(is_transient_e5rt_timeout(
            r#"Transcribe samples with words error: Error Domain=com.apple.CoreML Code=0 "Unable to compute the asynchronous prediction using ML Program. It can be an invalid input data or broken/unsupported model." UserInfo={NSUnderlyingError=0x600000ee0e70 {Error Domain=com.apple.CoreML Code=0 "E5RT: Submit Async failed for [2:1]: Async task: Encoder_main__Op3_Cast has timed out. @ CancelTimedOutAsyncTask_block_invoke (10)"}}"#
        ));

        for other in [
            "",
            "Swift bridge error: Transcription failed",
            "E5RT encountered an STL exception. msg = unordered_map::at: key not found.",
            "Transcribe error: invalidAudioData",
            r#"Error Domain=com.apple.CoreML Code=0 "Unable to compute the asynchronous prediction using ML Program. It can be an invalid input data or broken/unsupported model.""#,
        ] {
            assert!(
                !is_transient_e5rt_timeout(other),
                "{other:?} must fail the test outright, not be retried"
            );
        }
    }

    // Regression: the VAD/chunked paths call `transcribe_samples` once per
    // segment on a single backend instance. Before fluidaudio-rs carried the
    // upstream TDT stateless-reset fix (FluidInference/fluidaudio-rs#15), the
    // shared TdtDecoderState leaked the previous utterance's terminal token, so
    // the 2nd+ one-shot call collapsed to a degenerate prefix (usually "."). A
    // one-shot call must be independent of prior calls.
    #[test]
    #[ignore = "needs cached CoreML Parakeet models + Apple Neural Engine; run with --run-ignored on macOS arm64"]
    fn transcribe_samples_is_stateless_across_calls() {
        let wav = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/fixtures/benchmark-en/03-review-pull-request.ogg"
        );
        // The fixture is a Git LFS asset; on a checkout without LFS materialized
        // the path is a ~130-byte pointer, not audio. Fail with an actionable
        // message instead of a cryptic decode panic.
        let bytes = std::fs::read(wav).expect("read sentence fixture");
        assert!(
            !bytes.starts_with(b"version https://git-lfs"),
            "fixture is an unmaterialized Git LFS pointer — run `git lfs pull` before this test"
        );
        let samples = crate::audio::load_audio(wav).expect("decode sentence fixture");

        // Declared first so it drops last — after the backend's CoreML teardown.
        let mut dump = FailureDump { first_call: None };
        let mut be = FluidAudioBackend::new().expect("init FluidAudio CoreML backend");

        // #841: five instrumented dumps, one shape — the *first* call times out
        // inside CoreML ~20 s in on a virtualized runner with no ANE, and the
        // same SHA goes green on rerun. Since this job is the #592 pin-bump
        // guard, every occurrence spent a human on that rerun. One retry, scoped
        // to that signature: a real regression is deterministic and fails both
        // attempts, and the diagnostics still print per attempt, so the issue
        // keeps collecting evidence from a run that no longer goes red.
        let (mut outcome, bridge_output) = transcribe_capturing_bridge_output(&mut be, &samples);
        if outcome.is_err() && is_transient_e5rt_timeout(&bridge_output) {
            eprintln!("{}", render_diagnostics(None));
            eprintln!("#841: first transcribe_samples hit CoreML's async timeout — retrying once");
            outcome = transcribe_capturing_bridge_output(&mut be, &samples).0;
        }
        let first = outcome.expect("first transcribe_samples").text;
        dump.first_call = Some(first.clone());
        let second = be
            .transcribe_samples(&samples)
            .expect("second transcribe_samples")
            .text;

        assert!(
            !first.trim().is_empty(),
            "sanity: first call should transcribe speech, got {first:?}"
        );
        assert_eq!(
            first, second,
            "second one-shot call diverged — decoder state leaked across calls (got {second:?})"
        );
        assert!(
            !second.trim().trim_matches('.').trim().is_empty(),
            "second call collapsed to a degenerate prefix: {second:?}"
        );
    }

    /// `chunk_from`'s alignment gate is exercised above against hand-built
    /// timings; this is the half no unit test can reach — that FluidAudio's own
    /// grouping actually satisfies it on real speech, so the gate passes words
    /// through rather than silently dropping every one of them (#720).
    ///
    /// Deliberately outside `coreml-regression`'s two-test allowlist in
    /// `rust-test.yml`: that job runs on a virtualized runner with no Neural
    /// Engine, and this needs a real one.
    #[test]
    #[ignore = "needs cached CoreML Parakeet models + Apple Neural Engine; run with --run-ignored on macOS arm64"]
    fn real_speech_yields_words_the_segmenting_paths_will_accept() {
        let wav = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../tests/fixtures/benchmark-en/01-check-email.ogg"
        );
        let bytes = std::fs::read(wav).expect("read sentence fixture");
        assert!(
            !bytes.starts_with(b"version https://git-lfs"),
            "fixture is an unmaterialized Git LFS pointer — run `git lfs pull` before this test"
        );
        let samples = crate::audio::load_audio(wav).expect("decode sentence fixture");

        let mut be = FluidAudioBackend::new().expect("init FluidAudio CoreML backend");
        let chunk = be
            .transcribe_samples(&samples)
            .expect("transcribe_samples with words");
        let words = chunk
            .words
            .as_ref()
            .unwrap_or_else(|| panic!("words dropped for real speech: {chunk:?}"));

        assert_eq!(
            words.iter().map(|w| w.word.as_str()).collect::<Vec<_>>(),
            chunk.text.split_whitespace().collect::<Vec<_>>()
        );

        // Slice-local and in order: `words_onto_segment` owns the file offset, so
        // a backend that pre-offset them would break every segmenting path.
        let mut previous = f32::NEG_INFINITY;
        for w in words {
            assert!(w.start >= previous, "starts went backwards at {w:?}");
            assert!(w.end >= w.start, "{w:?} ends before it starts");
            previous = w.start;
        }
        assert!(
            words[0].start < 1.0,
            "first word starts at {:.2}s — times look file-relative, not slice-local",
            words[0].start
        );
    }
}
