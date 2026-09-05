use anyhow::{Context, Result};
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::manifest::*;
use super::paths::*;
use super::progress::{with_stderr, InFlight, ProgressReader, PROGRESS_MIN_BYTES};
#[cfg(all(
    feature = "system_kokoro",
    target_os = "macos",
    target_arch = "aarch64"
))]
use super::staging::{stage_ane_kokoro_voices, stage_fluidaudio_kokoro_assets};
use crate::coded_bail;
use crate::errors::{code_of, CodedContext, CodedError, ErrorCode};
use crate::protocol::events;

/// Optional HuggingFace mirror base URL. Respects `KESHA_MODEL_MIRROR` (#121).
///
/// Empty string and unset both fall through to the default upstream. Trailing
/// slashes are stripped so callers can safely concat with URL paths.
pub fn model_mirror() -> Option<String> {
    match std::env::var("KESHA_MODEL_MIRROR") {
        Ok(s) => {
            let trimmed = s.trim().trim_end_matches('/');
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        Err(_) => None,
    }
}

/// Rewrite a `huggingface.co` URL onto `KESHA_MODEL_MIRROR` if set. The HF
/// path hierarchy (`/<owner>/<repo>/resolve/<ref>/<file>`) is preserved
/// verbatim after the mirror base so operators can clone with `wget --mirror`
/// or plain `rsync`. URLs on other hosts (e.g. github.com release assets)
/// pass through unchanged — this env var only redirects model fetches.
pub fn apply_mirror(url: &str) -> String {
    if let Some(base) = model_mirror() {
        if let Some(path) = url.strip_prefix("https://huggingface.co") {
            return format!("{base}{path}");
        }
    }
    url.to_string()
}

/// Emit the "Model mirror active: <url>" banner so any user staring at a
/// fresh `kesha install` notices that downloads are flowing through
/// `KESHA_MODEL_MIRROR`. **Side effect**: writes a single line to stderr
/// on the first call per process, no-op thereafter. Idempotent via
/// `OnceLock` — repeated calls (test reruns inside one process) are safe.
///
/// Call this once at the start of the install handler in `main.rs` rather
/// than from each `download_*` function. Concentrating the side effect at
/// one boundary keeps `download_tts`, `download_vad`, and `download_diarize`
/// behaviourally pure-from-the-caller — they return `Result<()>` and don't
/// hide a surprise stderr write behind it.
pub fn init_mirror_logging() {
    use std::sync::OnceLock;
    static LOGGED: OnceLock<()> = OnceLock::new();
    LOGGED.get_or_init(|| {
        if let Some(base) = model_mirror() {
            events::progress(None, format!("Model mirror active: {base}"));
        }
    });
}

/// Static singleton avoids repeated `pthread_create`/teardown per install call.
fn download_pool() -> &'static rayon::ThreadPool {
    use std::sync::OnceLock;
    static POOL: OnceLock<rayon::ThreadPool> = OnceLock::new();
    POOL.get_or_init(|| {
        rayon::ThreadPoolBuilder::new()
            .num_threads(4)
            .thread_name(|i| format!("kesha-dl-{i}"))
            .build()
            .expect("download thread pool build failed")
    })
}

/// 4 concurrent downloads. Each file runs its own retry budget to completion, so
/// one file's transient 429 no longer cancels the three siblings mid-flight
/// (#724); the install then fails naming every file that exhausted its retries.
pub(super) fn parallel_download(
    cache: &Path,
    manifest: &[&ModelFile],
    no_cache: bool,
) -> Result<()> {
    use rayon::prelude::*;
    let mut failures: Vec<(&'static str, anyhow::Error)> = download_pool().install(|| {
        manifest
            .par_iter()
            .filter_map(|f| {
                download_verified(cache, f, no_cache)
                    .err()
                    .map(|e| (f.rel_path, e))
            })
            .collect()
    });
    if failures.is_empty() {
        return Ok(());
    }
    if failures.len() == 1 {
        return Err(failures.remove(0).1);
    }
    let summary = format!(
        "{} of {} model downloads failed: {}",
        failures.len(),
        manifest.len(),
        failures
            .iter()
            .map(|(path, _)| *path)
            .collect::<Vec<_>>()
            .join(", ")
    );
    // The returned chain can only carry one root cause, so the others are
    // reported here rather than dropped.
    for (path, err) in failures.iter().skip(1) {
        with_stderr(|| events::progress(None, format!("FAIL {path}: {err:#}")));
    }
    Err(failures.remove(0).1.context(summary))
}

/// Download the Sortformer `.mlpackage`. Opt-in via `kesha install --diarize`
/// (#199) — feature-gated to `system_diarize`, which build-engine.yml only
/// turns on for darwin-arm64. Non-darwin builds neither expose the flag nor
/// reach this function. 4-file manifest, ~245 MB total; goes through the
/// same hash-verify + retry path as the rest.
#[cfg(feature = "system_diarize")]
pub fn download_diarize(no_cache: bool) -> Result<()> {
    download_manifest(DIARIZE_FILES, no_cache)
}

/// Hash-verified parallel download of a static manifest into the cache dir.
fn download_manifest(files: &[ModelFile], no_cache: bool) -> Result<()> {
    let cache = cache_dir()?;
    let refs: Vec<&ModelFile> = files.iter().collect();
    parallel_download(&cache, &refs, no_cache)
}

/// Remove stale CoreML-compiled diarization sidecars after the current model
/// was successfully warmed. Only deletes Kesha-owned siblings next to the
/// active `.mlpackage`; never touches the source `.mlpackage` or Apple's e5rt
/// cache.
///
/// Keeping the active sidecar is load-bearing, not just tidiness: e5rt is keyed
/// by the compiled bundle's identity, not its path, so a recompiled `.mlmodelc`
/// at the same path is a cache MISS that re-pays the ~98 s cold ANE compile
/// (#444). Deleting only stale siblings preserves the warmed sidecar's cache hit.
#[cfg(feature = "system_diarize")]
pub fn cleanup_diarize_compiled_sidecars(keep_model_package: &Path) -> Result<usize> {
    let Some(parent) = keep_model_package.parent() else {
        return Ok(0);
    };
    if !parent.exists() {
        return Ok(0);
    }

    let keep_sidecar = compiled_model_sidecar(keep_model_package);
    let mut removed = 0;
    for entry in
        fs::read_dir(parent).with_context(|| format!("read diarize cache {}", parent.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        if path == keep_sidecar || !is_compiled_mlpackage_sidecar(&path) {
            continue;
        }
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(&path)
                .with_context(|| format!("remove stale diarize sidecar {}", path.display()))?;
        } else {
            fs::remove_file(&path)
                .with_context(|| format!("remove stale diarize sidecar {}", path.display()))?;
        }
        removed += 1;
    }
    Ok(removed)
}

#[cfg(feature = "system_diarize")]
fn compiled_model_sidecar(model_package: &Path) -> PathBuf {
    let mut sidecar = model_package.as_os_str().to_os_string();
    sidecar.push(".mlmodelc");
    PathBuf::from(sidecar)
}

#[cfg(feature = "system_diarize")]
fn is_compiled_mlpackage_sidecar(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with(".mlpackage.mlmodelc"))
}

/// Download the Silero VAD ONNX. Opt-in via `kesha install --vad` (#128).
pub fn download_vad(no_cache: bool) -> Result<()> {
    download_manifest(VAD_FILES, no_cache)
}

/// Download the TTS model files needed for `langs` only. Each file is streamed
/// to disk, then SHA256-verified, 4 concurrent (#178). An English-only install
/// skips the CharsiuG2P pack; a Russian-only install skips Kokoro entirely.
/// Empty `langs` is a no-op so the install handler can short-circuit a bare run.
#[cfg(feature = "tts")]
pub fn download_tts(langs: &[&str], no_cache: bool) -> Result<()> {
    if langs.is_empty() {
        return Ok(());
    }

    #[cfg(not(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    )))]
    {
        let cache = cache_dir()?;
        let mut manifest = kokoro_manifest_for(langs);
        if langs.contains(&"ru") {
            manifest.extend_from_slice(VOSK_RU_FILES);
        }
        let refs: Vec<&ModelFile> = manifest.iter().collect();
        parallel_download(&cache, &refs, no_cache)?;
    }

    // On the FluidAudio ANE Kokoro path everything lands in FluidAudio's own
    // caches: the model chain and its G2P assets so nothing downloads at first
    // synth (#823), plus the requested en/es/it/… voice catalog — including the
    // male `am_michael` default — so those resolve local-first instead of
    // 404ing against the ANE bundle (#475). Vosk-RU still lands under
    // KESHA_CACHE_DIR.
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    {
        if langs.contains(&"ru") {
            download_manifest(VOSK_RU_FILES, no_cache)?;
        }
        stage_fluidaudio_kokoro_assets(langs, no_cache)?;
        stage_ane_kokoro_voices(langs, no_cache)?;
    }

    Ok(())
}

