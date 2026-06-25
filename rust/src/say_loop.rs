//! `kesha-engine say --stdin-loop` — long-lived TTS process.
//!
//! Issue #213. Stdin: newline-delimited JSON requests. Stdout: framed binary
//! responses. Loaded engines (Kokoro session, Vosk cache, voice files) are
//! reused across requests, amortising the ~21 s/call Vosk RU cold-load and
//! ~1 s/call Kokoro load.
//!
//! ## Wire format
//!
//! ```text
//! request:   <JSON>\n
//! response:  <status:u8><id:u32 LE><len:u32 LE><payload:[u8; len]>
//! ```
//!
//! - `status`: `0` = ok (payload is encoded audio bytes per request `format`),
//!   `1` = err (payload is a UTF-8 error message).
//! - `id`: echoed verbatim from the request's `id` field. Pre-parse errors
//!   (oversized line, malformed JSON) emit `id = 0`.
//! - `len`: u32 little-endian, payload byte count. Capped at
//!   [`MAX_PAYLOAD_BYTES`] to give downstream readers a sane upper bound.
//!
//! ## Request shape
//!
//! ```json
//! {"id": 7, "text": "hello", "voice": "en-am_michael",
//!  "format": "wav", "rate": 1.0, "ssml": false, "expand_abbrev": true}
//! ```
//!
//! All fields except `text` and `voice` are optional. `format` /
//! `bitrate` / `sample_rate` mirror the CLI flags. `expand_abbrev`
//! defaults to `true`; set to `false` to suppress Cyrillic acronym
//! expansion for `ru-vosk-*` voices (mirrors `--no-expand-abbrev`).
//!
//! ## What this is NOT
//!
//! - Not a public API surface — the flag is hidden in `--help` output. The
//!   protocol may change between minor releases until a stable client lands.
//! - Not concurrent — requests are processed strictly serially. Out-of-order
//!   responses would need request-id-ordered delivery; today the cache makes
//!   that academic.
//! - Not lifecycle-managed — a v1 client should monitor the engine's stdin
//!   pipe and respawn on broken pipe / unexpected exit. Idle-eviction of the
//!   ~934 MB Vosk session is a separate follow-up issue.

use std::io::{BufRead, BufReader, Write};
use std::path::Path;

use crate::{models, tts};

/// Maximum bytes a single request line may carry. The longest legitimate
/// request is JSON-quoted text up to `tts::MAX_TEXT_CHARS` (5000 chars =
/// ~20 KB UTF-8 worst case) plus a few hundred bytes of metadata. 64 KB
/// gives generous headroom and bounds the worst-case allocation if a
/// misbehaving client stops emitting newlines.
pub const MAX_REQUEST_LINE: usize = 64 * 1024;

/// Maximum payload byte count for a single response frame. Today's Kokoro
/// output for 5000 chars at 24 kHz mono f32 is ~36 MB; 256 MB leaves room
/// for future engines and oversized SSML inputs while still bounding the
/// reader's pre-allocation.
pub const MAX_PAYLOAD_BYTES: usize = 256 * 1024 * 1024;

const STATUS_OK: u8 = 0;
const STATUS_ERR: u8 = 1;

#[derive(serde::Deserialize)]
struct LoopRequest {
    /// Echoed back on the response frame so a pipelined client can correlate responses to requests.
    #[serde(default)]
    id: u32,
    text: String,
    voice: String,
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    bitrate: Option<i32>,
    #[serde(default)]
    sample_rate: Option<u32>,
    #[serde(default)]
    lang: Option<String>,
    #[serde(default = "default_rate")]
    rate: f32,
    #[serde(default)]
    ssml: bool,
    /// Auto-expand all-uppercase acronyms before synth: Cyrillic on `ru-vosk-*`
    /// (#232), Latin on `en-*` (#244). Defaults to `true` when absent so legacy
    /// clients keep current behavior. Mirrors the CLI `--no-expand-abbrev` flag
    /// (inverted). No effect for `macos-*` voices.
    #[serde(default = "default_expand_abbrev")]
    expand_abbrev: bool,
}

fn default_rate() -> f32 {
    1.0
}

fn default_expand_abbrev() -> bool {
    true
}

