#!/usr/bin/env bash
set -euo pipefail

cd rust
# `system_diarize`, `fluid_stdout`, `fluid_stderr` (#1301) and `transcribe::diarize` build under no other lane, so they ride along here (#999, #1072).
cargo nextest run \
  --no-default-features --features coreml,system_diarize \
  --run-ignored all \
  -E 'test(an_undecodable_file_is_coded_bad_audio) + test(transcribe::diarize::) + test(fluid_stdout::) + test(fluid_stderr::) + test(a_failed_model_fetch_during_asr_init_reaches_stderr_only_as_events) + test(live_auto_stop_without_a_vad_model_is_model_missing_with_its_path_and_install_hint) + test(live_recording_without_an_asr_model_is_model_missing_with_the_install_hint)'
