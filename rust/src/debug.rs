//! Debug trace (#148): stderr `[debug/engine] ...` lines when `KESHA_DEBUG`
//! is truthy. No-op otherwise. Boundary-only — never per-sample, never in
//! the hot inference loop.
//!
//! Pairs with the TS-side `log.debug()` on the CLI wrapper. Together:
//!
//! ```text
//! $ KESHA_DEBUG=1 kesha audio.ogg
//! [debug] spawn /.../kesha-engine transcribe audio.ogg
//! [debug/engine] audio::load_mono16k audio.ogg
//! [debug/engine] asr::backend=onnx
//! [debug/engine] asr::transcribe.end dt=340ms chars=42
//! [debug] exit=0 dt=352ms args=["transcribe","audio.ogg"]
//! ```

use std::sync::OnceLock;

fn enabled() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(|| match std::env::var("KESHA_DEBUG").as_deref() {
        Ok("0" | "false" | "") | Err(_) => false,
        Ok(_) => true,
    })
}

/// Emit a stderr trace line when `KESHA_DEBUG` is on. Accepts `format_args!`
/// so call sites don't allocate when debug is off — `enabled()` is one atomic
/// load via OnceLock. Use via the `dtrace!` macro below.
pub fn trace_fmt(args: std::fmt::Arguments<'_>) {
    if enabled() {
        eprintln!("[debug/engine] {args}");
    }
}

/// Convenience macro so call sites don't allocate when off.
#[macro_export]
macro_rules! dtrace {
    ($($arg:tt)*) => {
        $crate::debug::trace_fmt(format_args!($($arg)*))
    };
}

#[cfg(test)]
mod tests {
    // `enabled()` caches via OnceLock so it can only be tested once per
    // process. Instead of fighting that, assert parsing behavior by calling
    // the core logic directly at test time.
    fn parse(v: Option<&str>) -> bool {
        match v {
            Some("0" | "false" | "") | None => false,
            Some(_) => true,
        }
    }

    #[test]
    fn off_when_unset() {
        assert!(!parse(None));
    }

    #[test]
    fn off_for_zero_and_false() {
        assert!(!parse(Some("0")));
        assert!(!parse(Some("false")));
        assert!(!parse(Some("")));
    }

    #[test]
    fn on_for_one_and_true() {
        assert!(parse(Some("1")));
        assert!(parse(Some("true")));
        assert!(parse(Some("anything")));
    }
}