struct LoopState {
    /// `Option` to defer load until the first Kokoro request; `ensure_model` handles swaps.
    kokoro: Option<tts::sessions::KokoroSession>,
    /// Vosk cache by model directory. The Russian path uses one model dir
    /// today, but keep it map-shaped so adding more languages is a no-op.
    vosk: tts::sessions::VoskCache,
    /// Cached CharsiuG2P session (three ONNX sessions, ~100 MB). Loaded once
    /// on the first Romance-language (es/fr/it/pt) request and reused for all
    /// subsequent ones. Fixes Greptile P1 (#509): previously `text_to_ipa`
    /// reloaded the three sessions from disk on every request.
    charsiu: tts::sessions::CharsiuCache,
}

/// Drive the loop. Returns 0 on clean stdin EOF, 4 on read error.
pub fn run() -> i32 {
    let stdin = std::io::stdin();
    let mut reader = BufReader::with_capacity(MAX_REQUEST_LINE + 1024, stdin.lock());
    let stdout = std::io::stdout();
    let mut stdout = stdout.lock();
    let mut state = LoopState {
        kokoro: None,
        vosk: tts::sessions::VoskCache::new(),
        charsiu: tts::sessions::CharsiuCache::new(),
    };

    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    loop {
        buf.clear();
        match read_line_bounded(&mut reader, &mut buf, MAX_REQUEST_LINE) {
            Ok(LineRead::Eof) => return 0,
            Ok(LineRead::Line) => {}
            Ok(LineRead::TooLong) => {
                let _ = write_err(&mut stdout, 0, "request line exceeds 64 KB; skipped");
                continue;
            }
            Err(e) => {
                let _ = write_err(&mut stdout, 0, &format!("read: {e}"));
                return 4;
            }
        }
        let Ok(s) = std::str::from_utf8(&buf) else {
            // A request whose bytes aren't valid UTF-8 must surface as a
            // visible err frame, otherwise the client blocks forever on
            // the response that never arrives.
            let _ = write_err(&mut stdout, 0, "request is not valid UTF-8");
            continue;
        };
        let line = s.trim_end_matches(['\n', '\r']);
        if line.trim().is_empty() {
            continue;
        }
        let req: LoopRequest = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                let _ = write_err(&mut stdout, 0, &format!("json: {e}"));
                continue;
            }
        };
        let id = req.id;
        match handle(&req, &mut state) {
            Ok(bytes) => {
                let _ = write_ok(&mut stdout, id, &bytes);
            }
            Err(msg) => {
                let _ = write_err(&mut stdout, id, &msg);
            }
        }
    }
}

fn handle(req: &LoopRequest, state: &mut LoopState) -> Result<Vec<u8>, String> {
    // Reset the per-process warn-once scope so each request gets a fresh
    // dedup baseline. Without this, a long-lived `--stdin-loop` process
    // would silently swallow the second occurrence of any warning that
    // had already fired earlier in its lifetime (#267 F15 / #311).
    tts::warn::reset();

    if req.text.is_empty() {
        return Err("text is empty".into());
    }
    let chars = req.text.chars().count();
    if chars > tts::MAX_TEXT_CHARS {
        return Err(format!(
            "text exceeds {} chars ({chars})",
            tts::MAX_TEXT_CHARS
        ));
    }

    let format = crate::cli::say::resolve_output_format(
        req.format.as_deref(),
        req.bitrate,
        req.sample_rate,
        None,
    )?;
    let resolved =
        tts::voices::resolve_voice(&models::cache_dir(), &req.voice).map_err(|e| e.to_string())?;
    let espeak_lang: &str = req
        .lang
        .as_deref()
        .unwrap_or_else(|| resolved.espeak_lang());

    match resolved {
        tts::voices::ResolvedVoice::Kokoro {
            model_path,
            voice_path,
            ..
        } => handle_kokoro(req, state, &model_path, &voice_path, espeak_lang, format),
        #[cfg(all(
            feature = "system_kokoro",
            target_os = "macos",
            target_arch = "aarch64"
        ))]
        tts::voices::ResolvedVoice::FluidKokoro { voice_id, .. } => {
            // SSML is handled inside `tts::say` for FluidAudio Kokoro post-#481
            // (prosody rate → model-native speed, break silence stitching). No
            // in-process session to cache: each `say` re-inits the bridge.
            tts::say(tts::SayOptions {
                text: &req.text,
                lang: espeak_lang,
                engine: tts::EngineChoice::FluidKokoro {
                    voice_id: &voice_id,
                    speed: req.rate,
                },
                ssml: req.ssml,
                format,
                expand_abbrev: req.expand_abbrev,
            })
            .map_err(|e| e.to_string())
        }
        tts::voices::ResolvedVoice::Vosk {
            model_dir,
            speaker_id,
        } => handle_vosk(req, state, &model_dir, speaker_id, format),
        #[cfg(all(feature = "system_tts", target_os = "macos"))]
        tts::voices::ResolvedVoice::AVSpeech { voice_id } => {
            // AVSpeech is a Swift sidecar — no in-process state to cache.
            if req.ssml {
                return Err("SSML is not yet supported with macos-* voices (#141)".into());
            }
            tts::say(tts::SayOptions {
                text: &req.text,
                lang: espeak_lang,
                engine: tts::EngineChoice::AVSpeech {
                    voice_id: &voice_id,
                    speed: req.rate,
                },
                ssml: false,
                format,
                expand_abbrev: req.expand_abbrev,
            })
            .map_err(|e| e.to_string())
        }
    }
}

