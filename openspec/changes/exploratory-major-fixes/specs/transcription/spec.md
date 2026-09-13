## MODIFIED Requirements

### Requirement: Machine-readable output formats

The CLI SHALL provide JSON (`--json` / `--format json`) and TOON (`--toon` /
`--format toon`) output: an array of per-file result objects
(`file`, `text`, `lang`, and detection/timing fields), with TOON losslessly
round-tripping to the same data as JSON. The CLI SHALL also provide
`--format transcript` (text plus a `[lang: <code>, confidence: <n>]` trailer)
and `--verbose`, which prints detection details and STT time to stderr for
every output format; stdout carries the result alone, so a redirected
`--verbose` run leaves a file holding nothing but the transcript.

#### Scenario: Sona requests JSON

- WHEN Sona runs `kesha --json call.ogg`
- THEN stdout is a 2-space-indented JSON array with one result object containing
  at least `file`, `text`, and `lang`
- AND the process exits 0

#### Scenario: TOON for LLM piping

- WHEN Sona runs `kesha --toon call1.ogg call2.ogg`
- THEN stdout is a TOON document that `@toon-format/toon`'s `decode()` turns
  back into the same result array `--json` would have printed

#### Scenario: Structured error reporting opt-in

- GIVEN `b.ogg` is missing
- WHEN Ira runs `kesha --json --include-errors a.ogg b.ogg` (or the same with
  `--toon`)
- THEN stdout is `{ "results": [...], "errors": [...] }` where the error record
  for `b.ogg` carries a stable error code, TOON encoding the same envelope
- AND without `--include-errors` stdout would be the plain results array
  holding only `a.ogg`

#### Scenario: Maks redirects a verbose run to a file

- WHEN Maks runs `kesha --verbose note.ogg > note.txt`
- THEN `note.txt` holds the transcript and nothing else
- AND the `Audio language`, `Text language` and `STT time` lines appear on
  stderr