/// Hash-verify on every path — cached hits short-circuit network; mismatch bails before
/// the bad file can reach inference (#174).
fn download_verified(cache: &Path, f: &ModelFile, no_cache: bool) -> Result<()> {
    let target = cache.join(f.rel_path);
    if target.exists() {
        if verify_sha256(&target, f.sha256)? {
            if !no_cache {
                with_stderr(|| events::progress(None, format!("OK  {} (cached)", f.rel_path)));
                return Ok(());
            }
            // no_cache over a valid file: keep it in place until a verified
            // replacement lands, so a failed refresh can't lose a working
            // install (Greptile P1 on #619).
        } else {
            // Corrupt/stale bytes: clear now so the existence-only cache
            // probes can't resurrect them even if this download fails (#174).
            let _ = fs::remove_file(&target);
        }
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    download_with_retries(&apply_mirror(f.url), f, &target)?;
    with_stderr(|| events::progress(None, format!("OK  {}", f.rel_path)));
    Ok(())
}

/// Re-issues the request while the failure looks like it might clear, backing
/// off between attempts. The verified write inside each attempt is unchanged:
/// retry covers the request, never the hash check (#174).
fn download_with_retries(url: &str, f: &ModelFile, target: &Path) -> Result<()> {
    let mut attempt: u32 = 1;
    loop {
        match download_attempt(url, f, target) {
            Ok(()) => return Ok(()),
            Err(fail) if attempt < fail.max_attempts => {
                let delay = backoff_delay(attempt, fail.retry_after, jitter_fraction());
                with_stderr(|| {
                    events::progress(
                        None,
                        format!(
                            "retrying {} in {:.1}s (attempt {}/{}, {})",
                            f.rel_path,
                            delay.as_secs_f64(),
                            attempt + 1,
                            fail.max_attempts,
                            fail.reason
                        ),
                    )
                });
                std::thread::sleep(delay);
                attempt += 1;
            }
            Err(fail) => {
                // The budget is spent, and the pid suffix means no later
                // process could claim this prefix anyway (#889).
                let _ = fs::remove_file(staging_path(target));
                return Err(fail
                    .err
                    .context(format!("{} failed after {attempt} attempt(s)", f.rel_path)));
            }
        }
    }
}

/// Attempts per file before the install gives up. Five spend roughly 15 s of
/// backoff on the default schedule — enough to ride out HuggingFace's anonymous
/// per-IP 429 window without leaving a dead download hanging for minutes (#724).
const MAX_DOWNLOAD_ATTEMPTS: u32 = 5;
const DNS_MAX_ATTEMPTS: u32 = 3;
const RETRY_BASE_DELAY: Duration = Duration::from_secs(1);
const RETRY_MAX_DELAY: Duration = Duration::from_secs(30);
/// A server asking for more than this is asking for longer than a user will
/// wait at an install prompt; clamp rather than honour it literally.
const RETRY_AFTER_MAX: Duration = Duration::from_secs(60);

/// One request+stream attempt that failed. `max_attempts` is the total the
/// retry loop may spend on this kind of failure; 1 means fatal, which is what a
/// sha256 mismatch always is (#174).
struct AttemptFailure {
    err: anyhow::Error,
    reason: String,
    retry_after: Option<Duration>,
    max_attempts: u32,
}

fn model_download_error(message: String) -> anyhow::Error {
    anyhow::Error::new(CodedError {
        code: ErrorCode::ModelDownload,
        message,
    })
}

const HEADER_BUDGET: Duration = Duration::from_secs(10);
const BODY_STALL_BUDGET: Duration = Duration::from_secs(30);

/// The request policy every download attempt runs under. ureq ships no timeouts
/// at all, so without these a host that accepts the connection and then goes
/// quiet hangs the install forever.
///
/// `header_budget` is what bounds the wait for response headers, and it rides on
/// `timeout_send_request`: `RecvResponse` inherits `SendRequest`'s absolute
/// deadline and nothing else bounds it, so deleting that line would silently
/// unbound the header wait (#893).
///
/// `stall_budget` is a *rolling* window: `RecvBody` inherits only
/// `RecvResponse`, so leaving the latter unset re-arms the deadline on every
/// read and the body aborts on silence rather than on elapsed time. Setting
/// `timeout_recv_response` again would cap the whole body instead — ureq takes
/// the minimum — which is what put a 654MB artifact out of reach on a slow link
/// (#776, #893).
///
/// Status is inspected by the caller rather than raised by ureq so a 429's
/// `Retry-After` header survives into the backoff decision (#724). `identity`
/// because a `Range` addresses the encoded representation: mixing a decompressed
/// prefix with an encoded remainder would corrupt the assembly, and ureq strips
/// `content-encoding` after decoding so the response cannot be inspected for it
/// afterwards.
///
/// Both budgets are parameters so tests can drive the real policy at a scaled
/// deadline instead of waiting out the production one.
fn download_request(
    url: &str,
    header_budget: Duration,
    stall_budget: Duration,
) -> ureq::RequestBuilder<ureq::typestate::WithoutBody> {
    ureq::get(url)
        .config()
        .http_status_as_error(false)
        .accept_encoding("identity")
        .timeout_resolve(Some(header_budget))
        .timeout_connect(Some(header_budget))
        .timeout_send_request(Some(header_budget))
        .timeout_recv_body(Some(stall_budget))
        .build()
}

/// One GET plus its verified stream to disk. Every failure path reports whether
/// it is worth retrying; the caller owns the backoff.
///
/// The resolved URL rides in the error message (#275 D11): under
/// `KESHA_MODEL_MIRROR` the user otherwise cannot tell which host was contacted.
fn download_attempt(
    url: &str,
    f: &ModelFile,
    target: &Path,
) -> std::result::Result<(), AttemptFailure> {
    // Claim in-flight before announcing: the request below blocks on headers, and a
    // sibling's bar must stop repainting over this row first (Greptile P1 on #681).
    let _in_flight = InFlight::new();
    with_stderr(|| events::progress(None, format!("GET {}", f.rel_path)));

    // Whatever an earlier attempt managed to stage is the prefix this one
    // resumes from (#889).
    let part = staging_path(target);
    let staged = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);

    let mut request = download_request(url, HEADER_BUDGET, BODY_STALL_BUDGET);
    if staged > 0 {
        request = request.header("range", format!("bytes={staged}-"));
    }
    let response = match request.call() {
        Ok(response) => response,
        Err(e) => {
            return Err(AttemptFailure {
                err: model_download_error(format!("GET {url} ({}): {e}", f.rel_path)),
                reason: e.to_string(),
                retry_after: None,
                max_attempts: ureq_error_attempts(&e),
            });
        }
    };

    let status = response.status().as_u16();
    // The partial outgrew the artifact — an upstream rehost, or a download that
    // finished but never got renamed. Neither is a resume point.
    if staged > 0 && status == 416 {
        let _ = fs::remove_file(&part);
        return Err(AttemptFailure {
            err: model_download_error(format!("GET {url} ({}): HTTP {status}", f.rel_path)),
            reason: "stale partial discarded".to_string(),
            retry_after: None,
            max_attempts: MAX_DOWNLOAD_ATTEMPTS,
        });
    }
    if !response.status().is_success() {
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|v| v.to_str().ok())
            .and_then(parse_retry_after);
        return Err(AttemptFailure {
            err: model_download_error(format!("GET {url} ({}): HTTP {status}", f.rel_path)),
            reason: format!("HTTP {status}"),
            retry_after,
            max_attempts: if status_is_transient(status) {
                MAX_DOWNLOAD_ATTEMPTS
            } else {
                1
            },
        });
    }

    // A server is free to ignore `Range` and answer 200 with the whole body;
    // appending that onto a partial would corrupt the assembly.
    let resume = if status == 206 { staged } else { 0 };

    // Not the raw header — that one reports the compressed size when decompression is active.
    let total = response.body().content_length().unwrap_or(0);
    let mut reader = TrackedStream {
        inner: response.into_body().into_reader(),
        read_failed: false,
    };
    let streamed = if total >= PROGRESS_MIN_BYTES && io::IsTerminal::is_terminal(&io::stderr()) {
        let mut reader = ProgressReader::new(&mut reader, total);
        write_verified(&mut reader, target, f.rel_path, f.sha256, Some(resume))
    } else {
        write_verified(&mut reader, target, f.rel_path, f.sha256, Some(resume))
    };
    streamed.map_err(|err| {
        // Only a stalled body leaves a prefix the next attempt can resume from;
        // a hash mismatch above all must not survive to be appended to (#174).
        if !reader.read_failed {
            let _ = fs::remove_file(&part);
        }
        stream_failure(err, reader.read_failed)
    })
}

/// Classifies a failed `write_verified`. A truncated stream deserves another go;
/// a sha mismatch means the host is not serving the pinned bytes and no amount
/// of retrying heals that (#174); a local write failure — full disk, read-only
/// cache — would only re-GET multiple GB to fail the same way (grok P2 on #761).
fn stream_failure(err: anyhow::Error, read_failed: bool) -> AttemptFailure {
    let (reason, max_attempts) = match code_of(&err) {
        ErrorCode::CacheCorrupt => ("hash mismatch", 1),
        _ if read_failed => ("download interrupted", MAX_DOWNLOAD_ATTEMPTS),
        _ => ("cache write failed", 1),
    };
    AttemptFailure {
        err,
        reason: reason.to_string(),
        retry_after: None,
        max_attempts,
    }
}

/// `io::copy` reports a stalled stream and a failing disk identically, so the
/// reader records whose error it was.
struct TrackedStream<R> {
    inner: R,
    read_failed: bool,
}

impl<R: io::Read> io::Read for TrackedStream<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.inner.read(buf);
        self.read_failed |= read.is_err();
        read
    }
}

/// Statuses that a later attempt can plausibly resolve. Everything else — 403
/// from a private repo, 404 from a moved artifact — is fatal on the first try.
fn status_is_transient(status: u16) -> bool {
    status == 408 || status == 429 || (500..600).contains(&status)
}

/// A resolver blip should not kill an install, but a genuinely wrong host would
/// burn the whole schedule proving it, so DNS gets a shorter budget.
fn ureq_error_attempts(err: &ureq::Error) -> u32 {
    match err {
        ureq::Error::Timeout(_) | ureq::Error::Io(_) | ureq::Error::ConnectionFailed => {
            MAX_DOWNLOAD_ATTEMPTS
        }
        ureq::Error::HostNotFound => DNS_MAX_ATTEMPTS,
        _ => 1,
    }
}

/// `Retry-After` per RFC 9110, delay-seconds only. HuggingFace's 429s send that
/// form; an HTTP-date falls through to the backoff schedule rather than pull a
/// calendar into the download path.
fn parse_retry_after(raw: &str) -> Option<Duration> {
    raw.trim().parse::<u64>().ok().map(Duration::from_secs)
}

