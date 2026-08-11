use std::os::fd::OwnedFd;

use anyhow::{Context, Result};
use fluidaudio_rs::FluidAudio;

use crate::fluid_stdout::with_silenced_stdout;

use super::TranscribeBackend;

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
    fn transcribe(&mut self, audio_path: &str) -> Result<String> {
        let result = self
            .audio
            .transcribe_file(audio_path)
            .context("FluidAudio transcription failed")?;
        Ok(result.text)
    }

    /// stdout is silenced for the call: even with padding, upstream prints
    /// would corrupt `--json` output (#259).
    fn transcribe_samples(&mut self, samples: &[f32]) -> Result<String> {
        let padded = pad_to_min(samples, MIN_SAMPLES);
        let result = with_silenced_stdout(self.sink.as_ref(), || {
            self.audio.transcribe_samples(&padded)
        })
        .context("FluidAudio sample transcription failed")?;
        Ok(result.text)
    }
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
    /// so the failing run is the only place the evidence will ever exist.
    /// Renders on panic, silent on a passing run.
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
        let first = be
            .transcribe_samples(&samples)
            .expect("first transcribe_samples");
        dump.first_call = Some(first.clone());
        let second = be
            .transcribe_samples(&samples)
            .expect("second transcribe_samples");

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
}
