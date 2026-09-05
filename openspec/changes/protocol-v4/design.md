## Context

Today's boundary (baseline `engine-contract`): `--capabilities-json` (protocol 3), `--error-codes-json`, `error [E_CODE]: <message>` on stderr, `diarize: ` progress prefix detected at `src/engine.ts:131-133`, `KESHA_DEBUG_FD` forwarded at `src/engine.ts:103-115`. The CLI mirrors Engine gates by hand in `preflightTranscribeEngineItn`, `preflightTranscribeEngineWithSegments`, `assertSpeakersSupported` (`src/engine.ts:326-380`) and keeps `TS_NATIVE_CODES` with a drift test (`src/error-codes.ts`).

## Goals / Non-Goals

Goals: one machine-readable side channel; one schema the CLI validates against generically; a version gate; one error type on the CLI side. Non-goals: as in the proposal.

## Decisions

### D1. Event stream on stderr, payload on stdout

Every non-payload line the Engine emits is one JSON object on stderr:

```json
{"kind":"progress","phase":"diarize","message":"loading model","pct":12}
{"kind":"warn","code":"W_VAD_NOT_INSTALLED","message":"audio is 400s; kesha install --vad would improve accuracy"}
{"kind":"error","code":"E_MODEL_MISSING","message":"voice 'ru-vosk-m02' not installed","hint":"kesha install --tts ru"}
{"kind":"debug","t_ms":412,"event":"asr.decode.start"}
```

`kind` and `message` are required; `code` is required on `error` and `warn`; `hint` is optional and is what the CLI prints after the message. A fatal `error` is followed by exit code 1 (the `say` exit-code exceptions in the tts-synthesis spec stay). Lines are `\n`-terminated; the CLI parser strips a trailing `\r` so Windows output parses identically. A line that is not valid JSON is a protocol violation the CLI reports as `E_INTERNAL` with the raw line in the message.

Argument parsing joins the stream. `rust/src/main.rs` uses `try_parse` instead of `Cli::parse()` (`rust/src/main.rs:99`), and both a clap parse error and a missing subcommand become one `error` event with code `E_INVALID_ARG` whose message carries clap's own text including the usage line; the process exits 2. `--help` and `--version` keep printing prose to stdout and are the only prose exemption, because they are the one output a person asks for by name.

Why stderr and not a third fd: stderr is what every runner, CI log and `2>` redirection already captures; the fd forwarding existed only to keep debug lines out of prose stderr, and with no prose left there is nothing to keep apart. This answers design-spec section 11 item 2: `doctor.ts` drops `KESHA_DEBUG_FD` from its env list (`src/doctor.ts:37`); the support bundle already reads the Diagnostic log, where `debug` events land, so nothing else changes.

### D2. `describe` is the whole schema

`kesha-engine describe` prints one JSON object on stdout and exits 0 (abridged: `features` lists a subset):

```json
{
  "protocolVersion": 4,
  "backend": "coreml",
  "profile": "darwin",
  "commands": {
    "transcribe": {
      "flags": {
        "json": {"gate": null},
        "vad": {"gate": null, "conflicts": ["no-vad"]},
        "speakers": {"gate": "transcribe.diarize", "requires": ["json"]},
        "itn": {"gate": "transcribe.itn"}
      }
    },
    "install": {"flags": {"no-cache": {"gate": null}, "tts": {"gate": "tts", "values": "langs"}, "vad": {"gate": null}, "diarize": {"gate": "transcribe.diarize"}, "no-warmup": {"gate": null}}},
    "say": {"flags": {"voice": {"gate": "tts"}, "stdin-loop": {"gate": "tts"}, "no-expand-abbrev": {"gate": ["tts.ru_acronym_expansion", "tts.en_acronym_expansion"], "whenUngated": "drop"}}},
    "record": {"flags": {"live": {"gate": "record.live"}, "auto-stop": {"gate": "record.live.auto-stop", "requires": ["live"]}}}
  },
  "features": ["transcribe", "transcribe.segments", "transcribe.itn", "transcribe.diarize", "detect-lang", "vad", "tts", "record.live"],
  "errors": [{"code": "E_MODEL_MISSING", "title": "Model or voice not installed", "category": "model", "retryable": false, "origin": "engine"}],
  "tts": {"languages": [{"code": "en", "engines": ["kokoro"]}]}
}
```

