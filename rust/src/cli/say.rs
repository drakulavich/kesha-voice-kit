use anyhow::Result;
use std::path::PathBuf;

use crate::protocol::events;
use crate::{models, say_loop, tts};

#[derive(clap::Args)]
pub struct SayArgs {
    /// Text to synthesize (omit to read from stdin)
    pub text: Option<String>,
    /// Voice id, e.g. `en-am_michael`
    #[arg(long)]
    pub voice: Option<String>,
    /// Override the voice's default BCP 47 language code, e.g. `en-gb`
    #[arg(long)]
    pub lang: Option<String>,
    /// Output file (default: stdout)
    #[arg(long)]
    pub out: Option<PathBuf>,
    /// Speaking rate (0.5–2.0)
    #[arg(long, default_value_t = 1.0)]
    pub rate: f32,
    /// List installed voices and exit
    #[arg(long)]
    pub list_voices: bool,
    /// Parse the input as SSML (supports <speak>, <break>; strips unknown tags).
    /// See issue #122 for the v1 tag matrix.
    #[arg(long)]
    pub ssml: bool,
    /// Output audio format. Defaults to `wav` (or inferred from `--out`
    /// extension when omitted). Supported: `wav`, `ogg-opus`. See #223.
    #[arg(long, value_name = "FORMAT")]
    pub format: Option<String>,
    /// Opus bitrate in bits/second (e.g. 16000, 32000, 64000). Only valid
    /// with `--format ogg-opus`. Default 32000 (Telegram-grade).
    #[arg(long, value_name = "BPS")]
    pub bitrate: Option<i32>,
    /// Encoder sample rate. Only valid with `--format ogg-opus`. Must be
    /// one of 8000/12000/16000/24000/48000. Default 24000.
    #[arg(long = "sample-rate", value_name = "HZ")]
    pub sample_rate: Option<u32>,
    /// Explicit model path (testing override)
    #[arg(long, hide = true)]
    pub model: Option<PathBuf>,
    /// Explicit voice embedding file (testing override)
    #[arg(long = "voice-file", hide = true)]
    pub voice_file: Option<PathBuf>,
    /// Long-lived loop: read newline-delimited JSON requests on stdin,
    /// reuse loaded engines across calls, write framed binary responses
    /// on stdout. See `docs/tts-stdin-loop.md`. Issue #213.
    #[arg(long = "stdin-loop", hide = true)]
    pub stdin_loop: bool,
    /// Disable acronym auto-expansion on `ru-vosk-*` voices (ВОЗ → "вэ о зэ")
    /// and English on ONNX Kokoro builds (FBI → "ef bee eye"). No effect on
    /// FluidAudio Kokoro, `macos-*` or non-English voices, which spell
    /// initialisms in their own G2P; those paths warn on stderr instead (#842).
    /// `<say-as interpret-as="characters">` in SSML remains honored.
    #[arg(long = "no-expand-abbrev", default_value_t = false)]
    pub no_expand_abbrev: bool,
}

/// Resolve `--format` / `--bitrate` / `--sample-rate` / `--out` into a
/// [`tts::OutputFormat`]. Priority: explicit flag > `--out` extension > Wav
/// default (preserves historical stdout-RIFF behaviour). See #223.
pub(crate) fn resolve_output_format(
    format: Option<&str>,
    bitrate: Option<i32>,
    sample_rate: Option<u32>,
    out: Option<&std::path::Path>,
) -> Result<tts::OutputFormat, String> {
    use std::str::FromStr;

    // #275 D10: source label fed to the dtrace probe at the bottom.
    let (mut chosen, source): (tts::OutputFormat, &'static str) = match (format, out) {
        (Some(f), _) => (tts::OutputFormat::from_str(f)?, "--format"),
        (None, Some(p)) => {
            let ext_fmt = p
                .extension()
                .and_then(|e| e.to_str())
                .and_then(tts::encode::format_from_extension);
            match ext_fmt {
                Some(fmt) => (fmt, "out-ext"),
                None => (tts::OutputFormat::default(), "default"),
            }
        }
        (None, None) => (tts::OutputFormat::default(), "default"),
    };

    if let tts::OutputFormat::OggOpus {
        bitrate: ref mut br,
        sample_rate: ref mut sr,
    } = chosen
    {
        if let Some(b) = bitrate {
            *br = b;
        }
        if let Some(r) = sample_rate {
            *sr = r;
        }
        // The encoder keeps its own check, but reaching it costs a full synthesis first (T1-5).
        if !tts::encode::OPUS_BITRATE_RANGE.contains(br) {
            return Err(format!("--bitrate must be 6000..=510000 bps, got {br}"));
        }
    } else if bitrate.is_some() || sample_rate.is_some() {
        return Err("--bitrate / --sample-rate only apply to --format ogg-opus".to_string());
    }

    crate::dtrace!("format::resolved chosen={chosen:?} source={source}");
    Ok(chosen)
}