/// Empty-segment check centralised here so every engine arm gets the same error.
fn parse_ssml_or_err(text: &str) -> Result<Vec<tts::ssml::Segment>, String> {
    let segments = tts::ssml::parse(text).map_err(|e| format!("ssml: {e}"))?;
    if segments.is_empty() {
        return Err("SSML had no speakable content".into());
    }
    Ok(segments)
}

/// Kokoro arm of [`handle`]: session reuse across ssml / English-segment / G2P-IPA paths.
fn handle_kokoro(
    req: &LoopRequest,
    state: &mut LoopState,
    model_path: &Path,
    voice_path: &Path,
    espeak_lang: &str,
    format: tts::encode::OutputFormat,
) -> Result<Vec<u8>, String> {
    let sess = match state.kokoro.as_mut() {
        Some(s) => {
            s.ensure_model(model_path)
                .map_err(|e| format!("kokoro reload: {e}"))?;
            s
        }
        None => state.kokoro.insert(
            tts::sessions::KokoroSession::load(model_path)
                .map_err(|e| format!("kokoro load: {e}"))?,
        ),
    };

    if req.ssml {
        let segments = parse_ssml_or_err(&req.text)?;
        // Apply English acronym normalization (Spell→letter names,
        // Text→expand when expand_abbrev) for en-* voices. Mirrors
        // the one-shot path in tts::synth_segments_kokoro (#244).
        let segments = if tts::en::is_en(espeak_lang) {
            tts::en::normalize_segments(segments, req.expand_abbrev)
        } else {
            segments
        };
        tts::synth_segments_kokoro_with(sess, &segments, espeak_lang, voice_path, req.rate, format)
            .map_err(|e| e.to_string())
    } else if tts::en::is_en(espeak_lang) {
        // Route through segment pipeline so IPA_LEXICON overrides bypass G2P (#244).
        let segments = tts::en::normalize_segments(
            vec![tts::ssml::Segment::Text(req.text.clone())],
            req.expand_abbrev,
        );
        tts::synth_segments_kokoro_with(sess, &segments, espeak_lang, voice_path, req.rate, format)
            .map_err(|e| e.to_string())
    } else {
        // es/fr/it/pt use the cached CharsiuG2P session to avoid reloading ~100 MB per request.
        let ipa = if matches!(
            crate::tts::charsiu::base_lang(espeak_lang),
            "es" | "fr" | "it" | "pt"
        ) {
            state
                .charsiu
                .to_ipa(
                    &models::cache_dir().join("models/g2p/byt5-tiny"),
                    &req.text,
                    espeak_lang,
                )
                .map_err(|e| format!("g2p: {e}"))?
        } else {
            tts::g2p::text_to_ipa(&req.text, espeak_lang).map_err(|e| format!("g2p: {e}"))?
        };
        if ipa.trim().is_empty() {
            return Err("no phonemes produced for input (empty after G2P)".into());
        }
        let audio = sess
            .infer_ipa(&ipa, voice_path, req.rate)
            .map_err(|e| format!("infer: {e}"))?;
        if audio.is_empty() {
            return Err("no recognizable phonemes in input".into());
        }
        tts::encode::encode(&audio, tts::kokoro::SAMPLE_RATE, format)
            .map_err(|e| format!("encode: {e}"))
    }
}

