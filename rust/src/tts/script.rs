//! Which scripts a voice's G2P can pronounce, decided from the text rather than from the voice's language: a dominant unsupported script refuses before inference, a minority run synthesizes with one warning (#492).
use unicode_normalization::UnicodeNormalization;

use crate::coded_bail;
use crate::errors::ErrorCode;
use crate::tts::token::{for_each_token, split_punct, TokenEvent};

/// Writing systems the classifier can tell apart. `Unknown` is any letter
/// outside them — never supported, so an Armenian or Ethiopic run refuses
/// rather than reaching a G2P that would drop it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Script {
    Latin,
    Cyrillic,
    Greek,
    Hebrew,
    Arabic,
    Devanagari,
    Thai,
    Han,
    Kana,
    Hangul,
    Unknown,
}

impl Script {
    /// Reads as a noun phrase in "the text is mostly {} script".
    pub fn name(self) -> &'static str {
        match self {
            Script::Latin => "Latin",
            Script::Cyrillic => "Cyrillic",
            Script::Greek => "Greek",
            Script::Hebrew => "Hebrew",
            Script::Arabic => "Arabic",
            Script::Devanagari => "Devanagari",
            Script::Thai => "Thai",
            Script::Han => "Han (Chinese characters)",
            Script::Kana => "Japanese kana",
            Script::Hangul => "Hangul",
            Script::Unknown => "an unrecognized",
        }
    }

    /// Kokoro/Vosk voices this build ships that phonemize the script.
    fn builtin_voices(self) -> &'static [&'static str] {
        match self {
            Script::Latin => &["en-am_michael"],
            Script::Cyrillic => &["ru-vosk-m02"],
            Script::Han => &["zh-zm_050"],
            _ => &[],
        }
    }
}

#[cfg(all(feature = "system_tts", target_os = "macos"))]
impl Script {
    /// BCP-47 language subtags whose AVSpeech voices write in this script.
    fn locales(self) -> &'static [&'static str] {
        match self {
            Script::Latin => &["en"],
            Script::Cyrillic => &["ru"],
            Script::Greek => &["el"],
            Script::Hebrew => &["he"],
            Script::Arabic => &["ar"],
            Script::Devanagari => &["hi"],
            Script::Thai => &["th"],
            // Han carries both languages and the text alone cannot say which.
            Script::Han => &["zh", "ja"],
            Script::Kana => &["ja"],
            Script::Hangul => &["ko"],
            Script::Unknown => &[],
        }
    }
}

const LATIN_ONLY: &[Script] = &[Script::Latin];
const CYRILLIC_ONLY: &[Script] = &[Script::Cyrillic];
const HAN_AND_LATIN: &[Script] = &[Script::Han, Script::Latin];

/// The scripts `voice_id`'s G2P handles, or `None` for a voice this gate does
/// not model (`macos-*` hands the text to AVSpeech, which speaks many scripts).
pub fn supported_scripts(voice_id: &str) -> Option<&'static [Script]> {
    let prefix = voice_id.split('-').next()?;
    match prefix {
        // The hi/ja packs ship Latin-only G2P, which is why romanized input works and native script does not (#492).
        "en" | "es" | "fr" | "it" | "pt" | "hi" | "ja" => Some(LATIN_ONLY),
        "ru" => Some(CYRILLIC_ONLY),
        "zh" => Some(HAN_AND_LATIN),
        _ => None,
    }
}

