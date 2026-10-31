# Speech-to-Text

The details behind the transcription bullets in the [README](../README.md#speech-to-text).

## Recording from the microphone (macOS)

`kesha record --out hello.wav` writes microphone audio to a WAV file (`kesha hello.wav` transcribes it). macOS prompts for microphone access on first use — grant it under System Settings → Privacy & Security → Microphone if it was denied. Linux, Windows and headless boxes do not capture the microphone; pass any existing audio file straight to `kesha` instead.

## Live dictation (darwin-arm64)

`kesha record --live` transcribes the mic as it captures and prints the transcript to stdout — no WAV in between, so it pipes (`kesha record --live | pbcopy`). To end after trailing silence, explicitly install VAD then opt in: `kesha install --vad && kesha record --live --auto-stop`. The defaults are 1,000 ms of silence after 250 ms of speech; tune them with `--auto-stop-silence-ms`, `--auto-stop-min-speech-ms`, and `--auto-stop-threshold`. Progress goes to stderr.

An interruption is recoverable: Ctrl-C (or SIGTERM) stops the session, still prints what you dictated, and exits 130/143, and the audio is spilled to a recovery WAV under `~/.cache/kesha/recordings/` — named on stderr when the session starts, deleted once the transcript has actually been delivered, kept if anything — a signal, a crash, a closed terminal, a dead pipe — got in the way first ([#962](https://github.com/drakulavich/kesha-voice-kit/issues/962)).

## Long and silence-heavy audio

Install VAD (`kesha install --vad`); Kesha auto-uses it past 120 s. Without VAD, long audio falls back to fixed ASR chunks. See [vad.md](vad.md).

## Speaker diarization (darwin-arm64)

`kesha install --diarize` (which installs VAD too), then `kesha --json --speakers meeting.m4a` stamps each segment with a `speaker` id. `--speakers` engages VAD windowing itself at any duration, so it cannot be combined with `--no-vad`. Linux/Windows return a clear "darwin-arm64 only" error ([#199](https://github.com/drakulavich/kesha-voice-kit/issues/199)).

## Word-level timestamps (every platform)

`kesha --json --timestamps audio.ogg` adds a `words` array to each segment — `{ "word": "email", "start": 0.72, "end": 1.12 }` — on the same file-relative clock as the segment, so a word always lies inside the segment carrying it. Kesha reads them off the decoder's own frame grid, so:

- times are quantised to 0.08 s;
- consecutive spans may overlap (each `end` is a per-word duration prediction, not the next word's `start`);
- `end >= start` rather than strictly greater;
- punctuation stays attached to its word.

The key is simply absent where a segment has none — any segment `--itn` rewrote, for one — so check the `transcribe.words` capability rather than expecting an empty array ([#720](https://github.com/drakulavich/kesha-voice-kit/issues/720)).

## Text-language detection

JSON and TOON results include `textLanguage` with a language code, confidence, and its `source`. On macOS Kesha uses Apple `NLLanguageRecognizer`; elsewhere it uses the bundled `tinyld` fallback, whose confidence scale is different. This is separate from `audioLanguage`, which identifies the spoken audio when available.

## Written-form numbers (`--itn`)

`--itn` rewrites what the model spells out — `"two hundred thirty two"` → `"232"`, `"five dollars and fifty cents"` → `"$5.50"`. Opt-in, every platform, timestamps untouched. English-only in practice; Russian and the rest pass through unchanged.

- Spoken punctuation names stay words (`"dot"`, `"comma"`, `"the period of growth"`) because Kesha transcribes speech rather than dictation — so `"example dot com"` keeps its words too ([#822](https://github.com/drakulavich/kesha-voice-kit/issues/822)).
- A sentence `"and"` survives the number that follows it (`"cats and three dogs"` → `"cats and 3 dogs"`), while an `"and"` the number owns still joins it (`"three hundred and five"` → `"305"`) ([#1000](https://github.com/drakulavich/kesha-voice-kit/issues/1000)) — and no longer splits the number around it (`"two hundred and thirty two"` → `"232"`, not `"230 2"`) ([#1006](https://github.com/drakulavich/kesha-voice-kit/issues/1006)).
- A hyphenated number reads the same as the spaced form (`"twenty-five apples"` → `"25 apples"`), while a hyphen between ordinary words is left alone (`"well-known"`, `"state-of-the-art"`, `"twenty-something"`) ([#1004](https://github.com/drakulavich/kesha-voice-kit/issues/1004)).

## A file name starting with `-`

Write it as `./-file.wav`, or put an option before `--` (`kesha --json -- -file.wav`). A bare `kesha -- -file.wav` fails with `unknown option`, because Bun drops a `--` that comes right after the command name ([#1464](https://github.com/drakulavich/kesha-voice-kit/issues/1464)).
