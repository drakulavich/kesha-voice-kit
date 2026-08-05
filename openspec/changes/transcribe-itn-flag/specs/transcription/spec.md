## ADDED Requirements

### Requirement: Transcription offers an opt-in written-form pass

Transcription SHALL accept an opt-in request to convert spoken-form numbers, money amounts,
dates and times in its output to written form, and SHALL leave output untouched when the
request is absent.

The pass is never applied by default, on any platform or Backend.

#### Scenario: Ira asks for written-form numbers

- GIVEN an English recording in which the speaker says "two hundred thirty two open pull requests"
- WHEN Ira transcribes it with the written-form pass requested
- THEN the transcript reads "232 open pull requests"

#### Scenario: Ira does not ask for it

- GIVEN the same recording
- WHEN Ira transcribes it without requesting the pass
- THEN the transcript keeps the spoken form the Backend produced

#### Scenario: Maks transcribes Russian with the pass requested

- GIVEN a Russian recording containing spoken numbers
- WHEN Maks transcribes it with the written-form pass requested
- THEN the transcript is byte-identical to the transcript without the pass
- AND no error is reported

> *Technical Note — the pass is `text_processing_rs::normalize_sentence`, a pure-Rust port of
> NVIDIA NeMo text processing, called from a new `rust/src/transcribe/itn.rs` at the tail of
> `transcribe_with_options` (`rust/src/transcribe/mod.rs:174`). It ships taggers for
> `de/en/es/fr/hi/ja/zh` and none for `ru`, which is why Russian is inert rather than
> guarded — see the change's design D1 and D4. The `fluidaudio-rs` `itn_normalize` binding
> named in #710 is a `dlsym` shim over a `libnemo_text_processing` that kesha does not link,
> and returns its input verbatim; it is deliberately not used.*

### Requirement: The written-form pass preserves Segment timing

Transcription SHALL keep every Segment's `start` and `end` unchanged when the written-form
pass runs, and SHALL keep the transcript consistent with the concatenation of its Segments.

The pass rewrites text inside a Segment; it never splits, merges, drops or re-times one.

#### Scenario: Ira requests timestamps and the written-form pass together

- GIVEN a multi-Segment English recording
- WHEN Ira transcribes it as JSON with both timestamps and the written-form pass requested
- THEN the output parses as a well-formed Transcription result
- AND each Segment's `start` and `end` match the run without the pass
- AND the Segment count matches the run without the pass
- AND the transcript equals the Segment texts joined in order

#### Scenario: the pass runs with no Segments requested

- GIVEN the same recording
- WHEN Ira transcribes it as plain text with the written-form pass requested
- THEN the transcript is normalized
- AND no Segments are emitted

#### Scenario: a Segment contains nothing the pass recognizes

- GIVEN a Segment whose text has no spoken-form number, money amount, date or time
- WHEN the written-form pass runs over it
- THEN the Segment's text is unchanged
