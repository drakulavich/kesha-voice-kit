## 1. Measure per channel in the meter helper

- [x] 1.1 Accumulate the sum of squares inside the per-channel loop in
      `SWIFT_MIC_METER_SCRIPT` and divide by `frameCount`, not by
      `channelCount * frameCount`
- [x] 1.2 Emit the per-channel levels as `channelRms`, keeping `peak` as the
      maximum across channels so the displayed level is unaffected
- [x] 1.3 Confirm the script still compiles: `swiftc -typecheck` on the extracted
      source

## 2. Reduce and classify in TypeScript

- [x] 2.1 Add `loudestChannelRms`, returning the maximum finite channel level and
      `0` for anything that is not an array of numbers
- [x] 2.2 Read `channelRms` in `parseMeterLine` and classify the reduced level
      against `SPEECH_RMS_THRESHOLD`; leave `percentFromPeak` on `peak`
- [x] 2.3 Keep the reduction in TypeScript rather than Swift — the Swift half
      cannot be exercised from vitest, so a decision living there is untestable

## 3. Tests

- [x] 3.1 Move the existing fixtures to the new meter output
- [x] 3.2 Test: speech on one channel of a two- and a four-channel device
      classifies as **signal**, and the reduced level is the speaking channel's
- [x] 3.3 Test: missing, empty, and non-numeric channel data read as **listening**
- [x] 3.4 Verify the new tests fail against the old pooled average, so they cover
      the regression rather than merely passing beside it

## 4. Verification

- [x] 4.1 `npm test` and `npm run lint` under `raycast/` — the two commands the
      `raycast-lint` CI job runs
- [x] 4.2 Run the meter helper against a real microphone and confirm every line
      parses and a quiet room classifies as **listening**
- [~] 4.3 Exercise a real multi-channel input device. NOT done — none available.
      The multi-channel path rests on the arithmetic and the unit tests; recorded
      as an Open Issue in the delta spec rather than implied to be verified.

## 5. Specs and mirror

- [x] 5.1 Correct the Signal meter Technical Note, which still named
      `SILENCE_PEAK_THRESHOLD` as the classifier after #670 replaced it and
      whose line ranges predate that change
- [x] 5.2 Land the upstream half in `raycast/extensions#29936` and keep both
      files byte-identical to it, so the next mirror sync is a no-op on them
- [ ] 5.3 After merge, fold this delta into
      `openspec/specs/raycast-extension/spec.md` and archive the change