fn list_kokoro_voices(_cache: &std::path::Path) -> Vec<String> {
    #[cfg(all(
        feature = "system_kokoro",
        target_os = "macos",
        target_arch = "aarch64"
    ))]
    {
        return tts::fluid_kokoro::available_voice_ids();
    }
    #[allow(unreachable_code)]
    {
        let dir = _cache.join("models/kokoro-82m/voices");
        std::fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let p = e.path();
                if p.extension().and_then(|s| s.to_str()) != Some("bin") {
                    return None;
                }
                let stem = p.file_stem()?.to_string_lossy().into_owned();
                // Only prefixes the non-ANE resolve_voice arm accepts may be listed; an id the resolver rejects is #1168 again.
                let lang = match stem.chars().next()? {
                    'a' | 'b' => "en",
                    'e' => "es",
                    'f' => "fr",
                    'i' => "it",
                    'p' => "pt",
                    _ => return None,
                };
                Some(format!("{lang}-{stem}"))
            })
            .collect()
    }
}

fn list_vosk_ru_voices(cache: &std::path::Path) -> Vec<String> {
    // Vosk-TTS Russian is a single multi-speaker model — once installed, all
    // five baked-in speakers are available. Same gate as resolve_vosk_ru, so
    // partial installs don't advertise voices that fail at synthesis time.
    let dir = models::model_dir_at(models::ModelKind::VoskRu, cache);
    if !models::is_cached_in(models::ModelKind::VoskRu, &dir) {
        return Vec::new();
    }
    vec![
        "ru-vosk-f01".into(),
        "ru-vosk-f02".into(),
        "ru-vosk-f03".into(),
        "ru-vosk-m01".into(),
        "ru-vosk-m02".into(),
    ]
}

/// Map a TTS error to the documented exit code for `kesha say`: 1 = operational,
/// 2 = bad input, 4 = uncoded or unservable, 5 = text too long.
/// Keyed on the code, so the same code cannot exit differently per engine (T2-5).
fn exit_code_for_tts_err(e: &tts::TtsError) -> i32 {
    use crate::errors::ErrorCode as C;
    match e.code() {
        C::ModelMissing
        | C::ModelDownload
        | C::CacheCorrupt
        | C::ModelLoad
        | C::SidecarMissing
        | C::VoiceUnknown => 1,
        C::InvalidArg | C::SsmlInvalid | C::TextEmpty => 2,
        C::TextTooLong => 5,
        _ => 4,
    }
}

/// Read text from stdin, trimming surrounding whitespace.
fn read_stdin() -> Result<String, i32> {
    use std::io::Read;
    // Four bytes per allowed character: a pipe that streams past it is refused without waiting for EOF.
    const MAX_STDIN_BYTES: u64 = tts::MAX_TEXT_CHARS as u64 * 4 + 4;
    let mut bytes = Vec::new();
    if let Err(e) = std::io::stdin()
        .lock()
        .take(MAX_STDIN_BYTES + 1)
        .read_to_end(&mut bytes)
    {
        events::error(
            crate::errors::ErrorCode::Internal,
            format!("failed to read stdin: {e}"),
            None,
        );
        return Err(4);
    }
    if bytes.len() as u64 > MAX_STDIN_BYTES {
        let err = tts::TtsError::TextTooLong {
            max: tts::MAX_TEXT_CHARS,
            actual: String::from_utf8_lossy(&bytes).chars().count(),
        };
        events::error(err.code(), format!("{err}"), None);
        return Err(exit_code_for_tts_err(&err));
    }
    Ok(String::from_utf8_lossy(&bytes).trim().to_string())
}

