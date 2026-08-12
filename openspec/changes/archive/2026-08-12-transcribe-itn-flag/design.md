# Design

## D1 — ITN engine: `text-processing-rs` directly, not `fluidaudio-rs::itn_normalize`

#710 assumed the binding already exposed working ITN. It does not. `TextNormalizer.shared`
resolves `nemo_normalize` via `dlsym(dlopen(nil, RTLD_NOW), …)`; with no
`libnemo_text_processing` in the process the constructor sets `isNativeAvailable = false` and
`normalize` / `normalizeSentence` return their input. Nothing in `fluidaudio-rs`, FluidAudio
0.14.8, or kesha links that library, so `--itn` built on that call would be a guaranteed no-op
on every released binary — a flag that reports success and changes nothing, which is exactly
what the ERROR HANDLING rule forbids.

Three ways out were considered:

1. **Ship the ticket as written.** Rejected: done-when #1 ("turns spelled-out numbers into
   digits on the en benchmark fixtures") is unreachable, and the flag would lie.
2. **Link `text-processing-rs` with its `ffi` feature so FluidAudio's `dlsym` finds the
   symbols.** This preserves the ticket's CoreML-only shape and buys FluidAudio's NLTagger
   ambiguous-word filter. Rejected as a Rube Goldberg: Rust → Swift → `dlopen(nil)` → the same
   Rust crate, with the whole feature resting on `#[no_mangle]` symbols from a `staticlib`
   surviving into the executable's dynamic export table. It also confines to macOS a pass that
   has no macOS-specific part.
3. **Call the crate from Rust.** Chosen. `text_processing_rs::normalize_sentence` is a plain
   function. No native library, no download, no Swift, unit-testable on every CI runner.

The consequence worth stating plainly: **ITN is not Backend-dependent.** #710 asked for ONNX
builds to reject `--itn`; under D1 there is nothing for them to reject, because the pass works
identically there. The flag still needs its Capabilities JSON gate (D3) — just against Engine
*version*, not Backend.

## D2 — The pass applies per Segment, and the transcript is rebuilt from the Segments

ITN changes token counts, so the question is what it can safely be applied to.

Applied to the whole transcript, the normalized text can no longer be mapped back onto
Segments: `--json --timestamps` would emit a `text` whose content disagrees with the
concatenation of `segments[].text`, and every consumer that renders Segments would show
un-normalized text next to a normalized transcript.

Applied per Segment, each Segment's `text` is rewritten in place and its `start`/`end` are
never touched — the timing came from VAD spans or the fixed-window chunker and has no
dependence on the text. Segment count is preserved (the taggers cannot delete a Segment; an
all-whitespace result is not reachable from non-empty input that already survived the
`trim().is_empty()` filters upstream).

The top-level `text` is then rebuilt with the existing `join_segment_texts`, which is what the
VAD and chunked paths already produce, so `text` and `segments` cannot drift. On the plain
path with `--json` there is exactly one Segment whose text is the transcript, so the rebuild is
an identity. With no Segments at all (the text-only path) the transcript is normalized directly.

"The text-only path has no Segments" is not free, though: the VAD path returns its speech spans
whether or not the caller asked for Segments, where plain returns none and chunked clears them.
Left alone, `--itn` without `--timestamps` would normalize per span on long audio only, and a
number phrase VAD split across two spans normalizes to `"20 1"` rather than `"21"`. So the pass
runs behind one shared tail that drops Segments whenever they weren't requested, making
`with_segments: false` mean the same thing on all three paths.

Ordering: ITN runs last in `transcribe_with_options`, after the Diarization merge. Diarization
assigns Speaker labels from time spans and never reads Segment text, so the two are
order-independent; running ITN last keeps it a single post-processing tail with one call site.

## D3 — Capability gate is about Engine version, not Backend

`transcribe.itn` goes in Capabilities JSON unconditionally, next to `transcribe.segments`.
The string is declared once in `rust/src/transcribe/mod.rs` and mirrored in `src/engine.ts`,
following `TRANSCRIBE_SEGMENTS_FEATURE` / `TRANSCRIBE_DIARIZE_FEATURE` exactly.

The gate is still load-bearing, and this is the part of #710's done-when #2 that survives:
users routinely run a new CLI against an Engine installed months ago. Without the check, clap
in the old Engine rejects `--itn` with its own unhelpful usage error, or — worse for a flag
this quiet — a future refactor could drop it silently. The CLI checks capabilities first and
fails with the upgrade action.

The check must run on both Transcription paths, not just the `--timestamps` one:
`--itn` is useful with plain text output, which today calls `transcribeEngine` with no
preflight at all. `preflightTranscribeWithSegments` currently short-circuits unless
`timestamps || speakers`; the ITN check is hoisted above that short-circuit.

## D4 — Russian is a documented no-op, not a guard

The ru benchmark fixture sentences all round-trip byte-identical through
`normalize_sentence`, because the taggers key on English number words. Two options were
weighed: reject `--itn` when the detected language is not English, or let it through as an
inert pass. Rejecting would require language detection to run *before* Transcription
post-processing (it currently runs after, on the transcript) and would break the mixed-language
case, which works correctly today — `"hello мир two hundred"` → `"hello мир 200"`. Letting it
through costs one pass over text that will not change. No guard.

## Open Issues

- **`"period"` → `"."` has no part-of-speech check.** `"run the test suite period then update
  the docs"` normalizes to `"run the test suite . then update the docs"`. FluidAudio's Swift
  `filterAmbiguousWords` exists for this and is unavailable on the pure-Rust path;
  `text-processing-rs` exposes no option to disable its punctuation tagger. Documented as a
  limitation of an opt-in flag rather than worked around. If it proves to be the common case
  on real speech, the fix belongs upstream.
- **`text-processing-rs` is not published on crates.io** and carries no release tags, so it is
  pinned by git rev like `fluidaudio-rs`. Bumping it is a manual, deliberate act.
