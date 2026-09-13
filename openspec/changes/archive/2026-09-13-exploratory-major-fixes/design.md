## Context

The 39 major findings share a small number of root causes: the CLI's option parser drops what it does not know instead of refusing it; `engineFailure` maps every non-zero engine exit that carries no error event to `E_INTERNAL`, including the 130/143 the CLI itself caused; several engine-side refusals of caller input raise the generic code; `log.warn` call sites are wrapped in the progress optional chain; language routing trusts any top guess; and neither the engine's `record` nor `kesha mcp` watches its owner. Fixes are grouped by root cause and implemented by seven agents in seven worktrees, merged into one branch.

## Goals / Non-Goals

**Goals:** every major finding either fixed with a regression test that fails without the fix and a `just mutate` proof, or explicitly recorded as not reproduced; no protocol version bump; no change to the JSON schema of `transcribe` output.

**Non-Goals:** the two blockers; minor findings; redesigning the option parser; a confidence field in the JSON output (the floor applies to routing only); Windows-specific parent-death detection beyond what `getppid`/stdin EOF give.

## Decisions

### D1. One new code, `E_INTERRUPTED`, CLI origin

Cancellation is a distinct outcome the docs already describe (`130`/`143` "mean cancelled, not failed"), but no code existed, so the CLI fell through to `E_INTERNAL`. `E_INTERRUPTED` is raised only by the CLI and the core API (origin `cli`), exit code follows the signal received (130 SIGINT, 143 SIGTERM, 129 SIGHUP), and the message names that signal even after escalation to SIGKILL. The engine is untouched: it still exits on the forwarded signal, and the CLI recognises its own cause. Alternative rejected: reusing `E_INTERNAL` with a different message, which keeps agents matching on the code wrong.

### D2. Refuse unknown flags before the spawn, in the CLI's own parser

`validateArgv` cannot see a flag the option parser already dropped, so the check moves to the boundary where the user's argv is parsed: any option not declared for that command is `E_INVALID_ARG` with the nearest declared flag suggested when the edit distance is at most two. The same path prints every CLI-level usage error as `error [E_INVALID_ARG]: …` on stderr with exit 2, so `--json --toon`, a missing input, `completions` without a shell and a global flag before a subcommand all look alike to a script.

### D3. Caller errors on the engine side become `E_INVALID_ARG`

The `--no-vad` ceiling and a bad `--out` are refusals of the caller's request with a self-explaining message; the code changes, the message does not. A container declaring no sample rate is caught where the decoder is opened and reported as `E_BAD_AUDIO` naming the file. AIFF: symphonia 0.5's `aiff` feature is enabled if it decodes a PCM AIFF fixture; otherwise the format list and the message are corrected instead.

### D4. Channels

`--verbose` output is diagnostic, so it joins progress on stderr. `--quiet` means "results and errors only": the language-mismatch warning is an error-class message and prints; `record --out`'s `Recorded …` line and `No speech detected.` are the result of that command and print. The support-bundle report was always specified as stderr. Diarization progress goes through the same gating as ASR progress.

### D5. A routing floor of 0.5, raw fields unchanged

`lang` is the field consumers route on; `audioLanguage`/`textLanguage` are evidence. A guess below `LANG_ROUTING_FLOOR = 0.5` from either source is not promoted to `lang` (the other source above the floor wins, else `""`); the evidence fields keep their raw code and confidence so the schema and existing consumers are unaffected. `--lang` comparison is on case-folded primary subtags with `_` read as `-`.

### D6. Owners are watched

`record` in the engine polls its parent (getppid changing to 1, or stdin EOF) about once a second and stops the microphone; `kesha mcp` treats stdin EOF as "client gone" even with a call in flight, aborting it; a cancelled MCP call forwards its `AbortSignal` into `transcribe()`, which already kills the engine on abort. The install lock reads back the `pid`/`host` it writes and breaks a lock whose owner is dead on the same host.

## Risks / Trade-offs

- [Refusing unknown flags breaks a script that passed a typo and got lucky] → that script was getting silently wrong output; the suggestion line makes the fix one edit.
- [`E_INTERRUPTED` is a new code agents have not seen] → documented in `docs/errors.md` beside the exit-code paragraph that already describes the case; the pact and describe-template tests pin it.
- [The 0.5 floor changes `lang` for short clips off macOS] → those values were `ber`-class guesses; `--verbose` says when the floor applied.
- [Seven parallel agents edit `src/cli/main.ts`] → each owns a named region (parser/usage, channels/lang, signals); the integrator merges cluster branches one at a time and runs the full preflight once on the merged branch.
- [Parent-death polling costs a wake-up per second in `record`] → negligible against the audio callback rate.
