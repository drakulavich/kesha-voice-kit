## Why

The Signal meter's AVAudioEngine tap pooled the squared samples of every input
channel and divided by the total sample count
(`raycast/src/lib/signal-meter.ts` lines 28–44 before this change), so the rms it
reported was averaged across channels. A microphone on one input of a
multi-channel device is therefore attenuated by `sqrt(channelCount)` before
`SPEECH_RMS_THRESHOLD` sees it — the other channels are digitally silent and
still count toward the divisor.

Against the levels measured in #648, that moves audible speech under the
threshold:

| channels | factor | speech p90 `0.0139` → | vs `SPEECH_RMS_THRESHOLD = 0.01` |
|---|---|---|---|
| 1 | 1.000 | 0.0139 | above |
| 2 | 0.707 | 0.0098 | **under** |
| 4 | 0.500 | 0.0069 | **under** |

The consequence is Idle auto-stop ending a Dictation session while Maks is still
talking. That is the failure direction #670 explicitly chose against when it
dropped the adaptive noise floor for a constant: failing to auto-stop is
recoverable, cutting a speaker off mid-sentence is not.

Found by review on the upstream mirror PR (`raycast/extensions#29936`), not by a
user report — no one has reported it, and it needs a multi-channel input device
to reproduce.

## What Changes

- The Signal meter classifies **signal** vs **listening** from the input channel
  actually carrying the voice, instead of from an average across all channels,
  so channel count no longer changes whether the same speech counts as speech.
- The meter helper reports one rms per channel; the reduction to a single level
  moves out of the Swift helper into TypeScript, beside the threshold it feeds.
  The helper's output is an implementation surface with exactly one consumer, so
  this is not a compatibility break.
- A meter sample carrying no usable channel level reads as **listening** rather
  than as an arbitrary number.
- The displayed level is untouched: it derives from peak, which was already the
  maximum across channels.

No behaviour changes for a single-channel input, which is every built-in
microphone.

## Capabilities

### New Capabilities

None. This corrects an existing requirement's guarantee.

### Modified Capabilities

- `raycast-extension`: the Signal meter requirement gains an explicit guarantee
  that classification is independent of the input device's channel count, and
  its Technical Note is corrected — it still names `SILENCE_PEAK_THRESHOLD` as
  the classifier, which #670 replaced with `SPEECH_RMS_THRESHOLD`, and its line
  ranges predate that change.

## Impact

- `raycast/src/lib/signal-meter.ts` — the Swift tap accumulates per channel and
  emits `channelRms`; new `loudestChannelRms` reduces it; `parseMeterLine` reads
  the array.
- `raycast/tests/signal-meter.test.ts` — fixtures move to the new meter output;
  two tests added for multichannel attenuation and unusable channel data.
- `raycast/` is mirrored into `raycast/extensions`: the upstream half of this
  change is `raycast/extensions#29936` commit `6908e88`, already reviewed and
  green there. Both files here are byte-identical to it.
- No CLI, Engine, or model surface is touched.

## Non-goals

- No change to `SPEECH_RMS_THRESHOLD` itself. The constant from #670 is correct
  once it is applied to an undiluted level; this fixes the level, not the
  threshold.
- No return to the adaptive noise floor #670 removed. Its trade-off is unchanged
  by this fix, and the reasoning that retired it still holds.
- No per-channel selection policy beyond "loudest". Deciding which input a user
  *meant* to speak into is a device-picker concern, not a meter concern.
- No change to `SILENCE_PEAK_THRESHOLD`, which `raycast/src/lib/wav.ts` lines 71
  and 87 still use to reject an all-silent recording — that is what −80 dBFS is
  genuinely right for.
- No change to the displayed level or its dB scale.
- No `raycast/CHANGELOG.md` entry. The section this belongs under does not exist
  in this copy at all — see Open Issues in the delta spec.