/// Validate text length against TTS limits; returns the validated string or an
/// exit code on failure.
fn validate_text(text: String) -> Result<String, i32> {
    if text.is_empty() {
        let err = tts::TtsError::EmptyText;
        events::error(err.code(), format!("{err}"), None);
        return Err(exit_code_for_tts_err(&err));
    }
    let len = text.chars().count();
    if len > tts::MAX_TEXT_CHARS {
        let err = tts::TtsError::TextTooLong {
            max: tts::MAX_TEXT_CHARS,
            actual: len,
        };
        events::error(err.code(), format!("{err}"), None);
        return Err(exit_code_for_tts_err(&err));
    }
    Ok(text)
}

/// Resolve `--model` + `--voice-file` overrides or look up the voice by id.
/// Returns `(ResolvedVoice, exit_code_on_err)`.
fn resolve_voice(
    model: Option<PathBuf>,
    voice_file: Option<PathBuf>,
    voice_id: Option<&str>,
) -> Result<tts::voices::ResolvedVoice, i32> {
    match (model, voice_file) {
        (Some(model_path), Some(voice_path)) => Ok(tts::voices::ResolvedVoice::Kokoro {
            model_path,
            voice_path,
            espeak_lang: "en-us",
        }),
        (Some(_), None) | (None, Some(_)) => {
            events::error(
                crate::errors::ErrorCode::InvalidArg,
                "pass both --model and --voice-file or neither",
                None,
            );
            Err(2)
        }
        (None, None) => {
            let id = voice_id.unwrap_or(tts::voices::DEFAULT_VOICE_ID);
            let cache = models::cache_dir().map_err(|err| crate::errors::report(&err))?;
            tts::voices::resolve_voice(&cache, id).map_err(|err| crate::errors::report(&err))
        }
    }
}

/// Build the [`tts::EngineChoice`] from the resolved voice and playback rate.
fn engine_choice<'a>(
    resolved: &'a tts::voices::ResolvedVoice,
    voice_id: &'a str,
    rate: f32,
) -> tts::EngineChoice<'a> {
    match resolved {
        tts::voices::ResolvedVoice::Kokoro {
            model_path,
            voice_path,
            ..
        } => tts::EngineChoice::Kokoro {
            model_path,
            voice_path,
            speed: rate,
        },
        #[cfg(all(
            feature = "system_kokoro",
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        tts::voices::ResolvedVoice::FluidKokoro { voice_id, .. } => {
            tts::EngineChoice::FluidKokoro {
                voice_id,
                speed: rate,
            }
        }
        tts::voices::ResolvedVoice::Vosk {
            model_dir,
            speaker_id,
        } => tts::EngineChoice::Vosk {
            voice_id,
            model_dir,
            speaker_id: *speaker_id,
            speed: rate,
        },
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        tts::voices::ResolvedVoice::AVSpeech { voice_id } => tts::EngineChoice::AVSpeech {
            voice_id,
            speed: rate,
        },
    }
}

/// A fifo destination streams, so it is never opened here: the open would block until a reader attaches.
#[cfg(unix)]
fn out_file_type_refusal(path: &std::path::Path) -> Option<Result<(), String>> {
    use std::os::unix::fs::FileTypeExt;
    let file_type = std::fs::metadata(path).map(|m| m.file_type());
    // `/dev/stdout` is the engine's stdout, which is the CLI's pipe, not the caller's (T1-15).
    let device = path.starts_with("/dev")
        || file_type
            .as_ref()
            .is_ok_and(|ft| ft.is_char_device() || ft.is_block_device());
    if device {
        return Some(Err(format!(
            "--out {} is a character device, where the audio would be discarded; \
             omit --out to write it to stdout",
            path.display()
        )));
    }
    file_type.is_ok_and(|ft| ft.is_fifo()).then_some(Ok(()))
}

