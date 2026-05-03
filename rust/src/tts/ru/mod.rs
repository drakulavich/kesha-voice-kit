//! Russian-specific text normalization for the Vosk-TTS path.
//!
//! Two responsibilities — both pure text-in / text-out:
//! - `letter_table::expand_chars` — letter-by-letter spelling
//!   for `<say-as interpret-as="characters">`.
//! - `acronym::expand_acronyms` — auto-detect all-uppercase
//!   Cyrillic acronyms in plain text (added in T4).
//!
//! `normalize_segments` (added in T5) routes [`crate::tts::ssml::Segment`]
//! values through the appropriate primitive.

pub mod letter_table;
