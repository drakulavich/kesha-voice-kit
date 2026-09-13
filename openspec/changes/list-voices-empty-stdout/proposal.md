## Why

`kesha-engine say --list-voices` prints one Voice id per line to stdout, and the tts-synthesis spec says that with nothing installed it prints `No voices installed. Run: kesha install --tts` there instead. Stdout on that command is the list itself, so the sentence arrives at every consumer as a Voice id: `kesha say --list-voices` happens to read fine, but the MCP `list_voices` tool answers "1 voices installed." with a voice whose model is `unknown` and whose language is empty, and `list_languages` then reports a language that does not exist (#1168). Both surfaces sit on one function, `listVoiceIds` in `src/synth.ts`, and the CLI-side alternatives — matching the sentence, or dropping stdout lines that do not look like ids — either break on a rewording or hide a real Engine change.

## What Changes

- The voice-listing requirement states that an empty list is an empty stdout: the `kesha install --tts` hint SHALL travel as a `progress` event on stderr, and the exit code stays 0.
- The "Nothing installed yet" scenario asserts empty stdout plus the stderr event instead of the sentence on stdout.

## Capabilities

### Modified Capabilities

- `tts-synthesis`: guidance for an empty voice list is an event, not payload.

## Impact

- `rust/src/cli/say.rs`: the empty-list branch emits `events::progress` and prints nothing.
- `rust/tests/tts_smoke.rs`: `list_voices_empty_on_fresh_cache` asserts empty stdout and the progress event.
- Reaches users with the next Engine release; the CLI needs no change, since an empty list parses as no voices on both surfaces already.
- Landed by the PR that closes #1168; this change is archived by the sync that follows it.

## Non-goals

- No CLI-side filter: the CLI keeps passing the Engine's stdout ids through.
- `--quiet` silences the hint like every progress event; a fresh machine then prints nothing and exits 0.
- The darwin-arm64 `system_kokoro` build lists the static FluidAudio catalog and never reaches the empty branch; unchanged.