fn script_of(c: char) -> Option<Script> {
    if !c.is_alphabetic() {
        return None;
    }
    Some(match c {
        'a'..='z' | 'A'..='Z' => Script::Latin,
        '\u{00C0}'..='\u{024F}' | '\u{1E00}'..='\u{1EFF}' => Script::Latin,
        '\u{0370}'..='\u{03FF}' | '\u{1F00}'..='\u{1FFF}' => Script::Greek,
        '\u{0400}'..='\u{052F}' => Script::Cyrillic,
        '\u{0590}'..='\u{05FF}' | '\u{FB1D}'..='\u{FB4F}' => Script::Hebrew,
        '\u{0600}'..='\u{06FF}'
        | '\u{0750}'..='\u{077F}'
        | '\u{FB50}'..='\u{FDFF}'
        | '\u{FE70}'..='\u{FEFF}' => Script::Arabic,
        '\u{0900}'..='\u{097F}' | '\u{A8E0}'..='\u{A8FF}' => Script::Devanagari,
        '\u{0E00}'..='\u{0E7F}' => Script::Thai,
        '\u{3040}'..='\u{30FF}' | '\u{31F0}'..='\u{31FF}' => Script::Kana,
        '\u{1100}'..='\u{11FF}' | '\u{3130}'..='\u{318F}' | '\u{AC00}'..='\u{D7AF}' => {
            Script::Hangul
        }
        '\u{3005}'
        | '\u{3400}'..='\u{4DBF}'
        | '\u{4E00}'..='\u{9FFF}'
        | '\u{F900}'..='\u{FAFF}'
        | '\u{20000}'..='\u{2A6DF}'
        | '\u{2A700}'..='\u{2CEAF}'
        | '\u{2CEB0}'..='\u{2EBEF}' => Script::Han,
        _ => Script::Unknown,
    })
}

/// What the gate decided about one (text, voice) pair.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    Supported,
    /// More than half the letters are in a script the voice cannot phonemize.
    Dominant(Script),
    /// A minority run the voice cannot phonemize: speakable, but mispronounced.
    Minority {
        script: Script,
        tokens: Vec<String>,
    },
}

/// How many offending tokens the warning names before it trails off.
const MAX_NAMED_TOKENS: usize = 5;

/// Bucket `text`'s letters by script and weigh them against `supported`.
///
/// NFKC runs first so fullwidth Latin (`Ｒｏｏｍ`) is counted as the Latin it
/// compatibility-decomposes to rather than as an unknown script.
pub fn classify(text: &str, supported: &[Script]) -> Verdict {
    let normalized: String = text.nfkc().collect();
    let mut counts: Vec<(Script, usize)> = Vec::new();
    for c in normalized.chars() {
        let Some(s) = script_of(c) else { continue };
        match counts.iter_mut().find(|(k, _)| *k == s) {
            Some((_, n)) => *n += 1,
            None => counts.push((s, 1)),
        }
    }
    let total: usize = counts.iter().map(|(_, n)| n).sum();
    if total == 0 {
        return Verdict::Supported;
    }
    let (top, top_count) = counts
        .iter()
        .copied()
        .max_by_key(|(_, n)| *n)
        .expect("non-zero total implies at least one bucket");
    if !supported.contains(&top) && top_count * 2 > total {
        return Verdict::Dominant(top);
    }
    let Some((worst, _)) = counts
        .iter()
        .copied()
        .filter(|(s, _)| !supported.contains(s))
        .max_by_key(|(_, n)| *n)
    else {
        return Verdict::Supported;
    };
    let mut tokens = Vec::new();
    for_each_token(&normalized, |ev| {
        if let TokenEvent::Token(t) = ev {
            let core = split_punct(t).1;
            if !core.is_empty() && core.chars().any(|c| script_of(c) == Some(worst)) {
                tokens.push(core.to_string());
            }
        }
    });
    Verdict::Minority {
        script: worst,
        tokens,
    }
}

fn named(tokens: &[String]) -> String {
    let head = tokens
        .iter()
        .take(MAX_NAMED_TOKENS)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    if tokens.len() > MAX_NAMED_TOKENS {
        format!("{head}, …")
    } else {
        head
    }
}

fn supported_names(supported: &[Script]) -> String {
    supported
        .iter()
        .map(|s| s.name())
        .collect::<Vec<_>>()
        .join(" and ")
}

