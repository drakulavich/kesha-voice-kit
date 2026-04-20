//! Library surface for integration tests. Modules are also compiled into the
//! `kesha-engine` binary — cargo handles the dual targets.

pub mod debug;

#[cfg(feature = "tts")]
pub mod tts;
