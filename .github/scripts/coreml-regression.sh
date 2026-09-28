#!/usr/bin/env bash
set -euo pipefail

cd rust
# --success-output immediate: nextest otherwise swallows the ANE gate's "this guard did not run" line (#841).
# `system_diarize`, `fluid_stdout`, `fluid_stderr` (#1301) and `transcribe::diarize` build under no other lane, so they ride along here (#999, #1072).
cargo nextest run \
  --no-default-features --features coreml,system_diarize \
  --run-ignored all \
  --success-output immediate \
  -E 'test(transcribe_samples_is_stateless_across_calls) + test(a_sub_second_file_transcribes_instead_of_erroring) + test(an_undecodable_file_is_coded_bad_audio) + test(transcribe::diarize::) + test(fluid_stdout::) + test(fluid_stderr::) + test(a_failed_model_fetch_during_asr_init_reaches_stderr_only_as_events)'
