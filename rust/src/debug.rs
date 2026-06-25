//! Debug trace (#148): stderr `[debug/engine +Nms] ...` lines when
//! `KESHA_DEBUG` is truthy. No-op otherwise. Boundary-only — never
//! per-sample, never in the hot inference loop.
//!
//! Pairs with the TS-side `log.debug()` on the CLI wrapper. Together:
//!
//! ```text
//! $ KESHA_DEBUG=1 kesha audio.ogg
//! [debug +12ms] spawn /.../kesha-engine transcribe audio.ogg
//! [debug/engine +5ms] audio::load_mono16k audio.ogg
//! [debug/engine +14ms] asr::backend=onnx
//! [debug/engine +354ms] asr::transcribe.end dt=340ms chars=42
//! [debug +365ms] exit=0 dt=352ms args=["transcribe","audio.ogg"]
//! ```
//!
//! The `+Nms` prefix is relative to the LOGGER's own start (TS vs Rust
//! process start) — the two axes are independent; use inline `dt=Nms`
//! tokens for spans within the same side.
//!
//! # Structured NDJSON sink (`KESHA_DEBUG_FD`, F19)
//!
//! `KESHA_DEBUG_FD=N` routes structured events to fd N (opened by the
//! parent before exec, e.g. `3>trace.ndjson`), keeping them off stderr:
//!
//! ```text
//! {"t_ms": 12, "event": "asr.backend_loaded", "dt_ms": 8}
//! {"t_ms": 354, "event": "asr.transcribe.end", "dt_ms": 340, "chars": 42}
//! ```
//!
//! Independent of `KESHA_DEBUG` — both paths can be active simultaneously.

use std::fs::File;
use std::io::Write;
#[cfg(unix)]
use std::os::fd::FromRawFd;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Off-values for `KESHA_DEBUG`, matched case-insensitively after trim.
/// Mirrored in `src/log.ts` (#275 D9) so `KESHA_DEBUG=False` flips both sides.
const KESHA_DEBUG_OFF_VALUES: &[&str] = &["", "0", "false", "no", "off"];

/// Pure helper so `enabled()` and its test share the same parsing logic.
fn debug_on_for(value: Option<&str>) -> bool {
    match value {
        None => false,
        Some(s) => {
            let normalized = s.trim().to_ascii_lowercase();
            !KESHA_DEBUG_OFF_VALUES.contains(&normalized.as_str())
        }
    }
}

/// Whether `KESHA_DEBUG` was truthy at process start.
///
/// `pub` so the [`dtrace!`] macro can guard the call site before building
/// format-args, skipping eager work like `ipa.chars().count()` (#313 F22).
pub fn enabled() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| debug_on_for(std::env::var("KESHA_DEBUG").ok().as_deref()))
}

static T0: OnceLock<Instant> = OnceLock::new();

/// Engine-side T0 for the `+Nms` prefix. Anchored by [`init`] before clap
/// parsing so early startup isn't collapsed into "+0ms" (Greptile P2 #293).
/// Independent of the TS side's `PROCESS_T0_MS` — each process logs against
/// its own start.
fn engine_t0() -> Instant {
    *T0.get_or_init(Instant::now)
}

/// Anchor T0 before `Cli::parse()` so startup work appears in `+Nms` rather
/// than being invisible. No-op if called again (OnceLock). Safe when debug off.
pub fn init() {
    let _ = engine_t0();
}

/// Emit a stderr trace line when `KESHA_DEBUG` is on.
/// Defence-in-depth guard for direct callers that bypass [`dtrace!`]; fast
/// path is the macro-level `enabled()` check.
pub fn trace_fmt(args: std::fmt::Arguments<'_>) {
    if enabled() {
        let t = engine_t0().elapsed().as_millis();
        eprintln!("[debug/engine +{t}ms] {args}");
    }
}

/// Emit a relative-ms-prefixed stderr line when `KESHA_DEBUG` is on.
/// **No-op when off, INCLUDING the format-args expression** — the
/// `enabled()` guard fires before `format_args!` so eager work like
/// `ipa.chars().count()` is skipped in production (#313 F22).
#[macro_export]
macro_rules! dtrace {
    ($($arg:tt)*) => {
        if $crate::debug::enabled() {
            $crate::debug::trace_fmt(format_args!($($arg)*));
        }
    };
}

/// Resolved JSON sink (`KESHA_DEBUG_FD`, F19). `None` when unset/invalid.
///
/// `Mutex<File>` not `BufWriter`: each NDJSON line must hit the kernel as
/// one `write(2)` so concurrent threads can't interleave half-lines.
/// Lines stay under `PIPE_BUF` (4096 on Linux), so `write_all` is atomic.
static JSON_SINK: OnceLock<Option<Mutex<File>>> = OnceLock::new();

#[cfg(unix)]
fn json_sink() -> Option<&'static Mutex<File>> {
    JSON_SINK
        .get_or_init(|| {
            let raw = std::env::var("KESHA_DEBUG_FD").ok()?;
            let fd: i32 = raw.trim().parse().ok()?;
            // Refuse 0/1/2 — they belong to the text-CLI contract; a stray
            // `KESHA_DEBUG_FD=2` would poison stderr with NDJSON.
            if fd < 3 {
                return None;
            }
            // SAFETY: caller contract — parent opened `fd` before exec and
            // keeps it alive for the engine's lifetime. EBADF on the first
            // `write(2)` silently drops the line; no panic, no abort.
            let file = unsafe { File::from_raw_fd(fd) };
            Some(Mutex::new(file))
        })
        .as_ref()
}