/// Vosk arm of [`handle`]: cached-session synth.
fn handle_vosk(
    req: &LoopRequest,
    state: &mut LoopState,
    model_dir: &Path,
    speaker_id: u32,
    format: tts::encode::OutputFormat,
) -> Result<Vec<u8>, String> {
    if req.ssml {
        let segments = parse_ssml_or_err(&req.text)?;
        let segments = tts::ru::normalize_segments(segments, req.expand_abbrev);
        tts::synth_segments_vosk_with(
            &mut state.vosk,
            &segments,
            model_dir,
            speaker_id,
            req.rate,
            format,
        )
        .map_err(|e| e.to_string())
    } else {
        let text: std::borrow::Cow<'_, str> = if req.expand_abbrev {
            std::borrow::Cow::Owned(tts::ru::expand_text(&req.text))
        } else {
            std::borrow::Cow::Borrowed(&req.text)
        };
        let (audio, sample_rate) = state
            .vosk
            .infer(model_dir, &text, speaker_id, req.rate)
            .map_err(|e| format!("vosk: {e}"))?;
        tts::encode::encode(&audio, sample_rate, format).map_err(|e| format!("encode: {e}"))
    }
}

fn write_ok<W: Write>(w: &mut W, id: u32, payload: &[u8]) -> std::io::Result<()> {
    write_ok_capped(w, id, payload, MAX_PAYLOAD_BYTES)
}

fn write_err<W: Write>(w: &mut W, id: u32, msg: &str) -> std::io::Result<()> {
    write_err_capped(w, id, msg.as_bytes(), MAX_PAYLOAD_BYTES)
}

/// `write_ok` with an injectable cap so unit tests can exercise the
/// oversize-downgrade path without allocating 256 MB.
fn write_ok_capped<W: Write>(
    w: &mut W,
    id: u32,
    payload: &[u8],
    max: usize,
) -> std::io::Result<()> {
    if payload.len() > max {
        // Engine bug: silent truncation under STATUS_OK would let the client
        // accept a corrupt audio blob as complete. Surface it as a visible err
        // frame instead so a misbehaving engine can't masquerade as healthy.
        let msg = format!(
            "engine produced {} bytes (max {max}); response would be truncated",
            payload.len()
        );
        return write_err_capped(w, id, msg.as_bytes(), max);
    }
    write_frame(w, STATUS_OK, id, payload)
}

/// Errors are usually under a KB; on the unlikely path where one exceeds the
/// cap, truncate the *message* rather than fail to surface the error at all.
fn write_err_capped<W: Write>(w: &mut W, id: u32, msg: &[u8], max: usize) -> std::io::Result<()> {
    let trimmed = if msg.len() > max { &msg[..max] } else { msg };
    write_frame(w, STATUS_ERR, id, trimmed)
}

