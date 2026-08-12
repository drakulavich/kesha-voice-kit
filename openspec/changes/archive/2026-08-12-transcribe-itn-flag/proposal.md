## Why

Parakeet emits numbers in spoken form. `kesha transcribe` hands that straight through —
`rust/src/transcribe/` does no post-processing at all — so Ira's pipeline gets
`"there are two hundred thirty two open pull requests"` where it wanted `232`.

#710 proposed reaching for `fluidaudio-rs::itn_normalize`, which has been in the binding
since crate 0.14.1. **That call does nothing, and cannot be made to do anything by kesha
alone.** A spike against the current pin (`fluidaudio-rs` rev `9b7ceda`, FluidAudio 0.14.8)
measured it directly:

```
native_available = false
IN   : "there are two hundred thirty two open pull requests"
WORD : Ok("there are two hundred thirty two open pull requests")
SENT : Ok("there are two hundred thirty two open pull requests")
```

Upstream `Sources/FluidAudio/ITN/TextNormalizer.swift` is a pure `dlsym` shim over an
external native library: it looks up `nemo_normalize` / `nemo_free_string` / `nemo_version`
in the current process, and when they are absent sets `isNativeAvailable = false` and
returns every input verbatim. The fluidaudio-rs doc comment claiming a "reduced coverage"
Apple-NaturalLanguage fallback is wrong — NaturalLanguage is used only to *filter* ambiguous
words before the native call, never to normalize. FluidAudio's own docs confirm the
requirement: *"To enable text processing support, link your app against
`libnemo_text_processing`"*, built from
[FluidInference/text-processing-rs](https://github.com/FluidInference/text-processing-rs).

That library is a **pure-Rust crate**. Kesha does not need the Swift round trip to reach it:
it can call `text_processing_rs::normalize_sentence` directly. Measured on the same fixture
sentences, with no native library, no model download, and no Swift in the loop:

```
"there are two hundred thirty two open pull requests" -> "there are 232 open pull requests"
"it costs five dollars and fifty cents"               -> "it costs $5.50"
"review pull request number forty two"               -> "review pull request number 42"
```

## What Changes

- Transcription gains an opt-in `--itn` pass that rewrites spoken-form numbers, money, dates
  and times in its output to written form. Off by default, on every platform.
- The pass applies **per Segment**, so `--timestamps` boundaries survive it: ITN changes the
  token count inside a Segment's text but never its `start`/`end`.
- Capabilities JSON advertises `transcribe.itn`, and the CLI validates `--itn` against it
  rather than forwarding the flag blind. An Engine predating this change fails loudly with
  the upgrade action instead of silently dropping the flag.
- Russian Transcription output is passed through unchanged — see Non-goals.

## Capabilities

### New Capabilities

None. `--itn` is a new option on existing Transcription, not a new capability.

### Modified Capabilities

- `transcription`: output may now be post-processed on request; the contract for what `--itn`
  guarantees, and what it explicitly does not touch, is stated here.
- `engine-contract`: one more feature string in Capabilities JSON, and one more flag the CLI
  is required to validate before forwarding.

## Non-goals

- **Making `--itn` a default.** #710 is explicit, and the "period" case below is reason
  enough on its own.
- **Russian ITN.** `text-processing-rs` ships taggers for `de/en/es/fr/hi/ja/zh` and no `ru`.
  Verified on the ru benchmark fixture sentences: every one is returned byte-identical, so
  the flag is inert rather than damaging on Russian. Kesha does not add a Russian tagger
  here; if Maks wants `двадцать три` → `23` that is upstream work and its own issue.
- **Per-language routing of the pass.** `--itn` runs the English tagger set regardless of
  detected language. Non-English input is a no-op in practice because the taggers match
  English number words. Wiring ITN to language detection is a follow-up, not this change.
- **Punctuation-command normalization quality.** The taggers rewrite a spoken `"period"` to
  `"."` with no part-of-speech check, so `"run the test suite period then update the docs"`
  becomes `"run the test suite . then update the docs"`. FluidAudio's Swift wrapper has an
  NLTagger filter for exactly this; the pure-Rust path does not. This is a known limitation
  of the opt-in flag, recorded in Open Issues, not something this change fixes.
- **Text normalization in the other direction (TN, written → spoken) for TTS.** The same
  crate exposes it. `kesha say` is untouched here.
- **Exposing the pass as an MCP tool argument.** Sona reaches it through the programmatic
  API, which takes the same `TranscribeOptions` and so gets the option for free; the MCP
  `transcribe` tool schema is deliberately left alone until there is a request for it.

## Impact

- New pinned git dependency `text-processing-rs` (Apache-2.0, FluidInference — the same
  upstream org as the existing `fluidaudio-rs` dependency), pinned by rev exactly as
  `fluidaudio-rs` is. Pure Rust, one transitive dependency (`lazy_static`); the `fst-engine`
  and `ffi` features that carry weight stay off.
- `rust/src/transcribe/` gains an `itn` module and one `TranscribeOptions` field;
  `rust/src/capabilities.rs`, `rust/src/main.rs`, `rust/src/cli/transcribe.rs`.
- `src/engine.ts`, `src/transcribe.ts`, `src/cli/main.ts` — the flag and its capability gate.
- Ships in every Backend, so the ONNX Linux/Windows binaries grow by the crate's code size.

Closes #710.
