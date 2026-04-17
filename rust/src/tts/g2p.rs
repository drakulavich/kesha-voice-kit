//! Grapheme-to-phoneme via `espeakng-sys`, linked dynamically against system libespeak-ng.
//!
//! `espeak_TextToPhonemes` returns one sentence at a time — we loop advancing the pointer
//! until it returns null. `espeak` keeps process-global state, so init + each call are
//! serialized behind a `Mutex`.

use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_void};
use std::ptr;
use std::sync::{Mutex, OnceLock};

/// phonememode bits 0-3 select the phoneme character set; `0x02` = IPA (Unicode).
/// Bits 4-7 (output destination) are left at 0 so the result is returned from the call.
const PHONEME_MODE_IPA: i32 = 0x02;

static ESPEAK_INIT: OnceLock<Mutex<bool>> = OnceLock::new();

/// Convert text to IPA phonemes for the given espeak language code (e.g. `en-us`).
///
/// Returns a phoneme string concatenated across all sentences, space-separated.
/// Empty input returns an empty string. Unsupported language returns an error.
pub fn text_to_ipa(text: &str, lang: &str) -> anyhow::Result<String> {
    if text.is_empty() {
        return Ok(String::new());
    }

    // Lock across the whole call: espeak's voice state is global, and
    // a concurrent call in another thread could swap the voice mid-synth.
    let lock = ESPEAK_INIT.get_or_init(|| Mutex::new(false));
    let mut initialized = lock.lock().expect("espeak mutex poisoned");

    if !*initialized {
        unsafe {
            let sample_rate = espeakng_sys::espeak_Initialize(
                espeakng_sys::espeak_AUDIO_OUTPUT_AUDIO_OUTPUT_SYNCHRONOUS,
                0,
                ptr::null(),
                0,
            );
            anyhow::ensure!(
                sample_rate > 0,
                "espeak_Initialize failed (rc={sample_rate})"
            );
        }
        *initialized = true;
    }

    unsafe {
        let c_lang = CString::new(lang)?;
        let rc = espeakng_sys::espeak_SetVoiceByName(c_lang.as_ptr());
        anyhow::ensure!(
            rc == espeakng_sys::espeak_ERROR_EE_OK,
            "unsupported lang '{lang}' (espeak rc={rc})"
        );

        let c_text = CString::new(text)?;
        let mut text_ptr: *const c_void = c_text.as_ptr() as *const c_void;
        let text_ptr_ptr: *mut *const c_void = &mut text_ptr;

        let mut out = String::new();
        loop {
            let ipa_c = espeakng_sys::espeak_TextToPhonemes(
                text_ptr_ptr,
                espeakng_sys::espeakCHARS_UTF8 as i32,
                PHONEME_MODE_IPA,
            );
            if ipa_c.is_null() {
                break;
            }
            let fragment = CStr::from_ptr(ipa_c as *const c_char).to_string_lossy();
            if !fragment.is_empty() {
                if !out.is_empty() {
                    out.push(' ');
                }
                out.push_str(&fragment);
            }
            if text_ptr.is_null() {
                break;
            }
        }

        Ok(out.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_world_produces_ipa() {
        let ipa = text_to_ipa("Hello, world", "en-us").unwrap();
        assert!(!ipa.is_empty(), "ipa empty");
        // Multiple sentences should both be represented — "hello" + "world" => "h" and "w" at minimum.
        assert!(ipa.contains('h'), "ipa missing 'h' for hello: {ipa}");
        assert!(ipa.contains('w'), "ipa missing 'w' for world: {ipa}");
    }

    #[test]
    fn empty_text_ok() {
        let ipa = text_to_ipa("", "en-us").unwrap();
        assert!(ipa.is_empty());
    }

    #[test]
    fn unsupported_lang_errors() {
        let err = text_to_ipa("hi", "xx-XX").unwrap_err();
        let msg = err.to_string().to_lowercase();
        assert!(
            msg.contains("lang") || msg.contains("xx-xx"),
            "expected lang error, got: {err}"
        );
    }
}