/// Inner writer; assumes `payload.len() <= u32::MAX as usize` (caller-enforced
/// via the `_capped` helpers above).
fn write_frame<W: Write>(w: &mut W, status: u8, id: u32, payload: &[u8]) -> std::io::Result<()> {
    w.write_all(&[status])?;
    w.write_all(&id.to_le_bytes())?;
    w.write_all(&(payload.len() as u32).to_le_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

#[derive(Debug, PartialEq, Eq)]
enum LineRead {
    Line,
    Eof,
    TooLong,
}

/// Drain bytes until `\n` or EOF. Called after the buffer hits `max` to keep
/// the reader aligned to the next request boundary.
fn drain_line<R: BufRead>(r: &mut R) -> std::io::Result<()> {
    let mut byte = [0u8; 1];
    loop {
        if r.read(&mut byte)? == 0 || byte[0] == b'\n' {
            return Ok(());
        }
    }
}

/// Read until a `\n` or `max` bytes, whichever comes first. On overflow,
/// drains the rest of the over-long line so the next read stays aligned to
/// a request boundary. Byte-by-byte rather than `read_until` to cap allocation
/// (a client that never sends `\n` would cause a multi-GB Vec with the stdlib call).
fn read_line_bounded<R: BufRead>(
    r: &mut R,
    buf: &mut Vec<u8>,
    max: usize,
) -> std::io::Result<LineRead> {
    let mut byte = [0u8; 1];
    loop {
        if buf.len() >= max {
            drain_line(r)?;
            return Ok(LineRead::TooLong);
        }
        if r.read(&mut byte)? == 0 {
            return Ok(if buf.is_empty() {
                LineRead::Eof
            } else {
                LineRead::Line
            });
        }
        buf.push(byte[0]);
        if byte[0] == b'\n' {
            return Ok(LineRead::Line);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frame_layout_ok() {
        let mut out: Vec<u8> = Vec::new();
        write_ok(&mut out, 0xCAFEBABE, b"hello").unwrap();
        assert_eq!(out.len(), 14);
        assert_eq!(out[0], STATUS_OK);
        assert_eq!(
            u32::from_le_bytes([out[1], out[2], out[3], out[4]]),
            0xCAFEBABE
        );
        assert_eq!(u32::from_le_bytes([out[5], out[6], out[7], out[8]]), 5);
        assert_eq!(&out[9..], b"hello");
    }

    #[test]
    fn frame_layout_err() {
        let mut out: Vec<u8> = Vec::new();
        write_err(&mut out, 7, "boom").unwrap();
        assert_eq!(out[0], STATUS_ERR);
        assert_eq!(u32::from_le_bytes([out[1], out[2], out[3], out[4]]), 7);
        assert_eq!(u32::from_le_bytes([out[5], out[6], out[7], out[8]]), 4);
        assert_eq!(&out[9..], b"boom");
    }

    #[test]
    fn write_ok_oversize_downgrades_to_err_frame() {
        // Engine bug guard: payloads above the cap MUST NOT emit STATUS_OK
        // with truncated bytes, because a client would happily decode the
        // truncated blob as a complete response. Test the boundary with a
        // tiny synthetic cap to avoid 256 MB allocations on CI.
        let mut out: Vec<u8> = Vec::new();
        let oversize = b"abcdefghij"; // 10 bytes
        write_ok_capped(&mut out, 42, oversize, 4).unwrap();
        assert_eq!(out[0], STATUS_ERR, "oversize OK must downgrade to ERR");
        assert_eq!(u32::from_le_bytes([out[1], out[2], out[3], out[4]]), 42);
        // Err message itself was clipped to the same cap (4 bytes), so the
        // frame's len header equals the cap, not the original message length.
        assert_eq!(u32::from_le_bytes([out[5], out[6], out[7], out[8]]), 4);
        assert_eq!(out.len(), 9 + 4);
    }

    #[test]
    fn write_err_truncates_oversize_message() {
        // An err whose message exceeds the cap is clipped (vs. dropped) so
        // the client still sees *something* surfaced. The frame stays valid.
        let mut out: Vec<u8> = Vec::new();
        let huge = vec![b'X'; 100];
        write_err_capped(&mut out, 1, &huge, 8).unwrap();
        assert_eq!(out[0], STATUS_ERR);
        assert_eq!(u32::from_le_bytes([out[5], out[6], out[7], out[8]]), 8);
        assert_eq!(&out[9..], b"XXXXXXXX");
    }

    #[test]
    fn read_line_bounded_returns_line() {
        let mut r = Cursor::new(b"hello\nworld\n".to_vec());
        let mut buf = Vec::new();
        let mut br = BufReader::new(&mut r);
        assert_eq!(
            read_line_bounded(&mut br, &mut buf, 1024).unwrap(),
            LineRead::Line
        );
        assert_eq!(buf, b"hello\n");
        buf.clear();
        assert_eq!(
            read_line_bounded(&mut br, &mut buf, 1024).unwrap(),
            LineRead::Line
        );
        assert_eq!(buf, b"world\n");
    }

    #[test]
    fn read_line_bounded_returns_eof_on_empty() {
        let mut r = Cursor::new(Vec::<u8>::new());
        let mut buf = Vec::new();
        let mut br = BufReader::new(&mut r);
        assert_eq!(
            read_line_bounded(&mut br, &mut buf, 1024).unwrap(),
            LineRead::Eof
        );
    }

    #[test]
    fn read_line_bounded_returns_line_on_unterminated() {
        // Trailing data without a final \n still yields a Line so the caller
        // can process it before noticing EOF on the next call.
        let mut r = Cursor::new(b"hello".to_vec());
        let mut buf = Vec::new();
        let mut br = BufReader::new(&mut r);
        assert_eq!(
            read_line_bounded(&mut br, &mut buf, 1024).unwrap(),
            LineRead::Line
        );
        assert_eq!(buf, b"hello");
    }

    #[test]
    fn read_line_bounded_too_long_drains_to_next_line() {
        // Over-long line followed by a normal line. The first call returns
        // TooLong; the second call must land on the next line cleanly.
        let mut data = vec![b'A'; 100];
        data.push(b'\n');
        data.extend_from_slice(b"ok\n");
        let mut r = Cursor::new(data);
        let mut buf = Vec::new();
        let mut br = BufReader::new(&mut r);
        assert_eq!(
            read_line_bounded(&mut br, &mut buf, 50).unwrap(),
            LineRead::TooLong
        );
        buf.clear();
        assert_eq!(
            read_line_bounded(&mut br, &mut buf, 50).unwrap(),
            LineRead::Line
        );
        assert_eq!(buf, b"ok\n");
    }

    #[test]
    fn loop_request_expand_abbrev_defaults_to_true() {
        // When a client omits `expand_abbrev`, legacy behavior (expansion on)
        // must be preserved — the field must deserialize to `true`.
        let json = r#"{"text":"ФСБ","voice":"ru-vosk-m02"}"#;
        let req: LoopRequest = serde_json::from_str(json).unwrap();
        assert!(req.expand_abbrev, "expand_abbrev must default to true");
    }

    #[test]
    fn loop_request_expand_abbrev_false_honored() {
        let json = r#"{"text":"ФСБ","voice":"ru-vosk-m02","expand_abbrev":false}"#;
        let req: LoopRequest = serde_json::from_str(json).unwrap();
        assert!(!req.expand_abbrev, "expand_abbrev:false must be honored");
    }

    #[test]
    fn handle_resets_warning_scope_per_request_before_validation() {
        let key = "test-say-loop-handle-reset";
        tts::warn::reset();
        tts::warn::warn_once(key, "seed warning scope");
        assert!(
            tts::warn::was_warned(key),
            "test setup should record the warning key"
        );

        let req = LoopRequest {
            id: 1,
            text: String::new(),
            voice: "en-am_michael".into(),
            format: None,
            bitrate: None,
            sample_rate: None,
            lang: None,
            rate: 1.0,
            ssml: false,
            expand_abbrev: true,
        };
        let mut state = LoopState {
            kokoro: None,
            vosk: tts::sessions::VoskCache::new(),
            charsiu: tts::sessions::CharsiuCache::new(),
        };

        let err = handle(&req, &mut state).unwrap_err();
        assert_eq!(err, "text is empty");
        assert!(
            !tts::warn::was_warned(key),
            "handle() must reset warn-once scope at the start of each request"
        );
    }

    #[test]
    fn read_line_bounded_too_long_at_eof() {
        // Over-long line with no trailing newline before EOF: we still
        // return TooLong, and the next call sees EOF.
        let data = vec![b'A'; 100];
        let mut r = Cursor::new(data);
        let mut buf = Vec::new();
        let mut br = BufReader::new(&mut r);
        assert_eq!(
            read_line_bounded(&mut br, &mut buf, 50).unwrap(),
            LineRead::TooLong
        );
        buf.clear();
        assert_eq!(
            read_line_bounded(&mut br, &mut buf, 50).unwrap(),
            LineRead::Eof
        );
    }

    #[test]
    fn drain_line_stops_at_newline() {
        // Bytes after the \n must remain readable after drain.
        let mut br = BufReader::new(Cursor::new(b"junk\nnext".to_vec()));
        drain_line(&mut br).unwrap();
        let mut rest = Vec::new();
        br.read_until(b'\n', &mut rest).unwrap();
        assert_eq!(rest, b"next");
    }

    #[test]
    fn drain_line_stops_at_eof() {
        // No newline — drain must return Ok(()) without looping forever.
        let mut br = BufReader::new(Cursor::new(b"junk".to_vec()));
        drain_line(&mut br).unwrap();
        let mut rest = Vec::new();
        br.read_until(b'\n', &mut rest).unwrap();
        assert!(rest.is_empty());
    }
}