#[cfg(not(unix))]
fn out_file_type_refusal(_path: &std::path::Path) -> Option<Result<(), String>> {
    None
}

/// Probe `--out` before synthesis pays for a path the caller mistyped, as `record::WavOutput::open` does (T1-4).
fn probe_out_path(path: &std::path::Path) -> Result<(), String> {
    if let Some(verdict) = out_file_type_refusal(path) {
        return verdict;
    }
    let existed = path.exists();
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|err| format!("cannot write --out {}: {err}", path.display()))?;
    if !existed {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// Write synthesized bytes to `--out` file or stdout.
fn write_output(out: Option<&std::path::Path>, bytes: &[u8]) -> Result<(), i32> {
    use std::io::Write;
    let result = match out {
        Some(p) => std::fs::write(p, bytes).map_err(|e| e.to_string()),
        None => std::io::stdout()
            .write_all(bytes)
            .map_err(|e| e.to_string()),
    };
    result.map_err(|msg| {
        events::error(
            crate::errors::ErrorCode::Internal,
            format!("write failed: {msg}"),
            None,
        );
        4
    })
}

pub fn run(a: SayArgs) -> i32 {
    if a.list_voices {
        let cache = match models::cache_dir() {
            Ok(c) => c,
            Err(err) => return crate::errors::report(&err),
        };
        let mut voice_ids: Vec<String> = list_kokoro_voices(&cache)
            .into_iter()
            .chain(list_vosk_ru_voices(&cache))
            .collect();
        // macos-* voices live in the OS, not the cache — enumerate them via
        // the AVSpeech helper (#141). Best-effort: if the helper is absent or
        // errors out, we still show Kokoro/Vosk voices.
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        voice_ids.extend(tts::avspeech::list_voices(None));
        voice_ids.sort();
        // Stdout is the list: a sentence there is a voice id to the MCP list_voices tool (#1168).
        if voice_ids.is_empty() {
            events::progress(None, "No voices installed. Run: kesha install --tts");
        }
        for id in voice_ids {
            println!("{id}");
        }
        return 0;
    }

    if a.stdin_loop {
        return say_loop::run();
    }

    let format = match resolve_output_format(
        a.format.as_deref(),
        a.bitrate,
        a.sample_rate,
        a.out.as_deref(),
    ) {
        Ok(f) => f,
        Err(msg) => {
            events::error(crate::errors::ErrorCode::InvalidArg, msg, None);
            return 2;
        }
    };

    if let Some(path) = a.out.as_deref() {
        if let Err(msg) = probe_out_path(path) {
            events::error(crate::errors::ErrorCode::InvalidArg, msg, None);
            return 2;
        }
    }

    if let Err(msg) = tts::say::validate_rate(a.rate) {
        events::error(crate::errors::ErrorCode::InvalidArg, msg, None);
        return 2;
    }

    let raw_text = match a.text {
        Some(s) => s,
        None => match read_stdin() {
            Ok(s) => s,
            Err(code) => return code,
        },
    };

    let text = match validate_text(raw_text) {
        Ok(t) => t,
        Err(code) => return code,
    };

    let resolved = match resolve_voice(a.model, a.voice_file, a.voice.as_deref()) {
        Ok(r) => r,
        Err(code) => return code,
    };

    let espeak_lang = a
        .lang
        .clone()
        .unwrap_or_else(|| resolved.espeak_lang().to_string());
    let engine = engine_choice(
        &resolved,
        a.voice.as_deref().unwrap_or(tts::voices::DEFAULT_VOICE_ID),
        a.rate,
    );

    let bytes = match tts::say(tts::SayOptions {
        text: &text,
        lang: &espeak_lang,
        engine,
        ssml: a.ssml,
        format,
        expand_abbrev: !a.no_expand_abbrev,
    }) {
        Ok(w) => w,
        Err(e) => {
            events::error(e.code(), format!("{e}"), None);
            return exit_code_for_tts_err(&e);
        }
    };

    match write_output(a.out.as_deref(), &bytes) {
        Ok(()) => 0,
        Err(code) => code,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn explicit_format_wins_over_out_extension() {
        let fmt = resolve_output_format(Some("wav"), None, None, Some(Path::new("x.flac")))
            .expect("wav with flac out path");
        assert_eq!(fmt, tts::OutputFormat::Wav);
    }

    #[test]
    fn out_extension_selects_format() {
        for (path, expected) in [
            ("a.oga", tts::OutputFormat::ogg_opus_default()),
            ("a.ogg", tts::OutputFormat::ogg_opus_default()),
            ("a.flac", tts::OutputFormat::Flac),
            ("a.wav", tts::OutputFormat::Wav),
            ("a.txt", tts::OutputFormat::Wav),
        ] {
            let fmt = resolve_output_format(None, None, None, Some(Path::new(path)))
                .unwrap_or_else(|e| panic!("{path}: {e}"));
            assert_eq!(fmt, expected, "{path}");
        }
    }

    #[test]
    fn defaults_to_wav_without_hints() {
        assert_eq!(
            resolve_output_format(None, None, None, None).unwrap(),
            tts::OutputFormat::Wav
        );
    }

    #[test]
    fn opus_knobs_apply_to_ogg_opus() {
        let fmt = resolve_output_format(Some("ogg-opus"), Some(64_000), Some(48_000), None)
            .expect("explicit opus with knobs");
        assert_eq!(
            fmt,
            tts::OutputFormat::OggOpus {
                bitrate: 64_000,
                sample_rate: 48_000
            }
        );
    }

    #[test]
    fn opus_knobs_rejected_for_other_formats() {
        for (format, out) in [
            (Some("wav"), None),
            (Some("flac"), None),
            (None, Some(Path::new("a.flac"))),
        ] {
            let err = resolve_output_format(format, Some(32_000), None, out)
                .expect_err("bitrate must be rejected off the opus path");
            assert!(err.contains("only apply to --format ogg-opus"), "{err}");
        }
        let err = resolve_output_format(Some("wav"), None, Some(24_000), None)
            .expect_err("sample-rate must be rejected off the opus path");
        assert!(err.contains("only apply to --format ogg-opus"), "{err}");
    }

    #[test]
    fn opus_bitrate_range_is_enforced_before_synthesis() {
        for bad in [1, 5_999, 510_001] {
            let err = resolve_output_format(Some("ogg-opus"), Some(bad), None, None)
                .expect_err("bitrate outside the documented range must be refused");
            assert!(err.contains("--bitrate must be 6000..=510000 bps"), "{err}");
        }
        for ok in [6_000, 32_000, 510_000] {
            resolve_output_format(Some("ogg-opus"), Some(ok), None, None)
                .unwrap_or_else(|e| panic!("{ok}: {e}"));
        }
    }

    #[test]
    fn unknown_format_lists_supported_values() {
        let err = resolve_output_format(Some("mp3"), None, None, None).unwrap_err();
        assert!(err.contains("supported: wav, ogg-opus, flac"), "{err}");
    }

    #[test]
    fn tts_exit_codes_match_documented_contract() {
        assert_eq!(exit_code_for_tts_err(&tts::TtsError::EmptyText), 2);
        assert_eq!(
            exit_code_for_tts_err(&tts::TtsError::TextTooLong {
                max: 5000,
                actual: 5001
            }),
            5
        );
        assert_eq!(
            exit_code_for_tts_err(&tts::TtsError::SynthesisFailed("boom".into())),
            4
        );
        use crate::errors::ErrorCode as C;
        for (code, expected) in [
            (C::ModelMissing, 1),
            (C::ModelDownload, 1),
            (C::CacheCorrupt, 1),
            (C::ModelLoad, 1),
            (C::SidecarMissing, 1),
            (C::VoiceUnknown, 1),
            (C::InvalidArg, 2),
            (C::SsmlInvalid, 2),
            (C::TextEmpty, 2),
            (C::TextTooLong, 5),
            (C::ScriptUnsupported, 4),
            (C::SsmlUnsupported, 4),
            (C::Internal, 4),
        ] {
            assert_eq!(
                exit_code_for_tts_err(&tts::TtsError::Coded {
                    code,
                    message: "boom".into()
                }),
                expected,
                "{}",
                code.as_str()
            );
        }
    }
}
