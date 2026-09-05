## Context

Today's boundary (baseline `engine-contract`): `--capabilities-json` (protocol 3), `--error-codes-json`, `error [E_CODE]: <message>` on stderr, `diarize: ` progress prefix detected at `src/engine.ts:140`, `KESHA_DEBUG_FD` forwarded at `src/engine.ts:103-115`. The CLI mirrors Engine gates by hand in `preflightTranscribeEngineItn`, `preflightTranscribeEngineWithSegments`, `assertSpeakersSupported` (`src/engine.ts:326-380`) and keeps `TS_NATIVE_CODES` with a drift test (`src/error-codes.ts`).

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

Why stderr and not a third fd: stderr is what every runner, CI log and `2>` redirection already captures; the fd forwarding existed only to keep debug lines out of prose stderr, and with no prose left there is nothing to keep apart.

### D2. `describe` is the whole schema

`kesha-engine describe` prints one JSON object on stdout and exits 0:

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
    "say": {"flags": {"voice": {"gate": "tts"}, "stdin-loop": {"gate": "tts"}}},
    "record": {"flags": {"live": {"gate": "record.live"}, "auto-stop": {"gate": "record.live.auto-stop", "requires": ["live"]}}}
  },
  "features": ["transcribe", "transcribe.segments", "transcribe.itn", "transcribe.diarize", "detect-lang", "vad", "tts", "record.live"],
  "errors": [{"code": "E_MODEL_MISSING", "title": "Model or voice not installed", "category": "model", "retryable": false}],
  "tts": {"languages": [{"code": "en", "engines": ["kokoro"]}]}
}
```

The flag list is derived from clap at runtime (`CommandFactory::command()`); the gates live in a table beside it, and a unit test asserts the two sets are equal, so a flag cannot exist without a schema row. `features` stays for consumers that only need a boolean. The CLI validates any argv with one function: every flag must exist for the command, its gate (if any) must be in `features`, its `requires` must be present and its `conflicts` absent. The CLI-native codes `E_INPUT_NOT_FOUND`, `E_ENGINE_SPAWN`, `E_INVALID_ARG`, `E_INTERNAL` are listed in `errors` with `"origin": "cli"`, so `docs/errors.md` can be generated from `describe` and no TS registry needs a drift test.

### D3. Version gate

The CLI refuses a `describe` whose `protocolVersion` is not 4 with `E_ENGINE_PROTOCOL` and the hint `kesha install` (a too-old Engine) or `bun add -g @drakulavich/kesha-voice-kit@latest` (a too-new Engine). Both directions are gated because both happen: `--engine-version` installs any release for one invocation.

### D4. Migration carrier

The Engine ships v4 as `v1.25.0-beta.1` (draft, un-drafted by hand); the CLI's first stage-2 PR pins that beta. `check:versions` rule 3 accepts a `-beta.N` pin and refuses an alpha, and beta releases are never pruned (design spec section 4).

## Risks / Trade-offs

- Anyone tailing `kesha-engine` stderr by hand sees JSON. Accepted; the CLI is the human interface and `docs/nix-install.md:15` changes its example to `describe`.
- Rust integration tests that assert on stderr prose (`diarize_e2e.rs:249`, `tts_smoke.rs:140`, `kokoro_rate_e2e.rs:78`, `error_codes_cli.rs:10`) rewrite their assertions to `kind`/`code`; that is the stage-1 work, not a hidden cost.

## Migration Plan

Stage 1 (Engine, 4–5 PRs): `describe` + gate table + parity test; event emitter replacing `eprintln!`; delete `--capabilities-json`, `--error-codes-json`, `KESHA_DEBUG_FD`; migrate the pact recorder, release smoke, Rust tests, `docs/errors.md`; tag `v1.25.0-beta.1`. Stage 2 (CLI, 5–6 PRs): beta pin, generic validation, event renderer, `KeshaError`; then one PR per command.

## Open Questions

- Whether `progress` events carry `pct` for every phase or only diarization. Resolve in the first stage-1 PR by emitting `pct` where a phase knows its total and omitting it otherwise; the field is optional in D1 for this reason.
