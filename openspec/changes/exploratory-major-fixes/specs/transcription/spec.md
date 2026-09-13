## MODIFIED Requirements

### Requirement: Long audio is handled via VAD or chunking, never silently truncated

The CLI SHALL transcribe audio of any length: with VAD installed, audio of
120 seconds or longer is automatically split on speech boundaries (auto mode);
`--vad` forces splitting (and fails if the VAD model is not installed);
`--no-vad` forces a single pass and SHALL fail rather than truncate when the
file exceeds the single-pass ceiling (24 minutes), reporting the refusal as the
Error code `E_INVALID_ARG` before any model is required. Without VAD installed,
long audio falls back to fixed overlapping windows with boundary deduplication.

#### Scenario: Hour-long recording with VAD installed

- GIVEN the Silero VAD model is installed
- WHEN Maks runs `kesha lecture.mp3` on a 60-minute file
- THEN the full lecture is transcribed via VAD-segmented passes
- AND the process exits 0

#### Scenario: Forcing VAD without the model

- GIVEN the VAD model is not installed
- WHEN Ira runs `kesha --vad call.ogg`
- THEN the run fails with an actionable `kesha install --vad` hint
- AND the process exits 1

#### Scenario: --no-vad on a file over the ceiling

- WHEN Ira runs `kesha --no-vad marathon.mp3` on a 30-minute file
- THEN the run fails early explaining the single-pass limit instead of
  returning a truncated transcript
- AND the Error code is `E_INVALID_ARG`, because the flag is the caller's
  choice and dropping it is the remedy, not a bug report
- AND the refusal does not depend on the ASR model being installed

> *Technical Note — VAD auto mode triggers at ≥120 s duration (and file size
> >200 KB); single-pass ceiling `FULL_FILE_SINGLE_PASS_MAX_SECONDS` = 24 min;
> fixed-window fallback uses 10-minute windows with 5-second overlap and
> ≥8-char boundary dedup. `validate_plain_transcribe_safety` runs before
> `ensure_asr_installed` and codes its refusal `ErrorCode::InvalidArg`. Sources:
> `rust/src/transcribe/mod.rs`, `rust/src/vad.rs`, `src/cli/main.ts` (VAD flag
> plumbing).*