#[cfg(not(unix))]
fn json_sink() -> Option<&'static Mutex<File>> {
    // fd-from-int is POSIX-only; Windows would need a HANDLE instead.
    // Fall back to the stderr text path (`KESHA_DEBUG=1`) on Windows for now.
    None
}

/// `pub` so [`dtrace_json!`] can skip the `serde_json::json!` allocation
/// when the sink is inactive — same zero-cost contract as [`dtrace!`] (#321).
pub fn json_sink_is_active() -> bool {
    json_sink().is_some()
}

/// Emit one NDJSON event to the JSON sink, if configured.
///
/// `fields` must be a `serde_json::Value::Object`; non-object payloads
/// trip a `debug_assert!` and degrade to empty map in release.
/// Reserved keys `t_ms` and `event` are always injected by the writer.
/// Prefer the [`dtrace_json!`] macro — it gates allocation on [`json_sink_is_active`].
pub fn trace_json(event: &str, fields: serde_json::Value) {
    let Some(sink) = json_sink() else {
        return;
    };
    let mut payload = match fields {
        serde_json::Value::Object(map) => map,
        other => {
            // Call-site bug: can't merge non-object payload with `t_ms`/`event`.
            // Catch in dev/test; degrade to empty map in release.
            debug_assert!(
                false,
                "dtrace_json! expects a JSON object payload, got: {other:?}"
            );
            serde_json::Map::new()
        }
    };
    let t = engine_t0().elapsed().as_millis();
    payload.insert(
        "t_ms".into(),
        serde_json::Value::Number(serde_json::Number::from(t as u64)),
    );
    payload.insert("event".into(), serde_json::Value::String(event.into()));
    let mut line = serde_json::to_vec(&payload).unwrap_or_else(|_| {
        // Infallible in practice (no NaN/Inf floats here), but keeps
        // `trace_json` panic-free against future serde_json changes.
        Vec::new()
    });
    if line.is_empty() {
        return;
    }
    line.push(b'\n');
    if let Ok(mut guard) = sink.lock() {
        // Best-effort: trace is observability, not a contract — IO errors
        // silently drop the line rather than spamming stderr.
        let _ = guard.write_all(&line);
    }
}

/// Emit a structured NDJSON event when [`json_sink_is_active`].
///
/// ```ignore
/// dtrace_json!("asr.backend_loaded", { "dt_ms": elapsed.as_millis() });
/// ```
///
/// Zero-cost when sink is unset: gate sits before `serde_json::json!`,
/// skipping the heap allocation the eager form had (Greptile P2 #321).
#[macro_export]
macro_rules! dtrace_json {
    ($event:expr, $fields:tt) => {
        if $crate::debug::json_sink_is_active() {
            $crate::debug::trace_json($event, ::serde_json::json!($fields))
        }
    };
}

#[cfg(test)]
mod tests {
    // `enabled()` caches via OnceLock (once per process); call the pure
    // helper directly so tests cover the same parsing rule without racing.
    use super::debug_on_for;

    #[test]
    fn off_when_unset() {
        assert!(!debug_on_for(None));
    }

    #[test]
    fn off_for_zero_false_empty() {
        assert!(!debug_on_for(Some("0")));
        assert!(!debug_on_for(Some("false")));
        assert!(!debug_on_for(Some("")));
    }

    #[test]
    fn off_for_no_and_off() {
        // `no` and `off` added in #275 D9.
        assert!(!debug_on_for(Some("no")));
        assert!(!debug_on_for(Some("off")));
    }

    #[test]
    fn off_case_insensitive() {
        // Pre-D9 used exact-case `"false"`, letting `"False"` flip only the engine ON (#275).
        assert!(!debug_on_for(Some("False")));
        assert!(!debug_on_for(Some("FALSE")));
        assert!(!debug_on_for(Some("No")));
        assert!(!debug_on_for(Some("OFF")));
    }

    #[test]
    fn off_with_surrounding_whitespace() {
        assert!(!debug_on_for(Some("  false  ")));
        assert!(!debug_on_for(Some("\t0\n")));
    }

    #[test]
    fn on_for_one_true_anything() {
        assert!(debug_on_for(Some("1")));
        assert!(debug_on_for(Some("true")));
        assert!(debug_on_for(Some("anything")));
    }

    /// Locks the F22 contract (#313 P2): `dtrace!` must NOT evaluate its
    /// format-args expression when `KESHA_DEBUG` is off.
    ///
    /// Uses a function-call arg (eagerly evaluated by Rust before `Arguments`
    /// is built) rather than a `Display` impl (lazy — `Display::fmt` only
    /// runs on write, so the internal guard in `trace_fmt` would mask a
    /// regression; Greptile P2 on #326).
    #[test]
    fn dtrace_skips_arg_evaluation_when_debug_is_off() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        if super::enabled() {
            eprintln!("KESHA_DEBUG is on in this process; skipping lazy-arg test");
            return;
        }

        static COUNT: AtomicUsize = AtomicUsize::new(0);

        fn side_effecting_arg() -> u32 {
            COUNT.fetch_add(1, Ordering::Relaxed);
            42
        }

        // Function-call arg is evaluated eagerly before `Arguments<'_>` is built.
        // Call-site guard (new) → fn never runs; guard only inside trace_fmt
        // (old) → fn runs and COUNT increments, detecting the regression.
        crate::dtrace!("f22-test {}", side_effecting_arg());

        assert_eq!(
            COUNT.load(Ordering::Relaxed),
            0,
            "dtrace! eagerly evaluated its format-arg expression when KESHA_DEBUG was off; \
             the call-site guard regressed (#313 F22)"
        );
    }
}
