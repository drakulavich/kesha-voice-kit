//! Vendored runtime subset of `vosk-tts-rs` (Apache 2.0).
//!
//! Public surface is intentionally minimal — only what
//! `kesha-engine`'s `tts::vosk` wrapper consumes:
//!
//! * [`Model::new`] (explicit-path constructor only)
//! * [`Synth::new`] + [`Synth::synth_audio`]
//! * [`model::ModelConfig::audio.sample_rate`] (via `model.config.audio.sample_rate`)
//!
//! See `NOTICE` for the list of upstream features deliberately dropped
//! (gRPC server/CLI, HTTP model fetch, the `tokenizers` crate).

pub mod error;
pub mod g2p;
pub mod model;
pub mod synth;
pub mod tokenizer;

pub use error::{Error, Result};
pub use model::Model;
pub use synth::Synth;