/// Exponential backoff with ±25% jitter, or the server's own `Retry-After`
/// where it gave one. Four rayon workers hit the same host together, so `jitter`
/// must be drawn independently per call — anything they can all read at the same
/// instant, a clock included, retries them in lockstep and re-triggers the rate
/// limit that caused the backoff (#724).
fn backoff_delay(attempt: u32, retry_after: Option<Duration>, jitter: f64) -> Duration {
    if let Some(after) = retry_after {
        return after.clamp(RETRY_BASE_DELAY, RETRY_AFTER_MAX);
    }
    let exponential = RETRY_BASE_DELAY.saturating_mul(1u32 << attempt.saturating_sub(1).min(10));
    exponential
        .min(RETRY_MAX_DELAY)
        .mul_f64(0.75 + 0.5 * jitter.clamp(0.0, 1.0))
}

/// A fresh fraction in `[0, 1)` per call, independent across calls and threads.
/// `RandomState` re-keys on every construction, so workers that back off within
/// the same microsecond still spread; a clock read cannot promise that (#724).
fn jitter_fraction() -> f64 {
    use std::hash::{BuildHasher, Hasher};
    let bits = std::collections::hash_map::RandomState::new()
        .build_hasher()
        .finish();
    (bits >> 11) as f64 / (1u64 << 53) as f64
}

/// Stream `reader` into `target` atomically: bytes land in a per-process
/// `.part.<pid>` sibling, the hash is checked over that whole assembled file,
/// and only a verified file is renamed into place. An interrupted or corrupt
/// download therefore never leaves bytes at `target` for the existence-only
/// cache probes to resurrect later (#174), and a failure never disturbs an
/// existing `target` (a concurrent installer's verified rename, or the
/// pre-refresh copy under `--no-cache`). The pid suffix keeps two concurrent
/// installers off each other's staging file; whichever verified rename lands
/// last wins.
///
/// `resume` says who owns the staging file on failure: `Some(n)` appends after
/// `n` bytes already staged (`Some(0)` truncates) and leaves whatever landed
/// for the caller to resume from with `Range`; `None` writes fresh and clears
/// the staging file itself (#889).
pub(super) fn write_verified<R: io::Read>(
    reader: &mut R,
    target: &Path,
    rel_path: &str,
    expected_sha: &str,
    resume: Option<u64>,
) -> Result<()> {
    let part = staging_path(target);

    let result = (|| -> Result<()> {
        let mut out = match resume {
            Some(n) if n > 0 => fs::OpenOptions::new()
                .append(true)
                .open(&part)
                .with_context(|| format!("append {}", part.display()))?,
            _ => fs::File::create(&part).with_context(|| format!("create {}", part.display()))?,
        };
        io::copy(reader, &mut out)
            .with_context(|| format!("download {rel_path}"))
            .coded(ErrorCode::ModelDownload)?;
        drop(out);
        if !verify_sha256(&part, expected_sha)? {
            // Recompute to embed the actual hash in the bail (#275 D5). One
            // extra hash pass on a freshly-downloaded file is cheap relative
            // to the failure-mode value: the user can now tell stale-mirror
            // vs corrupt-download vs upstream-rehost from one line of stderr.
            let actual = compute_sha256(&part).unwrap_or_else(|_| "<unreadable>".to_string());
            coded_bail!(
                ErrorCode::CacheCorrupt,
                "sha256 mismatch for {}: expected {} got {}",
                rel_path,
                expected_sha.get(..12).unwrap_or(expected_sha),
                actual.get(..12).unwrap_or(&actual)
            );
        }
        // `fs::rename` replaces an existing destination on every supported
        // platform (POSIX rename; MoveFileExW + MOVEFILE_REPLACE_EXISTING on
        // Windows), so the pre-refresh copy survives until this single call.
        fs::rename(&part, target).with_context(|| format!("rename {}", target.display()))
    })();

    if result.is_err() && resume.is_none() {
        // Best-effort: drop this process's staging file only — `target` is
        // either absent or a file another writer legitimately owns.
        let _ = fs::remove_file(&part);
    }
    result
}

pub(super) fn staging_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().map(OsString::from).unwrap_or_default();
    name.push(format!(".part.{}", std::process::id()));
    target.with_file_name(name)
}

pub(super) fn verify_sha256(path: &Path, expected: &str) -> Result<bool> {
    Ok(compute_sha256(path)?.eq_ignore_ascii_case(expected))
}