The flag list is derived from clap at runtime (`CommandFactory::command()`); the gates live in a table beside it, and a unit test asserts the two sets are equal, so a flag cannot exist without a schema row. `features` stays for consumers that only need a boolean. The CLI validates any argv with one function: every flag must exist for the command, its gate (if any) must be in `features`, its `requires` must be present and its `conflicts` absent. `whenUngated` is `reject` (default) or `drop`; `drop` reproduces today's `applyNoExpandAbbrev` behaviour (`src/synth.ts:69-85`): the flag is omitted with a warning instead of failing the call. A `gate` is a feature name or an any-of array.

Every entry in `errors` carries an `origin` of `engine`, `cli` or `both`. `E_INPUT_NOT_FOUND`, `E_INVALID_ARG` and `E_INTERNAL` are `both` — either side raises them. `E_ENGINE_SPAWN` and `E_ENGINE_PROTOCOL` are `cli`: only the CLI can observe a binary that will not start or a protocol it does not speak. With origins published, `docs/errors.md` is generated from `describe` and no TS registry needs a drift test.

The `install` platform pre-check is deliberately not schema-driven: `kesha install --diarize` on linux-x64 with no Engine on disk has nothing to validate against, so that check stays where it is and the platform pre-check reports `E_UNSUPPORTED_PLATFORM` (today it throws a bare `Error` at `src/cli/install.ts:228-233`; v4 assigns the code). Schema validation applies from the moment an Engine binary exists, and a gated flag on a build that lacks the gate is `E_INVALID_ARG`.

MODIFIED requirement titles that still say Capabilities JSON or TS-native are kept for baseline matching; they are legacy names.

### D3. Version gate

The CLI refuses a `describe` whose `protocolVersion` is not 4 with `E_ENGINE_PROTOCOL` and the hint `kesha install` (a too-old Engine) or `bun add -g @drakulavich/kesha-voice-kit@latest` (a too-new Engine). Both directions are gated because both happen: `--engine-version` installs any release for one invocation.

### D4. Migration carrier

The Engine ships v4 as `v1.25.0-beta.1` under the machinery that exists during stages 1–3 (draft, un-drafted by hand); the CLI's first stage-2 PR pins that beta. `check:versions` rule 3 accepts a `-beta.N` pin and refuses an alpha, and beta releases are never pruned (design spec section 4). The `unified-release` change replaces that draft flow with a published Prerelease in stage 4, after this migration has finished.

## Risks / Trade-offs

- Anyone tailing `kesha-engine` stderr by hand sees JSON. Accepted; the CLI is the human interface and `docs/nix-install.md:15` changes its example to `describe`.
- Rust integration tests that assert on stderr prose (`diarize_e2e.rs:249`, `tts_smoke.rs:140`, `kokoro_rate_e2e.rs:78`, `error_codes_cli.rs:10`) rewrite their assertions to `kind`/`code`; that is the stage-1 work, not a hidden cost.

## Migration Plan

Stage 1 (Engine, 4–5 PRs): `describe` + gate table + parity test; event emitter replacing `eprintln!`; delete `--capabilities-json`, `--error-codes-json`, `KESHA_DEBUG_FD`; migrate the pact recorder, release smoke, Rust tests, `docs/errors.md`; tag `v1.25.0-beta.1`. Stage 2 (CLI, 5–6 PRs): beta pin, generic validation, event renderer, `KeshaError`; then one PR per command.

One observable exit code changes: `kesha-engine` with no subcommand exits 2 instead of 1 (`rust/src/main.rs:155-157`), because a missing subcommand is an invalid argument and now reports as one. `kesha` itself is unaffected — it never invokes the Engine without a subcommand.

## Open Questions

- Whether `progress` events carry `pct` for every phase or only diarization. Resolve in the first stage-1 PR by emitting `pct` where a phase knows its total and omitting it otherwise; the field is optional in D1 for this reason.
- Technical-Note-only mentions of the old protocol remain in `audio-recording/spec.md:122`, `speaker-diarization/spec.md:415`, `audio-ingest/spec.md:141`, `installation/spec.md:48,99,148,299`, `cli-distribution/spec.md:241`; stage 1's last PR sweeps them. The two normative mentions are handled here instead: `audio-recording/spec.md:113` by this change's `audio-recording` delta, and `cli-distribution/spec.md:224` by the Nix requirement `build-profiles` already modifies.
