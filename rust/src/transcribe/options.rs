//! Type-state builder for [`TranscribeOptions`] (F18).
//!
//! The runtime guard in [`super::transcribe_with_options`] (`anyhow::ensure!`)
//! catches `with_speakers && !with_segments` at the API boundary. The
//! builder lifts that constraint into the type system: `with_speakers()`
//! is only callable in the `WithSegments` state, so the misuse becomes
//! a compile error at every call site that goes through the builder.
//!
//! The runtime guard stays in place as defence-in-depth — direct struct
//! construction (the public fields are still public) bypasses the
//! builder. Closes the type-state half of the #290 follow-up; the
//! `anyhow::ensure!` half remains.

use std::marker::PhantomData;

use super::{TranscribeOptions, VadMode};

pub(crate) mod marker {
    pub struct NoSegments;
    pub struct WithSegments;
}

/// Type-state builder for [`TranscribeOptions`]. Start with
/// [`TranscribeOptionsBuilder::new`] and chain `vad`, `itn`, `with_segments`,
/// `with_speakers` in any order — `with_speakers` is only available
/// after the `with_segments` transition.
#[derive(Debug)]
pub struct TranscribeOptionsBuilder<S = marker::NoSegments> {
    options: TranscribeOptions,
    _state: PhantomData<S>,
}

impl Default for TranscribeOptionsBuilder<marker::NoSegments> {
    fn default() -> Self {
        Self::new()
    }
}

impl<S> TranscribeOptionsBuilder<S> {
    /// Available in either state, so call-site ordering doesn't matter (#318 Greptile P2).
    pub fn vad(mut self, mode: VadMode) -> Self {
        self.options.mode = mode;
        self
    }

    /// Rewrite spoken-form numbers to written form (#710).
    pub fn itn(mut self, enabled: bool) -> Self {
        self.options.itn = enabled;
        self
    }

    /// Finalise into a [`TranscribeOptions`]. Segments and speakers reflect
    /// the state transitions taken, never the order the setters were called in.
    pub fn build(self) -> TranscribeOptions {
        self.options
    }
}

impl TranscribeOptionsBuilder<marker::NoSegments> {
    /// Start a new builder. Defaults match [`TranscribeOptions::default`]:
    /// `VadMode::Auto`, no segments, no speakers.
    pub fn new() -> Self {
        Self {
            options: TranscribeOptions::default(),
            _state: PhantomData,
        }
    }

    /// Transition to the `WithSegments` state: per-utterance segments
    /// will be populated. Required before `with_speakers` becomes available.
    pub fn with_segments(self) -> TranscribeOptionsBuilder<marker::WithSegments> {
        TranscribeOptionsBuilder {
            options: TranscribeOptions {
                with_segments: true,
                ..self.options
            },
            _state: PhantomData,
        }
    }
}

impl TranscribeOptionsBuilder<marker::WithSegments> {
    /// Enable speaker diarization labels on each segment. Only callable
    /// in the `WithSegments` state — the type-state mirrors the runtime
    /// `anyhow::ensure!` guard in [`super::transcribe_with_options`].
    pub fn with_speakers(mut self) -> Self {
        self.options.with_speakers = true;
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_segments_path_produces_text_only_options() {
        let opts = TranscribeOptionsBuilder::new().vad(VadMode::Off).build();
        assert_eq!(opts.mode, VadMode::Off);
        assert!(!opts.with_segments);
        assert!(!opts.with_speakers);
    }

    #[test]
    fn with_segments_alone_keeps_speakers_off() {
        let opts = TranscribeOptionsBuilder::new()
            .vad(VadMode::On)
            .with_segments()
            .build();
        assert_eq!(opts.mode, VadMode::On);
        assert!(opts.with_segments);
        assert!(!opts.with_speakers);
    }

    #[test]
    fn with_speakers_after_with_segments_enables_both() {
        let opts = TranscribeOptionsBuilder::new()
            .with_segments()
            .with_speakers()
            .build();
        assert!(opts.with_segments);
        assert!(opts.with_speakers);
    }

    #[test]
    fn itn_defaults_off_and_survives_the_with_segments_transition() {
        assert!(!TranscribeOptionsBuilder::new().build().itn);
        assert!(TranscribeOptionsBuilder::new().itn(true).build().itn);
        assert!(
            TranscribeOptionsBuilder::new()
                .itn(true)
                .with_segments()
                .with_speakers()
                .build()
                .itn
        );
    }

    #[test]
    fn vad_after_with_segments_matches_vad_before() {
        let before = TranscribeOptionsBuilder::new()
            .vad(VadMode::On)
            .with_segments()
            .build();
        let after = TranscribeOptionsBuilder::new()
            .with_segments()
            .vad(VadMode::On)
            .build();
        assert_eq!(before.mode, after.mode);
        assert_eq!(before.with_segments, after.with_segments);
    }
}