/// SHA-256 of `path`'s contents, lowercase hex (#275 D5).
/// 64 KiB BufReader avoids syscall-bound hashing on large model files.
fn compute_sha256(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let file = fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    let mut reader = std::io::BufReader::with_capacity(65_536, file);
    let mut hasher = Sha256::new();
    io::copy(&mut reader, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

pub(super) fn cleanup_legacy(cache: &Path) {
    let old_onnx = cache.join("v3");
    if old_onnx.exists() {
        events::progress(None, "Cleaning up legacy ONNX models...");
        let _ = fs::remove_dir_all(&old_onnx);
    }
    let old_swift = cache.join("coreml").join("bin").join("parakeet-coreml");
    if old_swift.exists() {
        events::progress(None, "Cleaning up legacy CoreML binary...");
        let _ = fs::remove_file(&old_swift);
    }
    #[cfg(unix)]
    cleanup_orphan_staging(cache);
}

/// Age threshold for orphaned download staging. A SIGKILLed download leaves
/// its `<name>.part.<pid>` behind forever (#619); a live concurrent
/// installer's staging keeps a fresh mtime while `io::copy` streams into it.
/// The 24 h threshold makes a stalled-but-alive download (no bytes for a full
/// day, process still up) practically impossible to misclassify while still
/// clearing true orphans on the next install. Unix-only: Windows
/// keeps last-write time stale while a handle is open and permits unlinking
/// open files, so an in-flight multi-hour download could be swept there.
#[cfg(unix)]
const STALE_STAGING_SECS: u64 = 24 * 60 * 60;

#[cfg(unix)]
fn cleanup_orphan_staging(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            cleanup_orphan_staging(&path);
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.contains(".part.") {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() > STALE_STAGING_SECS);
        if stale {
            events::progress(
                None,
                format!("Cleaning up orphaned download staging: {name}"),
            );
            let _ = fs::remove_file(&path);
        }
    }
}

#[cfg(all(test, feature = "system_diarize"))]
mod diarize_sidecar_tests {
    use super::*;

    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new(name: &str) -> Result<Self> {
            let path = std::env::temp_dir().join(format!(
                "kesha-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_nanos()
            ));
            fs::create_dir_all(&path)?;
            Ok(Self { path })
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn cleanup_diarize_sidecars_keeps_current_and_removes_stale() -> Result<()> {
        let tmp = TempDir::new("diarize-sidecars")?;
        let current = tmp.path.join("SortformerNvidiaLow_v2.mlpackage");
        let current_sidecar = tmp.path.join("SortformerNvidiaLow_v2.mlpackage.mlmodelc");
        let old_sidecar = tmp.path.join("SortformerNvidiaLow_v1.mlpackage.mlmodelc");
        let old_sidecar_file = tmp.path.join("SortformerNvidiaLow_v0.mlpackage.mlmodelc");
        let source_package = tmp.path.join("SortformerNvidiaLow_v1.mlpackage");
        let unrelated = tmp.path.join("README.md");

        fs::create_dir_all(&current)?;
        fs::create_dir_all(&current_sidecar)?;
        fs::create_dir_all(&old_sidecar)?;
        fs::write(&old_sidecar_file, b"compiled")?;
        fs::create_dir_all(&source_package)?;
        fs::write(&unrelated, b"leave me")?;

        let removed = cleanup_diarize_compiled_sidecars(&current)?;

        assert_eq!(removed, 2);
        assert!(current.exists());
        assert!(current_sidecar.exists());
        assert!(source_package.exists());
        assert!(unrelated.exists());
        assert!(!old_sidecar.exists());
        assert!(!old_sidecar_file.exists());
        Ok(())
    }

    #[test]
    fn cleanup_diarize_sidecars_ignores_missing_parent() -> Result<()> {
        let tmp = TempDir::new("diarize-sidecars-missing")?;
        let missing = tmp.path.join("missing/Current.mlpackage");

        assert_eq!(cleanup_diarize_compiled_sidecars(&missing)?, 0);
        Ok(())
    }

    const DIARIZE_RUNTIME_FILES: [&str; 4] = [
        "Manifest.json",
        "Data/com.apple.CoreML/model.mlmodel",
        "Data/com.apple.CoreML/weights/0-weight.bin",
        "Data/com.apple.CoreML/weights/1-weight.bin",
    ];

    fn write_layout(dir: &Path, files: &[&str]) -> Result<()> {
        for rel in files {
            let path = dir.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&path, b"x")?;
        }
        Ok(())
    }

    #[test]
    fn diarize_layout_needs_every_runtime_file() -> Result<()> {
        let tmp = TempDir::new("diarize-layout")?;
        let complete = tmp.path.join("complete.mlpackage");
        write_layout(&complete, &DIARIZE_RUNTIME_FILES)?;
        assert!(has_diarize_layout(&complete), "complete bundle is ready");

        for (i, missing) in DIARIZE_RUNTIME_FILES.iter().enumerate() {
            let partial = tmp.path.join(format!("partial-{i}.mlpackage"));
            let present: Vec<&str> = DIARIZE_RUNTIME_FILES
                .iter()
                .filter(|f| f != &missing)
                .copied()
                .collect();
            write_layout(&partial, &present)?;
            assert!(
                !has_diarize_layout(&partial),
                "{missing} missing must not read as ready"
            );
        }
        Ok(())
    }

    #[test]
    fn only_compiled_sidecars_are_removable() {
        assert!(is_compiled_mlpackage_sidecar(Path::new(
            "/cache/Sortformer.mlpackage.mlmodelc"
        )));
        assert!(!is_compiled_mlpackage_sidecar(Path::new(
            "/cache/Sortformer.mlpackage"
        )));
        assert!(!is_compiled_mlpackage_sidecar(Path::new(
            "/cache/Sortformer.mlmodelc"
        )));
        assert!(!is_compiled_mlpackage_sidecar(Path::new("/")));
    }
}

#[cfg(test)]
mod mirror_tests {
    use super::*;
    use crate::util::test_env::EnvGuard;

    #[test]
    fn unset_env_falls_through_to_upstream() {
        let _lock = crate::util::test_env::lock();

        {
            let _g = EnvGuard::unset(&_lock, "KESHA_MODEL_MIRROR");
            assert_eq!(model_mirror(), None);
            assert_eq!(
                apply_mirror("https://huggingface.co/foo/bar/resolve/main/file.onnx"),
                "https://huggingface.co/foo/bar/resolve/main/file.onnx"
            );
        }
        {
            let _g = EnvGuard::set(&_lock, "KESHA_MODEL_MIRROR", "");
            assert_eq!(model_mirror(), None);
            assert_eq!(
                apply_mirror("https://huggingface.co/foo/bar/resolve/main/file.onnx"),
                "https://huggingface.co/foo/bar/resolve/main/file.onnx"
            );
        }
        {
            let _g = EnvGuard::set(&_lock, "KESHA_MODEL_MIRROR", "   ");
            assert_eq!(model_mirror(), None);
        }
    }

    #[test]
    fn rewrites_hf_url_onto_mirror_base_preserving_path() {
        let _lock = crate::util::test_env::lock();
        let _g = EnvGuard::set(
            &_lock,
            "KESHA_MODEL_MIRROR",
            "https://mirror.example.com/kesha",
        );
        assert_eq!(
            apply_mirror("https://huggingface.co/foo/bar/resolve/main/file.onnx"),
            "https://mirror.example.com/kesha/foo/bar/resolve/main/file.onnx"
        );
    }

    #[test]
    fn strips_trailing_slash_from_mirror_base() {
        let _lock = crate::util::test_env::lock();
        let _g = EnvGuard::set(
            &_lock,
            "KESHA_MODEL_MIRROR",
            "https://mirror.example.com/kesha/",
        );
        assert_eq!(
            apply_mirror("https://huggingface.co/x/y/resolve/main/z.bin"),
            "https://mirror.example.com/kesha/x/y/resolve/main/z.bin"
        );
    }

    #[test]
    fn non_hf_urls_pass_through_unchanged() {
        // github.com release assets (engine binary + avspeech sidecar) must
        // NOT be redirected — KESHA_MODEL_MIRROR only covers model files.
        let _lock = crate::util::test_env::lock();
        let _g = EnvGuard::set(&_lock, "KESHA_MODEL_MIRROR", "https://mirror.example.com");
        let url = "https://github.com/drakulavich/kesha-voice-kit/releases/download/v1.3.0/kesha-engine-darwin-arm64";
        assert_eq!(apply_mirror(url), url);
    }
}

#[cfg(all(test, feature = "tts"))]
mod tts_tests {
    use super::*;

    #[test]
    fn download_tts_empty_langs_is_noop() {
        assert!(download_tts(&[], false).is_ok());
    }
}

#[cfg(test)]
mod characterization_tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[cfg(unix)]
    #[test]
    fn orphan_staging_sweep_removes_only_what_passed_the_24h_threshold() -> Result<()> {
        let dir = std::env::temp_dir().join(format!(
            "kesha-part-gc-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        fs::create_dir_all(dir.join("models"))?;
        let stale = dir.join("models/encoder.onnx.part.12345");
        let at_threshold = dir.join("models/joint.onnx.part.4242");
        let fresh = dir.join("models/decoder.onnx.part.999");
        let finished = dir.join("models/encoder.onnx");
        for p in [&stale, &at_threshold, &fresh, &finished] {
            fs::write(p, b"bytes")?;
        }
        let now = std::time::SystemTime::now();
        for (path, age) in [
            (&stale, STALE_STAGING_SECS + 60),
            (&at_threshold, STALE_STAGING_SECS),
        ] {
            fs::File::options().write(true).open(path)?.set_times(
                fs::FileTimes::new().set_modified(now - std::time::Duration::from_secs(age)),
            )?;
        }

        cleanup_orphan_staging(&dir);

        assert!(!stale.exists(), "stale staging must be swept");
        assert!(
            at_threshold.exists(),
            "24h is the boundary a download must pass, not reach"
        );
        assert!(fresh.exists(), "a live installer's fresh staging survives");
        assert!(finished.exists(), "real model files are never touched");
        let _ = fs::remove_dir_all(&dir);
        Ok(())
    }

    #[test]
    fn is_cached_resolves_against_the_active_cache_root() {
        let _lock = crate::util::test_env::lock();
        let tmp = tempfile::tempdir().unwrap();
        let _guard = crate::util::test_env::EnvGuard::set(
            &_lock,
            "KESHA_CACHE_DIR",
            tmp.path().to_str().expect("utf-8 temp path"),
        );

        assert!(!is_cached(ModelKind::LangId), "empty cache is not cached");

        let dir = tmp.path().join(ModelKind::LangId.subdir());
        fs::create_dir_all(&dir).unwrap();
        for f in LANG_ID_FILES {
            let name = std::path::Path::new(f.rel_path).file_name().unwrap();
            fs::write(dir.join(name), b"dummy").unwrap();
        }
        assert!(is_cached(ModelKind::LangId), "staged cache is cached");
    }

    /// `Repo.folderName` strips the `-coreml` suffix, and a `…-v3-coreml` sibling
    /// exists on disk. Keying on it would report a healthy install as missing ASR.
    #[test]
    #[cfg(feature = "coreml")]
    fn fluidaudio_asr_dir_is_the_directory_fluidaudio_loads_from() {
        let dir = legacy_fluidaudio_asr_dir().unwrap();
        assert!(dir.ends_with("parakeet-tdt-0.6b-v3"), "{dir:?}");
        assert!(
            dir.to_string_lossy()
                .contains("Library/Application Support/FluidAudio/Models"),
            "{dir:?} is not FluidAudio's ASR root"
        );
    }

    /// A machine with nothing staged yet gets one tree: the injected root and the directory
    /// we report must be the same decision, or `kesha install` stages voice packs into a
    /// directory FluidAudio never reads and re-fetches the bundle anyway (#688).
    #[test]
    fn a_missing_bundle_lands_under_the_kesha_cache() {
        let _lock = crate::util::test_env::lock();
        let tmp = tempfile::tempdir().unwrap();
        let _guard = crate::util::test_env::EnvGuard::set(
            &_lock,
            "KESHA_CACHE_DIR",
            tmp.path().to_str().expect("utf-8 temp path"),
        );

        let legacy = PathBuf::from("/nonexistent/FluidAudio/Models/parakeet-tdt-0.6b-v3");
        let at = fluidaudio_location(&legacy, false, "parakeet-tdt-0.6b-v3").unwrap();

        let root = at
            .root
            .as_ref()
            .expect("a missing bundle must inject a root");
        assert_eq!(root, &tmp.path().join("fluidaudio"));
        assert_eq!(
            at.dir,
            root.join("parakeet-tdt-0.6b-v3"),
            "the reported directory must be where the injected root puts it"
        );
    }

    /// The whole point of the read-fallback: an existing install holds ~2 GB under
    /// FluidAudio's own defaults, and injecting a root would re-download all of it (#688).
    #[test]
    fn an_existing_bundle_stays_put_and_injects_no_root() {
        let _lock = crate::util::test_env::lock();
        let tmp = tempfile::tempdir().unwrap();
        let _guard = crate::util::test_env::EnvGuard::set(
            &_lock,
            "KESHA_CACHE_DIR",
            tmp.path().to_str().expect("utf-8 temp path"),
        );

        let legacy = PathBuf::from("/somewhere/FluidAudio/Models/parakeet-tdt-0.6b-v3");
        let at = fluidaudio_location(&legacy, true, "parakeet-tdt-0.6b-v3").unwrap();

        assert_eq!(at.dir, legacy);
        assert!(
            at.root.is_none(),
            "a usable legacy bundle must keep FluidAudio's defaults rather than relocate"
        );
    }

    /// Every subsystem appends its own repo folder to the same base, so they end up as
    /// siblings under one root rather than three home-directory trees.
    #[test]
    fn subsystems_share_one_root_as_siblings() {
        let _lock = crate::util::test_env::lock();
        let tmp = tempfile::tempdir().unwrap();
        let _guard = crate::util::test_env::EnvGuard::set(
            &_lock,
            "KESHA_CACHE_DIR",
            tmp.path().to_str().expect("utf-8 temp path"),
        );

        let missing = PathBuf::from("/nonexistent");
        let asr = fluidaudio_location(&missing, false, "parakeet-tdt-0.6b-v3").unwrap();
        let kokoro = fluidaudio_location(&missing, false, "kokoro-82m-coreml").unwrap();
        let sortformer =
            fluidaudio_location(&missing, false, "fluidaudio-rs/SortformerCompiled").unwrap();

        assert_eq!(asr.root, kokoro.root);
        assert_eq!(kokoro.root, sortformer.root);
        assert_eq!(asr.dir.parent(), kokoro.dir.parent());
    }

    /// The transition the notice exists for: a pin bump changes the required model set, the
    /// probe rejects a bundle that still holds ~461 MB, and nothing ever reads it again. It
    /// was silent before #688, so the bytes stranded with nothing pointing at them.
    #[test]
    fn a_rejected_legacy_bundle_that_still_holds_files_names_itself() {
        let tmp = tempfile::tempdir().unwrap();
        let legacy = tmp.path().join("parakeet-tdt-0.6b-v3");
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("Encoder.mlmodelc"), b"x").unwrap();

        let notice = stale_legacy_notice(&legacy, false, &AtomicBool::new(false))
            .expect("a bundle the probe rejected but that still holds files must be announced");

        assert!(
            notice.contains(&legacy.display().to_string()),
            "the notice must name the directory to delete: {notice}"
        );
        assert_eq!(
            notice.lines().count(),
            1,
            "one line, not a paragraph: {notice}"
        );
    }

    /// The common case is a machine that never had a legacy bundle, and a warning there would
    /// greet every first-run user with a path they have never seen.
    #[test]
    fn a_missing_legacy_directory_is_silent() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(
            stale_legacy_notice(&tmp.path().join("absent"), false, &AtomicBool::new(false))
                .is_none()
        );
    }

    /// An empty directory strands no bytes, so there is nothing to tell anyone to delete.
    #[test]
    fn an_empty_legacy_directory_is_silent() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(stale_legacy_notice(tmp.path(), false, &AtomicBool::new(false)).is_none());
    }

    /// A bundle that still passes its probe is the one being read — announcing it as
    /// abandoned would invite a healthy install to delete the models it is using.
    #[test]
    fn a_legacy_bundle_still_in_use_is_silent() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("Encoder.mlmodelc"), b"x").unwrap();
        assert!(stale_legacy_notice(tmp.path(), true, &AtomicBool::new(false)).is_none());
    }

    /// The location is resolved per bridge construction, not once — five sites do it, and a
    /// single `kesha transcribe` reaches more than one.
    #[test]
    fn the_notice_is_emitted_once_per_process() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("Encoder.mlmodelc"), b"x").unwrap();
        let latched = AtomicBool::new(false);

        assert!(stale_legacy_notice(tmp.path(), false, &latched).is_some());
        assert!(
            stale_legacy_notice(tmp.path(), false, &latched).is_none(),
            "a second resolution must stay quiet"
        );
    }

    /// An interrupted FluidAudio fetch leaves the directory present but partial.
    /// Treating that as cached lets preflight pass and the backend finish the
    /// download mid-transcribe, violating the no-auto-download rule (#684).
    #[test]
    #[cfg(feature = "coreml")]
    fn fluidaudio_asr_readiness_requires_the_whole_bundle() {
        let dir = std::env::temp_dir().join(format!("kesha-fluid-asr-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        assert!(
            !fluidaudio_asr_ready_in(&dir),
            "empty dir must not be ready"
        );

        fs::write(dir.join("Encoder.mlmodelc"), b"x").unwrap();
        assert!(
            !fluidaudio_asr_ready_in(&dir),
            "encoder alone must not be ready"
        );

        for f in FLUID_ASR_REQUIRED {
            fs::write(dir.join(f), b"x").unwrap();
        }
        assert!(
            fluidaudio_asr_ready_in(&dir),
            "complete bundle must be ready"
        );

        // The bridge loads int8, so an int4-only bundle is unusable: calling it ready
        // would pass preflight and let FluidAudio fetch the int8 encoder mid-transcribe.
        fs::remove_file(dir.join("Encoder.mlmodelc")).unwrap();
        fs::write(dir.join("EncoderInt4.mlmodelc"), b"x").unwrap();
        assert!(
            !fluidaudio_asr_ready_in(&dir),
            "int4-only bundle must not satisfy an int8 loader"
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn model_kind_subdir_table() {
        assert_eq!(ModelKind::Asr.subdir(), "models/parakeet-tdt-v3");
        assert_eq!(ModelKind::LangId.subdir(), "models/lang-id-ecapa");
        assert_eq!(ModelKind::Vad.subdir(), "models/silero-vad");
    }

    #[cfg(feature = "tts")]
    #[test]
    fn model_kind_subdir_vosk_ru() {
        assert_eq!(ModelKind::VoskRu.subdir(), "models/vosk-ru");
    }

    #[test]
    fn is_cached_in_lang_id_and_vad_arms_check_their_own_files() {
        // The match arms wire each kind to its own file list independently of
        // the Asr/Vosk arms — pin present→true / empty→false per arm.
        for (kind, files) in [
            (ModelKind::LangId, LANG_ID_FILES),
            (ModelKind::Vad, VAD_FILES),
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let dir = tmp.path().join(kind.subdir());
            fs::create_dir_all(&dir).unwrap();
            assert!(!is_cached_in(kind, &dir), "{kind:?} empty dir");
            for f in files {
                let name = std::path::Path::new(f.rel_path).file_name().unwrap();
                fs::write(dir.join(name), b"dummy").unwrap();
            }
            assert!(is_cached_in(kind, &dir), "{kind:?} all files present");
        }
    }

    #[test]
    #[cfg(not(feature = "coreml"))]
    fn is_cached_in_asr_true_when_all_files_present() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("models/parakeet-tdt-v3");
        fs::create_dir_all(&dir).unwrap();
        for f in ASR_FILES {
            let name = std::path::Path::new(f.rel_path).file_name().unwrap();
            fs::write(dir.join(name), b"dummy").unwrap();
        }
        assert!(is_cached_in(ModelKind::Asr, &dir));
    }

    #[test]
    #[cfg(not(feature = "coreml"))]
    fn is_cached_in_asr_false_when_one_file_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("models/parakeet-tdt-v3");
        fs::create_dir_all(&dir).unwrap();
        for f in &ASR_FILES[..ASR_FILES.len() - 1] {
            let name = std::path::Path::new(f.rel_path).file_name().unwrap();
            fs::write(dir.join(name), b"dummy").unwrap();
        }
        assert!(!is_cached_in(ModelKind::Asr, &dir));
    }

    #[cfg(feature = "tts")]
    #[test]
    fn is_cached_in_vosk_ru_true_when_layout_present() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("models/vosk-ru");
        for f in VOSK_RU_FILES {
            let rel = f.rel_path.strip_prefix("models/vosk-ru/").unwrap();
            let path = dir.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"dummy").unwrap();
        }
        assert!(is_cached_in(ModelKind::VoskRu, &dir));
    }

    /// One negative case per manifest file: `Vosk::load` opens every entry, so a
    /// bundle missing any single one is not loadable however cached it looks.
    /// Omitting exactly one file per iteration keeps each existence check
    /// individually pinned (#1132).
    #[cfg(feature = "tts")]
    #[test]
    fn is_cached_in_vosk_ru_false_when_any_single_file_missing() {
        for missing in VOSK_RU_FILES {
            let tmp = tempfile::tempdir().unwrap();
            let dir = tmp.path().join("models/vosk-ru");
            fs::create_dir_all(dir.join("bert")).unwrap();
            for f in VOSK_RU_FILES {
                if f.rel_path == missing.rel_path {
                    continue;
                }
                let rel = f.rel_path.strip_prefix("models/vosk-ru/").unwrap();
                let path = dir.join(rel);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, b"dummy").unwrap();
            }
            assert!(
                !is_cached_in(ModelKind::VoskRu, &dir),
                "bundle missing {} still reported cached",
                missing.rel_path
            );
        }
    }

    #[cfg(all(
        feature = "tts",
        not(all(
            feature = "system_kokoro",
            target_os = "macos",
            target_arch = "aarch64"
        ))
    ))]
    #[test]
    fn multilang_voice_returns_expected_packs() {
        // es → em_alex.bin (male ✓)
        let es = multilang_voice("es").unwrap();
        assert!(es.rel_path.ends_with("em_alex.bin"), "{}", es.rel_path);
        // fr → ff_siwis.bin (female, brand-rule exception)
        let fr = multilang_voice("fr").unwrap();
        assert!(fr.rel_path.ends_with("ff_siwis.bin"), "{}", fr.rel_path);
        // it → im_nicola.bin (male ✓)
        let it = multilang_voice("it").unwrap();
        assert!(it.rel_path.ends_with("im_nicola.bin"), "{}", it.rel_path);
        // pt → pm_alex.bin (male ✓)
        let pt = multilang_voice("pt").unwrap();
        assert!(pt.rel_path.ends_with("pm_alex.bin"), "{}", pt.rel_path);
        // ru and de → None (not in multilang Kokoro)
        assert!(multilang_voice("ru").is_none());
        assert!(multilang_voice("de").is_none());
    }

    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    #[test]
    fn ane_voice_lang_maps_prefixes_correctly() {
        assert_eq!(ane_voice_lang("am_michael.bin"), Some("en"));
        assert_eq!(ane_voice_lang("bm_george.bin"), Some("en"));
        assert_eq!(ane_voice_lang("em_alex.bin"), Some("es"));
        assert_eq!(ane_voice_lang("ff_siwis.bin"), Some("fr"));
        assert_eq!(ane_voice_lang("hm_test.bin"), Some("hi"));
        assert_eq!(ane_voice_lang("im_nicola.bin"), Some("it"));
        assert_eq!(ane_voice_lang("jm_test.bin"), Some("ja"));
        assert_eq!(ane_voice_lang("pm_alex.bin"), Some("pt"));
        assert_eq!(ane_voice_lang("zm_050.bin"), Some("zh"));
        assert_eq!(ane_voice_lang("xm_unknown.bin"), None);
        assert_eq!(ane_voice_lang(""), None);
    }
}