/// Voices on this machine that can speak `script`, most specific first.
fn alternatives(script: Script) -> Vec<String> {
    let mut out: Vec<String> = script
        .builtin_voices()
        .iter()
        .map(|v| v.to_string())
        .collect();
    out.extend(system_voices(script));
    out
}

#[cfg(all(feature = "system_tts", target_os = "macos"))]
fn system_voices(script: Script) -> Vec<String> {
    let installed = crate::tts::avspeech::list_voices(None);
    script
        .locales()
        .iter()
        .flat_map(|lang| {
            let needle = format!(".{lang}-");
            installed
                .iter()
                .filter(move |id| id.contains(&needle))
                .cloned()
        })
        .take(MAX_NAMED_TOKENS)
        .collect()
}

#[cfg(not(all(feature = "system_tts", target_os = "macos")))]
fn system_voices(_script: Script) -> Vec<String> {
    Vec::new()
}

pub(crate) const WARN_SCRIPT_MINORITY: &str = "script-minority";

/// Refuse text the voice cannot phonemize, or warn about the part of it that
/// it cannot. A voice with no declared script set is passed through untouched.
pub fn ensure_supported(voice_id: &str, text: &str) -> anyhow::Result<()> {
    let Some(supported) = supported_scripts(voice_id) else {
        return Ok(());
    };
    match classify(text, supported) {
        Verdict::Supported => Ok(()),
        Verdict::Minority { script, tokens } => {
            crate::tts::warn::warn_once(
                WARN_SCRIPT_MINORITY,
                &format!(
                    "{} token{} in {} script cannot be pronounced by {voice_id}: {}",
                    tokens.len(),
                    if tokens.len() == 1 { "" } else { "s" },
                    script.name(),
                    named(&tokens)
                ),
            );
            Ok(())
        }
        Verdict::Dominant(script) => {
            let alts = alternatives(script);
            let hint = if alts.is_empty() {
                "Romanize the text (transliterate to Latin), or install a voice that speaks it \
                 (kesha say --list-voices)."
                    .to_string()
            } else {
                format!(
                    "Romanize the text (transliterate to Latin), or pick a voice that speaks it: \
                     {}.",
                    alts.join(", ")
                )
            };
            coded_bail!(
                ErrorCode::ScriptUnsupported,
                "the text is mostly {} script, which voice '{voice_id}' cannot phonemize \
                 (it handles {}). {hint} \
                 See https://github.com/drakulavich/kesha-voice-kit/issues/492",
                script.name(),
                supported_names(supported)
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verdict(text: &str, voice: &str) -> Verdict {
        classify(text, supported_scripts(voice).expect("gated voice"))
    }

    #[test]
    fn a_voice_the_gate_does_not_model_is_passed_through() {
        assert!(supported_scripts("macos-com.apple.voice.compact.ja-JP.Kyoko").is_none());
        ensure_supported("macos-com.apple.voice.compact.ja-JP.Kyoko", "こんにちは").expect("ok");
    }

    #[test]
    fn latin_voices_refuse_every_dominant_non_latin_script() {
        for (text, script) in [
            ("नमस्ते", Script::Devanagari),
            ("مرحبا", Script::Arabic),
            ("שלום", Script::Hebrew),
            ("สวัสดี", Script::Thai),
            ("Γειά σου", Script::Greek),
            ("Привет мир", Script::Cyrillic),
            ("你好世界", Script::Han),
            ("こんにちは", Script::Kana),
            ("안녕하세요", Script::Hangul),
            ("Բարեւ", Script::Unknown),
        ] {
            assert_eq!(
                verdict(text, "en-am_michael"),
                Verdict::Dominant(script),
                "text {text:?}"
            );
        }
    }

    #[test]
    fn latin_voices_accept_latin_text_including_accents_and_digits() {
        for text in [
            "Hello world",
            "¡Hola! Soy Kesha.",
            "Ciao, città però.",
            "Olá, coração.",
            "Room 405",
            "3rd place, 10:05 PM — $1,234.56!",
            "Namaste! Mera naam Kesha hai.",
        ] {
            assert_eq!(
                verdict(text, "en-am_michael"),
                Verdict::Supported,
                "{text:?}"
            );
        }
    }

    #[test]
    fn fullwidth_latin_counts_as_latin_after_nfkc() {
        assert_eq!(
            verdict("Ｒｏｏｍ ４０５", "en-am_michael"),
            Verdict::Supported
        );
    }

    #[test]
    fn punctuation_and_digits_alone_are_never_a_script() {
        assert_eq!(verdict("405 — 10:05!", "en-am_michael"), Verdict::Supported);
        assert_eq!(verdict("405 — 10:05!", "ru-vosk-m02"), Verdict::Supported);
    }

    #[test]
    fn a_minority_run_warns_and_names_its_tokens() {
        assert_eq!(
            verdict("Установи Kesha Voice Kit сегодня", "ru-vosk-m02"),
            Verdict::Minority {
                script: Script::Latin,
                tokens: vec!["Kesha".into(), "Voice".into(), "Kit".into()],
            }
        );
        assert_eq!(
            verdict("Meet me in 你好 town", "en-am_michael"),
            Verdict::Minority {
                script: Script::Han,
                tokens: vec!["你好".into()],
            }
        );
    }

    #[test]
    fn a_minority_run_synthesizes_while_a_dominant_one_refuses() {
        ensure_supported("ru-vosk-m02", "Установи Kesha Voice Kit сегодня").expect("speaks");
        let err = ensure_supported("ru-vosk-m02", "Install Kesha Voice Kit today")
            .expect_err("dominant Latin on a Cyrillic voice is refused");
        assert_eq!(crate::errors::code_of(&err), ErrorCode::ScriptUnsupported);
    }

    #[test]
    fn the_refusal_names_the_script_the_voice_and_a_voice_that_can_speak_it() {
        let err = ensure_supported("en-am_michael", "Привет мир").expect_err("refused");
        let rendered = format!("{err}");
        assert!(rendered.contains("Cyrillic"), "{rendered}");
        assert!(rendered.contains("en-am_michael"), "{rendered}");
        assert!(rendered.contains("ru-vosk-m02"), "{rendered}");
    }

    #[test]
    fn zh_voices_take_han_and_latin_but_not_kana() {
        assert_eq!(verdict("你好我叫凯沙", "zh-zm_050"), Verdict::Supported);
        assert_eq!(
            verdict("Ni hao! Wo jiao Kesha.", "zh-zm_050"),
            Verdict::Supported
        );
        assert_eq!(verdict("\u{20000}", "zh-zm_050"), Verdict::Supported);
        assert_eq!(
            verdict("こんにちは", "zh-zm_050"),
            Verdict::Dominant(Script::Kana)
        );
    }

    #[test]
    fn hi_and_ja_voices_keep_refusing_their_own_native_script() {
        assert_eq!(
            verdict("नमस्ते मेरा नाम केशा है", "hi-hm_omega"),
            Verdict::Dominant(Script::Devanagari)
        );
        assert_eq!(
            verdict("こんにちは、ケシャです", "ja-jm_kumo"),
            Verdict::Dominant(Script::Kana)
        );
        assert_eq!(
            verdict("日本語", "ja-jm_kumo"),
            Verdict::Dominant(Script::Han)
        );
    }

    #[test]
    fn the_warning_names_at_most_five_tokens() {
        let long = (0..8)
            .map(|i| format!("word{i}"))
            .collect::<Vec<_>>()
            .join(" ");
        let cyrillic = "Установи и запусти пожалуйста сегодня утром прямо сейчас без промедления";
        let Verdict::Minority { tokens, .. } =
            verdict(&format!("{cyrillic} {long}"), "ru-vosk-m02")
        else {
            panic!("expected a minority verdict");
        };
        assert_eq!(tokens.len(), 8);
        assert!(named(&tokens).ends_with(", …"), "{}", named(&tokens));
        assert_eq!(named(&tokens).matches(", ").count(), 5);
    }
}