#[cfg(test)]
mod retry_tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    #[test]
    fn only_rate_limit_timeout_and_server_errors_are_retried() {
        for status in [408, 429, 500, 502, 503, 504] {
            assert!(status_is_transient(status), "{status} must be retried");
        }
        for status in [400, 401, 403, 404, 410, 451, 200, 301] {
            assert!(!status_is_transient(status), "{status} must be fatal");
        }
    }

    #[test]
    fn retry_after_reads_delay_seconds() {
        assert_eq!(parse_retry_after("120"), Some(Duration::from_secs(120)));
        assert_eq!(parse_retry_after("  7 "), Some(Duration::from_secs(7)));
        assert_eq!(parse_retry_after("0"), Some(Duration::ZERO));
    }

    #[test]
    fn retry_after_rejects_what_it_cannot_parse() {
        for raw in ["soon", "", "-5", "Sun, 06 Nov 1994 08:49:37 GMT"] {
            assert_eq!(parse_retry_after(raw), None, "{raw:?} must not parse");
        }
    }

    #[test]
    fn dns_failures_retry_less_than_the_other_network_ones() {
        for err in [
            ureq::Error::ConnectionFailed,
            ureq::Error::Timeout(ureq::Timeout::Connect),
            ureq::Error::Io(io::Error::from(io::ErrorKind::UnexpectedEof)),
        ] {
            assert_eq!(ureq_error_attempts(&err), MAX_DOWNLOAD_ATTEMPTS, "{err}");
        }
        assert_eq!(
            ureq_error_attempts(&ureq::Error::HostNotFound),
            DNS_MAX_ATTEMPTS
        );
        for err in [
            ureq::Error::TooManyRedirects,
            ureq::Error::RedirectFailed,
            ureq::Error::BadUri("nonsense".to_string()),
        ] {
            assert_eq!(ureq_error_attempts(&err), 1, "{err} must be fatal");
        }
    }

    /// `io::copy` cannot tell a stalled socket from a failing disk on its own,
    /// and only the first is worth re-GETting gigabytes for (grok P2 on #761).
    #[test]
    fn a_local_write_failure_is_never_retried() {
        let interrupted = stream_failure(model_download_error("download x".to_string()), true);
        assert_eq!(interrupted.max_attempts, MAX_DOWNLOAD_ATTEMPTS);
        assert_eq!(interrupted.reason, "download interrupted");

        let disk = stream_failure(model_download_error("download x".to_string()), false);
        assert_eq!(disk.max_attempts, 1);
        assert_eq!(disk.reason, "cache write failed");

        let mismatch = stream_failure(
            anyhow::Error::new(CodedError {
                code: ErrorCode::CacheCorrupt,
                message: "sha256 mismatch".to_string(),
            }),
            false,
        );
        assert_eq!(mismatch.max_attempts, 1);
        assert_eq!(mismatch.reason, "hash mismatch");
    }

    #[test]
    fn backoff_grows_exponentially_and_stays_capped() {
        let plain = |attempt| backoff_delay(attempt, None, 0.5).as_secs_f64();
        assert!((plain(1) - 1.0).abs() < 1e-9);
        assert!((plain(2) - 2.0).abs() < 1e-9);
        assert!((plain(3) - 4.0).abs() < 1e-9);
        assert!((plain(4) - 8.0).abs() < 1e-9);
        assert!(
            plain(20) <= RETRY_MAX_DELAY.as_secs_f64(),
            "a long schedule must not run away"
        );
    }

    #[test]
    fn backoff_jitter_stays_within_a_quarter_of_the_schedule() {
        for jitter in [0.0, 0.25, 0.5, 0.75, 1.0] {
            let delay = backoff_delay(3, None, jitter).as_secs_f64();
            assert!((3.0..=5.0).contains(&delay), "{jitter} produced {delay}s");
        }
    }

    /// The workers that matter draw at the same instant, so sequential variance is
    /// not the contract — independence across threads is (#724).
    #[test]
    fn jitter_fraction_is_independent_across_simultaneous_workers() {
        const THREADS: usize = 4;
        const DRAWS: usize = 8;

        let barrier = std::sync::Arc::new(std::sync::Barrier::new(THREADS));
        let workers: Vec<_> = (0..THREADS)
            .map(|_| {
                let barrier = std::sync::Arc::clone(&barrier);
                std::thread::spawn(move || {
                    barrier.wait();
                    (0..DRAWS).map(|_| jitter_fraction()).collect::<Vec<f64>>()
                })
            })
            .collect();
        let samples: Vec<f64> = workers
            .into_iter()
            .flat_map(|w| w.join().expect("jitter worker panicked"))
            .collect();

        for j in &samples {
            assert!((0.0..1.0).contains(j), "jitter {j} escaped [0, 1)");
        }
        let distinct: std::collections::HashSet<u64> =
            samples.iter().map(|j| j.to_bits()).collect();
        assert_eq!(
            distinct.len(),
            THREADS * DRAWS,
            "64-bit draws must not repeat; a shared clock is what makes them collide"
        );
        let spread = samples.iter().cloned().fold(f64::MIN, f64::max)
            - samples.iter().cloned().fold(f64::MAX, f64::min);
        assert!(spread > 0.001, "jitter spread {spread} is not usable");
    }

    #[test]
    fn retry_after_overrides_the_schedule_but_is_clamped() {
        assert_eq!(
            backoff_delay(1, Some(Duration::from_secs(12)), 0.5),
            Duration::from_secs(12)
        );
        assert_eq!(
            backoff_delay(1, Some(Duration::from_secs(3_600)), 0.5),
            RETRY_AFTER_MAX,
            "an hour-long Retry-After is clamped, not honoured"
        );
        assert_eq!(
            backoff_delay(4, Some(Duration::ZERO), 0.5),
            RETRY_BASE_DELAY,
            "Retry-After: 0 must not become a hot loop"
        );
    }

    /// Serves `responses` in order, one per connection, and reports the request
    /// head it answered each one with. Each response must close the connection.
    fn stub_server(responses: Vec<Vec<u8>>) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stub server");
        let base = format!("http://{}", listener.local_addr().expect("stub addr"));
        let handle = std::thread::spawn(move || {
            let mut served = Vec::new();
            for response in responses {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut request = Vec::new();
                let mut buf = [0u8; 512];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                if stream.write_all(&response).is_err() {
                    break;
                }
                let _ = stream.flush();
                served.push(String::from_utf8_lossy(&request).to_lowercase());
            }
            served
        });
        (base, handle)
    }

    fn ok_response(body: &[u8]) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(body);
        out
    }

    fn header_only_response(head: &str) -> Vec<u8> {
        format!("{head}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes()
    }

    struct TempCache(PathBuf);

    impl TempCache {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "kesha-retry-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            ));
            fs::create_dir_all(&dir).expect("create temp cache");
            Self(dir)
        }
    }

    impl Drop for TempCache {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn model_file(rel_path: &'static str, url: String, body: &[u8]) -> ModelFile {
        use sha2::{Digest, Sha256};
        let sha = format!("{:x}", Sha256::digest(body));
        ModelFile {
            rel_path,
            url: Box::leak(url.into_boxed_str()),
            sha256: Box::leak(sha.into_boxed_str()),
        }
    }

    #[test]
    fn a_rate_limited_download_retries_and_then_verifies() {
        let body = b"kesha model bytes".to_vec();
        let (base, server) = stub_server(vec![
            header_only_response("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0"),
            header_only_response("HTTP/1.1 302 Found\r\nLocation: /payload.bin"),
            ok_response(&body),
        ]);
        let cache = TempCache::new("429");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            &body,
        );

        download_verified(&cache.0, &file, false).expect("429 then success must install");

        assert_eq!(
            fs::read(cache.0.join(file.rel_path)).expect("payload written"),
            body
        );
        assert_eq!(
            server.join().expect("stub server").len(),
            3,
            "one 429, one redirect hop, one delivery"
        );
    }

    #[test]
    fn a_missing_artifact_fails_on_the_first_attempt() {
        let (base, server) = stub_server(vec![header_only_response("HTTP/1.1 404 Not Found")]);
        let cache = TempCache::new("404");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            b"unused",
        );

        let err = download_verified(&cache.0, &file, false).expect_err("404 must fail");

        assert_eq!(code_of(&err), ErrorCode::ModelDownload);
        let rendered = format!("{err:#}");
        assert!(rendered.contains("HTTP 404"), "{rendered}");
        assert!(rendered.contains("after 1 attempt"), "{rendered}");
        assert_eq!(
            server.join().expect("stub server").len(),
            1,
            "404 never retries"
        );
    }

    /// One file's fatal failure used to short-circuit rayon and could cancel a
    /// sibling before it ever ran. Every file now gets its own attempt (#724).
    #[test]
    fn a_failing_file_does_not_cancel_its_siblings() {
        let body = b"sibling bytes".to_vec();
        let (good_base, good) = stub_server(vec![ok_response(&body)]);
        let (bad_base, bad) = stub_server(vec![header_only_response("HTTP/1.1 404 Not Found")]);
        let cache = TempCache::new("sibling");
        let ok_file = model_file(
            "models/retry/good.bin",
            format!("{good_base}/good.bin"),
            &body,
        );
        let bad_file = model_file("models/retry/bad.bin", format!("{bad_base}/bad.bin"), b"x");

        let err = parallel_download(&cache.0, &[&bad_file, &ok_file], false)
            .expect_err("the 404 still fails the install");

        assert_eq!(code_of(&err), ErrorCode::ModelDownload);
        assert_eq!(
            fs::read(cache.0.join(ok_file.rel_path)).expect("sibling installed"),
            body
        );
        assert_eq!(good.join().expect("good server").len(), 1);
        assert_eq!(bad.join().expect("bad server").len(), 1);
    }

    #[test]
    fn every_exhausted_file_is_named_in_the_install_failure() {
        let (first_base, first) = stub_server(vec![header_only_response("HTTP/1.1 404 Not Found")]);
        let (second_base, second) =
            stub_server(vec![header_only_response("HTTP/1.1 403 Forbidden")]);
        let cache = TempCache::new("aggregate");
        let a = model_file("models/retry/a.bin", format!("{first_base}/a.bin"), b"a");
        let b = model_file("models/retry/b.bin", format!("{second_base}/b.bin"), b"b");

        let err = parallel_download(&cache.0, &[&a, &b], false).expect_err("both files fail");

        let rendered = format!("{err:#}");
        assert!(
            rendered.contains("2 of 2 model downloads failed"),
            "{rendered}"
        );
        assert!(rendered.contains(a.rel_path), "{rendered}");
        assert!(rendered.contains(b.rel_path), "{rendered}");
        assert_eq!(first.join().expect("first server").len(), 1);
        assert_eq!(second.join().expect("second server").len(), 1);
    }

    /// Retry wraps the request only. Bytes that do not match the pinned hash are
    /// rejected on the first attempt — retrying them would be a way around
    /// verification (#174).
    #[test]
    fn a_hash_mismatch_is_never_retried() {
        let (base, server) = stub_server(vec![ok_response(b"wrong bytes")]);
        let cache = TempCache::new("hash");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            b"expected bytes",
        );

        let err = download_verified(&cache.0, &file, false).expect_err("bad hash must fail");

        assert_eq!(code_of(&err), ErrorCode::CacheCorrupt);
        assert_eq!(server.join().expect("stub server").len(), 1);
        assert!(
            !cache.0.join(file.rel_path).exists(),
            "unverified bytes never land at the target"
        );
    }

    #[test]
    fn a_truncated_stream_is_re_requested_and_then_verifies() {
        let body = b"kesha model bytes".to_vec();
        let mut truncated =
            b"HTTP/1.1 200 OK\r\nContent-Length: 64\r\nConnection: close\r\n\r\n".to_vec();
        truncated.extend_from_slice(&body[..4]);
        let (base, server) = stub_server(vec![truncated, ok_response(&body)]);
        let cache = TempCache::new("truncated");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            &body,
        );

        download_verified(&cache.0, &file, false).expect("a short read must be retried");

        assert_eq!(
            fs::read(cache.0.join(file.rel_path)).expect("payload written"),
            body
        );
        assert_eq!(server.join().expect("stub server").len(), 2);
    }

    /// A staging path that cannot be opened stands in for any permanent local
    /// I/O failure: one GET, never five (grok P2 on #761).
    #[test]
    fn a_blocked_cache_write_gives_up_after_one_request() {
        let body = b"kesha model bytes".to_vec();
        let (base, server) = stub_server(vec![ok_response(&body)]);
        let cache = TempCache::new("blocked");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            &body,
        );
        let target = cache.0.join(file.rel_path);
        fs::create_dir_all(target.parent().expect("target parent")).expect("create model dir");
        fs::create_dir(staging_path(&target)).expect("occupy the staging path");

        let err = download_verified(&cache.0, &file, false).expect_err("staging is blocked");

        let rendered = format!("{err:#}");
        assert!(rendered.contains("after 1 attempt"), "{rendered}");
        assert_eq!(server.join().expect("stub server").len(), 1);
    }

    #[test]
    fn an_exhausted_budget_names_every_attempt_it_spent() {
        let rate_limited =
            || header_only_response("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 0");
        let (base, server) = stub_server(
            (0..MAX_DOWNLOAD_ATTEMPTS)
                .map(|_| rate_limited())
                .collect::<Vec<_>>(),
        );
        let cache = TempCache::new("exhausted");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            b"never served",
        );

        let err = download_verified(&cache.0, &file, false).expect_err("every attempt 429s");

        let rendered = format!("{err:#}");
        assert!(
            rendered.contains(&format!("after {MAX_DOWNLOAD_ATTEMPTS} attempt")),
            "{rendered}"
        );
        assert_eq!(
            server.join().expect("stub server").len(),
            MAX_DOWNLOAD_ATTEMPTS as usize
        );
    }

    /// Reads the request line and headers off `stream`, returning false if the
    /// peer hung up first.
    fn read_request(stream: &mut std::net::TcpStream) -> bool {
        let mut request = Vec::new();
        let mut buf = [0u8; 512];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            match stream.read(&mut buf) {
                Ok(0) | Err(_) => return false,
                Ok(n) => request.extend_from_slice(&buf[..n]),
            }
        }
        true
    }

    /// Streams a complete `chunk * chunks` body, `gap_ms` apart, then closes.
    /// The socket never goes quiet before the last byte.
    fn streaming_server(chunk: usize, chunks: usize, gap_ms: u64) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind streaming server");
        let base = format!("http://{}", listener.local_addr().expect("stub addr"));
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            if !read_request(&mut stream) {
                return;
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                chunk * chunks
            );
            if stream.write_all(head.as_bytes()).is_err() {
                return;
            }
            for _ in 0..chunks {
                if stream.write_all(&vec![b'k'; chunk]).is_err() {
                    return;
                }
                let _ = stream.flush();
                std::thread::sleep(Duration::from_millis(gap_ms));
            }
        });
        base
    }

    /// Drips `chunk * chunks` bytes `gap_ms` apart while promising twice that
    /// many, then holds the socket open and quiet for `hold_ms` before hanging
    /// up. The body is still arriving when a deadline shorter than the drip
    /// fires, and no scheduling delay can hand the client the promised length —
    /// those bytes are never sent, so the read cannot come back `Ok` (#1013).
    #[cfg(unix)]
    fn never_completing_server(chunk: usize, chunks: usize, gap_ms: u64, hold_ms: u64) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind never-completing server");
        let base = format!("http://{}", listener.local_addr().expect("stub addr"));
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            if !read_request(&mut stream) {
                return;
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                chunk * chunks * 2
            );
            if stream.write_all(head.as_bytes()).is_err() {
                return;
            }
            for _ in 0..chunks {
                if stream.write_all(&vec![b'k'; chunk]).is_err() {
                    return;
                }
                let _ = stream.flush();
                std::thread::sleep(Duration::from_millis(gap_ms));
            }
            std::thread::sleep(Duration::from_millis(hold_ms));
        });
        base
    }

    /// The `Timeout` ureq blames for a cut body read, `None` if the reader
    /// failed for any other reason. `io::copy` hands back the wrapped
    /// `ureq::Error`, and the variant is what tells a rolling stall budget from
    /// the whole-body deadline — a wall-clock band cannot, and goes flaky under
    /// suite load besides (#1013).
    fn timeout_reason(err: &io::Error) -> Option<ureq::Timeout> {
        match err.get_ref()?.downcast_ref::<ureq::Error>()? {
            ureq::Error::Timeout(reason) => Some(*reason),
            _ => None,
        }
    }

    /// Promises `promised` bytes, sends `sent` of them, then holds the socket
    /// open and quiet for `silence_ms` without ever closing it.
    fn stalling_server(sent: usize, promised: usize, silence_ms: u64) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind stalling server");
        let base = format!("http://{}", listener.local_addr().expect("stub addr"));
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            if !read_request(&mut stream) {
                return;
            }
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {promised}\r\nConnection: close\r\n\r\n"
            );
            if stream.write_all(head.as_bytes()).is_err() {
                return;
            }
            if stream.write_all(&vec![b'k'; sent]).is_err() {
                return;
            }
            let _ = stream.flush();
            std::thread::sleep(Duration::from_millis(silence_ms));
        });
        base
    }

    /// Accepts the connection, reads the request, and never answers it.
    fn silent_server(silence_ms: u64) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind silent server");
        let base = format!("http://{}", listener.local_addr().expect("stub addr"));
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let _ = read_request(&mut stream);
            std::thread::sleep(Duration::from_millis(silence_ms));
        });
        base
    }

    /// The regression #893 exists for: a link slower than the receive window was
    /// cut mid-stream no matter how many times it retried, which is what put a
    /// 654MB artifact out of reach on ubuntu and macOS (#776). The stall budget
    /// is rolling, so a body that keeps arriving keeps its window alive.
    #[test]
    fn a_steady_body_outlasting_the_stall_budget_completes() {
        const BUDGET: Duration = Duration::from_millis(500);
        const CHUNK: usize = 64;
        const CHUNKS: usize = 60;

        let base = streaming_server(CHUNK, CHUNKS, 20);
        let started = std::time::Instant::now();
        let response = download_request(&format!("{base}/payload.bin"), BUDGET, BUDGET)
            .call()
            .expect("headers arrive promptly");

        let mut sink = Vec::new();
        io::copy(&mut response.into_body().into_reader(), &mut sink)
            .expect("a body that never goes silent must not be cut");

        assert_eq!(sink.len(), CHUNK * CHUNKS);
        assert!(
            started.elapsed() > BUDGET,
            "the body finished inside the budget, so nothing was proven"
        );
    }

    /// The other half of the swap: the budget must still fire on a body that
    /// really has stopped, and leave the prefix behind for #889's resume.
    #[test]
    fn a_body_that_goes_silent_is_cut_at_the_stall_budget() {
        const BUDGET: Duration = Duration::from_millis(500);
        const SENT: usize = 64;

        let base = stalling_server(SENT, SENT * 4, 5_000);
        let started = std::time::Instant::now();
        let response = download_request(&format!("{base}/payload.bin"), BUDGET, BUDGET)
            .call()
            .expect("headers arrive promptly");

        let mut sink = Vec::new();
        let err = io::copy(&mut response.into_body().into_reader(), &mut sink)
            .expect_err("a body that stopped arriving must be cut");
        let elapsed = started.elapsed();

        assert_eq!(sink.len(), SENT, "the prefix must survive for resume");
        assert!(
            elapsed >= BUDGET,
            "cut after {elapsed:?}, budget {BUDGET:?}"
        );
        assert_eq!(
            timeout_reason(&err),
            Some(ureq::Timeout::RecvBody),
            "the stall budget must be what cut it: {err:?}"
        );
    }

    /// The coupling the swap rests on. With the body budget generous, the only
    /// thing that can still cut a host which accepts and never answers is
    /// `timeout_send_request`; without this test, dropping that line would
    /// reintroduce an unbounded hang with nothing going red (#893).
    #[test]
    fn a_host_that_never_answers_is_cut_by_the_header_budget() {
        const BUDGET: Duration = Duration::from_millis(500);

        let base = silent_server(5_000);
        let started = std::time::Instant::now();
        let err = download_request(
            &format!("{base}/payload.bin"),
            BUDGET,
            Duration::from_secs(30),
        )
        .call()
        .expect_err("a host that never answers must be cut");
        let elapsed = started.elapsed();

        assert!(
            elapsed >= BUDGET,
            "cut after {elapsed:?}, budget {BUDGET:?}"
        );
        assert!(
            matches!(err, ureq::Error::Timeout(ureq::Timeout::SendRequest)),
            "{err}"
        );
    }

    /// #780 inferred that the receive deadline detects a stall; #889 asked for
    /// that measured, and it is the opposite. ureq stamps `RecvResponse` at
    /// headers-received and `RecvBody` inherits that deadline, so a body still
    /// arriving steadily is cut off the moment the clock runs out — an absolute
    /// per-attempt cap, which is why five retries from byte 0 could never
    /// finish a 654MB file (#776). The second arm pins the other half: ureq
    /// takes the *minimum* of the two deadlines, so a generous
    /// `timeout_recv_body` cannot loosen the cap.
    ///
    /// `download_request` dropped `timeout_recv_response` for exactly this
    /// reason (#893), so this now characterizes a config we no longer ship —
    /// which is the point. It is what goes red if anyone puts that knob back.
    ///
    /// Unix only, and that is itself the finding: this same probe on
    /// windows-latest received the whole body well past the deadline, which is
    /// why #776 reproduced on ubuntu while windows fetched the same file in
    /// 86s. Asserting the windows behaviour would pin a platform bug, so this
    /// pins the semantics the cap actually has where it is enforced (#893).
    ///
    /// The server promises more than it will ever send because ureq enforces
    /// the deadline through the socket read timeout: a client descheduled long
    /// enough for the whole body to land in the kernel buffer drains it without
    /// a single blocking read and never sees the cut. Against a body that
    /// cannot complete that race has no winning side (#1013).
    #[cfg(unix)]
    #[test]
    fn the_receive_deadline_caps_the_whole_body_not_just_a_stall() {
        const DEADLINE: Duration = Duration::from_millis(500);
        const CHUNK: usize = 64;
        const CHUNKS: usize = 100;

        for recv_body in [None, Some(Duration::from_secs(30))] {
            let base = never_completing_server(CHUNK, CHUNKS, 20, 10_000);
            let started = std::time::Instant::now();
            let response = ureq::get(format!("{base}/payload.bin"))
                .config()
                .http_status_as_error(false)
                .timeout_recv_response(Some(DEADLINE))
                .timeout_recv_body(recv_body)
                .build()
                .call()
                .expect("headers arrive promptly");

            let mut sink = Vec::new();
            let err = io::copy(&mut response.into_body().into_reader(), &mut sink)
                .expect_err("the deadline must cut a body that is still flowing");
            let elapsed = started.elapsed();

            assert!(
                elapsed >= DEADLINE,
                "{recv_body:?}: cut after {elapsed:?}, deadline {DEADLINE:?}"
            );
            assert_eq!(
                timeout_reason(&err),
                Some(ureq::Timeout::RecvResponse),
                "{recv_body:?}: the whole-body deadline must be what cut it: {err:?}"
            );
        }
    }

    fn partial_response(body: &[u8], from: usize) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {}-{}/{}\r\nConnection: close\r\n\r\n",
            body.len() - from,
            from,
            body.len() - 1,
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(&body[from..]);
        out
    }

    fn truncated_response(body: &[u8], cut: usize) -> Vec<u8> {
        let mut out = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        out.extend_from_slice(&body[..cut]);
        out
    }

    /// Plants the staging file a previous attempt would have left behind.
    fn stage_partial(cache: &Path, file: &ModelFile, bytes: &[u8]) -> PathBuf {
        let target = cache.join(file.rel_path);
        fs::create_dir_all(target.parent().expect("target parent")).expect("create model dir");
        fs::write(staging_path(&target), bytes).expect("plant partial");
        target
    }

    /// The whole point of #889: a link that drops once per few hundred MB used
    /// to make a 654MB file unreachable, because every retry restarted at zero.
    #[test]
    fn an_interrupted_download_resumes_from_the_bytes_already_staged() {
        let body = b"kesha model bytes that outlive one attempt".to_vec();
        let cut = 12;
        let (base, server) = stub_server(vec![
            truncated_response(&body, cut),
            partial_response(&body, cut),
        ]);
        let cache = TempCache::new("resume");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            &body,
        );

        download_verified(&cache.0, &file, false).expect("the remainder must complete the file");

        assert_eq!(
            fs::read(cache.0.join(file.rel_path)).expect("payload written"),
            body
        );
        let requests = server.join().expect("stub server");
        assert_eq!(requests.len(), 2);
        assert!(
            !requests[0].contains("range:"),
            "the first attempt asks for the whole file: {}",
            requests[0]
        );
        assert!(
            requests[1].contains(&format!("range: bytes={cut}-")),
            "the retry must ask only for the remainder: {}",
            requests[1]
        );
    }

    /// HuggingFace answers `resolve/` with a 302 onto its CDN, so a `Range` that
    /// does not survive the hop would resume nothing in production.
    #[test]
    fn a_resumed_range_survives_a_redirect() {
        let body = b"kesha model bytes behind a redirect".to_vec();
        let cut = 9;
        let (base, server) = stub_server(vec![
            header_only_response("HTTP/1.1 302 Found\r\nLocation: /payload.bin"),
            partial_response(&body, cut),
        ]);
        let cache = TempCache::new("redirect-resume");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/resolve/payload.bin"),
            &body,
        );
        stage_partial(&cache.0, &file, &body[..cut]);

        download_verified(&cache.0, &file, false).expect("resume must survive the redirect");

        assert_eq!(
            fs::read(cache.0.join(file.rel_path)).expect("payload written"),
            body
        );
        let requests = server.join().expect("stub server");
        assert_eq!(requests.len(), 2);
        assert!(
            requests[1].contains(&format!("range: bytes={cut}-")),
            "the redirected hop dropped the range: {}",
            requests[1]
        );
    }

    /// A mirror is just another host, and the pinned hash is what keeps it safe
    /// either way (#121) — resume must not be HuggingFace-shaped.
    #[test]
    fn a_mirrored_download_resumes_the_same_way() {
        let body = b"kesha model bytes from a mirror".to_vec();
        let cut = 7;
        let (base, server) = stub_server(vec![
            truncated_response(&body, cut),
            partial_response(&body, cut),
        ]);
        let _lock = crate::util::test_env::lock();
        let _guard = crate::util::test_env::EnvGuard::set(&_lock, "KESHA_MODEL_MIRROR", &base);
        let cache = TempCache::new("mirror-resume");
        let file = model_file(
            "models/retry/payload.bin",
            "https://huggingface.co/payload.bin".to_string(),
            &body,
        );

        download_verified(&cache.0, &file, false).expect("the mirror must resume too");

        assert_eq!(
            fs::read(cache.0.join(file.rel_path)).expect("payload written"),
            body
        );
        let requests = server.join().expect("stub server");
        assert!(
            requests[1].contains(&format!("range: bytes={cut}-")),
            "{}",
            requests[1]
        );
    }

    /// A server free to ignore `Range` answers 200 with the whole body. Appending
    /// that onto a partial would corrupt the file, so the staging file restarts.
    #[test]
    fn a_server_that_ignores_the_range_restarts_instead_of_appending() {
        let body = b"kesha model bytes".to_vec();
        let (base, server) = stub_server(vec![ok_response(&body)]);
        let cache = TempCache::new("ignored-range");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            &body,
        );
        let target = stage_partial(&cache.0, &file, b"stale prefix");

        download_verified(&cache.0, &file, false).expect("a 200 must restart cleanly");

        assert_eq!(
            fs::read(&target).expect("payload written"),
            body,
            "an ignored range must not be appended onto"
        );
        let requests = server.join().expect("stub server");
        assert_eq!(requests.len(), 1);
        assert!(requests[0].contains("range: bytes=12-"), "{}", requests[0]);
    }

    /// A partial longer than the artifact — an upstream rehost, or a file the
    /// last run finished but never renamed — is unusable, not fatal.
    #[test]
    fn a_range_past_the_end_discards_the_partial_and_starts_over() {
        let body = b"kesha model bytes".to_vec();
        let (base, server) = stub_server(vec![
            header_only_response("HTTP/1.1 416 Range Not Satisfiable"),
            ok_response(&body),
        ]);
        let cache = TempCache::new("range-past-end");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            &body,
        );
        let target = stage_partial(&cache.0, &file, &vec![b'x'; 999]);

        download_verified(&cache.0, &file, false).expect("a stale partial must not strand a file");

        assert_eq!(fs::read(&target).expect("payload written"), body);
        let requests = server.join().expect("stub server");
        assert_eq!(requests.len(), 2);
        assert!(
            !requests[1].contains("range:"),
            "the discarded partial must be re-fetched whole: {}",
            requests[1]
        );
    }

    /// Resume changes where the bytes come from, never what proves them: the
    /// hash is taken over the assembled file, so a bad prefix is still rejected
    /// on the first attempt (#174).
    #[test]
    fn a_resume_onto_corrupt_bytes_still_fails_the_pinned_hash() {
        let body = b"kesha model bytes".to_vec();
        let cut = 6;
        let (base, server) = stub_server(vec![partial_response(&body, cut)]);
        let cache = TempCache::new("bad-resume");
        let file = model_file(
            "models/retry/payload.bin",
            format!("{base}/payload.bin"),
            &body,
        );
        let target = stage_partial(&cache.0, &file, b"XXXXXX");

        let err =
            download_verified(&cache.0, &file, false).expect_err("a bad prefix must not install");

        assert_eq!(code_of(&err), ErrorCode::CacheCorrupt);
        assert!(!target.exists(), "unverified bytes never reach the target");
        assert!(
            !staging_path(&target).exists(),
            "a mismatched assembly is not a resume point"
        );
        assert_eq!(
            server.join().expect("stub server").len(),
            1,
            "a hash mismatch is never retried"
        );
    }
}
